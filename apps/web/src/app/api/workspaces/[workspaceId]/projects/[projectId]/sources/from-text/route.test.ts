// @vitest-environment node
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { prisma } from '@/lib/prisma';

let currentSession: { user: { id: string } } | null = null;

vi.mock('@/lib/auth', () => ({
  auth: async () => currentSession,
}));

vi.mock('@/lib/blob-storage', () => ({
  uploadSourceFile: vi.fn(async () => ({ storageKey: 'mock/storage/key.txt' })),
}));

const fetchMock = vi.fn(async () => new Response(null, { status: 200 }));
vi.stubGlobal('fetch', fetchMock);

const { POST } = await import('./route');

function makeRequest(body: unknown): Request {
  return new Request('http://localhost/api/workspaces/x/projects/y/sources/from-text', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
}

describe('POST /api/workspaces/[workspaceId]/projects/[projectId]/sources/from-text', () => {
  let workspace: { id: string };
  let project: { id: string };
  let admin: { id: string };
  let viewer: { id: string };

  beforeAll(async () => {
    workspace = await prisma.workspace.create({ data: { name: 'From-Text Test WS' } });
    project = await prisma.project.create({
      data: { workspaceId: workspace.id, name: 'From-Text Test Project' },
    });
    admin = await prisma.user.create({
      data: { email: `from-text-admin-${Date.now()}@test.local`, name: 'Admin', passwordHash: 'x' },
    });
    viewer = await prisma.user.create({
      data: {
        email: `from-text-viewer-${Date.now()}@test.local`,
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
    await prisma.source.deleteMany({ where: { projectId: project.id } });
    await prisma.workspaceMember.deleteMany({ where: { workspaceId: workspace.id } });
    await prisma.user.deleteMany({ where: { id: { in: [admin.id, viewer.id] } } });
    await prisma.project.deleteMany({ where: { id: project.id } });
    await prisma.workspace.deleteMany({ where: { id: workspace.id } });
  });

  const params = () => Promise.resolve({ workspaceId: workspace.id, projectId: project.id });

  it('returns 401 when no one is signed in', async () => {
    currentSession = null;
    const res = await POST(makeRequest({ text: 'hello' }), { params: params() });
    expect(res.status).toBe(401);
  });

  it('returns 403 for a VIEWER (paste requires ADMIN or REVIEWER)', async () => {
    currentSession = { user: { id: viewer.id } };
    const res = await POST(makeRequest({ text: 'hello' }), { params: params() });
    expect(res.status).toBe(403);
  });

  it('returns 400 when text is missing or blank', async () => {
    currentSession = { user: { id: admin.id } };
    const res = await POST(makeRequest({ text: '   ' }), { params: params() });
    expect(res.status).toBe(400);
  });

  it('creates a TRANSCRIPT Source and triggers parse on valid pasted text', async () => {
    currentSession = { user: { id: admin.id } };
    const before = await prisma.source.count({ where: { projectId: project.id } });
    const res = await POST(
      makeRequest({ name: 'Workshop notes', text: 'Some pasted transcript content.' }),
      { params: params() },
    );
    expect(res.status).toBe(201);
    const body = (await res.json()) as { source: { id: string; kind: string; name: string } };
    expect(body.source.kind).toBe('TRANSCRIPT');
    expect(body.source.name).toBe('Workshop notes');

    const after = await prisma.source.count({ where: { projectId: project.id } });
    expect(after).toBe(before + 1);
    expect(fetchMock).toHaveBeenCalledWith(
      expect.stringContaining(`/sources/${body.source.id}/parse`),
      expect.objectContaining({ method: 'POST' }),
    );
  });

  it('defaults the name to "Pasted transcript" when none is given', async () => {
    currentSession = { user: { id: admin.id } };
    const res = await POST(makeRequest({ text: 'No name provided here.' }), { params: params() });
    expect(res.status).toBe(201);
    const body = (await res.json()) as { source: { name: string } };
    expect(body.source.name).toBe('Pasted transcript');
  });
});
