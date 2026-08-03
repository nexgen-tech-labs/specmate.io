// @vitest-environment node
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { prisma } from '@/lib/prisma';

let currentSession: { user: { id: string } } | null = null;

vi.mock('@/lib/auth', () => ({
  auth: async () => currentSession,
}));

const { DELETE } = await import('./route');
const { GET: getWorkspaces } =
  await import('../../organizations/[organizationId]/workspaces/route');

/**
 * Workspace archive endpoint (Issue #99 Task 4): soft-delete via DELETE
 * /api/workspaces/{workspaceId}. Requires workspace ADMIN (direct or
 * org-inherited).
 */
describe('DELETE /api/workspaces/[workspaceId] (Issue #99)', () => {
  let organization: { id: string };
  let owner: { id: string };
  let admin: { id: string };
  let reviewer: { id: string };

  beforeAll(async () => {
    const stamp = Date.now();
    organization = await prisma.organization.create({ data: { name: `Archive Org ${stamp}` } });
    [owner, admin, reviewer] = await Promise.all(
      ['owner', 'admin', 'reviewer'].map((tag) =>
        prisma.user.create({
          data: { email: `ws-archive-${tag}-${stamp}@test.local`, name: tag, passwordHash: 'x' },
        }),
      ),
    );
    await prisma.organizationMember.create({
      data: { organizationId: organization.id, userId: owner.id, role: 'OWNER' },
    });
  });

  afterAll(async () => {
    await prisma.organizationMember.deleteMany({ where: { organizationId: organization.id } });
    await prisma.workspaceMember.deleteMany({
      where: { userId: { in: [owner.id, admin.id, reviewer.id] } },
    });
    await prisma.workspace.deleteMany({ where: { organizationId: organization.id } });
    await prisma.user.deleteMany({ where: { id: { in: [owner.id, admin.id, reviewer.id] } } });
    await prisma.organization.deleteMany({ where: { id: organization.id } });
  });

  function wsParams(id: string) {
    return { params: Promise.resolve({ workspaceId: id }) };
  }

  it('rejects unauthenticated requests with 401', async () => {
    currentSession = null;
    const workspace = await prisma.workspace.create({
      data: { name: 'WS Unauth', organizationId: organization.id },
    });
    const res = await DELETE(
      new Request('http://localhost', { method: 'DELETE' }),
      wsParams(workspace.id),
    );
    expect(res.status).toBe(401);
  });

  it('rejects a non-admin workspace member with 403', async () => {
    const workspace = await prisma.workspace.create({
      data: { name: 'WS Non-Admin', organizationId: organization.id },
    });
    await prisma.workspaceMember.create({
      data: { workspaceId: workspace.id, userId: reviewer.id, role: 'REVIEWER' },
    });
    currentSession = { user: { id: reviewer.id } };
    const res = await DELETE(
      new Request('http://localhost', { method: 'DELETE' }),
      wsParams(workspace.id),
    );
    expect(res.status).toBe(403);

    const fresh = await prisma.workspace.findUnique({ where: { id: workspace.id } });
    expect(fresh?.deletedAt).toBeNull();
  });

  it('archives (soft-deletes) the workspace for a direct workspace ADMIN, and it drops out of the org workspace list', async () => {
    const workspace = await prisma.workspace.create({
      data: { name: 'WS Admin Archive', organizationId: organization.id },
    });
    await prisma.workspaceMember.create({
      data: { workspaceId: workspace.id, userId: admin.id, role: 'ADMIN' },
    });
    // Listing is an org-level endpoint (OWNER/ADMIN of the org), so use the
    // org OWNER fixture to check list membership; the archive itself is
    // performed by the direct workspace ADMIN under test.
    currentSession = { user: { id: owner.id } };
    const listBefore = await getWorkspaces(new Request('http://localhost'), {
      params: Promise.resolve({ organizationId: organization.id }),
    });
    const bodyBefore = (await listBefore.json()) as { workspaces: Array<{ id: string }> };
    expect(bodyBefore.workspaces.some((w) => w.id === workspace.id)).toBe(true);

    currentSession = { user: { id: admin.id } };
    const res = await DELETE(
      new Request('http://localhost', { method: 'DELETE' }),
      wsParams(workspace.id),
    );
    expect(res.status).toBe(200);

    const fresh = await prisma.workspace.findUnique({ where: { id: workspace.id } });
    expect(fresh?.deletedAt).not.toBeNull();

    currentSession = { user: { id: owner.id } };
    const listAfter = await getWorkspaces(new Request('http://localhost'), {
      params: Promise.resolve({ organizationId: organization.id }),
    });
    const bodyAfter = (await listAfter.json()) as { workspaces: Array<{ id: string }> };
    expect(bodyAfter.workspaces.some((w) => w.id === workspace.id)).toBe(false);
  });

  it('allows an org OWNER to archive via role inheritance with no direct WorkspaceMember row', async () => {
    const workspace = await prisma.workspace.create({
      data: { name: 'WS Owner Inherited', organizationId: organization.id },
    });
    currentSession = { user: { id: owner.id } };

    const res = await DELETE(
      new Request('http://localhost', { method: 'DELETE' }),
      wsParams(workspace.id),
    );
    expect(res.status).toBe(200);

    const fresh = await prisma.workspace.findUnique({ where: { id: workspace.id } });
    expect(fresh?.deletedAt).not.toBeNull();

    const directMember = await prisma.workspaceMember.findUnique({
      where: { workspaceId_userId: { workspaceId: workspace.id, userId: owner.id } },
    });
    expect(directMember).toBeNull();
  });
});
