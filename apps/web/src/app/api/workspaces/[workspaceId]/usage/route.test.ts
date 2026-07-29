import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { prisma } from '@/lib/prisma';

let currentSession: { user: { id: string } } | null = null;

vi.mock('@/lib/auth', () => ({
  auth: async () => currentSession,
}));

const { GET } = await import('./route');

describe('GET /api/workspaces/[workspaceId]/usage', () => {
  let workspace: { id: string };
  let admin: { id: string };
  let viewer: { id: string };

  beforeAll(async () => {
    workspace = await prisma.workspace.create({
      data: { name: 'Usage Route Test', pricingTier: 'STARTER' },
    });
    admin = await prisma.user.create({
      data: { email: `usage-admin-${Date.now()}@test.local`, name: 'Admin', passwordHash: 'x' },
    });
    viewer = await prisma.user.create({
      data: { email: `usage-viewer-${Date.now()}@test.local`, name: 'Viewer', passwordHash: 'x' },
    });
    await prisma.workspaceMember.create({
      data: { workspaceId: workspace.id, userId: admin.id, role: 'ADMIN' },
    });
    await prisma.workspaceMember.create({
      data: { workspaceId: workspace.id, userId: viewer.id, role: 'VIEWER' },
    });
  });

  afterAll(async () => {
    await prisma.workspaceMember.deleteMany({ where: { workspaceId: workspace.id } });
    await prisma.user.deleteMany({ where: { id: { in: [admin.id, viewer.id] } } });
    await prisma.workspace.deleteMany({ where: { id: workspace.id } });
  });

  function makeRequest() {
    return new Request(`http://localhost/api/workspaces/${workspace.id}/usage`);
  }

  it('returns 401 when no one is signed in', async () => {
    currentSession = null;
    const res = await GET(makeRequest(), {
      params: Promise.resolve({ workspaceId: workspace.id }),
    });
    expect(res.status).toBe(401);
  });

  it('returns 403 for a workspace VIEWER (not ADMIN)', async () => {
    currentSession = { user: { id: viewer.id } };
    const res = await GET(makeRequest(), {
      params: Promise.resolve({ workspaceId: workspace.id }),
    });
    expect(res.status).toBe(403);
  });

  it('returns 200 with the UsageSummary shape for a workspace ADMIN', async () => {
    currentSession = { user: { id: admin.id } };
    const res = await GET(makeRequest(), {
      params: Promise.resolve({ workspaceId: workspace.id }),
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toMatchObject({
      publishedItemCount: 0,
      includedItems: 50,
      remaining: 50,
      overageCount: 0,
      percentUsed: 0,
      tier: 'STARTER',
    });
    expect(typeof body.periodStart).toBe('string');
    expect(typeof body.periodEnd).toBe('string');
  });
});
