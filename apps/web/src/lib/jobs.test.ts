import { afterEach, describe, expect, it, vi } from 'vitest';
import { awaitJob, JobPollTimeoutError } from './jobs';

const originalApiBaseUrl = process.env.API_BASE_URL;

describe('awaitJob', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    process.env.API_BASE_URL = originalApiBaseUrl;
  });

  it('returns immediately when the job is already DONE', async () => {
    process.env.API_BASE_URL = 'https://api.internal.example';
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        id: 'job-1',
        workspace_id: 'ws-1',
        project_id: 'proj-1',
        type: 'REGENERATE_ITEM',
        status: 'DONE',
        result_ref: 'item-123',
        error: null,
        created_at: '2026-01-01T00:00:00Z',
        started_at: '2026-01-01T00:00:00Z',
        finished_at: '2026-01-01T00:00:01Z',
      }),
    });
    vi.stubGlobal('fetch', fetchMock);

    const job = await awaitJob('job-1');
    expect(job.status).toBe('DONE');
    expect(job.result_ref).toBe('item-123');
    expect(fetchMock).toHaveBeenCalledWith('https://api.internal.example/jobs/job-1');
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('returns FAILED jobs without throwing (caller decides how to handle)', async () => {
    process.env.API_BASE_URL = 'https://api.internal.example';
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({
        ok: true,
        json: async () => ({
          id: 'job-1',
          workspace_id: 'ws-1',
          project_id: 'proj-1',
          type: 'REGENERATE_ITEM',
          status: 'FAILED',
          result_ref: null,
          error: 'AI generation is temporarily unavailable.',
          created_at: '2026-01-01T00:00:00Z',
          started_at: '2026-01-01T00:00:00Z',
          finished_at: '2026-01-01T00:00:01Z',
        }),
      }),
    );

    const job = await awaitJob('job-1');
    expect(job.status).toBe('FAILED');
    expect(job.error).toBe('AI generation is temporarily unavailable.');
  });

  it('polls until the job transitions from RUNNING to DONE', async () => {
    process.env.API_BASE_URL = 'https://api.internal.example';
    let call = 0;
    const fetchMock = vi.fn().mockImplementation(async () => {
      call += 1;
      const status = call < 3 ? 'RUNNING' : 'DONE';
      return {
        ok: true,
        json: async () => ({
          id: 'job-1',
          workspace_id: 'ws-1',
          project_id: 'proj-1',
          type: 'GENERATE_EPICS',
          status,
          result_ref: status === 'DONE' ? 'run-1' : null,
          error: null,
          created_at: '2026-01-01T00:00:00Z',
          started_at: '2026-01-01T00:00:00Z',
          finished_at: null,
        }),
      };
    });
    vi.stubGlobal('fetch', fetchMock);

    const job = await awaitJob('job-1', { intervalMs: 1 });
    expect(job.status).toBe('DONE');
    expect(call).toBe(3);
  });

  it('throws JobPollTimeoutError when the job never completes in time', async () => {
    process.env.API_BASE_URL = 'https://api.internal.example';
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({
        ok: true,
        json: async () => ({
          id: 'job-1',
          workspace_id: 'ws-1',
          project_id: 'proj-1',
          type: 'GENERATE_EPICS',
          status: 'RUNNING',
          result_ref: null,
          error: null,
          created_at: '2026-01-01T00:00:00Z',
          started_at: '2026-01-01T00:00:00Z',
          finished_at: null,
        }),
      }),
    );

    await expect(awaitJob('job-1', { timeoutMs: 5, intervalMs: 2 })).rejects.toThrow(
      JobPollTimeoutError,
    );
  });

  it('throws when the job status lookup itself fails', async () => {
    process.env.API_BASE_URL = 'https://api.internal.example';
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: false, status: 404 }));

    await expect(awaitJob('job-1')).rejects.toThrow('Job status lookup failed: 404');
  });
});
