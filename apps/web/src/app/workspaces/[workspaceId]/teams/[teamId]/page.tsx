import Link from 'next/link';
import { notFound } from 'next/navigation';
import { requireWorkspaceRole } from '@/lib/workspace-context';
import { prisma } from '@/lib/prisma';
import { TeamDetail } from './team-detail';

// Team detail page (Issue #99): member and project-scope management for a
// single team. The PATCH endpoint this posts to already existed from Issue
// 12.11 — this page is pure UI on top of it. Access rules mirror the
// endpoint's (effective-ADMIN-only).
export default async function TeamDetailPage({
  params,
}: {
  params: Promise<{ workspaceId: string; teamId: string }>;
}) {
  const { workspaceId, teamId } = await params;

  const access = await requireWorkspaceRole(workspaceId, ['ADMIN']);
  if (!access.ok) notFound();

  const team = await prisma.team.findFirst({
    where: { id: teamId, workspaceId, deletedAt: null },
    include: {
      members: { select: { userId: true } },
      projects: { select: { projectId: true } },
    },
  });
  if (!team) notFound();

  const [workspaceMembers, projects] = await Promise.all([
    prisma.workspaceMember.findMany({
      where: { workspaceId },
      select: { userId: true, user: { select: { name: true, email: true } } },
    }),
    prisma.project.findMany({
      where: { workspaceId, deletedAt: null },
      select: { id: true, name: true },
      orderBy: { name: 'asc' },
    }),
  ]);

  return (
    <div className="mx-auto max-w-3xl px-6 py-10">
      <Link
        href={`/workspaces/${workspaceId}/settings`}
        className="text-sm font-semibold text-cobalt"
      >
        ← Back to team list
      </Link>
      <h1 className="mt-2 text-3xl font-bold tracking-tight text-ink">{team.name}</h1>
      <div className="mt-8">
        <TeamDetail
          workspaceId={workspaceId}
          teamId={teamId}
          allWorkspaceMembers={workspaceMembers.map((m) => ({
            userId: m.userId,
            name: m.user.name,
            email: m.user.email,
          }))}
          allProjects={projects.map((p) => ({ id: p.id, name: p.name }))}
          initialMemberIds={team.members.map((m) => m.userId)}
          initialProjectIds={team.projects.map((p) => p.projectId)}
        />
      </div>
    </div>
  );
}
