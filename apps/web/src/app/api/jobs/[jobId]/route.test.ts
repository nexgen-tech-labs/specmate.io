import { afterEach, describe, expect, it, vi } from 'vitest';

let currentAccess: { ok: true; membership: unknown } | { ok: false; status: 401 | 403 };
vi.mock('@/lib/workspace-context', () => ({
  requireWorkspaceRole: async () => currentAccess,
}));

const { GET } = await import('./route');

function fakeJob(overrides: Partial<Record<string, unknown>> = {}) {
  return {
    id: 'job-1',
    type: 'GENERATE_EPICS',
    status: 'DONE',
    workspace_id: 'ws-1',
    project_id: 'proj-1',
    result_ref: 'run-1',
    error: null,
    created_at: '2026-01-01T00:00:00Z',
    started_at: '2026-01-01T00:00:00Z',
    finished_at: '2026-01-01T00:00:01Z',
    ...overrides,
  };
}

describe('GET /api/jobs/[jobId]', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('returns the job when the requester has workspace access', async () => {
    currentAccess = { ok: true, membership: { role: 'REVIEWER' } };
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({ ok: true, status: 200, json: async () => fakeJob() }),
    );

    const res = await GET(new Request('http://localhost'), {
      params: Promise.resolve({ jobId: 'job-1' }),
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.status).toBe('DONE');
    expect(body.result_ref).toBe('run-1');
  });

  it("rejects a requester without access to the job's workspace", async () => {
    currentAccess = { ok: false, status: 403 };
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({ ok: true, status: 200, json: async () => fakeJob() }),
    );

    const res = await GET(new Request('http://localhost'), {
      params: Promise.resolve({ jobId: 'job-1' }),
    });
    expect(res.status).toBe(403);
  });

  it('returns 404 when apps/api reports the job does not exist', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: false, status: 404 }));

    const res = await GET(new Request('http://localhost'), {
      params: Promise.resolve({ jobId: 'nonexistent' }),
    });
    expect(res.status).toBe(404);
  });

  it('returns 502 when apps/api is unreachable', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('network error')));

    const res = await GET(new Request('http://localhost'), {
      params: Promise.resolve({ jobId: 'job-1' }),
    });
    expect(res.status).toBe(502);
  });
});
