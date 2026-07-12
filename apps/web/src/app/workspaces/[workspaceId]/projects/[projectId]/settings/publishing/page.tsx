import { notFound } from 'next/navigation';
import { requireWorkspaceRole } from '@/lib/workspace-context';
import { prisma } from '@/lib/prisma';
import { PublishingSettings } from '@/components/publish/publishing-settings';

export default async function PublishingSettingsPage({
  params,
}: {
  params: Promise<{ workspaceId: string; projectId: string }>;
}) {
  const { workspaceId, projectId } = await params;

  // Connector setup is an ADMIN concern (Issue 5.3).
  const access = await requireWorkspaceRole(workspaceId, ['ADMIN']);
  if (!access.ok) notFound();

  const project = await prisma.project.findFirst({ where: { id: projectId, workspaceId } });
  if (!project) notFound();

  const mapping = await prisma.publishMapping.findUnique({
    where: { projectId_tool: { projectId, tool: 'JIRA' } },
  });

  return (
    <div className="min-h-screen bg-paper px-6 py-16">
      <div className="mx-auto max-w-2xl">
        <h1 className="text-3xl font-bold tracking-tight text-ink">Publishing settings</h1>
        <p className="mt-2 text-base text-sub">
          Map {project.name}&apos;s items to your Jira project so approved items publish as real
          issues.
        </p>
        <PublishingSettings
          workspaceId={workspaceId}
          projectId={projectId}
          initial={
            mapping
              ? {
                  remoteProject: mapping.remoteProject,
                  typeMap: mapping.typeMap as Record<string, string>,
                  fieldDefaults: (mapping.fieldDefaults as Record<string, unknown>) ?? {},
                  metadata: mapping.metadata as {
                    issue_types?: Array<{
                      name: string;
                      fields: Array<{
                        id: string;
                        name: string;
                        required: boolean;
                        has_default: boolean;
                      }>;
                    }>;
                  } | null,
                }
              : null
          }
        />
      </div>
    </div>
  );
}
