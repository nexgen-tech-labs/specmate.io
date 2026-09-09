import Link from 'next/link';
import { notFound } from 'next/navigation';
import { requireWorkspaceRole } from '@/lib/workspace-context';
import { prisma } from '@/lib/prisma';
import { AtlassianConnectClaim } from './atlassian-connect-claim';

// Claims an Atlassian Marketplace install for this workspace (Issue 10.2 AC 3:
// "Installation from the Marketplace correctly provisions a new SpecMate
// workspace connection"). There's no way to know which SpecMate workspace an
// install belongs to at install time (the Jira admin installing the app has
// no SpecMate account context), so an admin claims it manually here, matched
// by the Jira site's URL — the claim API itself already existed
// (api/workspaces/[workspaceId]/atlassian-connect/route.ts) but had no UI.
export default async function WorkspaceAtlassianConnectPage({
  params,
}: {
  params: Promise<{ workspaceId: string }>;
}) {
  const { workspaceId } = await params;

  const access = await requireWorkspaceRole(workspaceId, ['ADMIN']);
  if (!access.ok) notFound();

  const workspace = await prisma.workspace.findUnique({
    where: { id: workspaceId },
    select: { name: true },
  });
  if (!workspace) notFound();

  const [claimed, unclaimed] = await Promise.all([
    prisma.atlassianConnectInstall.findMany({
      where: { workspaceId, uninstalledAt: null },
      select: { id: true, clientKey: true, baseUrl: true, displayUrl: true, installedAt: true },
      orderBy: { installedAt: 'desc' },
    }),
    prisma.atlassianConnectInstall.findMany({
      where: { workspaceId: null, uninstalledAt: null },
      select: { id: true, clientKey: true, baseUrl: true, displayUrl: true, installedAt: true },
      orderBy: { installedAt: 'desc' },
    }),
  ]);

  return (
    <div className="mx-auto max-w-3xl px-6 py-10">
      <Link
        href={`/workspaces/${workspaceId}/settings`}
        className="text-sm font-semibold text-cobalt"
      >
        ← Back to workspace settings
      </Link>
      <h1 className="mt-2 text-3xl font-bold tracking-tight text-ink">Atlassian Marketplace</h1>
      <p className="mt-2 text-base text-sub">
        Link a Jira site that installed SpecMate from the Atlassian Marketplace to {workspace.name}.
      </p>
      <div className="mt-8">
        <AtlassianConnectClaim
          workspaceId={workspaceId}
          initialClaimed={claimed.map((install) => ({
            id: install.id,
            baseUrl: install.baseUrl,
            displayUrl: install.displayUrl,
            installedAt: install.installedAt.toISOString(),
          }))}
          initialUnclaimed={unclaimed.map((install) => ({
            id: install.id,
            baseUrl: install.baseUrl,
            displayUrl: install.displayUrl,
            installedAt: install.installedAt.toISOString(),
          }))}
        />
      </div>
    </div>
  );
}
