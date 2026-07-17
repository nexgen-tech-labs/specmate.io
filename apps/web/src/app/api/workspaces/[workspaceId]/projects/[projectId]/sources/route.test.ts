// @vitest-environment node
//
// Overrides the project-wide jsdom environment (vitest.config.ts) for this file only.
// jsdom ships its own File/FormData/Request polyfills that don't interoperate with the
// Next.js route handler's native (Node/undici) Request.formData() parsing — `file
// instanceof File` fails across the two realms. The node environment uses a single,
// consistent set of these globals, matching what the route actually runs under in prod.
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

const { POST, GET } = await import('./route');

interface FakeFile {
  name: string;
  type: string;
  sizeBytes: number;
}

function makeFile(name: string, type: string, sizeBytes: number): FakeFile {
  return { name, type, sizeBytes };
}

// The test environment is jsdom (for component tests elsewhere in the suite), whose
// File/FormData/Request polyfills don't interoperate with the Next.js route handler's
// native (Node) Request.formData() parsing — so the multipart body is built by hand here
// instead of relying on `new Request({ body: new FormData() })`.
function makeUploadRequest(file: FakeFile, previousVersionId?: string): Request {
  const boundary = '----vitest-boundary';
  const fileBuffer = Buffer.alloc(file.sizeBytes);

  const parts = [
    Buffer.from(
      `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="${file.name}"\r\nContent-Type: ${file.type}\r\n\r\n`,
    ),
    fileBuffer,
    Buffer.from(`\r\n`),
  ];
  if (previousVersionId) {
    parts.push(
      Buffer.from(
        `--${boundary}\r\nContent-Disposition: form-data; name="previousVersionId"\r\n\r\n${previousVersionId}\r\n`,
      ),
    );
  }
  parts.push(Buffer.from(`--${boundary}--\r\n`));

  return new Request('http://localhost/api/workspaces/x/projects/y/sources', {
    method: 'POST',
    headers: { 'Content-Type': `multipart/form-data; boundary=${boundary}` },
    body: Buffer.concat(parts),
  });
}

describe('POST /api/workspaces/[workspaceId]/projects/[projectId]/sources', () => {
  let workspace: { id: string };
  let otherWorkspace: { id: string };
  let project: { id: string };
  let admin: { id: string };
  let viewer: { id: string };
  let outsider: { id: string };

  beforeAll(async () => {
    workspace = await prisma.workspace.create({ data: { name: 'Upload Test WS' } });
    otherWorkspace = await prisma.workspace.create({ data: { name: 'Upload Test WS Other' } });
    project = await prisma.project.create({
      data: { workspaceId: workspace.id, name: 'Upload Test Project' },
    });

    admin = await prisma.user.create({
      data: { email: `upload-admin-${Date.now()}@test.local`, name: 'Admin', passwordHash: 'x' },
    });
    viewer = await prisma.user.create({
      data: { email: `upload-viewer-${Date.now()}@test.local`, name: 'Viewer', passwordHash: 'x' },
    });
    outsider = await prisma.user.create({
      data: {
        email: `upload-outsider-${Date.now()}@test.local`,
        name: 'Outsider',
        passwordHash: 'x',
      },
    });

    await prisma.workspaceMember.create({
      data: { workspaceId: workspace.id, userId: admin.id, role: 'ADMIN' },
    });
    await prisma.workspaceMember.create({
      data: { workspaceId: workspace.id, userId: viewer.id, role: 'VIEWER' },
    });
    await prisma.workspaceMember.create({
      data: { workspaceId: otherWorkspace.id, userId: outsider.id, role: 'ADMIN' },
    });
  });

  afterAll(async () => {
    await prisma.source.deleteMany({ where: { projectId: project.id } });
    await prisma.workspaceMember.deleteMany({
      where: { workspaceId: { in: [workspace.id, otherWorkspace.id] } },
    });
    await prisma.user.deleteMany({ where: { id: { in: [admin.id, viewer.id, outsider.id] } } });
    await prisma.project.deleteMany({ where: { id: project.id } });
    await prisma.workspace.deleteMany({ where: { id: { in: [workspace.id, otherWorkspace.id] } } });
  });

  const params = () => Promise.resolve({ workspaceId: workspace.id, projectId: project.id });

  it('returns 401 when no one is signed in', async () => {
    currentSession = null;
    const res = await POST(makeUploadRequest(makeFile('a.pdf', 'application/pdf', 100)), {
      params: params(),
    });
    expect(res.status).toBe(401);
  });

  it('returns 403 for a member of a different workspace', async () => {
    currentSession = { user: { id: outsider.id } };
    const res = await POST(makeUploadRequest(makeFile('a.pdf', 'application/pdf', 100)), {
      params: params(),
    });
    expect(res.status).toBe(403);
  });

  it('returns 403 for a VIEWER (upload requires ADMIN or REVIEWER)', async () => {
    currentSession = { user: { id: viewer.id } };
    const res = await POST(makeUploadRequest(makeFile('a.pdf', 'application/pdf', 100)), {
      params: params(),
    });
    expect(res.status).toBe(403);
  });

  it('rejects an unsupported file type with 400 and creates no Source row', async () => {
    currentSession = { user: { id: admin.id } };
    const before = await prisma.source.count({ where: { projectId: project.id } });
    const res = await POST(makeUploadRequest(makeFile('a.exe', 'application/x-msdownload', 100)), {
      params: params(),
    });
    expect(res.status).toBe(400);
    const after = await prisma.source.count({ where: { projectId: project.id } });
    expect(after).toBe(before);
  });

  it('rejects an oversized file with 400 and creates no Source row', async () => {
    currentSession = { user: { id: admin.id } };
    const before = await prisma.source.count({ where: { projectId: project.id } });
    const res = await POST(
      makeUploadRequest(makeFile('big.pdf', 'application/pdf', 26 * 1024 * 1024)),
      {
        params: params(),
      },
    );
    expect(res.status).toBe(400);
    const after = await prisma.source.count({ where: { projectId: project.id } });
    expect(after).toBe(before);
  });

  it('accepts a valid upload and creates a fully-populated Source row', async () => {
    currentSession = { user: { id: admin.id } };
    const res = await POST(makeUploadRequest(makeFile('reqs.pdf', 'application/pdf', 1234)), {
      params: params(),
    });
    expect(res.status).toBe(201);
    const body: {
      source: {
        id: string;
        storageKey: string;
        sizeBytes: number;
        mimeType: string;
        scanStatus: string;
      };
    } = await res.json();
    expect(body.source.storageKey).toBe('mock/storage/key.txt');
    expect(body.source.sizeBytes).toBe(1234);
    expect(body.source.mimeType).toBe('application/pdf');
    expect(body.source.scanStatus).toBe('CLEAN');

    const source = await prisma.source.findUnique({ where: { id: body.source.id } });
    expect(source?.kind).toBe('PDF');
    expect(source?.status).toBe('QUEUED');
  });

  it('triggers a parse call to apps/api for a DOCX upload', async () => {
    currentSession = { user: { id: admin.id } };
    fetchMock.mockClear();
    const res = await POST(
      makeUploadRequest(
        makeFile(
          'reqs.docx',
          'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
          1234,
        ),
      ),
      { params: params() },
    );
    expect(res.status).toBe(201);
    const body: { source: { id: string } } = await res.json();

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock).toHaveBeenCalledWith(
      expect.stringContaining(`/sources/${body.source.id}/parse`),
      expect.objectContaining({ method: 'POST' }),
    );
  });

  it('triggers a parse call for every parseable kind (CSV shown here)', async () => {
    // As of Issue #10/#11 every uploadable kind (DOCX/PDF/XLSX/CSV/TXT) has a parser,
    // so uploads of any accepted type fire the parse trigger.
    currentSession = { user: { id: admin.id } };
    fetchMock.mockClear();
    const res = await POST(makeUploadRequest(makeFile('reqs.csv', 'text/csv', 100)), {
      params: params(),
    });
    expect(res.status).toBe(201);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('auto-detects a new version by filename similarity (v3 -> v4)', async () => {
    currentSession = { user: { id: admin.id } };
    const v3 = await POST(
      makeUploadRequest(makeFile('Client-Requirements-v3.docx', 'application/pdf', 100)),
      { params: params() },
    );
    const v3Body: { source: { id: string; version: number } } = await v3.json();
    expect(v3Body.source.version).toBe(1);

    const v4 = await POST(
      makeUploadRequest(makeFile('Client-Requirements-v4.docx', 'application/pdf', 100)),
      { params: params() },
    );
    expect(v4.status).toBe(201);
    const v4Body: {
      source: { id: string; version: number; previousVersionId: string | null };
    } = await v4.json();
    expect(v4Body.source.version).toBe(2);
    expect(v4Body.source.previousVersionId).toBe(v3Body.source.id);

    // Previous version's Source row is untouched, not overwritten.
    const previous = await prisma.source.findUnique({ where: { id: v3Body.source.id } });
    expect(previous).not.toBeNull();
    expect(previous?.deletedAt).toBeNull();
  });

  it('an unrelated filename is not treated as a new version', async () => {
    currentSession = { user: { id: admin.id } };
    const res = await POST(
      makeUploadRequest(makeFile('Totally-Unrelated-Doc.docx', 'application/pdf', 100)),
      { params: params() },
    );
    const body: { source: { version: number; previousVersionId: string | null } } =
      await res.json();
    expect(body.source.version).toBe(1);
    expect(body.source.previousVersionId).toBeNull();
  });

  it('explicit previousVersionId overrides filename-based auto-detection', async () => {
    currentSession = { user: { id: admin.id } };
    const original = await POST(
      makeUploadRequest(makeFile('Backlog-Export.xlsx', 'text/csv', 100)),
      { params: params() },
    );
    const originalBody: { source: { id: string } } = await original.json();

    const linked = await POST(
      makeUploadRequest(
        makeFile('Completely-Different-Name.xlsx', 'text/csv', 100),
        originalBody.source.id,
      ),
      { params: params() },
    );
    expect(linked.status).toBe(201);
    const linkedBody: { source: { version: number; previousVersionId: string | null } } =
      await linked.json();
    expect(linkedBody.source.version).toBe(2);
    expect(linkedBody.source.previousVersionId).toBe(originalBody.source.id);
  });

  it('does not fail the upload response when the parse trigger call fails', async () => {
    currentSession = { user: { id: admin.id } };
    fetchMock.mockClear();
    fetchMock.mockImplementationOnce(async () => {
      throw new Error('network error');
    });

    const res = await POST(
      makeUploadRequest(
        makeFile(
          'reqs2.docx',
          'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
          1234,
        ),
      ),
      { params: params() },
    );
    expect(res.status).toBe(201);
  });
});

describe('GET /api/workspaces/[workspaceId]/projects/[projectId]/sources', () => {
  let workspace: { id: string };
  let project: { id: string };
  let viewer: { id: string };

  beforeAll(async () => {
    workspace = await prisma.workspace.create({ data: { name: 'List Test WS' } });
    project = await prisma.project.create({
      data: { workspaceId: workspace.id, name: 'List Test Project' },
    });
    viewer = await prisma.user.create({
      data: { email: `list-viewer-${Date.now()}@test.local`, name: 'Viewer', passwordHash: 'x' },
    });
    await prisma.workspaceMember.create({
      data: { workspaceId: workspace.id, userId: viewer.id, role: 'VIEWER' },
    });
    await prisma.source.create({
      data: { projectId: project.id, name: 'existing.pdf', kind: 'PDF', storageKey: 'k' },
    });
  });

  afterAll(async () => {
    await prisma.source.deleteMany({ where: { projectId: project.id } });
    await prisma.workspaceMember.deleteMany({ where: { workspaceId: workspace.id } });
    await prisma.user.deleteMany({ where: { id: viewer.id } });
    await prisma.project.deleteMany({ where: { id: project.id } });
    await prisma.workspace.deleteMany({ where: { id: workspace.id } });
  });

  it('lets a VIEWER list sources (read-only access is enough)', async () => {
    currentSession = { user: { id: viewer.id } };
    const res = await GET(new Request('http://localhost/api/workspaces/x/projects/y/sources'), {
      params: Promise.resolve({ workspaceId: workspace.id, projectId: project.id }),
    });
    expect(res.status).toBe(200);
    const body: { sources: Array<{ name: string }> } = await res.json();
    expect(body.sources.some((s) => s.name === 'existing.pdf')).toBe(true);
  });
});
