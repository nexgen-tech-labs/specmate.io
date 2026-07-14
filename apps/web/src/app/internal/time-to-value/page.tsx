import type { Metadata } from 'next';
import { notFound } from 'next/navigation';
import { auth } from '@/lib/auth';
import { isInternalAdmin } from '@/lib/admin-access';
import { getTimeToValueRows, getTimeToValueSummary } from '@/lib/time-to-value';

export const metadata: Metadata = {
  title: 'Time to First Value — SpecMate Internal',
  description: 'Internal, staff-only view of signup-to-first-generation time per workspace.',
};

function formatMinutes(minutes: number | null): string {
  if (minutes === null) return '—';
  if (minutes < 60) return `${minutes}m`;
  return `${Math.floor(minutes / 60)}h ${minutes % 60}m`;
}

// Issue 10.10 AC: "Time-to-first-value is tracked and visible on an internal
// dashboard." Same internal-staff-allowlist gate as the AI cost dashboard.
export default async function TimeToValueDashboardPage() {
  const session = await auth();
  if (!isInternalAdmin(session?.user?.email)) {
    notFound();
  }

  const [rows, summary] = await Promise.all([getTimeToValueRows(50), getTimeToValueSummary()]);

  return (
    <div className="min-h-screen bg-paper px-6 py-12 text-ink">
      <div className="mx-auto max-w-4xl">
        <div className="mb-2 font-mono text-sm text-sub">INTERNAL · STAFF ONLY</div>
        <h1 className="text-3xl font-bold tracking-tight">Time to First Value</h1>
        <p className="mt-2 text-base text-sub">
          Signup → first generated items, per workspace. Target: under {summary.target} minutes.
        </p>

        <div className="mt-6 grid grid-cols-3 gap-4">
          <div className="rounded-lg border border-line bg-panel p-4">
            <div className="font-mono text-xs text-sub">MET TARGET</div>
            <div className="mt-1 text-2xl font-bold">
              {summary.total === 0 ? '—' : `${summary.reached}/${summary.total}`}
            </div>
          </div>
          <div className="rounded-lg border border-line bg-panel p-4">
            <div className="font-mono text-xs text-sub">MEDIAN TIME</div>
            <div className="mt-1 text-2xl font-bold">{formatMinutes(summary.medianMinutes)}</div>
          </div>
          <div className="rounded-lg border border-line bg-panel p-4">
            <div className="font-mono text-xs text-sub">WORKSPACES SHOWN</div>
            <div className="mt-1 text-2xl font-bold">{rows.length}</div>
          </div>
        </div>

        <div className="mt-6 overflow-hidden rounded-lg border border-line bg-panel">
          <div className="grid grid-cols-[1fr_160px_160px_120px] border-b border-line bg-[#FCFBF8] px-5 py-3 font-mono text-sm text-sub">
            <span>WORKSPACE</span>
            <span>SIGNED UP</span>
            <span>FIRST GENERATION</span>
            <span>TIME</span>
          </div>
          {rows.length === 0 ? (
            <div className="px-5 py-6 text-base text-sub">No workspaces yet.</div>
          ) : (
            rows.map((row) => (
              <div
                key={row.workspaceId}
                className="grid grid-cols-[1fr_160px_160px_120px] items-center border-b border-line px-5 py-4 last:border-b-0"
              >
                <span className="text-base font-semibold">{row.workspaceName}</span>
                <span className="font-mono text-sm text-sub">
                  {row.createdAt.toLocaleDateString()}
                </span>
                <span className="font-mono text-sm text-sub">
                  {row.firstGenerationAt ? row.firstGenerationAt.toLocaleDateString() : 'not yet'}
                </span>
                <span
                  className={`font-mono text-sm ${
                    row.metTarget === false ? 'font-bold text-red' : 'text-sub'
                  }`}
                >
                  {formatMinutes(row.minutesToValue)}
                  {row.metTarget === true ? ' ✓' : ''}
                </span>
              </div>
            ))
          )}
        </div>
      </div>
    </div>
  );
}
