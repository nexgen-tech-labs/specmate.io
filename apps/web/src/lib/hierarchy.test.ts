// @vitest-environment node
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { prisma } from '@/lib/prisma';
import { getAccessibleProjectIds, getWorkspaceMembershipForUser } from './workspace-access';

/**
 * Organization → Workspace → Team → User hierarchy (Issues 12.10/12.11):
 * org-role inheritance, multi-org independence, and team project scoping.
 */
describe('hierarchy access resolution (Issues 12.10/12.11)', () => {
  let orgA: { id: string };
  let orgB: { id: string };
  let w1: { id: string }; // in orgA
  let w2: { id: string }; // in orgA
  let w3: { id: string }; // in orgB
  let wNoOrg: { id: string };
  let owner: { id: string }; // OWNER of orgA
  let orgAdmin: { id: string }; // ADMIN of orgA
  let reviewer: { id: string }; // direct REVIEWER in w1, OWNER of orgB
  let outsider: { id: string };
  let p1: { id: string };
  let p2: { id: string };
  let scopedTeam: { id: string };
  let plainTeam: { id: string };

  beforeAll(async () => {
    const stamp = Date.now();
    orgA = await prisma.organization.create({ data: { name: 'Hierarchy Org A' } });
    orgB = await prisma.organization.create({ data: { name: 'Hierarchy Org B' } });
    w1 = await prisma.workspace.create({ data: { name: 'H W1', organizationId: orgA.id } });
    w2 = await prisma.workspace.create({ data: { name: 'H W2', organizationId: orgA.id } });
    w3 = await prisma.workspace.create({ data: { name: 'H W3', organizationId: orgB.id } });
    wNoOrg = await prisma.workspace.create({ data: { name: 'H W No Org' } });

    [owner, orgAdmin, reviewer, outsider] = await Promise.all(
      ['owner', 'orgadmin', 'reviewer', 'outsider'].map((tag) =>
        prisma.user.create({
          data: { email: `h-${tag}-${stamp}@test.local`, name: tag, passwordHash: 'x' },
        }),
      ),
    );

    await prisma.organizationMember.createMany({
      data: [
        { organizationId: orgA.id, userId: owner.id, role: 'OWNER' },
        { organizationId: orgA.id, userId: orgAdmin.id, role: 'ADMIN' },
        { organizationId: orgB.id, userId: reviewer.id, role: 'OWNER' },
      ],
    });
    await prisma.workspaceMember.create({
      data: { workspaceId: w1.id, userId: reviewer.id, role: 'REVIEWER' },
    });

    p1 = await prisma.project.create({ data: { workspaceId: w1.id, name: 'H P1' } });
    p2 = await prisma.project.create({ data: { workspaceId: w1.id, name: 'H P2' } });

    scopedTeam = await prisma.team.create({ data: { workspaceId: w1.id, name: 'BA Team' } });
    plainTeam = await prisma.team.create({ data: { workspaceId: w1.id, name: 'Announcements' } });
    await prisma.teamMember.createMany({
      data: [
        { teamId: scopedTeam.id, userId: reviewer.id },
        { teamId: plainTeam.id, userId: reviewer.id },
      ],
    });
    await prisma.teamProject.create({ data: { teamId: scopedTeam.id, projectId: p1.id } });
  });

  afterAll(async () => {
    await prisma.teamProject.deleteMany({
      where: { teamId: { in: [scopedTeam.id, plainTeam.id] } },
    });
    await prisma.teamMember.deleteMany({
      where: { teamId: { in: [scopedTeam.id, plainTeam.id] } },
    });
    await prisma.team.deleteMany({ where: { workspaceId: w1.id } });
    await prisma.project.deleteMany({ where: { workspaceId: w1.id } });
    await prisma.workspaceMember.deleteMany({ where: { workspaceId: w1.id } });
    await prisma.organizationMember.deleteMany({
      where: { organizationId: { in: [orgA.id, orgB.id] } },
    });
    await prisma.workspace.deleteMany({
      where: { id: { in: [w1.id, w2.id, w3.id, wNoOrg.id] } },
    });
    await prisma.organization.deleteMany({ where: { id: { in: [orgA.id, orgB.id] } } });
    await prisma.user.deleteMany({
      where: { id: { in: [owner.id, orgAdmin.id, reviewer.id, outsider.id] } },
    });
  });

  it('org OWNER has implicit effective ADMIN in every workspace of the org (12.11 inheritance)', async () => {
    for (const ws of [w1, w2]) {
      const membership = await getWorkspaceMembershipForUser(ws.id, owner.id);
      expect(membership?.role).toBe('ADMIN');
      expect(membership?.via).toBe('ORGANIZATION');
      expect(membership?.orgRole).toBe('OWNER');
    }
  });

  it('org ADMIN inherits the same effective workspace ADMIN as OWNER', async () => {
    const membership = await getWorkspaceMembershipForUser(w2.id, orgAdmin.id);
    expect(membership?.role).toBe('ADMIN');
    expect(membership?.orgRole).toBe('ADMIN');
  });

  it('org roles do not leak across organizations', async () => {
    // orgA's owner has nothing in orgB's workspace, nor in the org-less workspace.
    expect(await getWorkspaceMembershipForUser(w3.id, owner.id)).toBeNull();
    expect(await getWorkspaceMembershipForUser(wNoOrg.id, owner.id)).toBeNull();
  });

  it('a user holds independent roles in different organizations (12.10 AC 2)', async () => {
    // reviewer: direct REVIEWER in orgA's w1, but org OWNER of orgB → ADMIN in w3.
    const inW1 = await getWorkspaceMembershipForUser(w1.id, reviewer.id);
    expect(inW1?.role).toBe('REVIEWER');
    expect(inW1?.via).toBe('WORKSPACE');

    const inW3 = await getWorkspaceMembershipForUser(w3.id, reviewer.id);
    expect(inW3?.role).toBe('ADMIN');
    expect(inW3?.via).toBe('ORGANIZATION');
  });

  it('non-members get null, exactly as in the flat model', async () => {
    expect(await getWorkspaceMembershipForUser(w1.id, outsider.id)).toBeNull();
  });

  it('a project-scoped team restricts a reviewer to its projects; unscoped teams never restrict', async () => {
    const membership = await getWorkspaceMembershipForUser(w1.id, reviewer.id);
    const ids = await getAccessibleProjectIds(w1.id, membership!);
    expect(ids).not.toBeNull();
    expect([...ids!]).toEqual([p1.id]);
    expect(ids!.has(p2.id)).toBe(false); // p2 hidden; the plain team adds nothing
  });

  it('effective ADMINs are never restricted by team scope', async () => {
    const membership = await getWorkspaceMembershipForUser(w1.id, owner.id);
    expect(await getAccessibleProjectIds(w1.id, membership!)).toBeNull();
  });

  it('a reviewer in no project-scoped team keeps whole-workspace visibility (backward compat)', async () => {
    await prisma.teamProject.deleteMany({ where: { teamId: scopedTeam.id } });
    const membership = await getWorkspaceMembershipForUser(w1.id, reviewer.id);
    expect(await getAccessibleProjectIds(w1.id, membership!)).toBeNull();
    // restore for other tests / cleanup determinism
    await prisma.teamProject.create({ data: { teamId: scopedTeam.id, projectId: p1.id } });
  });
});
