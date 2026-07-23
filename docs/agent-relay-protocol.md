# On-Prem Agent Relay Protocol (Issue 11.2)

Design-only spec — no code in this issue. Defines the message contract between SpecMate cloud (`apps/api`) and a future on-prem Go agent, so Epic 11's eventual implementation starts from a settled contract instead of being designed from scratch under time pressure.

## Why this exists

Some customers run Jira/ADO/GitHub Server (on-prem, not cloud) behind a firewall SpecMate's cloud API can never reach directly. The on-prem agent is a small process the customer runs inside their network that SpecMate's cloud can talk to (or that talks outward to SpecMate's cloud — see transport tradeoffs below), which then makes the actual Jira/ADO/GitHub Server call on SpecMate's behalf and reports the result back.

The connector abstraction built in [Issue 11.1](../architecture.md#connector-abstraction-layer-issue-111-appsapiappservicesconnectorstypespy--transportpy) already isolates every publish connector's HTTP dispatch behind a single `ConnectorTransport.request(...)` call. This spec defines what `AgentRelayTransport.request(...)` actually sends over the wire once it's real — the stub built in 11.1 raises `NotImplementedError` today and this document is what replaces that stub's body.

## Non-goals

- No code changes. This is a written contract only.
- No commitment to a specific transport mechanism yet (see tradeoffs below) — a follow-up issue picks one when Epic 11 is actually prioritized.
- No multi-agent-per-workspace design. One agent per on-prem tool connection is assumed; fan-out is future work if it comes up.

## 1. Auth handshake

Two distinct trust boundaries exist and must not be conflated:

**a) Agent → SpecMate cloud.** The agent must prove it's a legitimate, registered relay for a specific workspace's specific publish target (e.g., "the ADO Server relay for Workspace X"), not just any caller with a valid API key.

- Provisioning: an admin generates a single **agent registration token** from the SpecMate web UI (workspace settings → on-prem agents), scoped to one `PublishMapping` (one tool + one remote project). This is a one-time bootstrap secret, shown once, like a GitHub PAT.
- On first start, the agent exchanges the registration token for a long-lived **agent credential** (an asymmetric keypair generated locally by the agent — the private key never leaves the customer's network). SpecMate cloud stores the public key against an `Agent` row (new model: `id`, `workspaceId`, `publishMappingId`, `publicKey`, `lastSeenAt`, `revokedAt`).
- Every subsequent request from the agent to SpecMate cloud is signed (request body + timestamp + nonce, HMAC-style using the agent's private key) and verified cloud-side against the stored public key. This avoids shipping a long-lived shared secret that both sides must protect equally — only the customer's on-prem agent ever holds the private key.
- Revocation: admin can revoke an `Agent` row from the UI at any time; cloud rejects all further signed requests from that key immediately. No token rotation needed on the agent side for revocation — it's cloud-side and instant.

**b) Agent → local Jira/ADO/GitHub Server.** Entirely the customer's existing responsibility, unchanged by this design. The agent is configured locally (config file or env vars, never sent to SpecMate cloud) with whatever credential the on-prem tool requires — PAT, basic auth, OAuth app — using the exact same `JiraConnection`/`AdoConnection`/`GitHubConnection` auth abstractions (Issues 5.8/6.8/7.8) the cloud connectors already use. SpecMate cloud never sees these credentials; they're symmetric with how a self-hosted Jira admin already manages any other integration's access.

## 2. Item push format (cloud → agent: "please publish this")

A publish request for one `DraftItem` is logically identical to what `ConnectorTransport.request()` already carries — the agent relay just needs it serialized as a message instead of an in-process call.

```json
{
  "relay_request_id": "uuid",
  "agent_id": "agent-row-id",
  "issued_at": "2026-07-19T18:03:00Z",
  "http": {
    "method": "POST",
    "url": "https://jira.internal.customer.com/rest/api/2/issue",
    "headers": { "Content-Type": "application/json" },
    "auth_hint": null,
    "body": { "fields": { "...": "..." } },
    "timeout_seconds": 30
  }
}
```

- `relay_request_id`: generated cloud-side, idempotency key — the agent must treat a retried delivery of the same `relay_request_id` as a no-op if it already executed it (see error propagation below for why retries happen).
- `http.auth_hint` is deliberately `null` / absent: cloud never sends the on-prem credential. The agent injects its own locally-configured auth before dispatching, exactly as `DirectCloudTransport` injects `connection.auth()` today. This is the key security property — the relay carries _what to send_, never _how to authenticate to the target_.
- `http.*` otherwise mirrors `ConnectorTransport.request()`'s existing parameters 1:1 (`method`, `url`, `headers`, `json` body, `timeout`) so the cloud-side `AgentRelayTransport` implementation stays a thin serialize/deserialize shim around the same interface every other transport already implements — no new abstraction needed above the transport layer.

## 3. Status callback format (agent → cloud: "here's what happened")

```json
{
  "relay_request_id": "uuid",
  "completed_at": "2026-07-19T18:03:02Z",
  "outcome": "ok",
  "http_status": 201,
  "response_body": { "key": "PROJ-123", "...": "..." },
  "error": null
}
```

- Correlates back to the original `relay_request_id` — cloud-side, this resolves the `await transport.request(...)` call that's been waiting (mechanism depends on the transport choice below).
- On success (`outcome: "ok"`), `response_body` carries enough of the raw remote response for the calling `*_publish.py` function's existing parsing logic (`body["key"]`, `body["html_url"]`, etc.) to work completely unchanged — this is why the callback echoes `http_status` and `response_body` rather than a pre-parsed SpecMate-shaped result: the parsing stays in the connector, not the relay.
- On failure (`outcome: "agent_error"`), `error` carries a short machine string (`"network_unreachable"`, `"local_auth_rejected"`, `"timeout"`) plus a human-readable detail — distinct from a successful HTTP response that happens to carry a 4xx/5xx status (that's still `outcome: "ok"` with `http_status: 500`, since the _relay_ succeeded even though the _remote call_ didn't; the existing retry/backoff logic in `jira_publish.py` etc. already knows how to handle a 5xx `http_status`, so this distinction preserves that).

## 4. Error propagation (agent failure → SpecMate review/publish UI)

Three failure classes, surfaced differently:

1. **Remote tool rejected the request** (4xx/5xx from Jira/ADO/GitHub Server itself) — carried back via the normal `outcome: "ok"` / `http_status` path above. No new UI needed: this flows through the exact same `PublishOutcome.error` surfacing that already exists for cloud connectors today (Issue 5.7's retry/backoff and permanent-4xx handling in `*_publish.py` is untouched by the relay).
2. **Agent-side failure** (agent can't reach the local tool, or is stopped/crashed) — `outcome: "agent_error"`. Cloud-side, this maps to a `PublishOutcome(ok=False, error=...)` exactly like today's `httpx.HTTPError` branch, so the existing "Gave up after N attempts" retry-exhaustion path and per-item failure UI in the review/publish screens need no changes.
3. **Agent unreachable / never responds** (network partition, agent process down, message never delivered) — cloud-side timeout on the correlation wait (see transport tradeoffs — the exact timeout mechanism depends on which option is picked). Surfaces as a distinct `PublishOutcome.error` string ("On-prem agent did not respond within N seconds — check the agent is running") so a reviewer isn't left staring at a generic network error when the real problem is "the agent process is down," which is the single most likely on-prem failure mode and deserves a specific, actionable message.

Additionally: the SpecMate UI needs a simple **agent health indicator** (last-seen heartbeat, surfaced from `Agent.lastSeenAt`) on the workspace settings page, so an admin can tell "agent is down" apart from "publish is slow" before even attempting a publish — this is a small new UI surface, not part of this issue's scope, but flagged here since 11.3 (security model) or the eventual build issue should account for a heartbeat message type in the protocol.

## 5. Message transport options (tradeoffs, no commitment)

| Option                                                                                    | How it'd work                                                                                                                                                                                                                                     | Pros                                                                                                                                                                                                                                          | Cons                                                                                                                                                                                                                                                                                                                                                            |
| ----------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Long-polling**                                                                          | Agent repeatedly opens `GET /agents/{id}/next-request` with a long timeout (e.g., 25s); cloud holds the connection open until a request is queued or the timeout elapses, then the agent immediately re-polls. Status callback is a plain `POST`. | Works through any outbound-only firewall (agent never needs an inbound port) — the common case for on-prem deployments. No new infra (plain HTTP, same as everything else in this API). Simple to reason about and debug (it's just polling). | Slightly higher latency than push (up to one poll-interval's worth of delay in the worst case, though long-polling keeps this small). Many idle-but-open connections if a customer runs several agents — needs the API to handle long-held connections gracefully (already true of this FastAPI/async stack).                                                   |
| **WebSocket**                                                                             | Agent opens one persistent WS connection to cloud; cloud pushes item-push messages down it, agent pushes status callbacks up it.                                                                                                                  | Lowest latency, single persistent connection instead of a poll loop, natural fit for a "cloud pushes work to agent" model.                                                                                                                    | New infra surface (WS support behind Azure Container Apps / any load balancer needs sticky sessions or a pub/sub fanout if there's more than one API replica) — meaningfully more operational complexity than the rest of this stack, which is entirely stateless request/response today. Reconnection/backoff logic needs to be built and tested on both ends. |
| **Queue-based** (e.g., agent polls an Azure Storage Queue or Service Bus queue per-agent) | Cloud enqueues item-push messages; agent dequeues, processes, enqueues status callback to a response queue cloud polls/subscribes to.                                                                                                             | Durable by construction — a message isn't lost if the agent is briefly down, it's just picked up on next poll. Decouples cloud and agent uptime more cleanly than either HTTP option.                                                         | Introduces a message broker into a repo that has explicitly avoided one so far (`CLAUDE.md`: "Async jobs... tracked as rows in a Postgres job table... no message broker") — this would be a first, and a real infra/cost decision, not just a code choice. Highest implementation cost of the three.                                                           |

**Leaning, not a decision**: long-polling is the best fit _for this repo specifically_ — it needs no new infrastructure, works through the outbound-only firewalls on-prem customers actually have, and matches the existing "Postgres job table, no broker" philosophy (the poll endpoint can be backed by the same job-table pattern already used for parsing/AI-generation/sync jobs). This is a recommendation for whoever picks this up next, not a commitment — Epic 11's build issue should confirm before implementing.

## 6. Data model sketch (for the eventual build issue, not built here)

```
Agent
  id              string (pk)
  workspaceId     string (fk -> Workspace)
  publishMappingId string (fk -> PublishMapping)
  publicKey       string
  lastSeenAt      datetime | null
  revokedAt       datetime | null
  createdAt       datetime

AgentRelayRequest   (if long-polling / queue: a durable outbox, mirrors the existing job-table pattern)
  id                 string (pk)  -- == relay_request_id
  agentId            string (fk -> Agent)
  httpMethod         string
  httpUrl            string
  httpHeaders        json
  httpBody           json
  status             enum(queued, delivered, completed, failed, timed_out)
  responseHttpStatus int | null
  responseBody       json | null
  error              string | null
  createdAt          datetime
  completedAt        datetime | null
```

## Acceptance

- [x] Design document covers auth handshake, item push, status callback, and error propagation.
- [x] Sufficient to start implementation without major open questions: transport mechanism has a recommendation (long-polling) with tradeoffs documented for the alternatives; data model sketch included; explicitly identifies the one new UI surface (agent health indicator) an eventual build issue needs to account for.
- [x] No functional code — this issue is closed by documentation alone.
