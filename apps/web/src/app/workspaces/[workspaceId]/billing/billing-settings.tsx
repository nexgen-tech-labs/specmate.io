'use client';

import { useEffect, useState } from 'react';
import type { UsageSummary } from '@/lib/usage';

const ACTIVE_STATUSES = new Set(['TRIALING', 'ACTIVE']);

type UsageDisplayFields = Pick<
  UsageSummary,
  'publishedItemCount' | 'includedItems' | 'remaining' | 'overageCount' | 'percentUsed'
>;

function UsageSection({ workspaceId }: { workspaceId: string }) {
  const [usage, setUsage] = useState<UsageDisplayFields | null>(null);
  const [fetchFailed, setFetchFailed] = useState(false);

  useEffect(() => {
    let cancelled = false;
    void fetch(`/api/workspaces/${workspaceId}/usage`)
      .then((res) => (res.ok ? res.json() : Promise.reject(new Error(`status ${res.status}`))))
      .then((data: UsageDisplayFields) => {
        if (!cancelled) {
          setUsage(data);
          setFetchFailed(false);
        }
      })
      .catch(() => {
        if (!cancelled) {
          setUsage(null);
          setFetchFailed(true);
        }
      });
    return () => {
      cancelled = true;
    };
  }, [workspaceId]);

  // An admin near/over quota should see a visible signal that usage failed to
  // load, not silent nothing indistinguishable from "no usage data yet."
  if (fetchFailed) {
    return (
      <div className="mt-6 border-t border-line pt-6 text-left">
        <div className="text-sm font-semibold text-ink">Usage this period</div>
        <p className="mt-2 text-sm text-sub">Couldn&apos;t load usage — try refreshing.</p>
      </div>
    );
  }

  if (!usage) return null;

  const isUnlimited = usage.includedItems === null;
  const percent = usage.percentUsed ?? 0;
  const approachingQuota = !isUnlimited && percent >= 80 && percent < 100;
  const overQuota = !isUnlimited && percent >= 100;

  return (
    <div className="mt-6 border-t border-line pt-6 text-left">
      <div className="text-sm font-semibold text-ink">Usage this period</div>
      {isUnlimited ? (
        <p className="mt-2 text-sm text-sub">
          {usage.publishedItemCount} published items — Unlimited on this plan.
        </p>
      ) : (
        <>
          <p className="mt-2 text-sm text-sub">
            {usage.publishedItemCount} / {usage.includedItems} published items
          </p>
          <div className="mt-2 h-2 w-full overflow-hidden rounded-full bg-line">
            <div
              className={`h-full rounded-full ${overQuota ? 'bg-red' : 'bg-cobalt'}`}
              style={{ width: `${Math.min(100, percent)}%` }}
            />
          </div>
          <p className="mt-2 text-sm text-sub">
            {overQuota ? `${usage.overageCount} over quota` : `${usage.remaining} remaining`}
          </p>
          {approachingQuota ? (
            <p className="mt-3 rounded border border-amber bg-amber-soft p-3 text-sm text-amber">
              Approaching your plan&apos;s included usage for this period.
            </p>
          ) : null}
          {overQuota ? (
            <p className="mt-3 text-sm text-red">
              You&apos;ve exceeded your included usage for this period — overage charges apply.
            </p>
          ) : null}
        </>
      )}
    </div>
  );
}

export function BillingSettings({
  workspaceId,
  pricingTier,
  subscriptionStatus,
}: {
  workspaceId: string;
  pricingTier: 'STARTER' | 'ENTERPRISE';
  subscriptionStatus: string;
}) {
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  const isBilled = pricingTier === 'ENTERPRISE' || ACTIVE_STATUSES.has(subscriptionStatus);

  if (isBilled) {
    return (
      <div className="rounded-lg border border-line bg-panel p-8 text-center">
        <div className="font-mono text-sm font-bold tracking-[0.06em] text-green">
          {pricingTier === 'ENTERPRISE' ? 'ENTERPRISE PLAN' : 'STARTER PLAN — ACTIVE'}
        </div>
        <p className="mt-4 text-sm text-sub">
          {pricingTier === 'ENTERPRISE'
            ? 'This workspace is on a custom, sales-assisted plan. Contact your account manager for changes.'
            : 'This workspace has an active subscription — teammates can be invited freely.'}
        </p>
        <UsageSection workspaceId={workspaceId} />
      </div>
    );
  }

  async function startCheckout() {
    setError(null);
    setSubmitting(true);
    const res = await fetch(`/api/workspaces/${workspaceId}/billing/checkout`, { method: 'POST' });
    if (!res.ok) {
      const body: { error?: string } = await res.json().catch(() => ({}));
      setError(body.error ?? 'Could not start checkout.');
      setSubmitting(false);
      return;
    }
    const { url }: { url: string } = await res.json();
    window.location.href = url;
  }

  async function requestEnterprise() {
    setError(null);
    setSubmitting(true);
    const res = await fetch(`/api/workspaces/${workspaceId}/billing/tier`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ tier: 'ENTERPRISE' }),
    });
    setSubmitting(false);
    if (!res.ok) {
      const body: { error?: string } = await res.json().catch(() => ({}));
      setError(body.error ?? 'Could not update the plan.');
      return;
    }
    window.location.reload();
  }

  return (
    <div className="rounded-lg border border-line bg-panel p-8">
      <p className="text-sm text-sub">
        This workspace is free while it&apos;s just you. Adding a teammate requires an active plan.
      </p>
      <div className="mt-5 grid grid-cols-1 gap-4 sm:grid-cols-2">
        <button
          type="button"
          disabled={submitting}
          onClick={() => void startCheckout()}
          className="rounded-lg border border-line bg-paper p-5 text-left focus-visible:outline focus-visible:outline-2 focus-visible:outline-cobalt disabled:opacity-50"
        >
          <div className="text-lg font-bold text-ink">Starter</div>
          <p className="mt-1 text-sm text-sub">
            Self-serve. Base subscription + usage-based pricing per published item.
          </p>
          <div className="mt-3 text-sm font-semibold text-cobalt">Add payment method →</div>
        </button>
        <button
          type="button"
          disabled={submitting}
          onClick={() => void requestEnterprise()}
          className="rounded-lg border border-line bg-paper p-5 text-left focus-visible:outline focus-visible:outline-2 focus-visible:outline-cobalt disabled:opacity-50"
        >
          <div className="text-lg font-bold text-ink">Enterprise</div>
          <p className="mt-1 text-sm text-sub">
            Custom pricing, sales-assisted onboarding, for larger orgs and pilots.
          </p>
          <div className="mt-3 text-sm font-semibold text-cobalt">Contact sales →</div>
        </button>
      </div>
      {error ? <p className="mt-3 text-sm text-red">{error}</p> : null}
    </div>
  );
}
