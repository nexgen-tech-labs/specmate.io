import { NextResponse } from 'next/server';
import { prisma } from '@/lib/prisma';
import { requireWorkspaceRole } from '@/lib/workspace-context';
import { getStripeClient, isStripeConfigured } from '@/lib/stripe';

type Params = { params: Promise<{ workspaceId: string }> };

// Sets a workspace to ENTERPRISE (sales-assisted; custom pricing is
// negotiated and billed outside self-serve Checkout — see pricing.ts,
// ENTERPRISE has no Stripe Price at all). Issue 10.9's "tiers selectable at
// signup" AC, for the non-self-serve path.
//
// Only STARTER -> ENTERPRISE is supported here. ENTERPRISE -> STARTER is
// intentionally rejected: STARTER is self-serve-only and originates a new
// Stripe subscription via a Checkout Session redirect (/billing/checkout),
// which requires the user to complete a hosted payment flow. This endpoint
// never creates subscriptions, only cancels them, so it has no coherent way
// to "downgrade" a workspace into a paid Starter plan — callers must be
// pointed at /billing/checkout for that direction instead.
export async function POST(request: Request, { params }: Params) {
  const { workspaceId } = await params;

  const access = await requireWorkspaceRole(workspaceId, ['ADMIN']);
  if (!access.ok) {
    return NextResponse.json({ error: 'Forbidden' }, { status: access.status });
  }

  const body = (await request.json().catch(() => ({}))) as { tier?: unknown };
  if (body.tier !== 'ENTERPRISE') {
    return NextResponse.json(
      { error: 'This endpoint only sets ENTERPRISE. Use /billing/checkout for STARTER.' },
      { status: 400 },
    );
  }

  const workspace = await prisma.workspace.findUnique({ where: { id: workspaceId } });
  if (!workspace) return NextResponse.json({ error: 'Workspace not found.' }, { status: 404 });

  // If this workspace has a live Stripe subscription (the common case: a
  // paying STARTER customer upgrading to ENTERPRISE), end it with proration
  // so the customer gets a correctly prorated final invoice instead of
  // continuing to be billed for metered Starter usage after the switch.
  // There's no Stripe Price to "switch to" for ENTERPRISE, so the only
  // coherent Stripe-side action is canceling, not updating line items.
  if (workspace.stripeSubscriptionId && isStripeConfigured()) {
    const stripe = getStripeClient();
    await stripe.subscriptions.update(workspace.stripeSubscriptionId, {
      cancel_at: Math.floor(Date.now() / 1000),
      proration_behavior: 'create_prorations',
    });
  }

  await prisma.workspace.update({
    where: { id: workspaceId },
    data: { pricingTier: 'ENTERPRISE', subscriptionStatus: 'NONE' },
  });

  return NextResponse.json({ ok: true, tier: 'ENTERPRISE' });
}
