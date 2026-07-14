import Link from 'next/link';
import { notFound } from 'next/navigation';
import { requireWorkspaceRole } from '@/lib/workspace-context';
import { prisma } from '@/lib/prisma';
import { NewProjectForm } from '@/components/workspace/new-project-form';

// Workspace dashboard (Issue 10.10) — the landing page after signup/login.
// A brand-new workspace has zero projects; that empty state is itself the
// entry point into the guided onboarding wizard (create → wizard, not a
// separate "start onboarding" button).
export default async function WorkspaceDashboardPage({
  params,
}: {
  params: Promise<{ workspaceId: string }>;
}) {
  const { workspaceId } = await params;

  const access = await requireWorkspaceRole(workspaceId, ['ADMIN', 'REVIEWER', 'VIEWER']);
  if (!access.ok) notFound();

  const workspace = await prisma.workspace.findUnique({ where: { id: workspaceId } });
  if (!workspace) notFound();

  const projects = await prisma.project.findMany({
    where: { workspaceId, deletedAt: null },
    orderBy: { createdAt: 'desc' },
    include: {
      _count: { select: { sources: true, draftItems: true } },
    },
  });

  const canCreate = access.membership.role !== 'VIEWER';

  return (
    <div className="min-h-screen bg-paper px-6 py-16">
      <div className="mx-auto max-w-2xl">
        <div className="mb-8 flex items-end justify-between">
          <div>
            <h1 className="text-3xl font-bold tracking-tight text-ink">{workspace.name}</h1>
            <p className="mt-2 text-base text-sub">Your projects</p>
          </div>
          {access.membership.role === 'ADMIN' ? (
            <Link
              href={`/workspaces/${workspaceId}/invite`}
              className="text-sm text-cobalt underline-offset-2 hover:underline"
            >
              Invite teammate →
            </Link>
          ) : null}
        </div>

        {projects.length === 0 ? (
          <div className="rounded-lg border border-line bg-panel p-8 text-center">
            <p className="text-base text-ink">No projects yet.</p>
            <p className="mt-2 text-sm text-sub">
              Create your first project to connect a tool, upload a source, and generate your first
              items — usually under 15 minutes.
            </p>
            {canCreate ? (
              <div className="mt-6">
                <NewProjectForm workspaceId={workspaceId} redirectToWizard />
              </div>
            ) : null}
          </div>
        ) : (
          <>
            <ul className="space-y-2">
              {projects.map((project) => (
                <li key={project.id}>
                  <Link
                    href={`/workspaces/${workspaceId}/projects/${project.id}/review`}
                    className="flex items-center justify-between rounded-md border border-line bg-panel px-4 py-3 text-sm hover:border-cobalt"
                  >
                    <span className="font-semibold text-ink">{project.name}</span>
                    <span className="font-mono text-xs text-sub">
                      {project._count.sources} source{project._count.sources === 1 ? '' : 's'} ·{' '}
                      {project._count.draftItems} item{project._count.draftItems === 1 ? '' : 's'}
                    </span>
                  </Link>
                </li>
              ))}
            </ul>
            {canCreate ? (
              <div className="mt-6">
                <NewProjectForm workspaceId={workspaceId} />
              </div>
            ) : null}
          </>
        )}
      </div>
    </div>
  );
}
