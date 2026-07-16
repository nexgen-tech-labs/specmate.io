// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { prisma } from './prisma';
import { checkSeatGate, nextInviteNeedsBilling } from './billing-gate';

/** Free-while-solo billing gate (Issue 10.9 amendment). */
describe('checkSeatGate / nextInviteNeedsBilling', () => {
  let workspace: { id: string };
  let solo: { id: string };
  let second: { id: string };

  beforeEach(async () => {
    const stamp = Date.now();
    workspace = await prisma.workspace.create({ data: { name: 'Seat Gate WS' } });
    solo = await prisma.user.create({
      data: { email: `seat-solo-${stamp}@test.local`, name: 'Solo', passwordHash: 'x' },
    });
    second = await prisma.user.create({
      data: { email: `seat-second-${stamp}@test.local`, name: 'Second', passwordHash: 'x' },
    });
    await prisma.workspaceMember.create({
      data: { workspaceId: workspace.id, userId: solo.id, role: 'ADMIN' },
    });
  });

  afterEach(async () => {
    await prisma.workspaceMember.deleteMany({ where: { workspaceId: workspace.id } });
    await prisma.workspace.deleteMany({ where: { id: workspace.id } });
    await prisma.user.deleteMany({ where: { id: { in: [solo.id, second.id] } } });
  });

  it('allows a solo (1-member) workspace to stay solo without billing', async () => {
    // Re-adding the same user (e.g. idempotent invite acceptance) never trips it.
    const result = await checkSeatGate(workspace.id, solo.id);
    expect(result.allowed).toBe(true);
  });

  it('blocks adding a second distinct member on the free STARTER/NONE default', async () => {
    const result = await checkSeatGate(workspace.id, second.id);
    expect(result.allowed).toBe(false);
    expect(result.reason).toMatch(/free single-user plan/i);
  });

  it('allows a second member once the workspace has an active Stripe subscription', async () => {
    await prisma.workspace.update({
      where: { id: workspace.id },
      data: { subscriptionStatus: 'ACTIVE' },
    });
    expect((await checkSeatGate(workspace.id, second.id)).allowed).toBe(true);
  });

  it('allows a second member on TRIALING too', async () => {
    await prisma.workspace.update({
      where: { id: workspace.id },
      data: { subscriptionStatus: 'TRIALING' },
    });
    expect((await checkSeatGate(workspace.id, second.id)).allowed).toBe(true);
  });

  it('allows a second member on ENTERPRISE with no Stripe subscription at all', async () => {
    await prisma.workspace.update({
      where: { id: workspace.id },
      data: { pricingTier: 'ENTERPRISE' },
    });
    expect((await checkSeatGate(workspace.id, second.id)).allowed).toBe(true);
  });

  it('still blocks on PAST_DUE/CANCELED — only TRIALING/ACTIVE count as active', async () => {
    await prisma.workspace.update({
      where: { id: workspace.id },
      data: { subscriptionStatus: 'CANCELED' },
    });
    expect((await checkSeatGate(workspace.id, second.id)).allowed).toBe(false);
  });

  it('nextInviteNeedsBilling reflects the same gate for the invite-page warning', async () => {
    expect(await nextInviteNeedsBilling(workspace.id)).toBe(true);
    await prisma.workspace.update({
      where: { id: workspace.id },
      data: { subscriptionStatus: 'ACTIVE' },
    });
    expect(await nextInviteNeedsBilling(workspace.id)).toBe(false);
  });

  it('nextInviteNeedsBilling is false once the workspace already has 2+ members', async () => {
    await prisma.workspaceMember.create({
      data: { workspaceId: workspace.id, userId: second.id, role: 'VIEWER' },
    });
    // Already multi-user (however that happened) — no further gating signal needed.
    expect(await nextInviteNeedsBilling(workspace.id)).toBe(false);
  });
});
