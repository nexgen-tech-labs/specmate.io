import type { Metadata } from 'next';
import { notFound } from 'next/navigation';
import { auth } from '@/lib/auth';
import { isInternalAdmin } from '@/lib/admin-access';
import { getRateLimitSummary, getRecentRateLimitIncidents } from '@/lib/rate-limit-incidents';

export const metadata: Metadata = {
  title: 'Rate Limit Incidents — SpecMate Internal',
  description: 'Internal, staff-only view of outbound rate-limit incidents per tool and workspace.',
};

function formatDateTime(date: Date): string {
  return date.toLocaleString('en-US', {
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
  });
}

export default async function RateLimitIncidentsDashboardPage() {
  const session = await auth();
  if (!isInternalAdmin(session?.user?.email)) {
    notFound();
  }

  const [summary, recent] = await Promise.all([
    getRateLimitSummary(),
    getRecentRateLimitIncidents(200),
  ]);

  return (
    <div className="min-h-screen bg-paper px-6 py-12 text-ink">
      <div className="mx-auto max-w-4xl">
        <div className="mb-2 font-mono text-sm text-sub">INTERNAL · STAFF ONLY</div>
        <h1 className="text-3xl font-bold tracking-tight">Rate Limit Incidents</h1>
        <p className="mt-2 text-base text-sub">
          Outbound rate-limit retries against Jira, Azure DevOps, and GitHub during publish —
          grouped by tool and workspace.
        </p>

        <h2 className="mt-8 text-xl font-bold tracking-tight">By tool &amp; workspace</h2>
        <div className="mt-4 overflow-hidden rounded-lg border border-line bg-panel">
          <div className="grid grid-cols-[100px_1fr_120px_160px] border-b border-line bg-[#FCFBF8] px-5 py-3 font-mono text-sm text-sub">
            <span>TOOL</span>
            <span>WORKSPACE</span>
            <span>INCIDENTS</span>
            <span>MOST RECENT</span>
          </div>
          {summary.length === 0 ? (
            <div className="px-5 py-6 text-base text-sub">
              No rate-limit incidents recorded yet.
            </div>
          ) : (
            summary.map((row) => (
              <div
                key={`${row.tool}::${row.workspaceId}`}
                className="grid grid-cols-[100px_1fr_120px_160px] items-center border-b border-line px-5 py-4 last:border-b-0"
              >
                <span className="font-mono text-sm uppercase text-sub">{row.tool}</span>
                <span className="text-base font-semibold">{row.workspaceName}</span>
                <span className="font-mono text-sm">{row.incidentCount}</span>
                <span className="font-mono text-sm text-sub">
                  {formatDateTime(row.mostRecentAt)}
                </span>
              </div>
            ))
          )}
        </div>

        <h2 className="mt-10 text-xl font-bold tracking-tight">Recent incidents</h2>
        <p className="mt-2 text-base text-sub">Most recent 200 events, newest first.</p>
        <div className="mt-4 overflow-hidden rounded-lg border border-line bg-panel">
          <div className="grid grid-cols-[100px_1fr_90px_90px_90px_160px] border-b border-line bg-[#FCFBF8] px-5 py-3 font-mono text-xs text-sub">
            <span>TOOL</span>
            <span>WORKSPACE</span>
            <span>STATUS</span>
            <span>WAIT (S)</span>
            <span>ATTEMPT</span>
            <span>WHEN</span>
          </div>
          {recent.length === 0 ? (
            <div className="px-5 py-6 text-base text-sub">
              No rate-limit incidents recorded yet.
            </div>
          ) : (
            recent.map((incident) => (
              <div
                key={incident.id}
                className="grid grid-cols-[100px_1fr_90px_90px_90px_160px] items-center border-b border-line px-5 py-3 text-sm last:border-b-0"
              >
                <span className="font-mono text-xs uppercase text-sub">{incident.tool}</span>
                <span className="font-semibold">{incident.workspaceName}</span>
                <span className="font-mono text-xs">{incident.statusCode ?? '—'}</span>
                <span className="font-mono text-xs text-sub">
                  {incident.waitSeconds != null ? incident.waitSeconds.toFixed(1) : '—'}
                </span>
                <span className="font-mono text-xs text-sub">{incident.retryCount ?? '—'}</span>
                <span className="font-mono text-xs text-sub">
                  {formatDateTime(incident.createdAt)}
                </span>
              </div>
            ))
          )}
        </div>
      </div>
    </div>
  );
}
