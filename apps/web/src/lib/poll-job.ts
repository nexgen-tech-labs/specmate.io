/**
 * Client-side polling for a long-running background job (the dashboard's
 * Generate button, which can run clustering over an entire project's
 * ingested content — the exact operation whose blocking-request version
 * caused a real production 504). Distinct from lib/jobs.ts's awaitJob():
 * that one runs server-side inside a Next.js route (reading
 * process.env.API_BASE_URL, apps/api's internal-only address) and is for
 * routes that poll briefly to preserve a synchronous response shape for a
 * FAST operation. This one runs in the browser against the public,
 * auth-gated /api/jobs/[jobId] proxy, with no fixed timeout — the caller
 * decides how long to keep waiting (e.g. by unmounting the polling
 * component), since a genuinely long generation run has no natural time
 * limit the UI should impose.
 */

export interface JobStatusPayload {
  id: string;
  type: string;
  status: 'QUEUED' | 'RUNNING' | 'DONE' | 'FAILED';
  workspace_id: string;
  project_id: string;
  result_ref: string | null;
  error: string | null;
  created_at: string;
  started_at: string | null;
  finished_at: string | null;
}

/**
 * Polls /api/jobs/{jobId} every `intervalMs` until the job reaches DONE or
 * FAILED, or `signal` is aborted (e.g. the component unmounted) — in which
 * case it throws a DOMException named "AbortError", matching fetch's own
 * abort convention so callers can share one catch branch.
 */
export async function pollJobFromBrowser(
  jobId: string,
  { intervalMs = 1500, signal }: { intervalMs?: number; signal?: AbortSignal } = {},
): Promise<JobStatusPayload> {
  for (;;) {
    if (signal?.aborted) {
      throw new DOMException('Polling aborted.', 'AbortError');
    }
    const res = await fetch(`/api/jobs/${jobId}`, { signal });
    if (!res.ok) {
      const body: { error?: string } = await res.json().catch(() => ({}));
      throw new Error(body.error ?? `Job status lookup failed (${res.status}).`);
    }
    const job = (await res.json()) as JobStatusPayload;
    if (job.status === 'DONE' || job.status === 'FAILED') {
      return job;
    }
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(resolve, intervalMs);
      signal?.addEventListener(
        'abort',
        () => {
          clearTimeout(timer);
          reject(new DOMException('Polling aborted.', 'AbortError'));
        },
        { once: true },
      );
    });
  }
}
