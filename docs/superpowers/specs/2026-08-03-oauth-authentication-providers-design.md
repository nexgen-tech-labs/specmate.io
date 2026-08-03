# OAuth authentication providers (Issue #95 / 12.8) — design

## Context

Issue #95 amends and extends Issue 1.2 (auth core) to add GitHub, Google, and Microsoft OAuth login alongside the existing email/password flow, with correct account-linking so the same person doesn't end up with duplicate accounts across sign-in methods.

## Current state (confirmed by reading the code)

- `apps/web/src/lib/auth.ts`: Auth.js v5 (beta, `next-auth@5.0.0-beta.31`), single `Credentials` provider, JWT session strategy, no adapter. `authorize()` looks up `prisma.user` by email and verifies `passwordHash` directly.
- `User` model: `passwordHash: String` is **required**. No `emailVerified` field. **No `Account`/`Session`/`VerificationToken` tables exist** — this app never installed the standard Auth.js Prisma adapter schema.
- `/api/signup`: hand-written flow, not going through NextAuth at all — validates, checks for existing email (409 if found), hashes password, and in one `$transaction` creates `User` + `Organization` + `Workspace` + `OrganizationMember(OWNER)` + `WorkspaceMember(ADMIN)` + optional `WorkspaceInvite` rows. No email verification exists anywhere in this app today.
- No `middleware.ts` exists; every protected route/page calls `auth()` directly via `requireWorkspaceRole`/`requireProjectRole` (`apps/web/src/lib/workspace-context.ts`). Confirmed: session shape (`session.user.id`) is provider-agnostic already, so adding OAuth providers requires zero changes to this layer, as long as the `jwt` callback keeps setting `token.sub` to the correct internal `User.id`.
- Connector "OAuth" (Jira/ADO/GitHub, Epics 5-7) is confirmed unrelated — single-tenant env-configured credentials for third-party API access, not per-user delegated login. No encryption-at-rest pattern for stored secrets exists anywhere in this repo (connector credentials are env/Key-Vault-configured, never stored per-row in Postgres).
- No OAuth-related env vars exist in `.env.example` today.

## Scope decisions (from clarifying questions)

1. **Auto-link policy**: auto-link an OAuth identity to an existing email/password account ONLY when the OAuth provider's profile asserts the email is verified (GitHub's `verified` field on the primary email, Google's `email_verified` claim, Microsoft Entra ID's implicitly-verified org email). Otherwise, block the sign-in and prompt: "an account with this email already exists — sign in with your password, then link from account settings." This is the standard safe pattern — it means the OAuth provider has already proven the person controls that email address before any merge happens.
2. **Settings UI**: build a minimal link/unlink section (not deferred to auto-linking alone) — the AC's "vice versa" (a password user deliberately adding an OAuth identity) needs an explicit settings-driven flow, not just an implicit one triggered by a future login attempt.
3. **`passwordHash` nullability**: make it nullable. An OAuth-only user genuinely has no password; a sentinel/fake value would be a worse anti-pattern.
4. **New-user OAuth signup**: reuses the same Organization+Workspace+OWNER/ADMIN creation transaction as `/api/signup`, refactored into a shared helper — one tenant-creation path, not two divergent ones. Org name defaults from the OAuth profile name rather than blocking on a form, keeping OAuth login a single redirect round-trip.
5. **Token persistence**: discard OAuth access/refresh tokens after establishing identity — this issue is login-only, never delegated API access. Store only `provider` + `providerAccountId` + `userId` (the minimum needed for identity linking). See the filed follow-up (#111) for why this deliberately doesn't build toward future delegated-access use cases.

## Design

### 1. Schema changes

New `Account` model (`apps/web/prisma/schema.prisma` + SQLAlchemy mirror is NOT needed — this table is Auth.js/`apps/web`-only, `apps/api` has no reason to touch user identity/auth):

```prisma
model Account {
  id                String   @id @default(cuid())
  userId            String
  provider          String   // "github" | "google" | "microsoft-entra-id"
  providerAccountId String
  createdAt         DateTime @default(now())

  user User @relation(fields: [userId], references: [id])

  @@unique([provider, providerAccountId])
}
```

`User` model changes:

- `passwordHash String` → `passwordHash String?` (nullable).
- Add `emailVerified DateTime?` (set when an OAuth provider first establishes/confirms the email — used for internal bookkeeping/future use, not itself the auto-link gate; the gate is the _provider's_ per-sign-in assertion, not a stored flag, since a stored flag could go stale if the email address is later reused/reassigned).
- Add reverse relation `accounts Account[]`.

Existing `Credentials` `authorize()` must be updated to handle `user.passwordHash === null` (return `null` — no valid password to check) — this is the one behavior change to existing code from the nullability switch.

### 2. Providers — `apps/web/src/lib/auth.ts`

Add `GitHub`, `Google`, `MicrosoftEntraID` from `next-auth/providers/*`, each with an explicit minimal `authorization.params.scope` (never the provider's default scope, which can be broader than login needs):

- GitHub: `read:user user:email`
- Google: `openid email profile`
- Microsoft Entra ID: `openid email profile`

Env vars (new, `.env.example`): `GITHUB_OAUTH_CLIENT_ID`/`GITHUB_OAUTH_CLIENT_SECRET`, `GOOGLE_CLIENT_ID`/`GOOGLE_CLIENT_SECRET`, `MICROSOFT_ENTRA_ID_CLIENT_ID`/`MICROSOFT_ENTRA_ID_CLIENT_SECRET` (+ `MICROSOFT_ENTRA_ID_TENANT_ID` if Auth.js's provider requires it — confirm during implementation). Named distinctly from any existing `GITHUB_TOKEN`/`ADO`-connector env vars to avoid the naming collision flagged in the follow-up issue.

### 3. `signIn` callback — the core account-linking logic

```
On Credentials sign-in: unchanged.

On OAuth sign-in (account, profile):
  existing = Account.findUnique({ provider, providerAccountId: account.providerAccountId })
  if existing: proceed as existing.userId

  matchingUser = User.findUnique({ email: profile.email })
  if not matchingUser:
    # New signup — reuse the shared org/workspace creation helper
    create User (passwordHash: null, emailVerified: now if provider asserts verified else null)
    create Account (provider, providerAccountId, userId)
    create Organization + Workspace + OWNER/ADMIN memberships (shared helper, extracted from /api/signup)
    proceed as new user

  if matchingUser and provider asserts email verified:
    create Account (provider, providerAccountId, userId: matchingUser.id)  # auto-link
    proceed as matchingUser

  else:  # matchingUser exists, email not verified-asserted by provider
    reject sign-in, redirect to /login?error=AccountExists
```

`jwt` callback: unchanged in shape — still sets `token.sub` from the resolved `user.id`, now fed by either path above.

### 4. Settings — link/unlink section

A new "Connected accounts" section on the account/profile settings surface (exact page location confirmed during plan research — may be new if no such page exists yet, per the follow-up issue's point 4).

- "Link Google/GitHub/Microsoft" buttons initiate the OAuth flow with an explicit linking intent (e.g. a `callbackUrl` carrying a `link=true` marker, or a dedicated linking sub-route) so the `signIn` callback's handling, when invoked for an already-authenticated session, adds the `Account` row to the CURRENT session's user rather than running the "new user or match by email" branch.
- "Unlink" removes an `Account` row, but is blocked (with a clear error) if it's the user's only sign-in method — i.e., `passwordHash === null` AND this is their only linked `Account` — to guarantee a user can never be locked out of their own account.
- Lists currently-connected providers with a simple, unstyled-is-fine-for-now list + buttons — no design system work beyond matching existing settings page conventions.

### 5. Shared org/workspace-creation helper

Extract `/api/signup`'s `$transaction` body (Organization + Workspace + OWNER/ADMIN memberships) into a reusable function, called by both the existing `/api/signup` route and the new OAuth-signup path in the `signIn` callback. Team-invite creation (the `teamEmails` part of `/api/signup`) stays specific to the email/password form — OAuth signup doesn't collect team emails at sign-in time, matching the "keep OAuth a single redirect round-trip" decision.

## Testing

- Real-DB integration tests (matching `signup/route.test.ts`'s conventions: `@vitest-environment node`, dynamic import, tracked-ID cleanup):
  - New OAuth user (no matching email) creates `User` + `Account` + `Organization` + `Workspace` + correct roles.
  - Existing email/password user signs in via OAuth with a provider-verified email → auto-linked, no duplicate `User` row, `Account` row created pointing at the existing user.
  - Existing email/password user signs in via OAuth with an unverified-asserted email → rejected, no `Account`/`User` mutation, correct error surfaced.
  - `Account`'s `@@unique(provider, providerAccountId)` prevents the same provider identity from ever being linked to two different users.
  - Unlink is blocked when it's the user's last sign-in method (no password + last `Account`); succeeds otherwise.
  - Explicit-link flow (from settings, while already signed in) adds an `Account` to the current user, not a new user.
  - Each provider config asserts the minimal scope string (no accidental over-scoping).
  - `Credentials.authorize()` correctly returns `null` (not a crash) for a `passwordHash === null` user attempting password login.

## Out of scope

- Delegated API access via OAuth tokens (no token storage/refresh) — see follow-up #111.
- Any change to the connector-OAuth flows in Epics 5-7 — confirmed architecturally unrelated.
- A full account-settings page redesign — only the minimal "connected accounts" section.
- Changing the session strategy from JWT to database sessions.
- Email verification flow for email/password signups (out of scope for this issue; `emailVerified` is only populated by the OAuth path).
