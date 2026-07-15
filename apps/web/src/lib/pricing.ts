/**
 * Pricing & packaging (Issue 10.9) — hybrid model: base subscription + metered
 * usage tied to the value moment (published items).
 *
 * ⚠️ PLACEHOLDER PRICING — these numbers were never given real values by the
 * business; they exist so the metering/billing mechanism can be built and
 * tested end-to-end before real pricing is decided. Do not launch with these
 * numbers. Update STARTER_BASE_USD / STARTER_OVERAGE_PER_ITEM_USD (and the
 * matching Stripe Price IDs in .env) before going live.
 *
 * STARTER is self-serve: a Stripe subscription with a flat base price plus a
 * metered component billed per published item over the included allowance.
 * ENTERPRISE is sales-assisted and custom — not necessarily billed through
 * Stripe at all (see Workspace.planRevenueUsd as the manual fallback).
 */

export const PLACEHOLDER_PRICING = true;

export const STARTER_BASE_USD = 99;
export const STARTER_INCLUDED_ITEMS = 50;
export const STARTER_OVERAGE_PER_ITEM_USD = 2;

export const PRICING_TIERS = {
  STARTER: {
    name: 'Starter',
    baseUsd: STARTER_BASE_USD,
    includedItems: STARTER_INCLUDED_ITEMS,
    overagePerItemUsd: STARTER_OVERAGE_PER_ITEM_USD,
    selfServe: true,
  },
  ENTERPRISE: {
    name: 'Enterprise',
    baseUsd: null, // custom, sales-assisted
    includedItems: null,
    overagePerItemUsd: null,
    selfServe: false,
  },
} as const;

export type PricingTierKey = keyof typeof PRICING_TIERS;

/** Estimated monthly cost for a Starter workspace at a given published-item
 * volume — used for internal margin-flagging (10.9 AC), not shown to customers
 * as an invoice (Stripe is the source of truth for actual billed amounts). */
export function estimateStarterMonthlyUsd(publishedItemCount: number): number {
  const overageItems = Math.max(0, publishedItemCount - STARTER_INCLUDED_ITEMS);
  return STARTER_BASE_USD + overageItems * STARTER_OVERAGE_PER_ITEM_USD;
}
