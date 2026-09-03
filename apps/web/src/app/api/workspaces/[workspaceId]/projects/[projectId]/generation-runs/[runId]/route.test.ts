// @vitest-environment node
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { prisma } from '@/lib/prisma';

let currentSession: { user: { id: string } } | null = null;

vi.mock('@/lib/auth', () => ({
  auth: async () => currentSession,
}));

const { PATCH } = await import('./route');

function makeRequest(body: unknown = {}): Request {
  return new Request('http://localhost/api/workspaces/x/projects/y/generation-runs/z', {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
}

describe('PATCH .../generation-runs/[runId]', () => {
  let workspace: { id: string };
  let project: { id: string };
  let admin: { id: string };
  let viewer: { id: string };

  beforeAll(async () => {
    workspace = await prisma.workspace.create({ data: { name: 'Gen Run Rename Proxy Test WS' } });
    project = await prisma.project.create({
      data: { workspaceId: workspace.id, name: 'Gen Run Rename Proxy Test Project' },
    });
    admin = await prisma.user.create({
      data: {
        email: `gen-run-rename-admin-${Date.now()}@test.local`,
        name: 'Admin',
        passwordHash: 'x',
      },
    });
    viewer = await prisma.user.create({
      data: {
        email: `gen-run-rename-viewer-${Date.now()}@test.local`,
        name: 'Viewer',
        passwordHash: 'x',
      },
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
    await prisma.project.deleteMany({ where: { id: project.id } });
    await prisma.workspace.deleteMany({ where: { id: workspace.id } });
  });

  const params = () =>
    Promise.resolve({ workspaceId: workspace.id, projectId: project.id, runId: 'run-1' });

  it('returns 401 when no one is signed in', async () => {
    currentSession = null;
    const res = await PATCH(makeRequest({ name: 'x' }), { params: params() });
    expect(res.status).toBe(401);
  });

  it('returns 403 for a VIEWER (renaming is ADMIN/REVIEWER only)', async () => {
    currentSession = { user: { id: viewer.id } };
    const res = await PATCH(makeRequest({ name: 'x' }), { params: params() });
    expect(res.status).toBe(403);
  });

  it('proxies to apps/api and passes through the response status/body', async () => {
    currentSession = { user: { id: admin.id } };
    const fetchMock = vi.fn(
      async () =>
        new Response(
          JSON.stringify({ id: 'run-1', tag: 'payments', name: 'renamed', stage: 'COMPLETE' }),
          { status: 200 },
        ),
    );
    vi.stubGlobal('fetch', fetchMock);

    const res = await PATCH(makeRequest({ name: 'renamed' }), { params: params() });

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      id: 'run-1',
      tag: 'payments',
      name: 'renamed',
      stage: 'COMPLETE',
    });
    expect(fetchMock).toHaveBeenCalledWith(
      expect.stringContaining('/generation-runs/run-1'),
      expect.objectContaining({ method: 'PATCH', body: JSON.stringify({ name: 'renamed' }) }),
    );
    vi.unstubAllGlobals();
  });

  it('passes through a non-200 status from apps/api (e.g. 422 empty name)', async () => {
    currentSession = { user: { id: admin.id } };
    vi.stubGlobal(
      'fetch',
      vi.fn(
        async () =>
          new Response(JSON.stringify({ detail: 'name cannot be empty.' }), { status: 422 }),
      ),
    );

    const res = await PATCH(makeRequest({ name: '   ' }), { params: params() });

    expect(res.status).toBe(422);
    expect(await res.json()).toEqual({ detail: 'name cannot be empty.' });
    vi.unstubAllGlobals();
  });

  it('returns 502 when apps/api is unreachable', async () => {
    currentSession = { user: { id: admin.id } };
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        throw new Error('network down');
      }),
    );

    const res = await PATCH(makeRequest({ name: 'x' }), { params: params() });

    expect(res.status).toBe(502);
    vi.unstubAllGlobals();
  });
});
