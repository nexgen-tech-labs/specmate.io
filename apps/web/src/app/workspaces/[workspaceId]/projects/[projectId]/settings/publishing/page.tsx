import { notFound } from 'next/navigation';
import Link from 'next/link';
import { requireProjectRole } from '@/lib/workspace-context';
import { prisma } from '@/lib/prisma';
import { PublishingSettings } from '@/components/publish/publishing-settings';

export default async function PublishingSettingsPage({
  params,
}: {
  params: Promise<{ workspaceId: string; projectId: string }>;
}) {
  const { workspaceId, projectId } = await params;

  // Connector setup is an ADMIN concern (Issue 5.3).
  const access = await requireProjectRole(workspaceId, projectId, ['ADMIN']);
  if (!access.ok) notFound();

  const project = access.project;

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
        <Link
          href={`/workspaces/${workspaceId}/projects/${projectId}/connect/jira`}
          className="mt-4 inline-block rounded-md border border-line px-4 py-2 text-sm font-semibold text-ink"
        >
          {mapping ? 'Reconnect' : 'Set up connection'} →
        </Link>
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
