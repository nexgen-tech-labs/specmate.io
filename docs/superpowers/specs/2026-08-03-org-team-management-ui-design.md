# Organization and team management UI (Issue #99 / 12.12) — design

## Context

Issues 12.10/12.11 built the Organization → Workspace → Team → User hierarchy's data model and authorization resolution (`getWorkspaceMembershipForUser`, `getAccessibleProjectIds`, `requireOrganizationRole`/`requireWorkspaceRole`/`requireProjectRole`), deliberately deferring the management UI to this issue. This issue builds that UI plus the handful of backend endpoints it needs that don't exist yet.

## Current state (confirmed by reading the code)

- **Auth primitives already exist and need no changes**: `requireOrganizationRole(organizationId, ['OWNER'|'ADMIN'])`, `requireWorkspaceRole`, `requireProjectRole` — all in `apps/web/src/lib/workspace-context.ts`, all in production use.
- **No caching layer** in `getWorkspaceMembershipForUser`/`getAccessibleProjectIds` — every authorization check is a fresh Prisma read. This means AC 2 ("assigning a User to a Team+Project scope is reflected immediately") already holds true architecturally; a `PATCH` to a team's membership/scope takes effect on the very next request, no invalidation step needed.
- **Existing endpoints**: `GET/POST /api/organizations/{orgId}/workspaces` (list/create), `GET/POST /api/workspaces/{ws}/teams` (list/create, with same-name-archived-team resurrection), `PATCH/DELETE /api/workspaces/{ws}/teams/{teamId}` (member/scope update, archive).
- **Missing endpoints** (confirmed by absence): org member list, org member invite/add, org member removal (offboarding), workspace archive, org settings update. All genuinely new.
- **No offboarding code exists anywhere** — confirmed via grep. `OrganizationMember` has no soft-delete field (hard delete only); a correct offboarding transaction must also delete every `WorkspaceMember` and `TeamMember` row for that user across the org, or access is left orphaned (a direct `WorkspaceMember` row grants access independent of org membership).
- **No organization-facing page tree exists at all** — confirmed via `find`. This issue starts from nothing on the org UI side.
- **No shared settings nav/shell exists** — `/settings/account`, `/workspaces/{id}/billing`, `/workspaces/{id}/invite` are three separate, unlinked pages today, all following the same server-page + client-component split convention (see `billing/page.tsx` + `billing-settings.tsx`, or `settings/account/page.tsx` + `connected-accounts.tsx`).
- **Workspace** already has `deletedAt` (soft-delete), matching `Team`/`Organization`/`Project`'s existing pattern.

## Scope decisions (from clarifying questions)

1. **Settings shell**: build a minimal shared shell now (`/settings` layout, nav linking Organization/Workspace/Account) — this issue is the natural point to introduce it, since it's the first to need 4 co-located admin surfaces; prevents adding a 4th and 5th orphaned page to the pattern the research flagged.
2. **Offboarding**: hard, immediate, transactional removal — no soft-delete/undo window (none of the relevant join tables have a soft-delete pattern, and this repo has consistently avoided new background-job infrastructure). Safety comes from a deliberate UI confirmation step (type the user's name/email), not from reversibility. Existing `AuditEvent` model records what was removed.
3. **Workspace archive**: straightforward `deletedAt` soft-delete, no cascading changes to child Teams/Projects — matches the existing shallow-soft-delete pattern used elsewhere.
4. **Org member invites**: reuse the existing `WorkspaceInvite` token/expiry/accept shape as a new `OrganizationInvite` model, granting `OrgRole` on acceptance — one invite mechanism users already understand, not two divergent UXs.
5. **Org-wide policy defaults**: dropped. Not tied to any acceptance criterion, no concrete policy concept exists in the schema to surface — explicitly out of scope rather than guessing at an undefined feature.

## Design

### 1. Settings shell — `apps/web/src/app/settings/layout.tsx` (new)

A thin server-component layout wrapping a nav (Organization / Workspace / Account) rendered above `{children}`. `/settings/account` moves under this layout unchanged in content. New pages below live at their own routes (org pages are org-scoped, not under `/settings`, since they need an `orgId` in the path — the shell's nav computes links dynamically based on the signed-in user's orgs/workspaces). `billing/page.tsx` gains a small "back to settings" link; not restructured.

### 2. New schema — `OrganizationInvite`

Structurally parallel to `WorkspaceInvite`:

```prisma
model OrganizationInvite {
  id             String    @id @default(cuid())
  organizationId String
  email          String
  role           OrgRole
  token          String    @unique
  invitedByUserId String
  expiresAt      DateTime
  acceptedAt     DateTime?
  createdAt      DateTime  @default(now())

  organization Organization @relation(fields: [organizationId], references: [id])
  invitedBy    User         @relation(fields: [invitedByUserId], references: [id])
}
```

### 3. New API endpoints

- `GET /api/organizations/{orgId}/members` — `requireOrganizationRole(['OWNER','ADMIN'])`, returns `{ members: [{ userId, name, email, role }] }`.
- `POST /api/organizations/{orgId}/invites` — OWNER-only (inviting with OWNER role should itself require OWNER; ADMIN can invite ADMIN-role members only — mirrors the principle that you can't grant a role higher than your own), creates an `OrganizationInvite`, returns the invite URL (matching `WorkspaceInvite`'s existing response shape).
- `POST /api/organization-invites/{token}/accept` — matches the existing `/api/invites/{token}/accept` shape/conventions, creates the `OrganizationMember` row on acceptance.
- `DELETE /api/organizations/{orgId}/members/{userId}` — **OWNER-only** (not ADMIN — removing a person's entire access is a higher-privilege action than day-to-day workspace/team management, matching the OWNER/ADMIN split already documented in `workspace-context.ts`'s doc comment). One transaction: delete `OrganizationMember` row, delete every `WorkspaceMember` row for that user across every `Workspace` in the org, delete every `TeamMember` row for that user across every `Team` in every workspace of the org. Records an `AuditEvent`. Returns `{ ok: true }`.
- `DELETE /api/workspaces/{workspaceId}` — org-role-gated (`requireOrganizationRole(['OWNER','ADMIN'])`, resolved via the workspace's `organizationId`) or workspace-ADMIN — archive (soft-delete, `deletedAt`).
- `PATCH /api/organizations/{orgId}` — `requireOrganizationRole(['OWNER'])`, body `{ name?, size? }`.

### 4. Pages

- `/organizations/{orgId}/settings` — org name/size edit, workspace list (create + archive), member list (invite + role display + offboard button, OWNER-only for offboard).
- `/workspaces/{workspaceId}/settings` — new page (the existing dashboard at `/workspaces/{workspaceId}` stays focused on projects, unchanged): team list (create/archive), links to team detail.
- `/workspaces/{workspaceId}/teams/{teamId}` — team detail: member add/remove, project-scope assignment, using the existing `PATCH .../teams/{teamId}` endpoint's `addMemberIds`/`removeMemberIds`/`projectIds` in one call per save.

Each follows the established server-page (auth + fetch) + client-component (interactivity) split, reusing the existing Tailwind design tokens (`bg-paper`, `border-line`, `bg-panel`, `text-ink`/`text-sub`/`text-red`/`text-amber`).

### 5. Offboarding UI safety

The offboard action requires typing the target user's email to confirm (client-side gate before the `DELETE` call fires) — not a countdown/undo, a deliberate friction step matching the "hard removal, strong confirm" decision.

## Testing

- `DELETE /api/organizations/{orgId}/members/{userId}`: the load-bearing test — create a user with an `OrganizationMember` row, `WorkspaceMember` rows in 2+ workspaces of the org, and `TeamMember` rows in 2+ teams; call the endpoint; assert ALL of those rows are gone (zero orphaned rows), and that a same-org workspace/team the user was NOT part of is unaffected.
- Org member invite create/accept, mirroring `WorkspaceInvite`'s existing test conventions.
- Workspace archive: soft-delete only, child Teams/Projects untouched, archived workspace no longer appears in the org's workspace list.
- Org settings update: OWNER can, ADMIN cannot (403).
- Page-level tests for each new page/component, following this session's established conventions (real Postgres fixtures, server-page auth-gate tests, client-component interaction tests).

## Out of scope

- Org-wide policy defaults (no concrete concept defined, not tied to any AC).
- Soft-delete/undo window for offboarding.
- Cascading archive of a workspace's child Projects/Teams data.
- Any change to billing scope (stays workspace-scoped, per the existing 12.10 decision recorded on Issue #97).
- Connector configuration re-scoping under Workspace — the issue's scope mentions this but it's already correctly scoped under Workspace today (connector settings components live under workspace-scoped routes); no actual re-scoping work identified as needed.
