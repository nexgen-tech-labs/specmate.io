import { NextResponse } from 'next/server';
import { prisma } from '@/lib/prisma';
import { requireWorkspaceRole } from '@/lib/workspace-context';
import { getStripeClient, isStripeConfigured } from '@/lib/stripe';

type Params = { params: Promise<{ workspaceId: string }> };

// Starts a Stripe Checkout session for the self-serve STARTER tier: a
// subscription combining the flat base Price and the metered overage Price
// (Issue 10.9). Requires STRIPE_SECRET_KEY + STRIPE_STARTER_PRICE_ID +
// STRIPE_STARTER_OVERAGE_PRICE_ID to be configured — until a real Stripe
// account exists, this returns 503 rather than silently failing.
export async function POST(request: Request, { params }: Params) {
  const { workspaceId } = await params;

  const access = await requireWorkspaceRole(workspaceId, ['ADMIN']);
  if (!access.ok) {
    return NextResponse.json({ error: 'Forbidden' }, { status: access.status });
  }

  if (!isStripeConfigured()) {
    return NextResponse.json(
      {
        error:
          'Billing is not configured yet — Stripe test-mode keys are required. Contact an admin.',
      },
      { status: 503 },
    );
  }

  const basePriceId = process.env.STRIPE_STARTER_PRICE_ID;
  const overagePriceId = process.env.STRIPE_STARTER_OVERAGE_PRICE_ID;
  if (!basePriceId || !overagePriceId) {
    return NextResponse.json(
      { error: 'Starter tier Stripe Price IDs are not configured.' },
      { status: 503 },
    );
  }

  const workspace = await prisma.workspace.findUnique({ where: { id: workspaceId } });
  if (!workspace) return NextResponse.json({ error: 'Workspace not found.' }, { status: 404 });

  const stripe = getStripeClient();

  // Reuse an existing Stripe Customer for this workspace if we already created
  // one (e.g. a retried/abandoned checkout), otherwise create one now.
  let customerId = workspace.stripeCustomerId;
  if (!customerId) {
    const customer = await stripe.customers.create({
      name: workspace.name,
      metadata: { workspaceId },
    });
    customerId = customer.id;
    await prisma.workspace.update({
      where: { id: workspaceId },
      data: { stripeCustomerId: customerId },
    });
  }

  const origin = new URL(request.url).origin;
  const session = await stripe.checkout.sessions.create({
    mode: 'subscription',
    customer: customerId,
    line_items: [{ price: basePriceId, quantity: 1 }, { price: overagePriceId }],
    success_url: `${origin}/workspaces/${workspaceId}?billing=success`,
    cancel_url: `${origin}/workspaces/${workspaceId}?billing=canceled`,
    metadata: { workspaceId },
    subscription_data: { metadata: { workspaceId } },
  });

  if (!session.url) {
    return NextResponse.json({ error: 'Stripe did not return a checkout URL.' }, { status: 502 });
  }
  return NextResponse.json({ url: session.url });
}
