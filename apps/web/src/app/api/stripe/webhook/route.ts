import { NextResponse } from 'next/server';
import type Stripe from 'stripe';
import { prisma } from '@/lib/prisma';
import { getStripeClient } from '@/lib/stripe';

// Stripe webhook (Issue 10.9) — the only trusted path for subscription state
// changes; the app never assumes a subscription is active just because
// Checkout redirected successfully (a user can close the tab, a payment can
// fail after redirect, etc.). Signature verification is mandatory: without it,
// anyone could POST a fake "subscription active" event.
//
// Configure locally with the Stripe CLI: `stripe listen --forward-to
// localhost:3000/api/stripe/webhook` — it prints a webhook signing secret to
// put in STRIPE_WEBHOOK_SECRET.
export async function POST(request: Request) {
  const signature = request.headers.get('stripe-signature');
  const webhookSecret = process.env.STRIPE_WEBHOOK_SECRET;
  if (!signature || !webhookSecret) {
    return NextResponse.json({ error: 'Webhook not configured.' }, { status: 503 });
  }

  const rawBody = await request.text();
  const stripe = getStripeClient();

  let event: Stripe.Event;
  try {
    event = stripe.webhooks.constructEvent(rawBody, signature, webhookSecret);
  } catch (err) {
    const message = err instanceof Error ? err.message : 'invalid signature';
    return NextResponse.json(
      { error: `Webhook signature verification failed: ${message}` },
      {
        status: 400,
      },
    );
  }

  switch (event.type) {
    case 'checkout.session.completed': {
      const session = event.data.object as Stripe.Checkout.Session;
      const workspaceId = session.metadata?.workspaceId;
      const subscriptionId =
        typeof session.subscription === 'string' ? session.subscription : session.subscription?.id;
      if (workspaceId && subscriptionId) {
        await prisma.workspace.update({
          where: { id: workspaceId },
          data: { stripeSubscriptionId: subscriptionId, subscriptionStatus: 'ACTIVE' },
        });
      }
      break;
    }

    case 'customer.subscription.updated':
    case 'customer.subscription.created': {
      const subscription = event.data.object as Stripe.Subscription;
      const workspaceId = subscription.metadata?.workspaceId;
      if (workspaceId) {
        const baseItem = subscription.items.data.find(
          (item) => item.price.recurring?.usage_type !== 'metered',
        );
        await prisma.workspace.update({
          where: { id: workspaceId },
          data: {
            subscriptionStatus: mapStripeStatus(subscription.status),
            stripeSubscriptionId: subscription.id,
            subscriptionBaseUsd: baseItem?.price.unit_amount
              ? baseItem.price.unit_amount / 100
              : undefined,
          },
        });
      }
      break;
    }

    case 'customer.subscription.deleted': {
      const subscription = event.data.object as Stripe.Subscription;
      const workspaceId = subscription.metadata?.workspaceId;
      if (workspaceId) {
        await prisma.workspace.update({
          where: { id: workspaceId },
          data: { subscriptionStatus: 'CANCELED' },
        });
      }
      break;
    }

    default:
      // Unhandled event types are intentionally ignored, not errors — Stripe
      // sends many event types this integration doesn't need to act on.
      break;
  }

  return NextResponse.json({ received: true });
}

function mapStripeStatus(
  status: Stripe.Subscription.Status,
): 'TRIALING' | 'ACTIVE' | 'PAST_DUE' | 'CANCELED' | 'INCOMPLETE' {
  switch (status) {
    case 'trialing':
      return 'TRIALING';
    case 'active':
      return 'ACTIVE';
    case 'past_due':
    case 'unpaid':
      return 'PAST_DUE';
    case 'canceled':
      return 'CANCELED';
    default:
      return 'INCOMPLETE';
  }
}
