import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { prisma } from '@/lib/prisma';

let currentSession: { user: { id: string } } | null = null;
vi.mock('@/lib/auth', () => ({ auth: async () => currentSession }));

const { DELETE } = await import('./route');

describe('DELETE /api/organizations/[organizationId]/members/[userId] — offboarding', () => {
  let org: { id: string };
  let owner: { id: string };
  let departing: { id: string };
  let stayingUser: { id: string };
  let workspaceA: { id: string };
  let workspaceB: { id: string };
  let untouchedWorkspace: { id: string };
  let teamInA: { id: string };
  let teamInB: { id: string };
  let untouchedTeam: { id: string };
  let untouchedMembership: { id: string };
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
    stayingUser = await prisma.user.create({
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

    workspaceA = await prisma.workspace.create({ data: { name: 'WS A', organizationId: org.id } });
    workspaceB = await prisma.workspace.create({ data: { name: 'WS B', organizationId: org.id } });
    untouchedWorkspace = await prisma.workspace.create({
      data: { name: 'WS Untouched', organizationId: org.id },
    });

    await prisma.workspaceMember.create({
      data: { workspaceId: workspaceA.id, userId: departing.id, role: 'ADMIN' },
    });
    await prisma.workspaceMember.create({
      data: { workspaceId: workspaceB.id, userId: departing.id, role: 'REVIEWER' },
    });
    const um = await prisma.workspaceMember.create({
      data: { workspaceId: untouchedWorkspace.id, userId: stayingUser.id, role: 'ADMIN' },
    });
    untouchedMembership = um;

    teamInA = await prisma.team.create({ data: { workspaceId: workspaceA.id, name: 'Team A' } });
    teamInB = await prisma.team.create({ data: { workspaceId: workspaceB.id, name: 'Team B' } });
    untouchedTeam = await prisma.team.create({
      data: { workspaceId: untouchedWorkspace.id, name: 'Untouched Team' },
    });

    await prisma.teamMember.create({ data: { teamId: teamInA.id, userId: departing.id } });
    await prisma.teamMember.create({ data: { teamId: teamInB.id, userId: departing.id } });
    const utm = await prisma.teamMember.create({
      data: { teamId: untouchedTeam.id, userId: stayingUser.id },
    });
    untouchedTeamMember = utm;
  });

  afterAll(async () => {
    const userIds = [owner.id, departing.id, stayingUser.id];
    const workspaceIds = [workspaceA.id, workspaceB.id, untouchedWorkspace.id];
    // AuditEvent is trigger-protected (append-only, Issue 8.1); test-database cleanup
    // is the one sanctioned use of the maintenance GUC, and it must share the trigger's
    // session — hence a single transaction (see src/lib/review.test.ts).
    await prisma.$transaction([
      prisma.$executeRawUnsafe(`SET LOCAL specmate.maintenance = 'on'`),
      prisma.auditEvent.deleteMany({ where: { workspaceId: { in: workspaceIds } } }),
    ]);
    await prisma.teamMember.deleteMany({ where: { userId: { in: userIds } } });
    await prisma.team.deleteMany({ where: { workspaceId: { in: workspaceIds } } });
    await prisma.workspaceMember.deleteMany({ where: { workspaceId: { in: workspaceIds } } });
    await prisma.workspace.deleteMany({ where: { id: { in: workspaceIds } } });
    await prisma.organizationMember.deleteMany({ where: { organizationId: org.id } });
    await prisma.organization.delete({ where: { id: org.id } });
    await prisma.user.deleteMany({ where: { id: { in: userIds } } });
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

  it('removes ALL of the departing user access org-wide, and nothing else, with audit events per affected workspace', async () => {
    currentSession = { user: { id: owner.id } };
    const res = await DELETE(makeRequest(), {
      params: Promise.resolve({ organizationId: org.id, userId: departing.id }),
    });
    expect(res.status).toBe(200);

    const orgMembership = await prisma.organizationMember.findUnique({
      where: { organizationId_userId: { organizationId: org.id, userId: departing.id } },
    });
    expect(orgMembership).toBeNull();

    const remainingWorkspaceMemberships = await prisma.workspaceMember.findMany({
      where: { userId: departing.id, workspaceId: { in: [workspaceA.id, workspaceB.id] } },
    });
    expect(remainingWorkspaceMemberships).toHaveLength(0);

    const remainingTeamMemberships = await prisma.teamMember.findMany({
      where: { userId: departing.id, teamId: { in: [teamInA.id, teamInB.id] } },
    });
    expect(remainingTeamMemberships).toHaveLength(0);

    // A DIFFERENT user's membership/team-membership in an unrelated workspace/team is untouched.
    const untouchedStillThere = await prisma.workspaceMember.findUnique({
      where: { id: untouchedMembership.id },
    });
    expect(untouchedStillThere).not.toBeNull();
    const untouchedTeamMemberStillThere = await prisma.teamMember.findUnique({
      where: { id: untouchedTeamMember.id },
    });
    expect(untouchedTeamMemberStillThere).not.toBeNull();

    // Audit events: one per affected workspace (A and B), NONE for the untouched workspace.
    const auditEvents = await prisma.auditEvent.findMany({
      where: { entityId: departing.id, entityType: 'User', action: 'user.offboarded' },
    });
    const auditedWorkspaceIds = auditEvents.map((e) => e.workspaceId).sort();
    expect(auditedWorkspaceIds).toEqual([workspaceA.id, workspaceB.id].sort());
    for (const event of auditEvents) {
      expect(event.actorUserId).toBe(owner.id);
    }
  });

  it('returns 409 and does not remove the last OWNER of an organization, even self-offboarding', async () => {
    const soleOwnerOrg = await prisma.organization.create({ data: { name: 'Sole Owner Org' } });
    const soleOwner = await prisma.user.create({
      data: { email: `sole-owner-${Date.now()}@test.local`, name: 'Sole', passwordHash: 'x' },
    });
    await prisma.organizationMember.create({
      data: { organizationId: soleOwnerOrg.id, userId: soleOwner.id, role: 'OWNER' },
    });

    currentSession = { user: { id: soleOwner.id } };
    const res = await DELETE(makeRequest(), {
      params: Promise.resolve({ organizationId: soleOwnerOrg.id, userId: soleOwner.id }),
    });
    expect(res.status).toBe(409);

    const stillThere = await prisma.organizationMember.findUnique({
      where: { organizationId_userId: { organizationId: soleOwnerOrg.id, userId: soleOwner.id } },
    });
    expect(stillThere).not.toBeNull();

    await prisma.organizationMember.deleteMany({ where: { organizationId: soleOwnerOrg.id } });
    await prisma.organization.delete({ where: { id: soleOwnerOrg.id } });
    await prisma.user.delete({ where: { id: soleOwner.id } });
  });

  it('allows removing an OWNER when another OWNER remains', async () => {
    const twoOwnerOrg = await prisma.organization.create({ data: { name: 'Two Owner Org' } });
    const ownerOne = await prisma.user.create({
      data: { email: `owner-one-${Date.now()}@test.local`, name: 'One', passwordHash: 'x' },
    });
    const ownerTwo = await prisma.user.create({
      data: { email: `owner-two-${Date.now()}@test.local`, name: 'Two', passwordHash: 'x' },
    });
    await prisma.organizationMember.create({
      data: { organizationId: twoOwnerOrg.id, userId: ownerOne.id, role: 'OWNER' },
    });
    await prisma.organizationMember.create({
      data: { organizationId: twoOwnerOrg.id, userId: ownerTwo.id, role: 'OWNER' },
    });

    currentSession = { user: { id: ownerOne.id } };
    const res = await DELETE(makeRequest(), {
      params: Promise.resolve({ organizationId: twoOwnerOrg.id, userId: ownerTwo.id }),
    });
    expect(res.status).toBe(200);

    const removed = await prisma.organizationMember.findUnique({
      where: { organizationId_userId: { organizationId: twoOwnerOrg.id, userId: ownerTwo.id } },
    });
    expect(removed).toBeNull();

    await prisma.organizationMember.deleteMany({ where: { organizationId: twoOwnerOrg.id } });
    await prisma.organization.delete({ where: { id: twoOwnerOrg.id } });
    await prisma.user.deleteMany({ where: { id: { in: [ownerOne.id, ownerTwo.id] } } });
  });

  it('returns 404 if the target userId has no organization membership', async () => {
    currentSession = { user: { id: owner.id } };
    const neverMember = await prisma.user.create({
      data: { email: `never-member-${Date.now()}@test.local`, name: 'Never', passwordHash: 'x' },
    });
    const res = await DELETE(makeRequest(), {
      params: Promise.resolve({ organizationId: org.id, userId: neverMember.id }),
    });
    expect(res.status).toBe(404);
    await prisma.user.delete({ where: { id: neverMember.id } });
  });
});
