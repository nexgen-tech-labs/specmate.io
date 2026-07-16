/**
 * Free-while-solo gate (Issue 10.9 amendment): a new Organization/Workspace is
 * free for exactly one user — no Stripe touch at signup (see onboarding-form.tsx).
 * The moment a workspace would gain a *second* member, it needs either an active
 * paid subscription (STARTER + Stripe subscriptionStatus TRIALING/ACTIVE) or to be
 * on the sales-assisted ENTERPRISE tier (no self-serve Stripe object required —
 * billed outside Stripe, see billing/tier route).
 *
 * This is a workspace-level check (Workspace.pricingTier/subscriptionStatus,
 * Issue 10.9's model), not an org-level one — org-level billing consolidation is
 * an explicit open decision recorded on Issue #97, deferred until real pricing
 * lands. Each workspace pays for its own seats for now.
 */
import { prisma } from './prisma';

const ACTIVE_SUBSCRIPTION_STATUSES = new Set(['TRIALING', 'ACTIVE']);

export interface SeatGateResult {
  allowed: boolean;
  reason?: string;
}

function hasActiveBilling(workspace: {
  pricingTier: 'STARTER' | 'ENTERPRISE';
  subscriptionStatus: string;
}): boolean {
  if (workspace.pricingTier === 'ENTERPRISE') return true;
  return ACTIVE_SUBSCRIPTION_STATUSES.has(workspace.subscriptionStatus);
}

/** Would adding `newUserId` as a WorkspaceMember bring this workspace to 2+
 * distinct members? If so, billing must already be active. Counts current
 * WorkspaceMembers only — org-role-derived implicit access (Issue 12.11
 * inheritance) doesn't create a WorkspaceMember row and isn't a "seat" in the
 * billing sense, so an org OWNER browsing a workspace never trips this gate. */
export async function checkSeatGate(
  workspaceId: string,
  newUserId: string,
): Promise<SeatGateResult> {
  const workspace = await prisma.workspace.findUnique({
    where: { id: workspaceId },
    select: { pricingTier: true, subscriptionStatus: true },
  });
  if (!workspace) return { allowed: false, reason: 'Workspace not found.' };

  const existingMembers = await prisma.workspaceMember.findMany({
    where: { workspaceId },
    select: { userId: true },
  });
  const wouldBeNewMember = !existingMembers.some((m) => m.userId === newUserId);
  const memberCountAfter = existingMembers.length + (wouldBeNewMember ? 1 : 0);

  if (memberCountAfter <= 1) return { allowed: true };
  if (hasActiveBilling(workspace)) return { allowed: true };

  return {
    allowed: false,
    reason:
      'This workspace is on the free single-user plan. Add a payment method (or switch to Enterprise) before adding a teammate.',
  };
}

/** For UI hints (e.g. the invite page): would accepting the *next* invite
 * require billing, given the workspace's current member count? True only when
 * the workspace is currently solo (≤1 member) and has no active billing. */
export async function nextInviteNeedsBilling(workspaceId: string): Promise<boolean> {
  const [workspace, memberCount] = await Promise.all([
    prisma.workspace.findUnique({
      where: { id: workspaceId },
      select: { pricingTier: true, subscriptionStatus: true },
    }),
    prisma.workspaceMember.count({ where: { workspaceId } }),
  ]);
  if (!workspace || memberCount > 1) return false;
  return !hasActiveBilling(workspace);
}
