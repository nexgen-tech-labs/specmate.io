import Link from 'next/link';
import { notFound } from 'next/navigation';
import { requireWorkspaceRole } from '@/lib/workspace-context';
import { prisma } from '@/lib/prisma';
import { TeamList } from './team-list';

// Workspace settings page (Issue #99): the team list for a workspace. Team
// management (create/archive) is effective-ADMIN-only, mirroring the
// endpoints' access rules — the endpoints themselves already existed from
// Issues 12.10/12.11.
export default async function WorkspaceSettingsPage({
  params,
}: {
  params: Promise<{ workspaceId: string }>;
}) {
  const { workspaceId } = await params;

  const access = await requireWorkspaceRole(workspaceId, ['ADMIN']);
  if (!access.ok) notFound();

  const workspace = await prisma.workspace.findUnique({
    where: { id: workspaceId },
    select: { name: true, organizationId: true },
  });
  if (!workspace) notFound();

  const teams = await prisma.team.findMany({
    where: { workspaceId, deletedAt: null },
    include: {
      members: { select: { userId: true, user: { select: { name: true, email: true } } } },
      projects: { select: { projectId: true } },
    },
    orderBy: { name: 'asc' },
  });

  return (
    <div className="mx-auto max-w-3xl px-6 py-10">
      {workspace.organizationId ? (
        <Link
          href={`/organizations/${workspace.organizationId}/settings`}
          className="text-sm font-semibold text-cobalt"
        >
          ← Back to organization settings
        </Link>
      ) : null}
      <h1 className="mt-2 text-3xl font-bold tracking-tight text-ink">{workspace.name}</h1>
      <div className="mt-8">
        <TeamList
          workspaceId={workspaceId}
          initialTeams={teams.map((team) => ({
            id: team.id,
            name: team.name,
            memberCount: team.members.length,
            projectScopeCount: team.projects.length,
          }))}
        />
      </div>
    </div>
  );
}
