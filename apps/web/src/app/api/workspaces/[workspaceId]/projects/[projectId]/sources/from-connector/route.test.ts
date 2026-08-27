// @vitest-environment node
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { prisma } from '@/lib/prisma';

let currentSession: { user: { id: string } } | null = null;

vi.mock('@/lib/auth', () => ({
  auth: async () => currentSession,
}));

const fetchMock = vi.fn(
  async () =>
    new Response(
      JSON.stringify({ source_id: 's1', name: 'PAY', status: 'PARSED', chunk_count: 3 }),
      { status: 200 },
    ),
);
vi.stubGlobal('fetch', fetchMock);

const { POST } = await import('./route');

function makeRequest(body: unknown): Request {
  return new Request('http://localhost/api/workspaces/x/projects/y/sources/from-connector', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
}

describe('POST /api/workspaces/[workspaceId]/projects/[projectId]/sources/from-connector', () => {
  let workspace: { id: string };
  let project: { id: string };
  let admin: { id: string };
  let viewer: { id: string };

  beforeAll(async () => {
    workspace = await prisma.workspace.create({ data: { name: 'From-Connector Test WS' } });
    project = await prisma.project.create({
      data: { workspaceId: workspace.id, name: 'From-Connector Test Project' },
    });
    admin = await prisma.user.create({
      data: { email: `from-conn-admin-${Date.now()}@test.local`, name: 'Admin', passwordHash: 'x' },
    });
    viewer = await prisma.user.create({
      data: {
        email: `from-conn-viewer-${Date.now()}@test.local`,
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

  const params = () => Promise.resolve({ workspaceId: workspace.id, projectId: project.id });

  it('returns 401 when no one is signed in', async () => {
    currentSession = null;
    const res = await POST(makeRequest({ tool: 'jira', remote: 'PAY' }), { params: params() });
    expect(res.status).toBe(401);
  });

  it('returns 403 for a VIEWER', async () => {
    currentSession = { user: { id: viewer.id } };
    const res = await POST(makeRequest({ tool: 'jira', remote: 'PAY' }), { params: params() });
    expect(res.status).toBe(403);
  });

  it('returns 400 when tool or remote is missing', async () => {
    currentSession = { user: { id: admin.id } };
    const res = await POST(makeRequest({ tool: 'jira' }), { params: params() });
    expect(res.status).toBe(400);
  });

  it('proxies to apps/api and returns its response on success', async () => {
    currentSession = { user: { id: admin.id } };
    const res = await POST(makeRequest({ tool: 'jira', remote: 'PAY' }), { params: params() });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { source_id: string };
    expect(body.source_id).toBe('s1');
    expect(fetchMock).toHaveBeenCalledWith(
      expect.stringContaining(`/projects/${project.id}/sources/from-connector/jira`),
      expect.objectContaining({ method: 'POST' }),
    );
  });
});
