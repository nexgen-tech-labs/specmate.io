'use client';

import { useState } from 'react';

const ACTIVE_STATUSES = new Set(['TRIALING', 'ACTIVE']);

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
