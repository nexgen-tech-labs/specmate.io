import { describe, expect, it, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import { BillingSettings } from './billing-settings';

function mockUsageFetch(summary: Partial<Record<string, unknown>>) {
  vi.stubGlobal(
    'fetch',
    vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({
        periodStart: '2026-07-01T00:00:00.000Z',
        periodEnd: '2026-08-01T00:00:00.000Z',
        publishedItemCount: 0,
        includedItems: 50,
        remaining: 50,
        overageCount: 0,
        percentUsed: 0,
        tier: 'STARTER',
        ...summary,
      }),
    }),
  );
}

describe('BillingSettings — usage section', () => {
  beforeEach(() => {
    vi.unstubAllGlobals();
  });

  it('shows published item count vs. included quota for a billed STARTER workspace', async () => {
    mockUsageFetch({ publishedItemCount: 32, remaining: 18, percentUsed: 64 });
    render(
      <BillingSettings workspaceId="ws-1" pricingTier="STARTER" subscriptionStatus="ACTIVE" />,
    );
    await waitFor(() => expect(screen.getByText(/32/)).toBeDefined());
    expect(screen.getByText(/50/)).toBeDefined();
    expect(screen.getByText(/18 remaining/i)).toBeDefined();
  });

  it('shows an approaching-quota banner at 80% or more', async () => {
    mockUsageFetch({ publishedItemCount: 40, remaining: 10, percentUsed: 80 });
    render(
      <BillingSettings workspaceId="ws-1" pricingTier="STARTER" subscriptionStatus="ACTIVE" />,
    );
    await waitFor(() =>
      expect(screen.getByText(/approaching your plan's included usage/i)).toBeDefined(),
    );
  });

  it('shows an over-quota banner at 100% or more, with overage framing', async () => {
    mockUsageFetch({ publishedItemCount: 55, remaining: 0, overageCount: 5, percentUsed: 110 });
    render(
      <BillingSettings workspaceId="ws-1" pricingTier="STARTER" subscriptionStatus="ACTIVE" />,
    );
    await waitFor(() => expect(screen.getByText(/exceeded your included usage/i)).toBeDefined());
  });

  it('does not show a threshold banner under 80%', async () => {
    mockUsageFetch({ publishedItemCount: 10, remaining: 40, percentUsed: 20 });
    render(
      <BillingSettings workspaceId="ws-1" pricingTier="STARTER" subscriptionStatus="ACTIVE" />,
    );
    await waitFor(() => expect(screen.getByText(/10/)).toBeDefined());
    expect(screen.queryByText(/approaching your plan's included usage/i)).toBeNull();
    expect(screen.queryByText(/exceeded your included usage/i)).toBeNull();
  });

  it('shows a visible fallback (not silent nothing) when the usage fetch rejects outright', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('network error')));
    render(
      <BillingSettings workspaceId="ws-1" pricingTier="STARTER" subscriptionStatus="ACTIVE" />,
    );
    await waitFor(() => expect(screen.getByText(/couldn't load usage/i)).toBeDefined());
    expect(screen.queryByText(/remaining/i)).toBeNull();
  });

  it('shows a visible fallback (not silent nothing) when the usage fetch returns a non-200', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({ ok: false, status: 500, json: async () => ({}) }),
    );
    render(
      <BillingSettings workspaceId="ws-1" pricingTier="STARTER" subscriptionStatus="ACTIVE" />,
    );
    await waitFor(() => expect(screen.getByText(/couldn't load usage/i)).toBeDefined());
    expect(screen.queryByText(/remaining/i)).toBeNull();
  });

  it('shows "Unlimited" for an ENTERPRISE workspace with no bar or banner', async () => {
    mockUsageFetch({
      includedItems: null,
      remaining: null,
      overageCount: 0,
      percentUsed: null,
      publishedItemCount: 12,
      tier: 'ENTERPRISE',
    });
    render(
      <BillingSettings workspaceId="ws-1" pricingTier="ENTERPRISE" subscriptionStatus="NONE" />,
    );
    await waitFor(() => expect(screen.getByText(/unlimited/i)).toBeDefined());
    expect(screen.queryByText(/approaching your plan's included usage/i)).toBeNull();
  });
});
