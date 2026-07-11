// @vitest-environment node
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { prisma } from '@/lib/prisma';

let currentSession: { user: { id: string } } | null = null;

vi.mock('@/lib/auth', () => ({
  auth: async () => currentSession,
}));

const fetchMock = vi.fn(
  async () => new Response(JSON.stringify({ status: 'PARSED', chunk_count: 2 }), { status: 200 }),
);
vi.stubGlobal('fetch', fetchMock);

const { DELETE } = await import('./route');
const { POST: REPARSE } = await import('./reparse/route');

describe('source delete + reparse routes', () => {
  let workspace: { id: string };
  let project: { id: string };
  let source: { id: string };
  let admin: { id: string };
  let viewer: { id: string };

  beforeAll(async () => {
    workspace = await prisma.workspace.create({ data: { name: 'SrcMgmt Test WS' } });
    project = await prisma.project.create({
      data: { workspaceId: workspace.id, name: 'SrcMgmt Project' },
    });
    source = await prisma.source.create({
      data: { projectId: project.id, name: 'doc.docx', kind: 'DOCX', storageKey: 'k' },
    });
    await prisma.rawRequirement.create({
      data: { sourceId: source.id, text: 'frag', sectionPath: 'p.1', order: 0 },
    });

    admin = await prisma.user.create({
      data: { email: `srcmgmt-admin-${Date.now()}@test.local`, name: 'A', passwordHash: 'x' },
    });
    viewer = await prisma.user.create({
      data: { email: `srcmgmt-viewer-${Date.now()}@test.local`, name: 'V', passwordHash: 'x' },
    });
    await prisma.workspaceMember.create({
      data: { workspaceId: workspace.id, userId: admin.id, role: 'ADMIN' },
    });
    await prisma.workspaceMember.create({
      data: { workspaceId: workspace.id, userId: viewer.id, role: 'VIEWER' },
    });
  });

  afterAll(async () => {
    await prisma.auditEvent.deleteMany({ where: { workspaceId: workspace.id } });
    await prisma.rawRequirement.deleteMany({ where: { sourceId: source.id } });
    await prisma.source.deleteMany({ where: { projectId: project.id } });
    await prisma.workspaceMember.deleteMany({ where: { workspaceId: workspace.id } });
    await prisma.user.deleteMany({ where: { id: { in: [admin.id, viewer.id] } } });
    await prisma.project.deleteMany({ where: { id: project.id } });
    await prisma.workspace.deleteMany({ where: { id: workspace.id } });
  });

  const params = () =>
    Promise.resolve({ workspaceId: workspace.id, projectId: project.id, sourceId: source.id });
  const req = (method: string) => new Request('http://localhost/x', { method });

  it('reparse proxies to apps/api and returns its result', async () => {
    currentSession = { user: { id: admin.id } };
    fetchMock.mockClear();
    const res = await REPARSE(req('POST'), { params: params() });
    expect(res.status).toBe(200);
    expect(fetchMock).toHaveBeenCalledWith(
      expect.stringContaining(`/sources/${source.id}/parse`),
      expect.objectContaining({ method: 'POST' }),
    );
  });

  it('reparse is denied for a VIEWER', async () => {
    currentSession = { user: { id: viewer.id } };
    const res = await REPARSE(req('POST'), { params: params() });
    expect(res.status).toBe(403);
  });

  it('delete is denied for a VIEWER', async () => {
    currentSession = { user: { id: viewer.id } };
    const res = await DELETE(req('DELETE'), { params: params() });
    expect(res.status).toBe(403);
  });

  it('delete soft-deletes the source and its fragments and writes an audit event', async () => {
    currentSession = { user: { id: admin.id } };
    const res = await DELETE(req('DELETE'), { params: params() });
    expect(res.status).toBe(200);

    const deletedSource = await prisma.source.findUnique({ where: { id: source.id } });
    expect(deletedSource?.deletedAt).not.toBeNull();

    const fragments = await prisma.rawRequirement.findMany({ where: { sourceId: source.id } });
    expect(fragments.every((f) => f.deletedAt !== null)).toBe(true);
    expect(fragments.length).toBeGreaterThan(0); // preserved, not hard-deleted

    const audit = await prisma.auditEvent.findFirst({
      where: { entityId: source.id, action: 'source.deleted' },
    });
    expect(audit?.actorUserId).toBe(admin.id);
  });

  it('deleting an already-deleted source returns 404', async () => {
    currentSession = { user: { id: admin.id } };
    const res = await DELETE(req('DELETE'), { params: params() });
    expect(res.status).toBe(404);
  });
});
