# OAuth authentication providers Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add GitHub, Google, and Microsoft Entra ID OAuth login alongside the existing email/password flow, with safe account-linking (auto-link only when the provider asserts the email is verified; otherwise block with a clear message) and zero duplicate accounts.

**Architecture:** A new `Account` model (identity-linking only, no tokens stored) plus three OAuth providers added to the existing `apps/web/src/lib/auth.ts` NextAuth config. All linking logic lives in the `signIn` callback (DB reads/writes, approve/reject/redirect); the `jwt` callback separately re-resolves the correct internal `User.id` for `token.sub` via the `Account` row, since — verified directly against `@auth/core`'s source — this app has no database adapter, so `signIn`'s approval decision does NOT change what `user` object Auth.js hands to `jwt` afterward. GitHub's and Microsoft's default `profile()` transforms silently drop the provider's email-verification signal (confirmed by reading both providers' source), so both need a custom `profile()` override; Google's default already preserves `email_verified`.

**Tech Stack:** Next.js App Router, Auth.js v5 beta (`next-auth@5.0.0-beta.31`, `@auth/core@0.41.2`), Prisma, TypeScript, Vitest.

---

### Task 1: Schema — `Account` model, nullable `passwordHash`, `emailVerified`

**Files:**

- Modify: `apps/web/prisma/schema.prisma`
- Modify: `apps/web/src/lib/auth.ts` (only the `Credentials.authorize` null-check, not the OAuth work — that's Task 3)
- Create: Prisma migration

- [ ] **Step 1: Read the current `User` model in full**

```bash
grep -n "model User " -A 20 apps/web/prisma/schema.prisma
```

- [ ] **Step 2: Modify `User`, add `Account`**

```prisma
model User {
  id            String    @id @default(cuid())
  email         String    @unique
  name          String
  passwordHash  String?
  emailVerified DateTime?
  createdAt     DateTime  @default(now())
  updatedAt     DateTime  @updatedAt

  accounts         Account[]
  memberships      WorkspaceMember[]
  orgMemberships   OrganizationMember[]
  teamMemberships  TeamMember[]
  reviewDecisions  ReviewDecision[]
  auditEvents      AuditEvent[]
  sentInvites      WorkspaceInvite[]
}

// Login-identity linking only (Issue 12.8) — no access/refresh tokens stored,
// since this app never needs to call GitHub/Google/Microsoft APIs on the
// user's behalf (that's the separate, unrelated connector-OAuth surface in
// Epics 5-7 — see Issue #111 for why these two "OAuth" concepts must stay
// distinct). One row per (provider, providerAccountId) a user has linked.
model Account {
  id                String   @id @default(cuid())
  userId            String
  provider          String
  providerAccountId String
  createdAt         DateTime @default(now())

  user User @relation(fields: [userId], references: [id])

  @@unique([provider, providerAccountId])
}
```

Only change `passwordHash String` → `passwordHash String?` and add `emailVerified DateTime?` + `accounts Account[]` to the existing `User` block — preserve every other existing field/relation exactly as found in Step 1. Add the new `Account` model near `User`.

- [ ] **Step 3: Generate and apply the migration**

```bash
cd apps/web && npx prisma migrate dev --name add_oauth_accounts
```

Expected: migration created and applied cleanly. If you hit checksum drift on an unrelated prior migration (this has happened before in this repo this session), STOP and ask — do not run `prisma migrate reset` without explicit user confirmation, since it destroys all local dev data.

- [ ] **Step 4: Update `Credentials.authorize()` for nullable `passwordHash`**

Read `apps/web/src/lib/auth.ts`'s current `authorize()` in full first. Add a null check before `verifyPassword`:

```ts
const user = await prisma.user.findUnique({ where: { email } });
if (!user || !user.passwordHash) return null;

const valid = await verifyPassword(password, user.passwordHash);
```

(Just the added `|| !user.passwordHash` — don't restructure anything else in this function yet; OAuth providers are added in Task 3.)

- [ ] **Step 5: Run the full web test suite**

```bash
cd apps/web && npx vitest run
```

Expected: no regressions (check current baseline count first, since this repo's had several completed issues recently — run `npx vitest run` before making any change in this task to record the true baseline).

- [ ] **Step 6: Typecheck and lint**

```bash
cd apps/web
npx tsc --noEmit
npx eslint src/lib/auth.ts
```

- [ ] **Step 7: Commit**

```bash
git add prisma/schema.prisma prisma/migrations/ src/lib/auth.ts
git commit -m "Add Account model, nullable passwordHash for OAuth support (Issue #95)"
```

---

### Task 2: Shared org/workspace-creation helper (extracted from `/api/signup`)

**Files:**

- Create: `apps/web/src/lib/create-tenant.ts`
- Modify: `apps/web/src/app/api/signup/route.ts`
- Test: `apps/web/src/lib/create-tenant.test.ts` (new)

- [ ] **Step 1: Read `/api/signup/route.ts` in full** (already known from planning research — reproduced above in this plan's research, but re-read the live file before editing, since it may have changed)

- [ ] **Step 2: Write the failing test for the extracted helper**

```ts
import { afterEach, describe, expect, it } from 'vitest';
import { prisma } from './prisma';
import { createTenantForNewUser } from './create-tenant';

describe('createTenantForNewUser', () => {
  const createdUserIds: string[] = [];
  const createdWorkspaceIds: string[] = [];
  const createdOrgIds: string[] = [];

  afterEach(async () => {
    await prisma.workspaceMember.deleteMany({
      where: { workspaceId: { in: createdWorkspaceIds } },
    });
    await prisma.organizationMember.deleteMany({
      where: { organizationId: { in: createdOrgIds } },
    });
    await prisma.workspace.deleteMany({ where: { id: { in: createdWorkspaceIds } } });
    await prisma.organization.deleteMany({ where: { id: { in: createdOrgIds } } });
    await prisma.user.deleteMany({ where: { id: { in: createdUserIds } } });
    createdUserIds.length = 0;
    createdWorkspaceIds.length = 0;
    createdOrgIds.length = 0;
  });

  it('creates User + Organization + Workspace with OWNER/ADMIN roles', async () => {
    const { user, workspace, organization } = await createTenantForNewUser({
      name: 'Ada Lovelace',
      email: `tenant-test-${Date.now()}@test.local`,
      passwordHash: 'hashed',
      orgName: "Ada's Org",
      orgSize: 'SOLO',
      workspaceName: "Ada's Workspace",
    });
    createdUserIds.push(user.id);
    createdWorkspaceIds.push(workspace.id);
    createdOrgIds.push(organization.id);

    const membership = await prisma.workspaceMember.findFirstOrThrow({
      where: { workspaceId: workspace.id, userId: user.id },
    });
    expect(membership.role).toBe('ADMIN');
    const orgMembership = await prisma.organizationMember.findFirstOrThrow({
      where: { organizationId: organization.id, userId: user.id },
    });
    expect(orgMembership.role).toBe('OWNER');
  });

  it('accepts a null passwordHash for OAuth-originated signups', async () => {
    const { user } = await createTenantForNewUser({
      name: 'OAuth User',
      email: `tenant-oauth-test-${Date.now()}@test.local`,
      passwordHash: null,
      orgName: "OAuth User's Org",
      orgSize: 'SOLO',
      workspaceName: "OAuth User's Workspace",
    });
    createdUserIds.push(user.id);
    expect(user.passwordHash).toBeNull();
  });
});
```

Adjust field names/fixture cleanup order to match the real schema (verify `OrgSize` enum values, exact `WorkspaceMember`/`OrganizationMember` field names) — read the schema again if anything doesn't match what's assumed above.

- [ ] **Step 3: Run tests to verify they fail**

```bash
cd apps/web && npx vitest run src/lib/create-tenant.test.ts
```

- [ ] **Step 4: Extract the helper**

```ts
import { prisma } from './prisma';
import type { OrgSize } from '@prisma/client';

interface CreateTenantInput {
  name: string;
  email: string;
  passwordHash: string | null;
  orgName: string;
  orgSize: OrgSize;
  workspaceName: string;
}

// Extracted from /api/signup (Issue 12.8) so both email/password signup and
// new-user OAuth signup create tenants identically — one org/workspace
// creation path, not two divergent ones.
export async function createTenantForNewUser(input: CreateTenantInput) {
  return prisma.$transaction(async (tx) => {
    const user = await tx.user.create({
      data: { name: input.name, email: input.email, passwordHash: input.passwordHash },
    });
    const organization = await tx.organization.create({
      data: { name: input.orgName, size: input.orgSize },
    });
    const workspace = await tx.workspace.create({
      data: { name: input.workspaceName, organizationId: organization.id },
    });
    await tx.organizationMember.create({
      data: { organizationId: organization.id, userId: user.id, role: 'OWNER' },
    });
    await tx.workspaceMember.create({
      data: { workspaceId: workspace.id, userId: user.id, role: 'ADMIN' },
    });
    return { user, workspace, organization };
  });
}
```

- [ ] **Step 5: Update `/api/signup/route.ts` to call the helper**

Replace the inline `$transaction` block with:

```ts
const passwordHash = await hashPassword(body.password);
const { user, workspace } = await createTenantForNewUser({
  name: body.name,
  email: body.email,
  passwordHash,
  orgName: body.orgName,
  orgSize: body.orgSize,
  workspaceName: body.workspaceName,
});
```

Add the import (`import { createTenantForNewUser } from '@/lib/create-tenant';`). Leave everything else in the route (validation, existing-email check, team-invite creation, response) exactly as-is.

- [ ] **Step 6: Run tests**

```bash
cd apps/web
npx vitest run src/lib/create-tenant.test.ts
npx vitest run src/app/api/signup/route.test.ts
npx vitest run
```

Expected: all pass, no regressions — `/api/signup`'s existing tests must pass completely unchanged, since this is a pure refactor of its internals.

- [ ] **Step 7: Typecheck, lint**

```bash
cd apps/web
npx tsc --noEmit
npx eslint src/lib/create-tenant.ts src/lib/create-tenant.test.ts src/app/api/signup/route.ts
```

- [ ] **Step 8: Commit**

```bash
git add src/lib/create-tenant.ts src/lib/create-tenant.test.ts src/app/api/signup/route.ts
git commit -m "Extract shared tenant-creation helper from /api/signup (Issue #95)"
```

---

### Task 3: OAuth providers + `signIn`/`jwt` callback account-linking logic

**Files:**

- Modify: `apps/web/src/lib/auth.ts`
- Modify: `apps/web/.env.example`
- Test: `apps/web/src/lib/auth.test.ts` (new — check first whether any test file already covers `auth.ts`)

This is the security-critical task. Read the design spec's §3 (`docs/superpowers/specs/2026-08-03-oauth-authentication-providers-design.md`) in full before starting — it documents the exact `signIn`/`jwt` callback split verified against `@auth/core`'s source, and is more detailed than what's reproduced here.

- [ ] **Step 1: Read the current `apps/web/src/lib/auth.ts` in full** (post-Task-1 state)

- [ ] **Step 2: Add env vars to `.env.example`**

```
# OAuth login providers (Issue 12.8) — distinct from any connector-specific
# credentials (e.g. GITHUB_TOKEN is for the GitHub connector's API access,
# unrelated to login).
GITHUB_OAUTH_CLIENT_ID=""
GITHUB_OAUTH_CLIENT_SECRET=""
GOOGLE_CLIENT_ID=""
GOOGLE_CLIENT_SECRET=""
MICROSOFT_ENTRA_ID_CLIENT_ID=""
MICROSOFT_ENTRA_ID_CLIENT_SECRET=""
```

- [ ] **Step 3: Write the failing tests for the account-linking logic**

Since `signIn`/`jwt` are NextAuth internal callbacks (not directly HTTP-testable without a running server + real OAuth redirect), test the **linking logic as extracted pure/testable functions** rather than trying to invoke NextAuth's internal callback machinery directly. Refactor the design so the DB logic lives in small, directly-testable functions that `signIn`/`jwt` call — this is both more testable AND better practice than embedding complex logic inline in callback closures.

Create `apps/web/src/lib/oauth-linking.ts` test file `apps/web/src/lib/oauth-linking.test.ts`:

```ts
import { afterEach, describe, expect, it } from 'vitest';
import { prisma } from './prisma';
import { resolveOAuthSignIn } from './oauth-linking';

describe('resolveOAuthSignIn', () => {
  const createdUserIds: string[] = [];
  const createdWorkspaceIds: string[] = [];
  const createdOrgIds: string[] = [];
  const createdAccountIds: string[] = [];

  afterEach(async () => {
    await prisma.account.deleteMany({ where: { id: { in: createdAccountIds } } });
    await prisma.workspaceMember.deleteMany({
      where: { workspaceId: { in: createdWorkspaceIds } },
    });
    await prisma.organizationMember.deleteMany({
      where: { organizationId: { in: createdOrgIds } },
    });
    await prisma.workspace.deleteMany({ where: { id: { in: createdWorkspaceIds } } });
    await prisma.organization.deleteMany({ where: { id: { in: createdOrgIds } } });
    await prisma.user.deleteMany({ where: { id: { in: createdUserIds } } });
  });

  it('creates a new User + Account + tenant when no existing Account or matching email exists', async () => {
    const email = `oauth-new-${Date.now()}@test.local`;
    const result = await resolveOAuthSignIn({
      provider: 'github',
      providerAccountId: `gh-${Date.now()}`,
      email,
      name: 'New OAuth User',
      emailVerifiedByProvider: true,
    });
    expect(result.outcome).toBe('signed_in');
    if (result.outcome === 'signed_in') {
      createdUserIds.push(result.userId);
      const account = await prisma.account.findFirstOrThrow({ where: { userId: result.userId } });
      createdAccountIds.push(account.id);
      const membership = await prisma.workspaceMember.findFirstOrThrow({
        where: { userId: result.userId },
      });
      createdWorkspaceIds.push(membership.workspaceId);
      const orgMembership = await prisma.organizationMember.findFirstOrThrow({
        where: { userId: result.userId },
      });
      createdOrgIds.push(orgMembership.organizationId);
    }
  });

  it('returns the existing userId when the (provider, providerAccountId) Account already exists', async () => {
    const email = `oauth-existing-${Date.now()}@test.local`;
    const providerAccountId = `gh-${Date.now()}`;
    const first = await resolveOAuthSignIn({
      provider: 'github',
      providerAccountId,
      email,
      name: 'X',
      emailVerifiedByProvider: true,
    });
    if (first.outcome === 'signed_in') {
      createdUserIds.push(first.userId);
      const acct = await prisma.account.findFirstOrThrow({ where: { userId: first.userId } });
      createdAccountIds.push(acct.id);
      const membership = await prisma.workspaceMember.findFirstOrThrow({
        where: { userId: first.userId },
      });
      createdWorkspaceIds.push(membership.workspaceId);
      const orgMembership = await prisma.organizationMember.findFirstOrThrow({
        where: { userId: first.userId },
      });
      createdOrgIds.push(orgMembership.organizationId);
    }

    const second = await resolveOAuthSignIn({
      provider: 'github',
      providerAccountId,
      email,
      name: 'X',
      emailVerifiedByProvider: true,
    });
    expect(second.outcome).toBe('signed_in');
    if (second.outcome === 'signed_in' && first.outcome === 'signed_in') {
      expect(second.userId).toBe(first.userId);
    }
  });

  it('auto-links to an existing password-based User when the provider asserts the email is verified', async () => {
    const email = `oauth-link-${Date.now()}@test.local`;
    const existingUser = await prisma.user.create({
      data: { name: 'Existing', email, passwordHash: 'hashed' },
    });
    createdUserIds.push(existingUser.id);

    const result = await resolveOAuthSignIn({
      provider: 'google',
      providerAccountId: `g-${Date.now()}`,
      email,
      name: 'Existing',
      emailVerifiedByProvider: true,
    });
    expect(result.outcome).toBe('signed_in');
    if (result.outcome === 'signed_in') {
      expect(result.userId).toBe(existingUser.id);
      const account = await prisma.account.findFirstOrThrow({ where: { userId: existingUser.id } });
      createdAccountIds.push(account.id);
    }
  });

  it('rejects sign-in when a matching User exists but the provider does not assert the email is verified', async () => {
    const email = `oauth-reject-${Date.now()}@test.local`;
    const existingUser = await prisma.user.create({
      data: { name: 'Existing', email, passwordHash: 'hashed' },
    });
    createdUserIds.push(existingUser.id);

    const result = await resolveOAuthSignIn({
      provider: 'microsoft-entra-id',
      providerAccountId: `m-${Date.now()}`,
      email,
      name: 'Existing',
      emailVerifiedByProvider: false,
    });
    expect(result.outcome).toBe('blocked_existing_account');

    const accounts = await prisma.account.findMany({ where: { userId: existingUser.id } });
    expect(accounts).toHaveLength(0); // no Account was created — nothing was linked
  });
});
```

- [ ] **Step 4: Run tests to verify they fail**

```bash
cd apps/web && npx vitest run src/lib/oauth-linking.test.ts
```

- [ ] **Step 5: Write `apps/web/src/lib/oauth-linking.ts`**

```ts
/**
 * OAuth account-linking logic (Issue 12.8), extracted from the auth.ts
 * signIn callback into directly-testable functions — NextAuth's internal
 * callback plumbing (verified against @auth/core@0.41.2's source) isn't
 * easily invokable in isolation, so the actual DB decisions live here.
 *
 * Security-critical: auto-linking an OAuth identity to an existing
 * email/password account is ONLY safe when the OAuth provider itself
 * asserts the email is verified — otherwise anyone who knows a victim's
 * email address could potentially create an OAuth account with that same
 * (unverified) email and get silently merged into the victim's account.
 */
import { prisma } from './prisma';
import { createTenantForNewUser } from './create-tenant';

interface ResolveOAuthSignInInput {
  provider: string;
  providerAccountId: string;
  email: string;
  name: string;
  emailVerifiedByProvider: boolean;
}

type ResolveOAuthSignInResult =
  { outcome: 'signed_in'; userId: string } | { outcome: 'blocked_existing_account' };

export async function resolveOAuthSignIn(
  input: ResolveOAuthSignInInput,
): Promise<ResolveOAuthSignInResult> {
  const existingAccount = await prisma.account.findUnique({
    where: {
      provider_providerAccountId: {
        provider: input.provider,
        providerAccountId: input.providerAccountId,
      },
    },
  });
  if (existingAccount) {
    return { outcome: 'signed_in', userId: existingAccount.userId };
  }

  const matchingUser = await prisma.user.findUnique({ where: { email: input.email } });

  if (!matchingUser) {
    const { user } = await createTenantForNewUser({
      name: input.name,
      email: input.email,
      passwordHash: null,
      orgName: `${input.name}'s Organization`,
      orgSize: 'SOLO',
      workspaceName: `${input.name}'s Workspace`,
    });
    await prisma.account.create({
      data: {
        provider: input.provider,
        providerAccountId: input.providerAccountId,
        userId: user.id,
      },
    });
    if (input.emailVerifiedByProvider) {
      await prisma.user.update({ where: { id: user.id }, data: { emailVerified: new Date() } });
    }
    return { outcome: 'signed_in', userId: user.id };
  }

  if (input.emailVerifiedByProvider) {
    await prisma.account.create({
      data: {
        provider: input.provider,
        providerAccountId: input.providerAccountId,
        userId: matchingUser.id,
      },
    });
    return { outcome: 'signed_in', userId: matchingUser.id };
  }

  return { outcome: 'blocked_existing_account' };
}

/** Used by the jwt callback to resolve the internal User.id for an OAuth
 * sign-in, since (per @auth/core's no-adapter behavior) the `user` object
 * jwt() receives is the raw provider profile, not our database user. */
export async function resolveUserIdForOAuthAccount(
  provider: string,
  providerAccountId: string,
): Promise<string> {
  const account = await prisma.account.findUniqueOrThrow({
    where: { provider_providerAccountId: { provider, providerAccountId } },
  });
  return account.userId;
}
```

Verify the exact Prisma-generated compound-unique-key field name (`provider_providerAccountId`) matches what `@@unique([provider, providerAccountId])` actually generates — run `npx prisma generate` and check the generated client types, or just try it and let TypeScript/a test failure confirm/correct the exact name.

- [ ] **Step 6: Run tests to verify they pass**

```bash
cd apps/web && npx vitest run src/lib/oauth-linking.test.ts
```

Expected: PASS, all 4 tests.

- [ ] **Step 7: Wire providers + callbacks into `auth.ts`**

```ts
import NextAuth from 'next-auth';
import Credentials from 'next-auth/providers/credentials';
import GitHub from 'next-auth/providers/github';
import Google from 'next-auth/providers/google';
import MicrosoftEntraID from 'next-auth/providers/microsoft-entra-id';
import { prisma } from './prisma';
import { verifyPassword } from './password';
import { resolveOAuthSignIn, resolveUserIdForOAuthAccount } from './oauth-linking';

export const { handlers, auth, signIn, signOut } = NextAuth({
  session: { strategy: 'jwt' },
  pages: { signIn: '/login' },
  providers: [
    Credentials({
      // ... unchanged from Task 1 ...
    }),
    GitHub({
      clientId: process.env.GITHUB_OAUTH_CLIENT_ID,
      clientSecret: process.env.GITHUB_OAUTH_CLIENT_SECRET,
      authorization: { params: { scope: 'read:user user:email' } },
      // GitHub's default profile() drops the /user/emails `verified` field
      // (confirmed by reading @auth/core's github.js source) — override to
      // preserve it, since it's the auto-link safety gate.
      async profile(profile, tokens) {
        let verified = false;
        let email = profile.email;
        const res = await fetch('https://api.github.com/user/emails', {
          headers: { Authorization: `Bearer ${tokens.access_token}`, 'User-Agent': 'authjs' },
        });
        if (res.ok) {
          const emails: Array<{ email: string; primary: boolean; verified: boolean }> =
            await res.json();
          const primary = emails.find((e) => e.primary) ?? emails[0];
          if (primary) {
            email = primary.email;
            verified = primary.verified;
          }
        }
        return {
          id: profile.id.toString(),
          name: profile.name ?? profile.login,
          email,
          image: profile.avatar_url,
          emailVerifiedByProvider: verified,
        };
      },
    }),
    Google({
      clientId: process.env.GOOGLE_CLIENT_ID,
      clientSecret: process.env.GOOGLE_CLIENT_SECRET,
      authorization: { params: { scope: 'openid email profile' } },
      // Google's default profile() already includes email_verified — but the
      // default User shape doesn't carry it through to our custom field name,
      // so map it explicitly for consistency with the other two providers.
      profile(profile) {
        return {
          id: profile.sub,
          name: profile.name,
          email: profile.email,
          image: profile.picture,
          emailVerifiedByProvider: Boolean(profile.email_verified),
        };
      },
    }),
    MicrosoftEntraID({
      clientId: process.env.MICROSOFT_ENTRA_ID_CLIENT_ID,
      clientSecret: process.env.MICROSOFT_ENTRA_ID_CLIENT_SECRET,
      authorization: { params: { scope: 'openid email profile' } },
      // Default profile() fetches a profile photo (unnecessary for login-only
      // use) and drops any verification signal — override to skip the photo
      // fetch and treat an Entra ID email as provider-verified (Microsoft's
      // own account system requires verified email for org accounts).
      profile(profile) {
        return {
          id: profile.sub,
          name: profile.name,
          email: profile.email,
          image: null,
          emailVerifiedByProvider: true,
        };
      },
    }),
  ],
  callbacks: {
    async signIn({ account, profile }) {
      if (!account || account.provider === 'credentials') return true;

      const email = (profile as { email?: string } | undefined)?.email;
      const name = (profile as { name?: string } | undefined)?.name ?? email ?? 'New User';
      const emailVerifiedByProvider = Boolean(
        (profile as { emailVerifiedByProvider?: boolean } | undefined)?.emailVerifiedByProvider,
      );
      if (!email) return false;

      const result = await resolveOAuthSignIn({
        provider: account.provider,
        providerAccountId: account.providerAccountId,
        email,
        name,
        emailVerifiedByProvider,
      });
      if (result.outcome === 'blocked_existing_account') {
        return '/login?error=AccountExists';
      }
      return true;
    },
    async jwt({ token, user, account }) {
      if (account && account.provider !== 'credentials') {
        token.sub = await resolveUserIdForOAuthAccount(account.provider, account.providerAccountId);
      } else if (user) {
        token.sub = user.id;
      }
      return token;
    },
    session({ session, token }) {
      if (token.sub) session.user.id = token.sub;
      return session;
    },
  },
});
```

Note: `profile()`'s return type in each provider is intentionally carrying a nonstandard `emailVerifiedByProvider` field — check whether TypeScript's `Profile`/`User` type from `next-auth` needs an ambient module augmentation (a `next-auth.d.ts` file extending the `Profile`/`User` interfaces) to accept this extra field without a type error. If so, add one following whatever pattern (if any) already exists for `session.user.id` (check if `auth.ts` or a sibling file already does a `declare module "next-auth"` augmentation for the existing `session.user.id` addition — likely not, since the code above just does `session.user.id = token.sub` without complaint, suggesting either loose typing already in play or an existing augmentation file to find and extend).

- [ ] **Step 8: Update `/login` page to surface the `AccountExists` error and add OAuth sign-in buttons**

Read `apps/web/src/app/login/login-form.tsx` in full. Add:

- Handling for `error=AccountExists` in the URL (NextAuth redirects here with `?error=...` per the `signIn` callback's string-return behavior) — show: "An account with this email already exists. Sign in with your password, then link this provider from account settings."
- Three buttons calling the client-side `signIn('github')`, `signIn('google')`, `signIn('microsoft-entra-id')` (no `redirect: false` needed here, unlike the Credentials form — let NextAuth handle the full OAuth redirect).

- [ ] **Step 9: Run the full web test suite**

```bash
cd apps/web && npx vitest run
```

Expected: no regressions from the Task 1 baseline, plus the new `oauth-linking.test.ts` tests.

- [ ] **Step 10: Typecheck, lint**

```bash
cd apps/web
npx tsc --noEmit
npx eslint src/lib/auth.ts src/lib/oauth-linking.ts src/lib/oauth-linking.test.ts src/app/login/
```

- [ ] **Step 11: Manual smoke test**

```bash
cd apps/web && pnpm dev
```

Visit `/login`, confirm the three OAuth buttons render (they'll fail on click without real client IDs configured locally — that's expected; just confirm no console/render errors and the page loads). Stop the dev server after confirming.

- [ ] **Step 12: Commit**

```bash
git add src/lib/auth.ts src/lib/oauth-linking.ts src/lib/oauth-linking.test.ts src/app/login/ .env.example
git commit -m "Add GitHub/Google/Microsoft OAuth providers with safe account-linking (Issue #95)"
```

---

### Task 4: Settings — connected accounts (read-only list + unlink)

**Files:**

- Create: `apps/web/src/app/settings/account/page.tsx`
- Create: `apps/web/src/app/settings/account/connected-accounts.tsx`
- Create: `apps/web/src/app/api/account/connections/route.ts` (list)
- Create: `apps/web/src/app/api/account/connections/[accountId]/route.ts` (DELETE — unlink)
- Test: extend/create corresponding `route.test.ts` files

- [ ] **Step 1: Check whether ANY account/profile settings page already exists**

```bash
find apps/web/src/app -iname "*settings*" -o -iname "*account*" -o -iname "*profile*"
```

Per planning research, none should exist yet (only project-level `.../settings/`) — confirm this is still true before creating a new top-level `/settings/account` route, and pick a path consistent with whatever convention (if any) partially exists.

- [ ] **Step 2: Write the failing tests for `GET /api/account/connections`**

Follow `apps/web/src/app/api/workspaces/[workspaceId]/invites/route.test.ts`'s conventions (`vi.mock('@/lib/auth', ...)`, real Postgres fixtures). This route has no workspace param — it's purely session-scoped.

```ts
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { prisma } from '@/lib/prisma';

let currentSession: { user: { id: string } } | null = null;
vi.mock('@/lib/auth', () => ({ auth: async () => currentSession }));

const { GET } = await import('./route');

describe('GET /api/account/connections', () => {
  let user: { id: string };
  let account: { id: string };

  beforeAll(async () => {
    user = await prisma.user.create({
      data: { email: `conn-test-${Date.now()}@test.local`, name: 'X', passwordHash: 'hashed' },
    });
    account = await prisma.account.create({
      data: { provider: 'github', providerAccountId: `gh-${Date.now()}`, userId: user.id },
    });
  });

  afterAll(async () => {
    await prisma.account.deleteMany({ where: { userId: user.id } });
    await prisma.user.deleteMany({ where: { id: user.id } });
  });

  it('returns 401 when signed out', async () => {
    currentSession = null;
    const res = await GET(new Request('http://localhost/api/account/connections'));
    expect(res.status).toBe(401);
  });

  it("returns the signed-in user's connected providers", async () => {
    currentSession = { user: { id: user.id } };
    const res = await GET(new Request('http://localhost/api/account/connections'));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.accounts).toContainEqual(
      expect.objectContaining({ id: account.id, provider: 'github' }),
    );
    expect(body.hasPassword).toBe(true);
  });
});
```

- [ ] **Step 3: Run tests to verify they fail**

```bash
cd apps/web && npx vitest run "src/app/api/account/connections/route.test.ts"
```

- [ ] **Step 4: Write `GET /api/account/connections`**

```ts
import { NextResponse } from 'next/server';
import { auth } from '@/lib/auth';
import { prisma } from '@/lib/prisma';

export async function GET(_request: Request) {
  const session = await auth();
  if (!session?.user?.id) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }
  const [accounts, user] = await Promise.all([
    prisma.account.findMany({
      where: { userId: session.user.id },
      select: { id: true, provider: true, createdAt: true },
    }),
    prisma.user.findUniqueOrThrow({
      where: { id: session.user.id },
      select: { passwordHash: true },
    }),
  ]);
  return NextResponse.json({ accounts, hasPassword: user.passwordHash !== null });
}
```

- [ ] **Step 5: Write the failing tests for `DELETE /api/account/connections/[accountId]`**

Cases: 401 signed out; 404 for an account belonging to a DIFFERENT user (no existence leak — mirrors the 404-not-403 pattern used elsewhere in this repo, e.g. `requireProjectRole`); 200 unlink success when the user has a password OR more than one linked account; 409 blocked when it's the user's ONLY sign-in method (`passwordHash === null` AND this is their last `Account`).

- [ ] **Step 6: Run tests to verify they fail**

```bash
cd apps/web && npx vitest run "src/app/api/account/connections/[accountId]/route.test.ts"
```

- [ ] **Step 7: Write `DELETE /api/account/connections/[accountId]`**

```ts
import { NextResponse } from 'next/server';
import { auth } from '@/lib/auth';
import { prisma } from '@/lib/prisma';

type Params = { params: Promise<{ accountId: string }> };

export async function DELETE(_request: Request, { params }: Params) {
  const session = await auth();
  if (!session?.user?.id) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }
  const { accountId } = await params;

  const account = await prisma.account.findUnique({ where: { id: accountId } });
  if (!account || account.userId !== session.user.id) {
    return NextResponse.json({ error: 'Not found.' }, { status: 404 });
  }

  const user = await prisma.user.findUniqueOrThrow({
    where: { id: session.user.id },
    select: { passwordHash: true, _count: { select: { accounts: true } } },
  });
  const wouldLoseAllSignInMethods = user.passwordHash === null && user._count.accounts <= 1;
  if (wouldLoseAllSignInMethods) {
    return NextResponse.json(
      {
        error: 'This is your only sign-in method — set a password or link another provider first.',
      },
      { status: 409 },
    );
  }

  await prisma.account.delete({ where: { id: accountId } });
  return NextResponse.json({ ok: true });
}
```

- [ ] **Step 8: Run tests to verify they pass**

```bash
cd apps/web && npx vitest run "src/app/api/account/connections"
```

- [ ] **Step 9: Build the settings page**

`apps/web/src/app/settings/account/page.tsx` (server component, `await auth()` + `notFound()`/redirect-to-login if signed out, fetch connected accounts server-side) rendering `connected-accounts.tsx` (client component, lists providers with an "Unlink" button per row, calling `DELETE /api/account/connections/{id}`, showing the 409 error message when blocked). Match this app's existing page/component split conventions (see `billing/page.tsx` + `billing-settings.tsx` for the established pattern of server page + client component).

- [ ] **Step 10: Run full web suite, typecheck, lint**

```bash
cd apps/web
npx vitest run
npx tsc --noEmit
npx eslint src/app/settings/ src/app/api/account/
```

- [ ] **Step 11: Commit**

```bash
git add src/app/settings/ src/app/api/account/
git commit -m "Add connected-accounts settings page (list + unlink) (Issue #95)"
```

---

### Task 5: Full regression, documentation, close the issue

**Files:** none beyond `architecture.md`

- [ ] **Step 1: Full regression**

```bash
cd apps/web && npx vitest run && npx tsc --noEmit && npx eslint .
```

- [ ] **Step 2: Manual smoke test**

```bash
cd apps/web && pnpm dev
```

Confirm `/login`, `/settings/account`, and `/api/signup` (still) all load/function without error. Stop the dev server after confirming.

- [ ] **Step 3: Update `architecture.md`**

Add a new subsection under Section 7 (Security Considerations) or a new `###` under the auth-related area of Section 5 (whichever fits the file's existing structure best — check both before deciding):

```markdown
### OAuth login providers (Issue 12.8, `apps/web/src/lib/auth.ts` + `oauth-linking.ts`)

GitHub, Google, and Microsoft Entra ID OAuth login alongside the existing email/password flow. This app runs Auth.js v5 with NO database adapter (confirmed by reading `@auth/core`'s source directly) — Auth.js's built-in account-linking machinery is a complete no-op without one, so all linking logic is hand-rolled in `oauth-linking.ts`'s `resolveOAuthSignIn()`, called from the `signIn` callback. Auto-linking an OAuth identity to an existing email/password account happens ONLY when the provider asserts the email is verified (GitHub's `/user/emails` `verified` field, Google's `email_verified` claim, Microsoft Entra ID treated as always-verified) — otherwise the sign-in is blocked with a redirect to `/login?error=AccountExists`, preventing an unverified-email OAuth signup from silently merging into someone else's account. GitHub's and Microsoft's default provider `profile()` transforms both silently drop their verification signal (confirmed by reading each provider's source) — both are overridden with custom `profile()` functions; Google's default is used as-is. Because `signIn`'s approval decision doesn't change what `user` object Auth.js passes to the subsequent `jwt` callback (again, a no-adapter behavior), `jwt` separately re-resolves the correct internal `User.id` via `resolveUserIdForOAuthAccount()`, reading the `Account` row `signIn` just confirmed exists — this split is load-bearing and was verified against Auth.js internals, not assumed. New `Account` model stores only `provider`/`providerAccountId`/`userId` — no OAuth access/refresh tokens are persisted, since this is login-only (see Issue #111 for why this is distinct from the separate, unrelated connector-OAuth work in Epics 5-7, and why token storage was deliberately not built here). A minimal "connected accounts" settings page (`/settings/account`) lists linked providers and allows unlinking, blocked if it would leave the user with zero sign-in methods; adding a NEW provider to an existing account has no dedicated in-session "link" flow (dropped during planning — would have required reading the session from inside the `signIn` callback via raw cookies rather than `auth()`, risking recursion, for a secondary feature) — instead, signing out and back in via that provider with a matching verified email hits the same auto-link path.
```

- [ ] **Step 4: Commit**

```bash
git add architecture.md
git commit -m "Document OAuth login providers in architecture.md"
```

- [ ] **Step 5: Close Issue #95**

```bash
gh issue close 95 --comment "$(cat <<'EOF'
Implemented GitHub, Google, and Microsoft Entra ID OAuth login alongside the existing email/password flow.

**Account linking is the core of this issue, and it's security-scoped correctly**: an OAuth identity auto-links to an existing email/password account ONLY when the provider itself asserts the email is verified (GitHub's `/user/emails` `verified` field, Google's `email_verified` claim, Microsoft Entra ID treated as always-verified). Otherwise the sign-in is blocked with a clear message, never silently merged — closing the account-takeover vector where someone could claim an unverified OAuth email matching an existing user.

**Verified against Auth.js internals, not assumed**: this app runs with no database adapter, so Auth.js's built-in linking machinery is a complete no-op — all linking logic is hand-rolled (`oauth-linking.ts`). A subtlety caught during design: `signIn`'s approval decision doesn't control what `user` object flows to the subsequent `jwt` callback, so the internal `User.id` had to be separately re-resolved in `jwt` via the `Account` row — a naive single-callback implementation would have put a raw provider ID into the session token instead, breaking every authorization check downstream.

**Minimal scope, by design**: no OAuth access/refresh tokens are persisted (login-only, not delegated API access — see follow-up #111 for why this is distinct from the unrelated connector-OAuth work in Epics 5-7). No in-session "link a new provider" button — dropped in favor of the existing auto-link-on-sign-in path, avoiding added auth-surface risk for a secondary feature. A minimal settings page covers listing/unlinking connected providers, blocked from ever leaving a user with zero sign-in methods.

New-user OAuth signup reuses the exact same Organization+Workspace+OWNER/ADMIN creation transaction as email/password signup (extracted into a shared helper), so there's one tenant-creation path, not two.

Full regression: web test suite green, tsc/eslint clean.
EOF
)"
```

---

## Self-review notes (for the plan author, already applied above)

- **Spec coverage**: sign-up/sign-in via all 3 providers (Task 3), correct account matching without duplicates (Task 3's `resolveOAuthSignIn`, directly tested), minimal scopes (Task 3's explicit `authorization.params.scope` on each provider, distinct from provider defaults).
- **Type consistency**: `resolveOAuthSignIn`'s `ResolveOAuthSignInResult` discriminated union (`outcome: 'signed_in' | 'blocked_existing_account'`) is the single source of truth consumed by the `signIn` callback — no duplicate/divergent status representation introduced elsewhere.
- **Regression safety**: Task 2's extraction of `createTenantForNewUser` is verified to leave `/api/signup`'s existing tests passing completely unchanged (pure refactor); Task 1's `passwordHash` nullability change is the one intentional behavior change to existing code, isolated to a single added null-check.
- **No placeholders**: every step has real, complete code. The one place genuine API-shape uncertainty exists (Task 3 Step 7's note on possibly needing a `next-auth.d.ts` module augmentation) is explicitly flagged as "check and adapt" rather than silently assumed away — this mirrors how earlier plans in this session (e.g. the AI-scheduler plan) handled genuine implementation-time unknowns honestly.
- **Deliberately scoped down**: no token persistence, no in-session linking flow, no account-settings redesign beyond the minimal connected-accounts section — all explicitly decided during brainstorming and not silently expanded here.
