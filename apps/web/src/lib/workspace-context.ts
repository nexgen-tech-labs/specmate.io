import { auth } from './auth';
import { getWorkspaceMembershipForUser, hasRequiredRole } from './workspace-access';
import type { WorkspaceMember } from '@prisma/client';

export { getWorkspaceMembershipForUser, hasRequiredRole } from './workspace-access';

export async function getCurrentWorkspaceMembership(
  workspaceId: string,
): Promise<WorkspaceMember | null> {
  const session = await auth();
  const userId = session?.user?.id;
  if (!userId) return null;
  return getWorkspaceMembershipForUser(workspaceId, userId);
}

export async function requireWorkspaceRole(
  workspaceId: string,
  allowedRoles: Array<WorkspaceMember['role']>,
): Promise<{ ok: true; membership: WorkspaceMember } | { ok: false; status: 401 | 403 }> {
  const session = await auth();
  if (!session?.user?.id) return { ok: false, status: 401 };

  const membership = await getCurrentWorkspaceMembership(workspaceId);
  if (!hasRequiredRole(membership, allowedRoles)) {
    return { ok: false, status: 403 };
  }
  return { ok: true, membership };
}
