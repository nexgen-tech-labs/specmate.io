import type { Metadata } from 'next';
import { notFound } from 'next/navigation';
import { auth } from '@/lib/auth';
import { isInternalAdmin } from '@/lib/admin-access';
import { getCostToRevenueBreaches, getTopWorkspacesByCost } from '@/lib/ai-cost';
import { getMarginRows } from '@/lib/margin';
import { PLACEHOLDER_PRICING } from '@/lib/pricing';

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

  const [rankings, breaches, marginRows] = await Promise.all([
    getTopWorkspacesByCost(10),
    getCostToRevenueBreaches(),
    getMarginRows(),
  ]);
  const breachedWorkspaceIds = new Set(breaches.map((b) => b.workspaceId));
  const marginBreaches = marginRows.filter((r) => r.isBreach);

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
          Cost-to-revenue alerting above uses the manually-entered planRevenueUsd fallback. The
          table below uses real tier pricing instead (Issue 10.9).
        </p>

        <h2 className="mt-10 text-2xl font-bold tracking-tight">Margin by pricing tier</h2>
        <p className="mt-2 text-base text-sub">
          AI cost vs. tier-derived effective revenue (real usage × real pricing formula), current
          month.
          {PLACEHOLDER_PRICING ? (
            <span className="ml-1 font-semibold text-red">
              ⚠ Pricing numbers are still placeholders — see lib/pricing.ts.
            </span>
          ) : null}
        </p>

        {marginBreaches.length > 0 ? (
          <div className="mt-4 rounded-lg border border-red bg-red-soft p-4">
            <div className="font-mono text-sm font-bold text-red">
              {marginBreaches.length} workspace{marginBreaches.length === 1 ? '' : 's'} unprofitable
              relative to tier pricing
            </div>
          </div>
        ) : null}

        <div className="mt-4 overflow-hidden rounded-lg border border-line bg-panel">
          <div className="grid grid-cols-[1fr_100px_110px_120px_120px_90px] border-b border-line bg-[#FCFBF8] px-5 py-3 font-mono text-xs text-sub">
            <span>WORKSPACE</span>
            <span>TIER</span>
            <span>AI COST</span>
            <span>ITEMS</span>
            <span>EFF. REVENUE</span>
            <span>RATIO</span>
          </div>
          {marginRows.length === 0 ? (
            <div className="px-5 py-6 text-base text-sub">No workspaces yet.</div>
          ) : (
            marginRows.map((row) => (
              <div
                key={row.workspaceId}
                className="grid grid-cols-[1fr_100px_110px_120px_120px_90px] items-center border-b border-line px-5 py-3 text-sm last:border-b-0"
              >
                <span className="font-semibold">{row.workspaceName}</span>
                <span className="font-mono text-xs text-sub">{row.pricingTier}</span>
                <span className="font-mono text-xs">{formatUsd(row.aiCostUsd)}</span>
                <span className="font-mono text-xs text-sub">{row.publishedItemCount}</span>
                <span className="font-mono text-xs">
                  {row.effectiveRevenueUsd != null ? formatUsd(row.effectiveRevenueUsd) : '—'}
                </span>
                <span
                  className={`font-mono text-xs ${row.isBreach ? 'font-bold text-red' : 'text-sub'}`}
                >
                  {row.ratio != null
                    ? `${(row.ratio * 100).toFixed(0)}%${row.isBreach ? ' ⚠' : ''}`
                    : '—'}
                </span>
              </div>
            ))
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
