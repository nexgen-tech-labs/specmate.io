import { afterEach, describe, expect, it, vi } from 'vitest';
import { pollJobFromBrowser } from './poll-job';

describe('pollJobFromBrowser', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  function job(overrides: Partial<Record<string, unknown>> = {}) {
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

  it('returns immediately when the job is already DONE', async () => {
    const fetchMock = vi.fn().mockResolvedValue({ ok: true, json: async () => job() });
    vi.stubGlobal('fetch', fetchMock);

    const result = await pollJobFromBrowser('job-1');
    expect(result.status).toBe('DONE');
    expect(fetchMock).toHaveBeenCalledWith('/api/jobs/job-1', { signal: undefined });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('polls until the job transitions from RUNNING to DONE', async () => {
    let call = 0;
    vi.stubGlobal(
      'fetch',
      vi.fn().mockImplementation(async () => {
        call += 1;
        return { ok: true, json: async () => job({ status: call < 3 ? 'RUNNING' : 'DONE' }) };
      }),
    );

    const result = await pollJobFromBrowser('job-1', { intervalMs: 1 });
    expect(result.status).toBe('DONE');
    expect(call).toBe(3);
  });

  it('returns FAILED jobs without throwing', async () => {
    vi.stubGlobal(
      'fetch',
      vi
        .fn()
        .mockResolvedValue({
          ok: true,
          json: async () => job({ status: 'FAILED', error: 'boom' }),
        }),
    );

    const result = await pollJobFromBrowser('job-1');
    expect(result.status).toBe('FAILED');
    expect(result.error).toBe('boom');
  });

  it('throws when the proxy route returns a non-ok response', async () => {
    vi.stubGlobal(
      'fetch',
      vi
        .fn()
        .mockResolvedValue({ ok: false, status: 403, json: async () => ({ error: 'Forbidden' }) }),
    );

    await expect(pollJobFromBrowser('job-1')).rejects.toThrow('Forbidden');
  });

  it('stops polling and throws AbortError when the signal is already aborted', async () => {
    const controller = new AbortController();
    controller.abort();

    await expect(pollJobFromBrowser('job-1', { signal: controller.signal })).rejects.toThrow(
      'Polling aborted.',
    );
  });

  it('stops polling mid-wait when the signal is aborted', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({ ok: true, json: async () => job({ status: 'RUNNING' }) }),
    );
    const controller = new AbortController();

    const pending = pollJobFromBrowser('job-1', { intervalMs: 10_000, signal: controller.signal });
    // Let the first fetch resolve and the wait timer get scheduled, then abort.
    await new Promise((resolve) => setTimeout(resolve, 10));
    controller.abort();

    await expect(pending).rejects.toThrow('Polling aborted.');
  });
});
