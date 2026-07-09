import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { prisma } from './prisma';
import { getWorkspaceMembershipForUser, hasRequiredRole } from './workspace-access';

describe('workspace isolation', () => {
  let workspaceA: { id: string };
  let workspaceB: { id: string };
  let userA: { id: string };
  let userB: { id: string };

  beforeAll(async () => {
    workspaceA = await prisma.workspace.create({ data: { name: 'Workspace A' } });
    workspaceB = await prisma.workspace.create({ data: { name: 'Workspace B' } });

    userA = await prisma.user.create({
      data: { email: `user-a-${Date.now()}@test.local`, name: 'User A', passwordHash: 'x' },
    });
    userB = await prisma.user.create({
      data: { email: `user-b-${Date.now()}@test.local`, name: 'User B', passwordHash: 'x' },
    });

    await prisma.workspaceMember.create({
      data: { workspaceId: workspaceA.id, userId: userA.id, role: 'REVIEWER' },
    });
    await prisma.workspaceMember.create({
      data: { workspaceId: workspaceB.id, userId: userB.id, role: 'ADMIN' },
    });
  });

  afterAll(async () => {
    await prisma.workspaceMember.deleteMany({
      where: { workspaceId: { in: [workspaceA.id, workspaceB.id] } },
    });
    await prisma.user.deleteMany({ where: { id: { in: [userA.id, userB.id] } } });
    await prisma.workspace.deleteMany({ where: { id: { in: [workspaceA.id, workspaceB.id] } } });
  });

  it('returns the membership for a user in their own workspace', async () => {
    const membership = await getWorkspaceMembershipForUser(workspaceA.id, userA.id);
    expect(membership?.workspaceId).toBe(workspaceA.id);
    expect(membership?.role).toBe('REVIEWER');
  });

  it('returns null when user A queries workspace B, which they are not a member of', async () => {
    const membership = await getWorkspaceMembershipForUser(workspaceB.id, userA.id);
    expect(membership).toBeNull();
  });

  it('returns null when user B queries workspace A, which they are not a member of', async () => {
    const membership = await getWorkspaceMembershipForUser(workspaceA.id, userB.id);
    expect(membership).toBeNull();
  });

  it('hasRequiredRole rejects a null membership regardless of allowed roles', () => {
    expect(hasRequiredRole(null, ['ADMIN', 'REVIEWER', 'VIEWER'])).toBe(false);
  });

  it('hasRequiredRole rejects a REVIEWER membership against an ADMIN-only allowlist', async () => {
    const membership = await getWorkspaceMembershipForUser(workspaceA.id, userA.id);
    expect(hasRequiredRole(membership, ['ADMIN'])).toBe(false);
  });

  it('hasRequiredRole accepts an ADMIN membership against an ADMIN-only allowlist', async () => {
    const membership = await getWorkspaceMembershipForUser(workspaceB.id, userB.id);
    expect(hasRequiredRole(membership, ['ADMIN'])).toBe(true);
  });
});
