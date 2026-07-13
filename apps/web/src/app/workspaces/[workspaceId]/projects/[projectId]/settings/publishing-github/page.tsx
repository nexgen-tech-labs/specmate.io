import { notFound } from 'next/navigation';
import { requireWorkspaceRole } from '@/lib/workspace-context';
import { prisma } from '@/lib/prisma';
import { GithubPublishingSettings } from '@/components/publish/github-publishing-settings';

export default async function GithubPublishingSettingsPage({
  params,
}: {
  params: Promise<{ workspaceId: string; projectId: string }>;
}) {
  const { workspaceId, projectId } = await params;

  const access = await requireWorkspaceRole(workspaceId, ['ADMIN']);
  if (!access.ok) notFound();

  const project = await prisma.project.findFirst({ where: { id: projectId, workspaceId } });
  if (!project) notFound();

  const mapping = await prisma.publishMapping.findUnique({
    where: { projectId_tool: { projectId, tool: 'GITHUB' } },
  });

  return (
    <div className="min-h-screen bg-paper px-6 py-16">
      <div className="mx-auto max-w-2xl">
        <h1 className="text-3xl font-bold tracking-tight text-ink">GitHub publishing</h1>
        <p className="mt-2 text-base text-sub">
          Map {project.name}&apos;s items to a GitHub repository so approved items publish as real
          issues.
        </p>
        <GithubPublishingSettings
          workspaceId={workspaceId}
          projectId={projectId}
          initial={
            mapping
              ? {
                  remoteProject: mapping.remoteProject,
                  formatMode: mapping.formatMode,
                  metadata: mapping.metadata as {
                    labels?: string[];
                    milestones?: Array<{ number: number; title: string }>;
                    file_paths?: string[];
                  } | null,
                }
              : null
          }
        />
      </div>
    </div>
  );
}
