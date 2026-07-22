"""GitHub Issues publishing (Issues 7.2, 7.4, 7.6, 7.7): discovery of a repo's
labels/milestones/file tree, and creating issues from approved DraftItems with
task-list hierarchy, retry/backoff, and per-item results."""

from __future__ import annotations

from collections.abc import Awaitable, Callable
from dataclasses import dataclass

import httpx

from app.models import DraftItem
from app.services.connectors.format_adapter import FormatMode, FormattedContent, format_item
from app.services.connectors.github_auth import GitHubConnection
from app.services.connectors.transport import DirectCloudTransport
from app.services.connectors.types import ConnectorError, ConnectorTransport

# GitHub Issues has no native type hierarchy — SpecMate item type becomes a label
# (Issue 7.3 AC), prefixed to avoid colliding with the repo's own labels.
LABEL_PREFIX = "specmate:"

_default_transport = DirectCloudTransport()


# ---------- Discovery (Issue 7.2) ----------


async def discover_repos(
    connection: GitHubConnection, transport: ConnectorTransport = _default_transport
) -> list[dict[str, str]]:
    try:
        response = await transport.request(
            "GET",
            f"{connection.base_url()}/user/repos",
            target="github",
            headers=connection.headers(),
            params={"per_page": 50, "sort": "updated"},
            timeout=30,
        )
        response.raise_for_status()
    except httpx.HTTPError as exc:
        raise ConnectorError(f"GitHub repo discovery failed: {exc}") from exc
    return [
        {"full_name": r["full_name"], "id": str(r["id"])}
        for r in response.json()
        if r.get("permissions", {}).get("push")
    ]


async def discover_repo_meta(
    connection: GitHubConnection,
    repo: str,
    transport: ConnectorTransport = _default_transport,
) -> dict[str, object]:
    """Labels, milestones, and (best-effort) top-level file tree for agent-mode
    file references — repo: 'owner/name'."""
    base = connection.base_url()
    try:
        labels_response = await transport.request(
            "GET",
            f"{base}/repos/{repo}/labels",
            target="github",
            headers=connection.headers(),
            params={"per_page": 100},
            timeout=30,
        )
        labels_response.raise_for_status()
        milestones_response = await transport.request(
            "GET",
            f"{base}/repos/{repo}/milestones",
            target="github",
            headers=connection.headers(),
            params={"state": "open"},
            timeout=30,
        )
        milestones_response.raise_for_status()
    except httpx.HTTPError as exc:
        raise ConnectorError(f"GitHub metadata discovery failed for {repo}: {exc}") from exc

    file_paths: list[str] = []
    try:
        repo_response = await transport.request(
            "GET", f"{base}/repos/{repo}", target="github", headers=connection.headers(), timeout=30
        )
        repo_response.raise_for_status()
        default_branch = repo_response.json().get("default_branch", "main")
        tree_response = await transport.request(
            "GET",
            f"{base}/repos/{repo}/git/trees/{default_branch}",
            target="github",
            headers=connection.headers(),
            params={"recursive": "1"},
            timeout=30,
        )
        if tree_response.status_code == 200:
            file_paths = [
                item["path"]
                for item in tree_response.json().get("tree", [])
                if item.get("type") == "blob"
            ][:500]  # cap — this is for reference suggestions, not a full mirror
    except httpx.HTTPError:
        pass  # file tree is best-effort (Issue 7.2 scope); discovery still succeeds without it

    return {
        "repo": repo,
        "labels": [label_entry["name"] for label_entry in labels_response.json()],
        "milestones": [
            {"number": m["number"], "title": m["title"]} for m in milestones_response.json()
        ],
        "file_paths": file_paths,
    }


def suggest_file_references(item: DraftItem, file_paths: list[str]) -> list[str]:
    """Best-effort: matches words from the item's title against path segments.
    Deliberately simple (no embeddings/semantic search) — a real recommendation
    engine is future work; this satisfies 'file references where available'
    without fabricating paths that don't exist in the repo."""
    if not file_paths:
        return []
    words = {w.lower() for w in item.title.replace("-", " ").replace("_", " ").split() if len(w) > 3}
    matches = [
        path
        for path in file_paths
        if any(word in path.lower() for word in words)
    ]
    return matches[:5]


# ---------- Publishing (Issues 7.4/7.6/7.7) ----------


@dataclass(frozen=True)
class GitHubPublishCandidate:
    item_id: str
    item_type: str
    content: FormattedContent
    parent_item_id: str | None


@dataclass
class GitHubPublishOutcome:
    item_id: str
    ok: bool
    key: str | None = None
    url: str | None = None
    error: str | None = None
    number: int | None = None
    attempts: int = 1


HIERARCHY_ORDER = ["EPIC", "STORY", "TASK", "SUBTASK"]


def sort_for_hierarchy(candidates: list[GitHubPublishCandidate]) -> list[GitHubPublishCandidate]:
    def rank(c: GitHubPublishCandidate) -> int:
        try:
            return HIERARCHY_ORDER.index(c.item_type)
        except ValueError:
            return len(HIERARCHY_ORDER)

    return sorted(candidates, key=rank)


def build_body(content: FormattedContent, child_task_list: list[tuple[str, str]] | None = None) -> str:
    """child_task_list: [(title, issue_url_or_placeholder)] rendered as GitHub
    task-list checkboxes (Issue 7.6) — populated for Epics once their children
    are known; empty at initial creation since children publish after parents."""
    body = content.body_markdown
    if child_task_list:
        items = "\n".join(f"- [ ] {title} {url}" for title, url in child_task_list)
        body += f"\n\n## Child items\n{items}"
    return body


async def create_issue(
    connection: GitHubConnection,
    repo: str,
    candidate: GitHubPublishCandidate,
    labels: list[str],
    milestone: int | None,
    transport: ConnectorTransport = _default_transport,
    on_rate_limited: Callable[[int, float, int], Awaitable[None]] | None = None,
) -> GitHubPublishOutcome:
    """Creates one issue; retry/backoff on rate-limiting (429/5xx, or a
    header-confirmed 403 secondary-rate-limit) is handled by the transport
    (Issue 12.2)."""
    payload: dict[str, object] = {
        "title": candidate.content.title,
        "body": build_body(candidate.content),
        "labels": [f"{LABEL_PREFIX}{candidate.item_type.lower()}", *labels],
    }
    if milestone is not None:
        payload["milestone"] = milestone

    try:
        response = await transport.request(
            "POST",
            f"{connection.base_url()}/repos/{repo}/issues",
            target="github",
            headers=connection.headers(),
            json=payload,
            timeout=30,
            on_rate_limited=on_rate_limited,
        )
    except httpx.HTTPError as exc:
        return GitHubPublishOutcome(
            item_id=candidate.item_id,
            ok=False,
            error=f"network error: {exc}",
        )

    if response.status_code == 201:
        body = response.json()
        return GitHubPublishOutcome(
            item_id=candidate.item_id,
            ok=True,
            key=f"#{body['number']}",
            number=body["number"],
            url=body["html_url"],
        )
    if response.status_code == 429 or response.status_code >= 500:
        # Transport already retried per GITHUB_POLICY and gave up -- this is the
        # final failed response, not a first attempt.
        return GitHubPublishOutcome(
            item_id=candidate.item_id,
            ok=False,
            error=f"Gave up after retries — last error: HTTP {response.status_code} (transient)",
        )
    # A 403 reaching here was either a permanent permissions error (transport
    # never treated it as rate-limited) or a rate limit the transport already
    # retried and gave up on -- either way it's not safely re-describable as
    # "transient" without re-checking headers the connector no longer owns, so
    # it falls through to the generic rejection message below like any other
    # permanent 4xx.
    try:
        detail = response.json()
    except ValueError:
        detail = response.text[:300]
    return GitHubPublishOutcome(
        item_id=candidate.item_id,
        ok=False,
        error=f"GitHub rejected the issue ({response.status_code}): {detail}",
    )


async def update_issue_body(
    connection: GitHubConnection,
    repo: str,
    issue_number: int,
    body: str,
    transport: ConnectorTransport = _default_transport,
) -> None:
    """Used to append the child task-list to a parent Epic issue once children
    have published (issue is created before its children can be known)."""
    try:
        response = await transport.request(
            "PATCH",
            f"{connection.base_url()}/repos/{repo}/issues/{issue_number}",
            target="github",
            headers=connection.headers(),
            json={"body": body},
            timeout=30,
        )
        response.raise_for_status()
    except httpx.HTTPError as exc:
        raise ConnectorError(f"Failed to update issue #{issue_number} task list: {exc}") from exc


async def update_issue(
    connection: GitHubConnection,
    repo: str,
    issue_number: int,
    candidate: GitHubPublishCandidate,
    transport: ConnectorTransport = _default_transport,
    on_rate_limited: Callable[[int, float, int], Awaitable[None]] | None = None,
) -> GitHubPublishOutcome:
    """Updates title/body on an already-published issue (Issue 9.4) — labels and
    milestone are set once at creation and not touched by a source-content update.
    Retry/backoff on rate-limiting is handled by the transport (Issue 12.2); unlike
    the pre-refactor version of this function, a 403 is no longer treated as
    unconditionally transient here -- the transport only retries a 403 when
    GitHub's own headers confirm a secondary rate limit, so a genuine permission
    error now correctly surfaces as a permanent failure instead of being retried."""
    try:
        response = await transport.request(
            "PATCH",
            f"{connection.base_url()}/repos/{repo}/issues/{issue_number}",
            target="github",
            headers=connection.headers(),
            json={"title": candidate.content.title, "body": candidate.content.body_markdown},
            timeout=30,
            on_rate_limited=on_rate_limited,
        )
    except httpx.HTTPError as exc:
        return GitHubPublishOutcome(
            item_id=candidate.item_id,
            ok=False,
            error=f"network error: {exc}",
        )

    if response.status_code == 200:
        return GitHubPublishOutcome(
            item_id=candidate.item_id,
            ok=True,
            key=f"#{issue_number}",
            url=str(response.json().get("html_url", "")),
            number=issue_number,
        )
    if response.status_code == 429 or response.status_code >= 500:
        # Transport already retried per GITHUB_POLICY and gave up -- this is the
        # final failed response, not a first attempt.
        return GitHubPublishOutcome(
            item_id=candidate.item_id,
            ok=False,
            error=f"Gave up after retries — last error: HTTP {response.status_code} (transient)",
        )
    try:
        detail = response.json()
    except ValueError:
        detail = response.text[:300]
    return GitHubPublishOutcome(
        item_id=candidate.item_id,
        ok=False,
        error=f"GitHub rejected the issue update ({response.status_code}): {detail}",
    )


async def add_comment(
    connection: GitHubConnection,
    repo: str,
    issue_number: int,
    comment_text: str,
    transport: ConnectorTransport = _default_transport,
) -> None:
    """Flags an issue for reviewer attention (Issue 9.4) when its source requirement
    was removed — a comment, never an auto-close, so a human decides what happens."""
    try:
        response = await transport.request(
            "POST",
            f"{connection.base_url()}/repos/{repo}/issues/{issue_number}/comments",
            target="github",
            headers=connection.headers(),
            json={"body": comment_text},
            timeout=30,
        )
        response.raise_for_status()
    except httpx.HTTPError as exc:
        raise ConnectorError(f"Failed to comment on issue #{issue_number}: {exc}") from exc


@dataclass(frozen=True)
class RemoteIssueState:
    number: int
    title: str
    description: str
    status: str


async def fetch_issue(
    connection: GitHubConnection,
    repo: str,
    issue_number: int,
    transport: ConnectorTransport = _default_transport,
) -> RemoteIssueState:
    """Reads current title/body/state straight from GitHub (Issue 9.5's drift
    check) — never cached, always the live remote state."""
    try:
        response = await transport.request(
            "GET",
            f"{connection.base_url()}/repos/{repo}/issues/{issue_number}",
            target="github",
            headers=connection.headers(),
            timeout=30,
        )
        response.raise_for_status()
    except httpx.HTTPError as exc:
        raise ConnectorError(f"Failed to fetch issue #{issue_number}: {exc}") from exc
    body = response.json()
    return RemoteIssueState(
        number=issue_number,
        title=str(body.get("title", "")),
        description=str(body.get("body") or ""),
        status=str(body.get("state", "")),
    )


def build_candidate(
    item: DraftItem, mode: FormatMode, parent_item_id: str | None, file_references: list[str] | None = None
) -> GitHubPublishCandidate:
    content = (
        format_item(item, FormatMode.HUMAN)
        if mode == FormatMode.HUMAN
        else format_item(item, FormatMode.CODING_AGENT, file_references)
    )
    return GitHubPublishCandidate(
        item_id=item.id, item_type=item.type.value, content=content, parent_item_id=parent_item_id
    )
