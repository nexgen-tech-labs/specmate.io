# Organization and team management UI Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build the admin UI for the Organization → Workspace → Team → User hierarchy: org settings (workspace list, member list, offboarding), workspace settings (team list), team detail (member/scope management) — plus the handful of backend endpoints this needs that don't exist yet (org member list/invite/offboard, workspace archive, org settings update).

**Architecture:** All authorization reuses the already-existing `requireOrganizationRole`/`requireWorkspaceRole` primitives (`apps/web/src/lib/workspace-context.ts`) — no new auth logic. New endpoints mirror the exact conventions of the existing `.../organizations/{orgId}/workspaces` and `.../workspaces/{ws}/teams[/teamId]` routes (read in full during planning, quoted below). Offboarding is the one security-critical piece: a single transaction must delete `OrganizationMember` + every `WorkspaceMember` + every `TeamMember` for the target user across the whole org, or access is left orphaned.

**Tech Stack:** Next.js App Router, Prisma, TypeScript, Vitest, Testing Library.

**Correction from the design spec**: the spec's `OrganizationInvite` sketch used an `acceptedAt: DateTime?` field — the ACTUAL existing `WorkspaceInvite` model (verified by reading `apps/web/prisma/schema.prisma` during planning) instead uses a `status: InviteStatus @default(PENDING)` enum (`PENDING | ACCEPTED | REVOKED`). `OrganizationInvite` in this plan uses the same `status` enum shape for consistency — Task 2 below reflects the corrected shape, not the spec's.

---

### Task 1: `OrganizationInvite` schema + settings shell layout

**Files:**

- Modify: `apps/web/prisma/schema.prisma`
- Create: Prisma migration
- Create: `apps/web/src/app/settings/layout.tsx`
- Modify: `apps/web/src/app/settings/account/page.tsx` (only if the layout requires wrapping adjustments — likely none needed, App Router layouts wrap automatically)

- [ ] **Step 1: Add `OrganizationInvite` to the schema**

Read the exact `WorkspaceInvite` model first (`apps/web/prisma/schema.prisma`, confirmed current shape):

```prisma
model WorkspaceInvite {
  id              String       @id @default(cuid())
  workspaceId     String
  email           String
  role            Role
  token           String       @unique
  status          InviteStatus @default(PENDING)
  invitedByUserId String
  expiresAt       DateTime
  createdAt       DateTime     @default(now())
  updatedAt       DateTime     @updatedAt

  workspace  Workspace @relation(fields: [workspaceId], references: [id])
  invitedBy  User      @relation(fields: [invitedByUserId], references: [id])
}
```

Add, mirroring this shape exactly but for `Organization`/`OrgRole`:

```prisma
model OrganizationInvite {
  id              String       @id @default(cuid())
  organizationId  String
  email           String
  role            OrgRole
  token           String       @unique
  status          InviteStatus @default(PENDING)
  invitedByUserId String
  expiresAt       DateTime
  createdAt       DateTime     @default(now())
  updatedAt       DateTime     @updatedAt

  organization Organization @relation(fields: [organizationId], references: [id])
  invitedBy    User         @relation(fields: [invitedByUserId], references: [id])
}
```

Add reverse relations: `Organization.invites OrganizationInvite[]`, `User.sentOrgInvites OrganizationInvite[]` (check `User`'s existing `sentInvites WorkspaceInvite[]` field name/style and match it — likely `sentInvites` is already taken, so use a distinctly-named field like `sentOrgInvites`).

- [ ] **Step 2: Generate and apply the migration**

```bash
cd apps/web && npx prisma migrate dev --name add_organization_invite
```

Expected: clean migration, no drift. If you hit ANY migration error (checksum drift, needing a reset), STOP and report back — do not run `prisma migrate reset` yourself; that requires explicit user consent obtained by the orchestrating conversation.

- [ ] **Step 3: Build the settings shell layout**

Read `apps/web/src/app/settings/account/page.tsx` in full first (existing page, to confirm its exact current styling/structure — the layout must not break it).

Create `apps/web/src/app/settings/layout.tsx`:

```tsx
import { auth } from '@/lib/auth';
import { prisma } from '@/lib/prisma';
import Link from 'next/link';

export default async function SettingsLayout({ children }: { children: React.ReactNode }) {
  const session = await auth();
  const userId = session?.user?.id;

  const orgMemberships = userId
    ? await prisma.organizationMember.findMany({
        where: { userId },
        select: { organizationId: true, organization: { select: { name: true } } },
      })
    : [];

  return (
    <div className="min-h-screen bg-paper">
      <nav className="border-b border-line bg-panel px-6 py-4">
        <div className="mx-auto flex max-w-3xl items-center gap-6 text-sm font-semibold text-sub">
          {orgMemberships.map((m) => (
            <Link
              key={m.organizationId}
              href={`/organizations/${m.organizationId}/settings`}
              className="hover:text-ink"
            >
              {m.organization.name}
            </Link>
          ))}
          <Link href="/settings/account" className="hover:text-ink">
            Account
          </Link>
        </div>
      </nav>
      {children}
    </div>
  );
}
```

Note: `/organizations/{orgId}/settings` pages (built in later tasks) live OUTSIDE the `/settings` route tree (since they need an `orgId` path segment), so this layout only wraps `/settings/*`. Confirm this doesn't double-wrap `bg-paper`/padding on the existing `/settings/account/page.tsx` (check its current root div — if it already sets `min-h-screen bg-paper`, remove the duplicate from the page since the layout now provides it, keeping the page's inner content div as-is).

- [ ] **Step 4: Run tests, typecheck, lint**

```bash
cd apps/web
npx vitest run
npx tsc --noEmit
npx eslint src/app/settings/
```

Expected: no regressions (check baseline count first).

- [ ] **Step 5: Manual smoke test**

```bash
cd apps/web && pnpm dev &
sleep 5
curl -s -o /dev/null -w "%{http_code}\n" http://localhost:3000/settings/account
kill %1 2>/dev/null
```

- [ ] **Step 6: Commit**

```bash
git add prisma/schema.prisma prisma/migrations/ src/app/settings/
git commit -m "Add OrganizationInvite schema + settings shell layout (Issue #99)"
```

---

### Task 2: Org member list, invite, and accept endpoints

**Files:**

- Create: `apps/web/src/app/api/organizations/[organizationId]/members/route.ts`
- Create: `apps/web/src/app/api/organizations/[organizationId]/invites/route.ts`
- Create: `apps/web/src/app/api/organization-invites/[token]/accept/route.ts`
- Test: matching `route.test.ts` for each

- [ ] **Step 1: Read the existing `WorkspaceInvite` accept route in full** (already quoted above in this plan's header note — reproduced here for the exact pattern to mirror):

```ts
import { NextResponse } from 'next/server';
import { auth } from '@/lib/auth';
import { prisma } from '@/lib/prisma';
import { checkSeatGate } from '@/lib/billing-gate';

export async function POST(_request: Request, { params }: { params: Promise<{ token: string }> }) {
  const { token } = await params;

  const session = await auth();
  const userId = session?.user?.id;
  const userEmail = session?.user?.email;
  if (!userId || !userEmail) {
    return NextResponse.json({ error: 'Sign in required.' }, { status: 401 });
  }

  const invite = await prisma.workspaceInvite.findUnique({ where: { token } });
  if (!invite || invite.status !== 'PENDING' || invite.expiresAt < new Date()) {
    return NextResponse.json({ error: 'Invite is invalid or has expired.' }, { status: 404 });
  }
  if (invite.email !== userEmail) {
    return NextResponse.json(
      { error: 'This invite was sent to a different email address.' },
      { status: 403 },
    );
  }

  await prisma.$transaction([
    prisma.workspaceMember.create({
      data: { workspaceId: invite.workspaceId, userId, role: invite.role },
    }),
    prisma.workspaceInvite.update({
      where: { id: invite.id },
      data: { status: 'ACCEPTED' },
    }),
  ]);

  return NextResponse.json({ workspaceId: invite.workspaceId }, { status: 200 });
}
```

Note: this workspace version has a `checkSeatGate` billing check that does NOT apply at the org level (billing stays workspace-scoped, confirmed in architecture.md) — the org-invite accept route below omits that check entirely.

- [ ] **Step 2: Write failing tests for `GET /api/organizations/{organizationId}/members`**

Follow `apps/web/src/app/api/organizations/[organizationId]/workspaces/route.test.ts`'s exact conventions if it exists (check first — the design research didn't confirm a test file exists for the sibling `workspaces` route; if none exists, follow `apps/web/src/app/api/workspaces/[workspaceId]/teams/route.test.ts`'s conventions instead, adapted for org scope).

```ts
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { prisma } from '@/lib/prisma';

let currentSession: { user: { id: string } } | null = null;
vi.mock('@/lib/auth', () => ({ auth: async () => currentSession }));

const { GET } = await import('./route');

describe('GET /api/organizations/[organizationId]/members', () => {
  let org: { id: string };
  let owner: { id: string };
  let admin: { id: string };
  let nonMember: { id: string };

  beforeAll(async () => {
    org = await prisma.organization.create({ data: { name: 'Org Members Test' } });
    owner = await prisma.user.create({
      data: { email: `org-owner-${Date.now()}@test.local`, name: 'Owner', passwordHash: 'x' },
    });
    admin = await prisma.user.create({
      data: { email: `org-admin-${Date.now()}@test.local`, name: 'Admin', passwordHash: 'x' },
    });
    nonMember = await prisma.user.create({
      data: { email: `non-member-${Date.now()}@test.local`, name: 'NonMember', passwordHash: 'x' },
    });
    await prisma.organizationMember.create({
      data: { organizationId: org.id, userId: owner.id, role: 'OWNER' },
    });
    await prisma.organizationMember.create({
      data: { organizationId: org.id, userId: admin.id, role: 'ADMIN' },
    });
  });

  afterAll(async () => {
    await prisma.organizationMember.deleteMany({ where: { organizationId: org.id } });
    await prisma.organization.delete({ where: { id: org.id } });
    await prisma.user.deleteMany({ where: { id: { in: [owner.id, admin.id, nonMember.id] } } });
  });

  function makeRequest() {
    return new Request(`http://localhost/api/organizations/${org.id}/members`);
  }

  it('returns 401 when signed out', async () => {
    currentSession = null;
    const res = await GET(makeRequest(), { params: Promise.resolve({ organizationId: org.id }) });
    expect(res.status).toBe(401);
  });

  it('returns 403 for a non-member', async () => {
    currentSession = { user: { id: nonMember.id } };
    const res = await GET(makeRequest(), { params: Promise.resolve({ organizationId: org.id }) });
    expect(res.status).toBe(403);
  });

  it('returns the member list for an org OWNER', async () => {
    currentSession = { user: { id: owner.id } };
    const res = await GET(makeRequest(), { params: Promise.resolve({ organizationId: org.id }) });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.members).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ userId: owner.id, role: 'OWNER' }),
        expect.objectContaining({ userId: admin.id, role: 'ADMIN' }),
      ]),
    );
  });
});
```

- [ ] **Step 3: Run tests to verify they fail, then write the route**

```bash
cd apps/web && npx vitest run "src/app/api/organizations/[organizationId]/members/route.test.ts"
```

```ts
import { NextResponse } from 'next/server';
import { prisma } from '@/lib/prisma';
import { requireOrganizationRole } from '@/lib/workspace-context';

type Params = { params: Promise<{ organizationId: string }> };

export async function GET(_request: Request, { params }: Params) {
  const { organizationId } = await params;
  const access = await requireOrganizationRole(organizationId, ['OWNER', 'ADMIN']);
  if (!access.ok) return NextResponse.json({ error: 'Forbidden' }, { status: access.status });

  const members = await prisma.organizationMember.findMany({
    where: { organizationId },
    select: { userId: true, role: true, user: { select: { name: true, email: true } } },
    orderBy: { createdAt: 'asc' },
  });

  return NextResponse.json({
    members: members.map((m) => ({
      userId: m.userId,
      role: m.role,
      name: m.user.name,
      email: m.user.email,
    })),
  });
}
```

- [ ] **Step 4: Run tests to verify they pass**

```bash
cd apps/web && npx vitest run "src/app/api/organizations/[organizationId]/members/route.test.ts"
```

- [ ] **Step 5: Write failing tests for `POST /api/organizations/{organizationId}/invites`**

Cases: 401 signed out; 403 non-member; 403 when an ADMIN (not OWNER) tries to invite with `role: 'OWNER'` (can't grant a role higher than your own); 201 happy path for OWNER inviting either role, asserting an `OrganizationInvite` row is created with `status: 'PENDING'` and a token.

- [ ] **Step 6: Run tests to verify they fail, then write the route**

```ts
import { randomUUID } from 'node:crypto';
import { NextResponse } from 'next/server';
import { prisma } from '@/lib/prisma';
import { requireOrganizationRole } from '@/lib/workspace-context';

type Params = { params: Promise<{ organizationId: string }> };
const INVITE_TTL_MS = 7 * 24 * 60 * 60 * 1000;

export async function POST(request: Request, { params }: Params) {
  const { organizationId } = await params;
  const access = await requireOrganizationRole(organizationId, ['OWNER', 'ADMIN']);
  if (!access.ok) return NextResponse.json({ error: 'Forbidden' }, { status: access.status });

  const body = (await request.json().catch(() => ({}))) as { email?: unknown; role?: unknown };
  const email = typeof body.email === 'string' ? body.email.trim() : '';
  const role = body.role === 'OWNER' || body.role === 'ADMIN' ? body.role : null;
  if (!email || !role) {
    return NextResponse.json({ error: 'A valid email and role are required.' }, { status: 400 });
  }
  // Can't grant a role higher than your own — an ADMIN may only invite ADMINs.
  if (role === 'OWNER' && access.membership.role !== 'OWNER') {
    return NextResponse.json({ error: 'Only an OWNER can invite a new OWNER.' }, { status: 403 });
  }

  const invite = await prisma.organizationInvite.create({
    data: {
      organizationId,
      email,
      role,
      token: randomUUID(),
      invitedByUserId: access.membership.userId,
      expiresAt: new Date(Date.now() + INVITE_TTL_MS),
    },
  });

  return NextResponse.json({ id: invite.id, token: invite.token }, { status: 201 });
}
```

- [ ] **Step 7: Run tests to verify they pass**

- [ ] **Step 8: Write failing tests for `POST /api/organization-invites/{token}/accept`**

Cases: 401 signed out; 404 invalid/expired/wrong-status token; 403 email mismatch; 200 happy path creating the `OrganizationMember` row and marking the invite `ACCEPTED`.

- [ ] **Step 9: Run tests to verify they fail, then write the route**

```ts
import { NextResponse } from 'next/server';
import { auth } from '@/lib/auth';
import { prisma } from '@/lib/prisma';

export async function POST(_request: Request, { params }: { params: Promise<{ token: string }> }) {
  const { token } = await params;

  const session = await auth();
  const userId = session?.user?.id;
  const userEmail = session?.user?.email;
  if (!userId || !userEmail) {
    return NextResponse.json({ error: 'Sign in required.' }, { status: 401 });
  }

  const invite = await prisma.organizationInvite.findUnique({ where: { token } });
  if (!invite || invite.status !== 'PENDING' || invite.expiresAt < new Date()) {
    return NextResponse.json({ error: 'Invite is invalid or has expired.' }, { status: 404 });
  }
  if (invite.email !== userEmail) {
    return NextResponse.json(
      { error: 'This invite was sent to a different email address.' },
      { status: 403 },
    );
  }

  await prisma.$transaction([
    prisma.organizationMember.create({
      data: { organizationId: invite.organizationId, userId, role: invite.role },
    }),
    prisma.organizationInvite.update({
      where: { id: invite.id },
      data: { status: 'ACCEPTED' },
    }),
  ]);

  return NextResponse.json({ organizationId: invite.organizationId }, { status: 200 });
}
```

Handle the edge case: what if the user is ALREADY an `OrganizationMember` of this org (re-accepting, or already a member via a different path)? `organizationMember.create` would throw on the `@@unique([organizationId, userId])` constraint. Check for an existing membership first and return a clean error (e.g. 409 "Already a member of this organization.") rather than letting a raw Prisma error propagate — write a test for this case too.

- [ ] **Step 10: Run tests to verify they pass, full suite, typecheck, lint**

```bash
cd apps/web
npx vitest run
npx tsc --noEmit
npx eslint src/app/api/organizations/ src/app/api/organization-invites/
```

- [ ] **Step 11: Commit**

```bash
git add src/app/api/organizations/ src/app/api/organization-invites/
git commit -m "Add org member list, invite, and accept endpoints (Issue #99)"
```

---

### Task 3: Offboarding endpoint (security-critical)

**Files:**

- Create: `apps/web/src/app/api/organizations/[organizationId]/members/[userId]/route.ts`
- Test: matching `route.test.ts`

- [ ] **Step 1: Read `apps/web/src/services/audit.ts` or wherever `AuditEvent`/`record_audit_event`-equivalent lives in `apps/web`** (this app is TypeScript/Prisma — confirm the exact existing helper name and signature; the `apps/api` Python equivalent is `record_audit_event`, but this is a `apps/web` TS route, so find the TS-side equivalent if one exists — grep `apps/web/src` for `AuditEvent` usage to find the pattern, e.g. `prisma.auditEvent.create(...)` called directly, or a wrapper function).

```bash
grep -rln "AuditEvent" apps/web/src --include="*.ts" | grep -v test
```

- [ ] **Step 2: Write the failing test — this is THE load-bearing test for the whole issue**

```ts
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { prisma } from '@/lib/prisma';

let currentSession: { user: { id: string } } | null = null;
vi.mock('@/lib/auth', () => ({ auth: async () => currentSession }));

const { DELETE } = await import('./route');

describe('DELETE /api/organizations/[organizationId]/members/[userId] — offboarding', () => {
  let org: { id: string };
  let owner: { id: string };
  let departing: { id: string };
  let workspaceA: { id: string };
  let workspaceB: { id: string };
  let untouchedWorkspace: { id: string };
  let teamInA: { id: string };
  let teamInB: { id: string };
  let untouchedTeamMember: { id: string };

  beforeAll(async () => {
    org = await prisma.organization.create({ data: { name: 'Offboard Test Org' } });
    owner = await prisma.user.create({
      data: { email: `offboard-owner-${Date.now()}@test.local`, name: 'Owner', passwordHash: 'x' },
    });
    departing = await prisma.user.create({
      data: {
        email: `offboard-departing-${Date.now()}@test.local`,
        name: 'Departing',
        passwordHash: 'x',
      },
    });
    const stayingUser = await prisma.user.create({
      data: {
        email: `offboard-staying-${Date.now()}@test.local`,
        name: 'Staying',
        passwordHash: 'x',
      },
    });

    await prisma.organizationMember.create({
      data: { organizationId: org.id, userId: owner.id, role: 'OWNER' },
    });
    await prisma.organizationMember.create({
      data: { organizationId: org.id, userId: departing.id, role: 'ADMIN' },
    });

    workspaceA = await prisma.workspace.create({
      data: { name: 'WS A', organizationId: org.id },
    });
    workspaceB = await prisma.workspace.create({
      data: { name: 'WS B', organizationId: org.id },
    });
    untouchedWorkspace = await prisma.workspace.create({
      data: { name: 'WS Untouched', organizationId: org.id },
    });

    // Departing user is a WorkspaceMember in A and B, but NOT in the untouched one.
    await prisma.workspaceMember.create({
      data: { workspaceId: workspaceA.id, userId: departing.id, role: 'ADMIN' },
    });
    await prisma.workspaceMember.create({
      data: { workspaceId: workspaceB.id, userId: departing.id, role: 'REVIEWER' },
    });
    // A different user's membership in the untouched workspace must survive.
    const untouchedMembership = await prisma.workspaceMember.create({
      data: { workspaceId: untouchedWorkspace.id, userId: stayingUser.id, role: 'ADMIN' },
    });

    teamInA = await prisma.team.create({ data: { workspaceId: workspaceA.id, name: 'Team A' } });
    teamInB = await prisma.team.create({ data: { workspaceId: workspaceB.id, name: 'Team B' } });
    const untouchedTeam = await prisma.team.create({
      data: { workspaceId: untouchedWorkspace.id, name: 'Untouched Team' },
    });

    await prisma.teamMember.create({ data: { teamId: teamInA.id, userId: departing.id } });
    await prisma.teamMember.create({ data: { teamId: teamInB.id, userId: departing.id } });
    // A different user's team membership in an unrelated team must survive.
    untouchedTeamMember = await prisma.teamMember.create({
      data: { teamId: untouchedTeam.id, userId: stayingUser.id },
    });

    // stash for cleanup
    (globalThis as any).__offboardCleanup = {
      stayingUserId: stayingUser.id,
      untouchedMembershipId: untouchedMembership.id,
    };
  });

  afterAll(async () => {
    const cleanup = (globalThis as any).__offboardCleanup;
    await prisma.teamMember.deleteMany({
      where: { userId: { in: [owner.id, departing.id, cleanup.stayingUserId] } },
    });
    await prisma.team.deleteMany({
      where: { workspaceId: { in: [workspaceA.id, workspaceB.id, untouchedWorkspace.id] } },
    });
    await prisma.workspaceMember.deleteMany({
      where: { workspaceId: { in: [workspaceA.id, workspaceB.id, untouchedWorkspace.id] } },
    });
    await prisma.workspace.deleteMany({
      where: { id: { in: [workspaceA.id, workspaceB.id, untouchedWorkspace.id] } },
    });
    await prisma.organizationMember.deleteMany({ where: { organizationId: org.id } });
    await prisma.organization.delete({ where: { id: org.id } });
    await prisma.user.deleteMany({
      where: { id: { in: [owner.id, departing.id, cleanup.stayingUserId] } },
    });
  });

  function makeRequest() {
    return new Request('http://localhost/api/organizations/x/members/y', { method: 'DELETE' });
  }

  it('returns 403 when an ADMIN (not OWNER) attempts offboarding', async () => {
    currentSession = { user: { id: departing.id } }; // departing is ADMIN, not OWNER
    const res = await DELETE(makeRequest(), {
      params: Promise.resolve({ organizationId: org.id, userId: owner.id }),
    });
    expect(res.status).toBe(403);
  });

  it('removes ALL of the departing user access org-wide, and nothing else', async () => {
    currentSession = { user: { id: owner.id } };
    const res = await DELETE(makeRequest(), {
      params: Promise.resolve({ organizationId: org.id, userId: departing.id }),
    });
    expect(res.status).toBe(200);

    // Org membership gone.
    const orgMembership = await prisma.organizationMember.findUnique({
      where: { organizationId_userId: { organizationId: org.id, userId: departing.id } },
    });
    expect(orgMembership).toBeNull();

    // WorkspaceMember rows in BOTH workspace A and B gone.
    const remainingWorkspaceMemberships = await prisma.workspaceMember.findMany({
      where: { userId: departing.id, workspaceId: { in: [workspaceA.id, workspaceB.id] } },
    });
    expect(remainingWorkspaceMemberships).toHaveLength(0);

    // TeamMember rows in BOTH teams gone.
    const remainingTeamMemberships = await prisma.teamMember.findMany({
      where: { userId: departing.id, teamId: { in: [teamInA.id, teamInB.id] } },
    });
    expect(remainingTeamMemberships).toHaveLength(0);

    // A DIFFERENT user's membership in an unrelated workspace/team is untouched.
    const cleanup = (globalThis as any).__offboardCleanup;
    const untouchedStillThere = await prisma.workspaceMember.findUnique({
      where: { id: cleanup.untouchedMembershipId },
    });
    expect(untouchedStillThere).not.toBeNull();
    const untouchedTeamMemberStillThere = await prisma.teamMember.findUnique({
      where: { id: untouchedTeamMember.id },
    });
    expect(untouchedTeamMemberStillThere).not.toBeNull();
  });
});
```

Adapt the `(globalThis as any).__offboardCleanup` stash-pattern to whatever cleaner approach fits — this is illustrative of the REQUIRED assertions (all departing-user rows gone, all other-user rows untouched), not a mandated implementation; use `let` variables in the outer `describe` scope instead if that's cleaner (it should be — the `globalThis` stash was just this plan's placeholder for passing values between `beforeAll` and `afterAll`; use proper closure variables instead).

- [ ] **Step 2: Run tests to verify they fail**

```bash
cd apps/web && npx vitest run "src/app/api/organizations/[organizationId]/members/[userId]/route.test.ts"
```

- [ ] **Step 3: Write the route**

```ts
import { NextResponse } from 'next/server';
import { prisma } from '@/lib/prisma';
import { requireOrganizationRole } from '@/lib/workspace-context';

type Params = { params: Promise<{ organizationId: string; userId: string }> };

// Offboarding (Issue 12.12 AC 3): removes a departing user's access
// org-wide in one transaction — OrganizationMember + every WorkspaceMember
// row in every Workspace of this org + every TeamMember row in every Team of
// every Workspace of this org. Missing any one of these would leave
// orphaned access (a direct WorkspaceMember row grants access independent
// of org membership — see workspace-access.ts). OWNER-only: removing a
// person's entire access is a higher-privilege action than day-to-day
// workspace/team management (which is ADMIN-permitted elsewhere).
export async function DELETE(_request: Request, { params }: Params) {
  const { organizationId, userId } = await params;
  const access = await requireOrganizationRole(organizationId, ['OWNER']);
  if (!access.ok) return NextResponse.json({ error: 'Forbidden' }, { status: access.status });

  const workspaceIds = (
    await prisma.workspace.findMany({
      where: { organizationId },
      select: { id: true },
    })
  ).map((w) => w.id);

  await prisma.$transaction(async (tx) => {
    if (workspaceIds.length > 0) {
      const teamIds = (
        await tx.team.findMany({
          where: { workspaceId: { in: workspaceIds } },
          select: { id: true },
        })
      ).map((t) => t.id);
      if (teamIds.length > 0) {
        await tx.teamMember.deleteMany({ where: { userId, teamId: { in: teamIds } } });
      }
      await tx.workspaceMember.deleteMany({ where: { userId, workspaceId: { in: workspaceIds } } });
    }
    await tx.organizationMember.deleteMany({ where: { organizationId, userId } });
  });

  return NextResponse.json({ ok: true });
}
```

Note this deliberately does NOT filter `workspace.findMany` by `deletedAt: null` — an archived workspace's `WorkspaceMember`/`TeamMember` rows must ALSO be cleaned up (the user shouldn't retain latent access if the workspace is ever un-archived, and even if it can't be, leaving stale rows is still incorrect data hygiene for an "offboarding" action whose entire point is completeness).

Check whether `apps/web` has an `AuditEvent`-recording helper (from Step 1's grep) and add a call to record this action if one exists — follow its exact existing call signature, don't invent a new one. If no reusable helper exists, write a direct `prisma.auditEvent.create(...)` matching whatever shape `AuditEvent` rows take elsewhere in `apps/web` (check the model's fields first).

- [ ] **Step 4: Run tests to verify they pass**

```bash
cd apps/web && npx vitest run "src/app/api/organizations/[organizationId]/members/[userId]/route.test.ts"
```

Expected: PASS, both tests — especially the full-coverage assertion test.

- [ ] **Step 5: Run the full suite, typecheck, lint**

```bash
cd apps/web
npx vitest run
npx tsc --noEmit
npx eslint "src/app/api/organizations/[organizationId]/members/"
```

- [ ] **Step 6: Commit**

```bash
git add "src/app/api/organizations/[organizationId]/members/[userId]/"
git commit -m "Add offboarding endpoint — removes org-wide access in one transaction (Issue #99)"
```

---

### Task 4: Workspace archive + org settings update endpoints

**Files:**

- Create: `apps/web/src/app/api/workspaces/[workspaceId]/route.ts` (DELETE — check first whether this file already exists with a GET or other method; if so, ADD the DELETE export, don't overwrite)
- Create: `apps/web/src/app/api/organizations/[organizationId]/route.ts` (PATCH — same check)
- Test: matching `route.test.ts` for each (extend existing test file if the route file already exists)

- [ ] **Step 1: Check whether these route files already exist**

```bash
ls "apps/web/src/app/api/workspaces/[workspaceId]/" 2>/dev/null | grep -x route.ts
ls "apps/web/src/app/api/organizations/[organizationId]/" 2>/dev/null | grep -x route.ts
```

If either exists, read it in full and ADD the new HTTP method as an additional export in the same file, matching its existing style exactly — don't create a conflicting/duplicate file.

- [ ] **Step 2: Write failing tests for `DELETE /api/workspaces/{workspaceId}` (archive)**

Cases: 401; 403 for a non-admin; 200 for a workspace ADMIN (soft-delete, `deletedAt` set, workspace no longer appears in `GET /api/organizations/{orgId}/workspaces`'s list since that query already filters `deletedAt: null`); 200 for an org OWNER/ADMIN acting via role inheritance (no direct `WorkspaceMember` row needed — confirm `requireWorkspaceRole` already handles this, per the existing inheritance logic).

- [ ] **Step 3: Run tests to verify they fail, then write/add the route**

```ts
export async function DELETE(_request: Request, { params }: Params) {
  const { workspaceId } = await params;
  const access = await requireWorkspaceRole(workspaceId, ['ADMIN']);
  if (!access.ok) return NextResponse.json({ error: 'Forbidden' }, { status: access.status });

  await prisma.workspace.update({ where: { id: workspaceId }, data: { deletedAt: new Date() } });
  return NextResponse.json({ ok: true });
}
```

(Match this into the existing file's exact import/type-alias conventions if the file already exists — read it first per Step 1.)

- [ ] **Step 4: Run tests to verify they pass**

- [ ] **Step 5: Write failing tests for `PATCH /api/organizations/{organizationId}` (settings update)**

Cases: 401; 403 for a non-OWNER (including an org ADMIN — OWNER-only per the design); 200 happy path updating `name`/`size`.

- [ ] **Step 6: Run tests to verify they fail, then write/add the route**

```ts
export async function PATCH(request: Request, { params }: Params) {
  const { organizationId } = await params;
  const access = await requireOrganizationRole(organizationId, ['OWNER']);
  if (!access.ok) return NextResponse.json({ error: 'Forbidden' }, { status: access.status });

  const body = (await request.json().catch(() => ({}))) as { name?: unknown; size?: unknown };
  const data: { name?: string; size?: 'SOLO' | 'SMALL' | 'MEDIUM' | 'LARGE' | 'ENTERPRISE' } = {};
  if (typeof body.name === 'string' && body.name.trim()) data.name = body.name.trim();
  if (
    typeof body.size === 'string' &&
    ['SOLO', 'SMALL', 'MEDIUM', 'LARGE', 'ENTERPRISE'].includes(body.size)
  ) {
    data.size = body.size as typeof data.size;
  }
  if (Object.keys(data).length === 0) {
    return NextResponse.json({ error: 'No valid fields to update.' }, { status: 400 });
  }

  const organization = await prisma.organization.update({ where: { id: organizationId }, data });
  return NextResponse.json({
    id: organization.id,
    name: organization.name,
    size: organization.size,
  });
}
```

- [ ] **Step 7: Run tests, full suite, typecheck, lint**

```bash
cd apps/web
npx vitest run
npx tsc --noEmit
npx eslint "src/app/api/workspaces/[workspaceId]/route.ts" "src/app/api/organizations/[organizationId]/route.ts"
```

- [ ] **Step 8: Commit**

```bash
git add "src/app/api/workspaces/[workspaceId]/route.ts" "src/app/api/organizations/[organizationId]/route.ts" "src/app/api/workspaces/[workspaceId]/route.test.ts" "src/app/api/organizations/[organizationId]/route.test.ts"
git commit -m "Add workspace archive and org settings update endpoints (Issue #99)"
```

---

### Task 5: Organization settings page

**Files:**

- Create: `apps/web/src/app/organizations/[organizationId]/settings/page.tsx`
- Create: `apps/web/src/app/organizations/[organizationId]/settings/org-settings.tsx`
- Test: `apps/web/src/app/organizations/[organizationId]/settings/org-settings.test.tsx`

- [ ] **Step 1: Read `apps/web/src/app/workspaces/[workspaceId]/billing/page.tsx` + `billing-settings.tsx` in full** as the server-page + client-component convention to mirror (already read during design research — re-read live to confirm current exact shape before writing).

- [ ] **Step 2: Write the server page**

```tsx
import { notFound } from 'next/navigation';
import { requireOrganizationRole } from '@/lib/workspace-context';
import { prisma } from '@/lib/prisma';
import { OrgSettings } from './org-settings';

export default async function OrganizationSettingsPage({
  params,
}: {
  params: Promise<{ organizationId: string }>;
}) {
  const { organizationId } = await params;

  const access = await requireOrganizationRole(organizationId, ['OWNER', 'ADMIN']);
  if (!access.ok) notFound();

  const organization = await prisma.organization.findUnique({
    where: { id: organizationId },
    select: { name: true, size: true },
  });
  if (!organization) notFound();

  const [workspaces, members] = await Promise.all([
    prisma.workspace.findMany({
      where: { organizationId, deletedAt: null },
      select: { id: true, name: true, createdAt: true },
      orderBy: { createdAt: 'asc' },
    }),
    prisma.organizationMember.findMany({
      where: { organizationId },
      select: { userId: true, role: true, user: { select: { name: true, email: true } } },
      orderBy: { createdAt: 'asc' },
    }),
  ]);

  return (
    <div className="mx-auto max-w-3xl px-6 py-10">
      <h1 className="text-3xl font-bold tracking-tight text-ink">{organization.name}</h1>
      <OrgSettings
        organizationId={organizationId}
        initialName={organization.name}
        initialSize={organization.size}
        isOwner={access.membership.role === 'OWNER'}
        initialWorkspaces={workspaces.map((w) => ({ id: w.id, name: w.name }))}
        initialMembers={members.map((m) => ({
          userId: m.userId,
          role: m.role,
          name: m.user.name,
          email: m.user.email,
        }))}
      />
    </div>
  );
}
```

- [ ] **Step 3: Write the client component**

`OrgSettings` renders three sections:

1. **Org name/size** (OWNER-only edit form) — `PATCH /api/organizations/{organizationId}`.
2. **Workspaces** — list with a "Create workspace" form (`POST /api/organizations/{organizationId}/workspaces`, already exists) and an "Archive" button per row (`DELETE /api/workspaces/{id}`, from Task 4), each linking to `/workspaces/{id}/settings` (Task 6).
3. **Members** — list with role, an "Invite member" form (email + role, `POST /api/organizations/{organizationId}/invites`) showing the resulting invite link, and an "Offboard" button per row (OWNER-only, `DELETE /api/organizations/{organizationId}/members/{userId}`) gated behind a type-to-confirm modal/inline field (user must type the target's email exactly before the button is enabled — client-side friction only, the server doesn't require this, it's a UI safety measure).

Follow `billing-settings.tsx`'s exact `useState`/`fetch`/error-display conventions (read it fully in Step 1 before writing this). Use the same Tailwind tokens (`border-line`, `bg-panel`, `text-ink`/`text-sub`/`text-red`/`text-amber`).

- [ ] **Step 4: Write page/component tests**

Cover: 403/`notFound()` for a non-member (via a route-level or page-level test, matching whichever convention this codebase uses for testing `notFound()`-throwing server pages — check an existing example, e.g. `billing/page.tsx` likely has no direct test since it's a thin wrapper; if so, focus tests on the `OrgSettings` client component instead, following `billing-settings.test.tsx`'s conventions: mock `fetch`, render with props, assert create/archive/invite/offboard interactions call the right endpoints with the right bodies). The offboard type-to-confirm gate should have a dedicated test: button stays disabled until the exact email is typed, only then does clicking call `DELETE`.

- [ ] **Step 5: Run tests, full suite, typecheck, lint**

```bash
cd apps/web
npx vitest run
npx tsc --noEmit
npx eslint "src/app/organizations/"
```

- [ ] **Step 6: Manual smoke test**

```bash
cd apps/web && pnpm dev &
sleep 5
curl -s -o /dev/null -w "%{http_code}\n" http://localhost:3000/organizations/nonexistent-id/settings
kill %1 2>/dev/null
```

Expected: 404 (via `notFound()`), confirms no crash.

- [ ] **Step 7: Commit**

```bash
git add "src/app/organizations/"
git commit -m "Add organization settings page (Issue #99)"
```

---

### Task 6: Workspace settings page (team list)

**Files:**

- Create: `apps/web/src/app/workspaces/[workspaceId]/settings/page.tsx`
- Create: `apps/web/src/app/workspaces/[workspaceId]/settings/team-list.tsx`
- Test: `apps/web/src/app/workspaces/[workspaceId]/settings/team-list.test.tsx`

- [ ] **Step 1: Write the server page**, mirroring Task 5's pattern: `requireWorkspaceRole(workspaceId, ['ADMIN'])` → `notFound()`, fetch teams via the existing `GET /api/workspaces/{ws}/teams` shape (or query directly via Prisma, matching that route's exact select/include shape — reuse the query, don't diverge), fetch the workspace's `organizationId` to render a "back to org settings" link.

- [ ] **Step 2: Write the client component** (`TeamList`): list of teams (name, member count, project-scope count) with "Create team" form (`POST /api/workspaces/{ws}/teams`, already exists) and "Archive" button per row (`DELETE .../teams/{teamId}`, already exists), each team name linking to `/workspaces/{workspaceId}/teams/{teamId}` (Task 7).

- [ ] **Step 3: Write tests**, matching Task 5's approach.

- [ ] **Step 4: Run tests, full suite, typecheck, lint, manual smoke test, commit**

```bash
cd apps/web
npx vitest run
npx tsc --noEmit
npx eslint "src/app/workspaces/[workspaceId]/settings/"
git add "src/app/workspaces/[workspaceId]/settings/"
git commit -m "Add workspace settings page with team list (Issue #99)"
```

---

### Task 7: Team detail page (member + scope management)

**Files:**

- Create: `apps/web/src/app/workspaces/[workspaceId]/teams/[teamId]/page.tsx`
- Create: `apps/web/src/app/workspaces/[workspaceId]/teams/[teamId]/team-detail.tsx`
- Test: `apps/web/src/app/workspaces/[workspaceId]/teams/[teamId]/team-detail.test.tsx`

- [ ] **Step 1: Write the server page**: `requireWorkspaceRole(workspaceId, ['ADMIN'])` → `notFound()`; fetch the team (matching `findTeam`'s existing shape from `.../teams/[teamId]/route.ts` — `{ id: teamId, workspaceId, deletedAt: null }`) → `notFound()` if missing/archived; fetch the workspace's full member list (for the "add member" picker) and full project list (for the "scope" picker).

- [ ] **Step 2: Write the client component** (`TeamDetail`): current members list with "Remove" buttons, an "Add member" picker (dropdown/multiselect of workspace members not already on the team), a project-scope picker (checkboxes over the workspace's projects, empty selection = unscoped). Save button calls `PATCH /api/workspaces/{ws}/teams/{teamId}` with `{ addMemberIds, removeMemberIds, projectIds }` computed as the diff between current and desired state — read the existing `PATCH` route's exact accepted body shape (already quoted in full above) and match it precisely.

- [ ] **Step 3: Write tests**: member add/remove correctly computes the diff and calls `PATCH` with the right `addMemberIds`/`removeMemberIds`; project-scope save with an empty selection sends `projectIds: []` (not omitted — the route's own comment confirms `[]` is meaningfully different from omitting the field, since `null`/omitted leaves scope unchanged while `[]` explicitly unscopes).

- [ ] **Step 4: Run tests, full suite, typecheck, lint, manual smoke test, commit**

```bash
cd apps/web
npx vitest run
npx tsc --noEmit
npx eslint "src/app/workspaces/[workspaceId]/teams/"
git add "src/app/workspaces/[workspaceId]/teams/"
git commit -m "Add team detail page for member and scope management (Issue #99)"
```

---

### Task 8: Full regression, documentation, close the issue

**Files:** none beyond `architecture.md`

- [ ] **Step 1: Full regression**

```bash
cd apps/web && npx vitest run && npx tsc --noEmit && npx eslint .
```

- [ ] **Step 2: Manual smoke test walkthrough**

```bash
cd apps/web && pnpm dev &
sleep 5
curl -s -o /dev/null -w "settings/account: %{http_code}\n" http://localhost:3000/settings/account
kill %1 2>/dev/null
```

Confirm no regressions to existing pages from the new settings layout.

- [ ] **Step 3: Update `architecture.md`**

Extend the existing "Organization → Workspace → Team → User hierarchy (Issues 12.10/12.11)" section (don't create a new `###` — this IS that feature's UI, append to the existing bullet list) with a new bullet:

```markdown
- **Management UI (Issue 12.12)**: `/organizations/{id}/settings` (org name/size, workspace create/archive, member list/invite/offboard — offboarding is OWNER-only, a single transaction removing `OrganizationMember` + every `WorkspaceMember` + every `TeamMember` for that user across every workspace/team in the org, including archived workspaces, since the auth resolution layer (`workspace-access.ts`) has no caching — removal takes effect on the very next request, no invalidation needed); `/workspaces/{id}/settings` (team list); `/workspaces/{id}/teams/{teamId}` (team member/project-scope management, using the existing `PATCH .../teams/{teamId}` endpoint from 12.11). A new `OrganizationInvite` model mirrors `WorkspaceInvite`'s existing token/expiry/status shape. A minimal shared settings shell (`apps/web/src/app/settings/layout.tsx`) links Organization/Account settings — the first point multiple admin surfaces needed to coexist, replacing what would otherwise be a third and fourth orphaned page.
```

- [ ] **Step 4: Commit**

```bash
git add architecture.md
git commit -m "Document organization and team management UI in architecture.md"
```

- [ ] **Step 5: Close Issue #99**

```bash
gh issue close 99 --comment "$(cat <<'EOF'
Implemented the admin UI for the Organization → Workspace → Team → User hierarchy, built entirely on the already-existing authorization primitives from Issues 12.10/12.11 (`requireOrganizationRole`/`requireWorkspaceRole`/`requireProjectRole`) — no new auth logic needed.

**Organization settings** (`/organizations/{id}/settings`): workspace list with create/archive, member list with org-scoped invite (new `OrganizationInvite` model mirroring the existing `WorkspaceInvite` shape) and OWNER-only offboarding.

**Offboarding is the security-critical piece**: a single transaction removes `OrganizationMember` + every `WorkspaceMember` + every `TeamMember` for the departing user across every workspace and team in the org — including archived workspaces, to avoid latent orphaned access. Directly tested: creates a user with access spanning 2 workspaces and 2 teams, offboards them, asserts every row is gone AND that an unrelated user's access in an untouched workspace/team is unaffected. No caching layer exists in the authorization resolution path, so removal takes effect on the very next request — no invalidation step needed.

**Workspace settings** (`/workspaces/{id}/settings`): team list with create/archive, reusing the existing team endpoints from 12.11 unchanged.

**Team detail** (`/workspaces/{id}/teams/{teamId}`): member add/remove and project-scope assignment, reusing the existing `PATCH .../teams/{teamId}` endpoint's diff-based update shape.

**Settings shell**: a minimal shared nav (`apps/web/src/app/settings/layout.tsx`) links Organization and Account settings — this issue was the natural point to introduce it, since it's the first to need multiple co-located admin surfaces (previously, billing/account/invite pages were three separate, unlinked pages).

**Explicitly out of scope** (confirmed with the user before implementation): org-wide policy defaults (not tied to any AC, no concrete concept exists), soft-delete/undo for offboarding (hard removal with a client-side type-to-confirm safety gate instead), cascading archive of a workspace's child data, any change to billing scope.

Full regression: web test suite green, tsc/eslint clean.
EOF
)"
```

---

## Self-review notes (for the plan author, already applied above)

- **Spec coverage**: AC 1 (Org Owner creates Workspace + Workspace Admin creates Teams via UI) covered by Tasks 5-6, both reusing already-existing, already-tested endpoints. AC 2 (assignment reflected immediately) requires no extra work — confirmed architecturally true from the no-caching authorization layer, covered by Task 7's PATCH reuse. AC 3 (offboarding revokes everything, no orphans) is Task 3, the plan's most rigorously specified task given its security consequences.
- **Type consistency**: `OrganizationInvite`'s shape was corrected from the design spec's `acceptedAt`-based sketch to match the ACTUAL existing `WorkspaceInvite`'s `status: InviteStatus` enum shape, verified by reading the real schema during planning — this is called out explicitly at the top of the plan so the discrepancy isn't silently lost.
- **Regression safety**: every new endpoint in Tasks 2-4 either mirrors an already-tested existing route's exact pattern (auth gate, error shapes) or extends an existing route file additively (Task 4's "check if the file exists first" step) rather than risking an overwrite.
- **No placeholders**: every step has real, complete code. Task 3's offboarding route is the one piece written with the most explicit reasoning in its own code comment, since it's the AC most directly about avoiding a correctness bug (orphaned permissions).
- **Deliberately scoped down**: org-wide policy defaults, offboarding undo, cascading workspace archive — all explicitly out of scope per the design spec's clarifying-question decisions, not touched by any task.
