import { redirect, notFound } from 'next/navigation';
import { auth } from '@/lib/auth';
import { prisma } from '@/lib/prisma';

// apps/api's org-level OAuth callback (jira_oauth.py / github_oauth.py)
// redirects here after authorizing the org-level Connection — there's no
// dedicated org-connect page in the design (the whole flow lives in the
// dashboard's Connect a Tool modal), so this route's only job is to resolve
// which workspace in this org the signed-in user should land back on, and
// forward the ?oauth=success signal so the dashboard's client shell reopens
// the Connect modal at the scope-picker step instead of losing the flow.
export default async function OrgConnectReturnPage({
  params,
  searchParams,
}: {
  params: Promise<{ organizationId: string; toolKey: string }>;
  searchParams: Promise<{ oauth?: string }>;
}) {
  const { organizationId, toolKey } = await params;
  const { oauth } = await searchParams;

  const session = await auth();
  if (!session?.user?.id) notFound();

  const membership = await prisma.workspaceMember.findFirst({
    where: { userId: session.user.id, workspace: { organizationId } },
    orderBy: { createdAt: 'asc' },
    select: { workspaceId: true },
  });
  if (!membership) notFound();

  const oauthParam = oauth === 'success' ? '&oauth=success' : '';
  redirect(`/workspaces/${membership.workspaceId}?connect_tool=${toolKey}${oauthParam}`);
}
