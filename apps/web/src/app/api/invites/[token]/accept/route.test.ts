// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { prisma } from '@/lib/prisma';

let currentSession: { user: { id: string; email: string } } | null = null;

vi.mock('@/lib/auth', () => ({
  auth: async () => currentSession,
}));

const { POST } = await import('./route');

/** End-to-end enforcement of the free-while-solo billing gate at the actual
 * moment a workspace becomes multi-user: invite acceptance. */
describe('POST /api/invites/[token]/accept — billing gate (Issue 10.9 amendment)', () => {
  let workspace: { id: string };
  let admin: { id: string; email: string };
  let invitee: { id: string; email: string };

  beforeEach(async () => {
    const stamp = Date.now();
    workspace = await prisma.workspace.create({ data: { name: 'Accept Gate WS' } });
    admin = await prisma.user.create({
      data: { email: `accept-admin-${stamp}@test.local`, name: 'Admin', passwordHash: 'x' },
    });
    invitee = await prisma.user.create({
      data: { email: `accept-invitee-${stamp}@test.local`, name: 'Invitee', passwordHash: 'x' },
    });
    await prisma.workspaceMember.create({
      data: { workspaceId: workspace.id, userId: admin.id, role: 'ADMIN' },
    });
  });

  afterEach(async () => {
    await prisma.workspaceInvite.deleteMany({ where: { workspaceId: workspace.id } });
    await prisma.workspaceMember.deleteMany({ where: { workspaceId: workspace.id } });
    await prisma.workspace.deleteMany({ where: { id: workspace.id } });
    await prisma.user.deleteMany({ where: { id: { in: [admin.id, invitee.id] } } });
  });

  async function makeInvite() {
    return prisma.workspaceInvite.create({
      data: {
        workspaceId: workspace.id,
        email: invitee.email,
        role: 'REVIEWER',
        token: `test-token-${Date.now()}-${Math.random()}`,
        invitedByUserId: admin.id,
        expiresAt: new Date(Date.now() + 60_000),
      },
    });
  }

  it('rejects acceptance with 402 when the workspace is free/solo and unbilled', async () => {
    const invite = await makeInvite();
    currentSession = { user: { id: invitee.id, email: invitee.email } };

    const res = await POST(new Request('http://localhost', { method: 'POST' }), {
      params: Promise.resolve({ token: invite.token }),
    });
    expect(res.status).toBe(402);
    const body = (await res.json()) as { code?: string };
    expect(body.code).toBe('BILLING_REQUIRED');

    const memberCount = await prisma.workspaceMember.count({
      where: { workspaceId: workspace.id },
    });
    expect(memberCount).toBe(1); // no member row was created

    const refreshedInvite = await prisma.workspaceInvite.findUnique({ where: { id: invite.id } });
    expect(refreshedInvite?.status).toBe('PENDING'); // invite not consumed
  });

  it('succeeds once the workspace has an active subscription', async () => {
    await prisma.workspace.update({
      where: { id: workspace.id },
      data: { subscriptionStatus: 'ACTIVE' },
    });
    const invite = await makeInvite();
    currentSession = { user: { id: invitee.id, email: invitee.email } };

    const res = await POST(new Request('http://localhost', { method: 'POST' }), {
      params: Promise.resolve({ token: invite.token }),
    });
    expect(res.status).toBe(200);

    const membership = await prisma.workspaceMember.findUnique({
      where: { workspaceId_userId: { workspaceId: workspace.id, userId: invitee.id } },
    });
    expect(membership).not.toBeNull();
  });

  it('succeeds on ENTERPRISE with no Stripe subscription', async () => {
    await prisma.workspace.update({
      where: { id: workspace.id },
      data: { pricingTier: 'ENTERPRISE' },
    });
    const invite = await makeInvite();
    currentSession = { user: { id: invitee.id, email: invitee.email } };

    const res = await POST(new Request('http://localhost', { method: 'POST' }), {
      params: Promise.resolve({ token: invite.token }),
    });
    expect(res.status).toBe(200);
  });
});
