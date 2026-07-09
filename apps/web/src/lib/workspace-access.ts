import { prisma } from './prisma';
import type { WorkspaceMember } from '@prisma/client';

/**
 * The single choke point every workspace-scoped query must go through.
 *
 * Returns userId's WorkspaceMember row for the given workspace, or null if
 * they aren't a member. No route or query should trust a workspaceId from the
 * request without first confirming membership through this function — that's
 * what prevents cross-workspace data leakage (Issue #1.2 acceptance criterion).
 *
 * Deliberately has no dependency on next-auth/auth.ts — keeps this pure and
 * directly unit-testable without pulling in Next.js request-context machinery.
 */
export function getWorkspaceMembershipForUser(
  workspaceId: string,
  userId: string,
): Promise<WorkspaceMember | null> {
  return prisma.workspaceMember.findUnique({
    where: { workspaceId_userId: { workspaceId, userId } },
  });
}

export function hasRequiredRole(
  membership: WorkspaceMember | null,
  allowedRoles: Array<WorkspaceMember['role']>,
): membership is WorkspaceMember {
  return membership != null && allowedRoles.includes(membership.role);
}
