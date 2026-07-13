import { notFound } from 'next/navigation';
import { requireWorkspaceRole } from '@/lib/workspace-context';
import { prisma } from '@/lib/prisma';
import { AdoPublishingSettings } from '@/components/publish/ado-publishing-settings';

export default async function AdoPublishingSettingsPage({
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
    where: { projectId_tool: { projectId, tool: 'ADO' } },
  });

  return (
    <div className="min-h-screen bg-paper px-6 py-16">
      <div className="mx-auto max-w-2xl">
        <h1 className="text-3xl font-bold tracking-tight text-ink">Azure DevOps publishing</h1>
        <p className="mt-2 text-base text-sub">
          Map {project.name}&apos;s items to your ADO project so approved items publish as real work
          items.
        </p>
        <AdoPublishingSettings
          workspaceId={workspaceId}
          projectId={projectId}
          initial={
            mapping
              ? {
                  remoteProject: mapping.remoteProject,
                  typeMap: mapping.typeMap as Record<string, string>,
                  fieldDefaults: (mapping.fieldDefaults as Record<string, unknown>) ?? {},
                  metadata: mapping.metadata as {
                    work_item_types?: Array<{
                      name: string;
                      required_fields: Array<{ id: string; name: string }>;
                    }>;
                    area_paths?: string[];
                    iteration_paths?: string[];
                  } | null,
                }
              : null
          }
        />
      </div>
    </div>
  );
}
