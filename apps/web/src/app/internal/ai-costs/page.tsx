import type { Metadata } from 'next';
import { notFound } from 'next/navigation';
import { auth } from '@/lib/auth';
import { isInternalAdmin } from '@/lib/admin-access';
import { getCostToRevenueBreaches, getTopWorkspacesByCost } from '@/lib/ai-cost';

export const metadata: Metadata = {
  title: 'AI Cost Dashboard — SpecMate Internal',
  description: 'Internal, staff-only view of per-workspace AI spend.',
};

function formatUsd(value: number): string {
  return `$${value.toFixed(2)}`;
}

export default async function AiCostsDashboardPage() {
  const session = await auth();
  if (!isInternalAdmin(session?.user?.email)) {
    notFound();
  }

  const [rankings, breaches] = await Promise.all([
    getTopWorkspacesByCost(10),
    getCostToRevenueBreaches(),
  ]);
  const breachedWorkspaceIds = new Set(breaches.map((b) => b.workspaceId));

  return (
    <div className="min-h-screen bg-paper px-6 py-12 text-ink">
      <div className="mx-auto max-w-4xl">
        <div className="mb-2 font-mono text-sm text-sub">INTERNAL · STAFF ONLY</div>
        <h1 className="text-3xl font-bold tracking-tight">AI Cost Dashboard</h1>
        <p className="mt-2 text-base text-sub">Top 10 workspaces by AI spend this month.</p>

        {breaches.length > 0 ? (
          <div className="mt-6 rounded-lg border border-red bg-red-soft p-4">
            <div className="font-mono text-sm font-bold text-red">
              {breaches.length} workspace{breaches.length === 1 ? '' : 's'} over the cost-to-revenue
              threshold
            </div>
          </div>
        ) : null}

        <div className="mt-6 overflow-hidden rounded-lg border border-line bg-panel">
          <div className="grid grid-cols-[1fr_140px_120px_140px] border-b border-line bg-[#FCFBF8] px-5 py-3 font-mono text-sm text-sub">
            <span>WORKSPACE</span>
            <span>COST (MTD)</span>
            <span>CALLS</span>
            <span>COST / REVENUE</span>
          </div>
          {rankings.length === 0 ? (
            <div className="px-5 py-6 text-base text-sub">No AI usage recorded this month.</div>
          ) : (
            rankings.map((row) => {
              const ratio =
                row.planRevenueUsd != null && row.planRevenueUsd > 0
                  ? row.totalCostUsd / row.planRevenueUsd
                  : null;
              const isBreach = breachedWorkspaceIds.has(row.workspaceId);
              return (
                <div
                  key={row.workspaceId}
                  className="grid grid-cols-[1fr_140px_120px_140px] items-center border-b border-line px-5 py-4 last:border-b-0"
                >
                  <span className="text-base font-semibold">{row.workspaceName}</span>
                  <span className="font-mono text-sm">{formatUsd(row.totalCostUsd)}</span>
                  <span className="font-mono text-sm text-sub">{row.callCount}</span>
                  <span
                    className={`font-mono text-sm ${isBreach ? 'font-bold text-red' : 'text-sub'}`}
                  >
                    {ratio != null ? `${(ratio * 100).toFixed(0)}%${isBreach ? ' ⚠' : ''}` : '—'}
                  </span>
                </div>
              );
            })
          )}
        </div>

        <p className="mt-6 text-sm text-sub">
          Cost-to-revenue alerting shown here is visual only — no email/Slack notification is wired
          up yet.
        </p>
      </div>
    </div>
  );
}
