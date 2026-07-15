import { auth } from './auth';
import { prisma } from './prisma';
import {
  getAccessibleProjectIds,
  getOrganizationMembership,
  getWorkspaceMembershipForUser,
  hasRequiredRole,
  type EffectiveMembership,
} from './workspace-access';
import type { OrganizationMember, Project, Role } from '@prisma/client';

export {
  getAccessibleProjectIds,
  getWorkspaceMembershipForUser,
  hasRequiredRole,
} from './workspace-access';
export type { EffectiveMembership } from './workspace-access';

export async function getCurrentWorkspaceMembership(
  workspaceId: string,
): Promise<EffectiveMembership | null> {
  const session = await auth();
  const userId = session?.user?.id;
  if (!userId) return null;
  return getWorkspaceMembershipForUser(workspaceId, userId);
}

export async function requireWorkspaceRole(
  workspaceId: string,
  allowedRoles: Array<Role>,
): Promise<{ ok: true; membership: EffectiveMembership } | { ok: false; status: 401 | 403 }> {
  const session = await auth();
  if (!session?.user?.id) return { ok: false, status: 401 };

  const membership = await getCurrentWorkspaceMembership(workspaceId);
  if (!hasRequiredRole(membership, allowedRoles)) {
    return { ok: false, status: 403 };
  }
  return { ok: true, membership };
}

/**
 * Workspace-role check + project lookup + team-scope enforcement in one call
 * (Issue 12.11 AC: scoping enforced server-side on every relevant API call).
 * Replaces the repeated requireWorkspaceRole + `prisma.project.findFirst`
 * pattern in project-scoped routes/pages. Out-of-scope and nonexistent
 * projects both return 404 — a team-scoped user can't distinguish "hidden
 * from me" from "doesn't exist", avoiding an existence leak.
 */
export async function requireProjectRole(
  workspaceId: string,
  projectId: string,
  allowedRoles: Array<Role>,
): Promise<
  | { ok: true; membership: EffectiveMembership; project: Project }
  | { ok: false; status: 401 | 403 | 404 }
> {
  const access = await requireWorkspaceRole(workspaceId, allowedRoles);
  if (!access.ok) return access;

  const project = await prisma.project.findFirst({ where: { id: projectId, workspaceId } });
  if (!project) return { ok: false, status: 404 };

  const accessibleIds = await getAccessibleProjectIds(workspaceId, access.membership);
  if (accessibleIds && !accessibleIds.has(projectId)) {
    return { ok: false, status: 404 };
  }

  return { ok: true, membership: access.membership, project };
}

/** Org-level gate (Issue 12.11): OWNER for billing/org settings/workspace
 * lifecycle; ADMIN for workspace/team management. */
export async function requireOrganizationRole(
  organizationId: string,
  allowedRoles: Array<OrganizationMember['role']>,
): Promise<{ ok: true; membership: OrganizationMember } | { ok: false; status: 401 | 403 }> {
  const session = await auth();
  if (!session?.user?.id) return { ok: false, status: 401 };

  const membership = await getOrganizationMembership(organizationId, session.user.id);
  if (!membership || !allowedRoles.includes(membership.role)) {
    return { ok: false, status: 403 };
  }
  return { ok: true, membership };
}
