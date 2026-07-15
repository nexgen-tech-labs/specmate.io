// @vitest-environment node
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import Stripe from 'stripe';
import { prisma } from '@/lib/prisma';

const WEBHOOK_SECRET = 'whsec_test_secret_for_route_tests';

describe('POST /api/stripe/webhook', () => {
  let workspace: { id: string };

  beforeAll(async () => {
    workspace = await prisma.workspace.create({
      data: { name: 'Webhook Test WS', pricingTier: 'STARTER' },
    });
  });

  afterAll(async () => {
    await prisma.workspace.deleteMany({ where: { id: workspace.id } });
  });

  beforeEach(() => {
    vi.stubEnv('STRIPE_SECRET_KEY', 'sk_test_fake_key_for_route_tests');
    vi.stubEnv('STRIPE_WEBHOOK_SECRET', WEBHOOK_SECRET);
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  function signedRequest(payload: object): Request {
    const body = JSON.stringify(payload);
    const header = Stripe.webhooks.generateTestHeaderString({
      payload: body,
      secret: WEBHOOK_SECRET,
    });
    return new Request('http://localhost/api/stripe/webhook', {
      method: 'POST',
      headers: { 'stripe-signature': header, 'content-type': 'application/json' },
      body,
    });
  }

  it('rejects requests with no signature header', async () => {
    const { POST } = await import('./route');
    const res = await POST(
      new Request('http://localhost/api/stripe/webhook', { method: 'POST', body: '{}' }),
    );
    expect(res.status).toBe(503);
  });

  it('rejects requests with an invalid signature', async () => {
    const { POST } = await import('./route');
    const res = await POST(
      new Request('http://localhost/api/stripe/webhook', {
        method: 'POST',
        headers: { 'stripe-signature': 't=1,v1=deadbeef' },
        body: JSON.stringify({ type: 'checkout.session.completed', data: { object: {} } }),
      }),
    );
    expect(res.status).toBe(400);
  });

  it('activates a subscription on a validly-signed checkout.session.completed event', async () => {
    const { POST } = await import('./route');
    const req = signedRequest({
      id: 'evt_test_1',
      object: 'event',
      type: 'checkout.session.completed',
      data: {
        object: {
          id: 'cs_test_1',
          object: 'checkout.session',
          metadata: { workspaceId: workspace.id },
          subscription: 'sub_test_1',
        },
      },
    });
    const res = await POST(req);
    expect(res.status).toBe(200);

    const updated = await prisma.workspace.findUniqueOrThrow({ where: { id: workspace.id } });
    expect(updated.stripeSubscriptionId).toBe('sub_test_1');
    expect(updated.subscriptionStatus).toBe('ACTIVE');
  });

  it('marks the workspace CANCELED on customer.subscription.deleted', async () => {
    const { POST } = await import('./route');
    const req = signedRequest({
      id: 'evt_test_2',
      object: 'event',
      type: 'customer.subscription.deleted',
      data: {
        object: {
          id: 'sub_test_1',
          object: 'subscription',
          metadata: { workspaceId: workspace.id },
        },
      },
    });
    const res = await POST(req);
    expect(res.status).toBe(200);

    const updated = await prisma.workspace.findUniqueOrThrow({ where: { id: workspace.id } });
    expect(updated.subscriptionStatus).toBe('CANCELED');
  });

  it('ignores events with no matching workspaceId in metadata without erroring', async () => {
    const { POST } = await import('./route');
    const req = signedRequest({
      id: 'evt_test_3',
      object: 'event',
      type: 'checkout.session.completed',
      data: { object: { id: 'cs_test_2', object: 'checkout.session', metadata: {} } },
    });
    const res = await POST(req);
    expect(res.status).toBe(200);
  });
});
