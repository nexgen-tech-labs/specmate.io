/**
 * Server-side helper for apps/web routes that proxy one of apps/api's
 * async-job-enqueuing endpoints (generate/generate-downstream/regenerate/
 * targeted-regenerate — see apps/api's Job model docstring for the full
 * "why"). Two distinct usage patterns exist in this codebase:
 *
 * - Routes backing a fast, single-item operation (e.g. regenerating ONE
 *   draft item from a reviewer's gap answer) poll internally via
 *   awaitJob() and keep their existing synchronous response shape — the
 *   underlying AI call is small and fast, so blocking this one proxy
 *   request for a few seconds preserves the existing UX with no visible
 *   change, while still benefiting from apps/api never blocking ITS OWN
 *   request thread on the AI call.
 * - Routes backing a genuinely long-running operation (the dashboard's
 *   Generate button, which can run clustering over an entire project's
 *   ingested content) instead return the job_id immediately and let the
 *   browser poll GET /api/jobs/[jobId] itself, showing real progress
 *   instead of a spinner with no bound.
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

export class JobPollTimeoutError extends Error {}

/**
 * Polls apps/api's GET /jobs/{job_id} until the job reaches DONE or FAILED,
 * or `timeoutMs` elapses (throws JobPollTimeoutError — callers should treat
 * this as "still running, check back later" rather than a failure, since
 * the job itself keeps running in apps/api regardless of whether this
 * particular poll loop gave up waiting).
 */
export async function awaitJob(
  jobId: string,
  { timeoutMs = 25_000, intervalMs = 500 }: { timeoutMs?: number; intervalMs?: number } = {},
): Promise<JobStatusPayload> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const res = await fetch(`${process.env.API_BASE_URL}/jobs/${jobId}`);
    if (!res.ok) {
      throw new Error(`Job status lookup failed: ${res.status}`);
    }
    const job = (await res.json()) as JobStatusPayload;
    if (job.status === 'DONE' || job.status === 'FAILED') {
      return job;
    }
    if (Date.now() >= deadline) {
      throw new JobPollTimeoutError(`Job ${jobId} did not complete within ${timeoutMs}ms.`);
    }
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
}
