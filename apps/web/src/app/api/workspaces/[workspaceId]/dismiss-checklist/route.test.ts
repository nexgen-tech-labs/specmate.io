// @vitest-environment node
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { prisma } from '@/lib/prisma';

let currentSession: { user: { id: string } } | null = null;

vi.mock('@/lib/auth', () => ({
  auth: async () => currentSession,
}));

const { POST } = await import('./route');

describe('POST /api/workspaces/[workspaceId]/dismiss-checklist', () => {
  let workspace: { id: string };
  let admin: { id: string };
  let outsider: { id: string };

  beforeAll(async () => {
    workspace = await prisma.workspace.create({ data: { name: 'Dismiss Checklist Test WS' } });
    admin = await prisma.user.create({
      data: { email: `dismiss-admin-${Date.now()}@test.local`, name: 'Admin', passwordHash: 'x' },
    });
    outsider = await prisma.user.create({
      data: {
        email: `dismiss-outsider-${Date.now()}@test.local`,
        name: 'Outsider',
        passwordHash: 'x',
      },
    });
    await prisma.workspaceMember.create({
      data: { workspaceId: workspace.id, userId: admin.id, role: 'ADMIN' },
    });
  });

  afterAll(async () => {
    await prisma.workspaceMember.deleteMany({ where: { workspaceId: workspace.id } });
    await prisma.user.deleteMany({ where: { id: { in: [admin.id, outsider.id] } } });
    await prisma.workspace.deleteMany({ where: { id: workspace.id } });
  });

  const params = () => Promise.resolve({ workspaceId: workspace.id });

  it('returns 401 when no one is signed in', async () => {
    currentSession = null;
    const res = await POST(new Request('http://localhost/x', { method: 'POST' }), {
      params: params(),
    });
    expect(res.status).toBe(401);
  });

  it('returns 403 for someone not in the workspace', async () => {
    currentSession = { user: { id: outsider.id } };
    const res = await POST(new Request('http://localhost/x', { method: 'POST' }), {
      params: params(),
    });
    expect(res.status).toBe(403);
  });

  it('sets onboardingChecklistDismissedAt for a member', async () => {
    currentSession = { user: { id: admin.id } };
    const res = await POST(new Request('http://localhost/x', { method: 'POST' }), {
      params: params(),
    });
    expect(res.status).toBe(200);

    const updated = await prisma.workspace.findUniqueOrThrow({ where: { id: workspace.id } });
    expect(updated.onboardingChecklistDismissedAt).not.toBeNull();
  });
});
