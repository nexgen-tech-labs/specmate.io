// @vitest-environment node
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { prisma } from '@/lib/prisma';

let currentSession: { user: { id: string } } | null = null;

vi.mock('@/lib/auth', () => ({
  auth: async () => currentSession,
}));

const subscriptionsUpdate = vi.fn();

vi.mock('@/lib/stripe', () => ({
  getStripeClient: () => ({
    subscriptions: {
      update: subscriptionsUpdate,
    },
  }),
  isStripeConfigured: () => process.env.STRIPE_SECRET_KEY !== undefined,
}));

const { POST } = await import('./route');

describe('POST /api/workspaces/[workspaceId]/billing/tier', () => {
  let admin: { id: string };

  beforeAll(async () => {
    admin = await prisma.user.create({
      data: { email: `tier-admin-${Date.now()}@test.local`, name: 'Tier Admin', passwordHash: 'x' },
    });
  });

  afterAll(async () => {
    await prisma.user.deleteMany({ where: { id: admin.id } });
  });

  beforeEach(() => {
    currentSession = { user: { id: admin.id } };
    subscriptionsUpdate.mockReset();
    subscriptionsUpdate.mockResolvedValue({ id: 'sub_test_1' });
    vi.stubEnv('STRIPE_SECRET_KEY', 'sk_test_fake_key_for_route_tests');
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  function makeRequest(body: object) {
    return new Request('http://localhost/api/workspaces/x/billing/tier', {
      method: 'POST',
      body: JSON.stringify(body),
    });
  }

  async function createWorkspace(
    data: Partial<Parameters<typeof prisma.workspace.create>[0]['data']> = {},
  ) {
    const workspace = await prisma.workspace.create({
      data: { name: `Tier Test WS ${Date.now()}-${Math.random()}`, ...data },
    });
    await prisma.workspaceMember.create({
      data: { workspaceId: workspace.id, userId: admin.id, role: 'ADMIN' },
    });
    return workspace;
  }

  async function cleanupWorkspace(workspaceId: string) {
    await prisma.workspaceMember.deleteMany({ where: { workspaceId } });
    await prisma.workspace.deleteMany({ where: { id: workspaceId } });
  }

  it('STARTER -> ENTERPRISE with an active Stripe subscription: cancels the subscription with proration and updates the tier', async () => {
    const workspace = await createWorkspace({
      pricingTier: 'STARTER',
      subscriptionStatus: 'ACTIVE',
      stripeSubscriptionId: 'sub_active_123',
    });

    try {
      const res = await POST(makeRequest({ tier: 'ENTERPRISE' }), {
        params: Promise.resolve({ workspaceId: workspace.id }),
      });
      expect(res.status).toBe(200);

      expect(subscriptionsUpdate).toHaveBeenCalledTimes(1);
      const [subscriptionId, updateParams] = subscriptionsUpdate.mock.calls[0];
      expect(subscriptionId).toBe('sub_active_123');
      // Ends the Stripe subscription immediately (no Stripe Price exists for
      // ENTERPRISE — see pricing.ts baseUsd: null) while generating a prorated
      // final invoice so the customer isn't charged for unused time.
      expect(updateParams).toMatchObject({ proration_behavior: 'create_prorations' });
      expect(typeof updateParams.cancel_at).toBe('number');

      const updated = await prisma.workspace.findUniqueOrThrow({ where: { id: workspace.id } });
      expect(updated.pricingTier).toBe('ENTERPRISE');
    } finally {
      await cleanupWorkspace(workspace.id);
    }
  });

  it('ENTERPRISE -> STARTER is rejected: self-serve Starter must go through /billing/checkout', async () => {
    const workspace = await createWorkspace({
      pricingTier: 'ENTERPRISE',
      subscriptionStatus: 'NONE',
    });

    try {
      const res = await POST(makeRequest({ tier: 'STARTER' }), {
        params: Promise.resolve({ workspaceId: workspace.id }),
      });
      expect(res.status).toBe(400);
      expect(subscriptionsUpdate).not.toHaveBeenCalled();

      const unchanged = await prisma.workspace.findUniqueOrThrow({ where: { id: workspace.id } });
      expect(unchanged.pricingTier).toBe('ENTERPRISE');
    } finally {
      await cleanupWorkspace(workspace.id);
    }
  });

  it('tier change on a workspace with no active Stripe subscription: Stripe is never called', async () => {
    const workspace = await createWorkspace({
      pricingTier: 'STARTER',
      subscriptionStatus: 'NONE',
      stripeSubscriptionId: null,
    });

    try {
      const res = await POST(makeRequest({ tier: 'ENTERPRISE' }), {
        params: Promise.resolve({ workspaceId: workspace.id }),
      });
      expect(res.status).toBe(200);
      expect(subscriptionsUpdate).not.toHaveBeenCalled();

      const updated = await prisma.workspace.findUniqueOrThrow({ where: { id: workspace.id } });
      expect(updated.pricingTier).toBe('ENTERPRISE');
    } finally {
      await cleanupWorkspace(workspace.id);
    }
  });

  it('rejects an invalid tier value with 400', async () => {
    const workspace = await createWorkspace({ pricingTier: 'STARTER' });

    try {
      const res = await POST(makeRequest({ tier: 'BOGUS' }), {
        params: Promise.resolve({ workspaceId: workspace.id }),
      });
      expect(res.status).toBe(400);
      expect(subscriptionsUpdate).not.toHaveBeenCalled();
    } finally {
      await cleanupWorkspace(workspace.id);
    }
  });
});
