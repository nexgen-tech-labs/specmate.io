import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { prisma } from '@/lib/prisma';

let currentSession: { user: { id: string } } | null = null;
vi.mock('@/lib/auth', () => ({ auth: async () => currentSession }));

const { GET } = await import('./route');

describe('GET /api/me/workspace', () => {
  let userWithWorkspace: { id: string };
  let userWithoutWorkspace: { id: string };
  let workspace: { id: string };
  let secondWorkspace: { id: string };

  beforeAll(async () => {
    userWithWorkspace = await prisma.user.create({
      data: { email: `me-ws-${Date.now()}@test.local`, name: 'X', passwordHash: 'hashed' },
    });
    userWithoutWorkspace = await prisma.user.create({
      data: { email: `me-ws-none-${Date.now()}@test.local`, name: 'Y', passwordHash: 'hashed' },
    });
    workspace = await prisma.workspace.create({ data: { name: 'Me Workspace Test WS' } });
    secondWorkspace = await prisma.workspace.create({ data: { name: 'Me Workspace Test WS 2' } });
    // Two memberships, created in order -- the route should resolve the
    // oldest one, matching the onboarding flow's "your first workspace" idea.
    await prisma.workspaceMember.create({
      data: { workspaceId: workspace.id, userId: userWithWorkspace.id, role: 'ADMIN' },
    });
    await prisma.workspaceMember.create({
      data: { workspaceId: secondWorkspace.id, userId: userWithWorkspace.id, role: 'VIEWER' },
    });
  });

  afterAll(async () => {
    await prisma.workspaceMember.deleteMany({ where: { userId: userWithWorkspace.id } });
    await prisma.workspace.deleteMany({
      where: { id: { in: [workspace.id, secondWorkspace.id] } },
    });
    await prisma.user.deleteMany({
      where: { id: { in: [userWithWorkspace.id, userWithoutWorkspace.id] } },
    });
  });

  it('returns 401 when signed out', async () => {
    currentSession = null;
    const res = await GET(new Request('http://localhost/api/me/workspace'));
    expect(res.status).toBe(401);
  });

  it("returns the signed-in user's oldest workspace membership", async () => {
    currentSession = { user: { id: userWithWorkspace.id } };
    const res = await GET(new Request('http://localhost/api/me/workspace'));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.workspaceId).toBe(workspace.id);
  });

  it('returns workspaceId: null for a signed-in user with no workspace membership', async () => {
    currentSession = { user: { id: userWithoutWorkspace.id } };
    const res = await GET(new Request('http://localhost/api/me/workspace'));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.workspaceId).toBeNull();
  });
});
