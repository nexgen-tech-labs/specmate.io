import { prisma } from './prisma';
import type { Role } from '@prisma/client';

/**
 * Access resolution across the Organization → Workspace → Team → User
 * hierarchy (Issues 12.10/12.11), built on the original flat-workspace choke
 * point from Issue #1.2. Every workspace-scoped query must still come through
 * here — that's what prevents cross-workspace (and now cross-organization)
 * data leakage.
 *
 * Effective-role rules:
 * - A direct WorkspaceMember row grants its role, exactly as before.
 * - An org-level OWNER or ADMIN of the workspace's organization has an
 *   implicit effective Workspace ADMIN role in every workspace of that org
 *   (Issue 12.11's inheritance rule), even with no WorkspaceMember row.
 * - When both exist, the higher access wins (org OWNER/ADMIN ⇒ ADMIN).
 * - A workspace with no organizationId simply has no org-level grants —
 *   deny-by-default, nothing breaks.
 *
 * Team-scoping rules (restriction, not grant — see schema.prisma Team docs):
 * - ADMINs (direct or org-derived) are never restricted.
 * - A REVIEWER/VIEWER who belongs to ≥1 project-scoped team in the workspace
 *   sees only the union of those teams' projects.
 * - Members of no team, or only of unscoped teams, see the whole workspace
 *   (backward compatible with all pre-hierarchy members).
 *
 * Deliberately has no dependency on next-auth/auth.ts — keeps this pure and
 * directly unit-testable without Next.js request-context machinery.
 */

export interface EffectiveMembership {
  workspaceId: string;
  userId: string;
  role: Role;
  /** How the role was obtained — 'ORGANIZATION' means there is no
   * WorkspaceMember row; the role is inherited from org OWNER/ADMIN. */
  via: 'WORKSPACE' | 'ORGANIZATION';
  orgRole: 'OWNER' | 'ADMIN' | null;
}

export async function getWorkspaceMembershipForUser(
  workspaceId: string,
  userId: string,
): Promise<EffectiveMembership | null> {
  const [direct, workspace] = await Promise.all([
    prisma.workspaceMember.findUnique({
      where: { workspaceId_userId: { workspaceId, userId } },
    }),
    prisma.workspace.findUnique({
      where: { id: workspaceId },
      select: { organizationId: true },
    }),
  ]);
  if (!workspace) return null;

  const orgMember = workspace.organizationId
    ? await prisma.organizationMember.findUnique({
        where: {
          organizationId_userId: { organizationId: workspace.organizationId, userId },
        },
      })
    : null;

  if (!direct && !orgMember) return null;

  // Org OWNER/ADMIN ⇒ effective workspace ADMIN, overriding a lower direct role.
  const role: Role = orgMember ? 'ADMIN' : (direct as NonNullable<typeof direct>).role;

  return {
    workspaceId,
    userId,
    role,
    via: direct ? 'WORKSPACE' : 'ORGANIZATION',
    orgRole: orgMember?.role ?? null,
  };
}

export function hasRequiredRole(
  membership: EffectiveMembership | null,
  allowedRoles: Array<Role>,
): membership is EffectiveMembership {
  return membership != null && allowedRoles.includes(membership.role);
}

/**
 * Team project scoping (Issue 12.11 AC 2). Returns `null` when the user has
 * unrestricted project visibility in the workspace (they're an effective
 * ADMIN, or belong to no project-scoped team); otherwise the set of project
 * ids they may see/act on.
 */
export async function getAccessibleProjectIds(
  workspaceId: string,
  membership: EffectiveMembership,
): Promise<Set<string> | null> {
  if (membership.role === 'ADMIN') return null;

  const scopedTeams = await prisma.team.findMany({
    where: {
      workspaceId,
      deletedAt: null,
      members: { some: { userId: membership.userId } },
      projects: { some: {} },
    },
    select: { projects: { select: { projectId: true } } },
  });
  if (scopedTeams.length === 0) return null;

  return new Set(scopedTeams.flatMap((team) => team.projects.map((p) => p.projectId)));
}

/** Org membership lookup for org-level endpoints (create workspace, org settings). */
export function getOrganizationMembership(organizationId: string, userId: string) {
  return prisma.organizationMember.findUnique({
    where: { organizationId_userId: { organizationId, userId } },
  });
}
