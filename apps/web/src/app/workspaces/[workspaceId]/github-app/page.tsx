import Link from 'next/link';
import { notFound } from 'next/navigation';
import { requireWorkspaceRole } from '@/lib/workspace-context';
import { prisma } from '@/lib/prisma';
import { GitHubAppClaim } from './github-app-claim';

// Claims a GitHub Marketplace install for this workspace (Issue 10.3 AC:
// "Installation correctly provisions workspace access"). There's no way to
// know which SpecMate workspace a GitHub App install belongs to at install
// time (the GitHub org/user admin installing the app has no SpecMate
// account context), so an admin claims it manually here, matched by account
// login — mirrors the Atlassian Connect claim page exactly.
export default async function WorkspaceGitHubAppPage({
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
    prisma.gitHubAppInstall.findMany({
      where: { workspaceId, uninstalledAt: null },
      select: {
        id: true,
        accountLogin: true,
        accountType: true,
        repositorySelection: true,
        installedAt: true,
      },
      orderBy: { installedAt: 'desc' },
    }),
    prisma.gitHubAppInstall.findMany({
      where: { workspaceId: null, uninstalledAt: null },
      select: {
        id: true,
        accountLogin: true,
        accountType: true,
        repositorySelection: true,
        installedAt: true,
      },
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
      <h1 className="mt-2 text-3xl font-bold tracking-tight text-ink">GitHub Marketplace</h1>
      <p className="mt-2 text-base text-sub">
        Link a GitHub account that installed SpecMate from the GitHub Marketplace to{' '}
        {workspace.name}.
      </p>
      <div className="mt-8">
        <GitHubAppClaim
          workspaceId={workspaceId}
          initialClaimed={claimed.map((install) => ({
            id: install.id,
            accountLogin: install.accountLogin,
            accountType: install.accountType,
            repositorySelection: install.repositorySelection,
            installedAt: install.installedAt.toISOString(),
          }))}
          initialUnclaimed={unclaimed.map((install) => ({
            id: install.id,
            accountLogin: install.accountLogin,
            accountType: install.accountType,
            repositorySelection: install.repositorySelection,
            installedAt: install.installedAt.toISOString(),
          }))}
        />
      </div>
    </div>
  );
}
