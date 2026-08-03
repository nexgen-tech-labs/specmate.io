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

    expect(organization.name).toBe("Ada's Org");
    expect(organization.size).toBe('SOLO');
    expect(workspace.name).toBe("Ada's Workspace");
    expect(workspace.organizationId).toBe(organization.id);

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
    const { user, workspace, organization } = await createTenantForNewUser({
      name: 'OAuth User',
      email: `tenant-oauth-test-${Date.now()}@test.local`,
      passwordHash: null,
      orgName: "OAuth User's Org",
      orgSize: 'SOLO',
      workspaceName: "OAuth User's Workspace",
    });
    createdUserIds.push(user.id);
    createdWorkspaceIds.push(workspace.id);
    createdOrgIds.push(organization.id);

    expect(user.passwordHash).toBeNull();
  });
});
