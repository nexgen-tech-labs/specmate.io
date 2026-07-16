import Link from 'next/link';
import { notFound } from 'next/navigation';
import { requireWorkspaceRole } from '@/lib/workspace-context';
import { prisma } from '@/lib/prisma';
import { nextInviteNeedsBilling } from '@/lib/billing-gate';
import { InviteForm } from './invite-form';

export default async function WorkspaceInvitePage({
  params,
}: {
  params: Promise<{ workspaceId: string }>;
}) {
  const { workspaceId } = await params;

  const access = await requireWorkspaceRole(workspaceId, ['ADMIN']);
  if (!access.ok) {
    notFound();
  }

  const workspace = await prisma.workspace.findUnique({ where: { id: workspaceId } });
  if (!workspace) notFound();

  // Free-while-solo (Issue 10.9 amendment): warn upfront if this workspace is
  // still solo and unbilled — the invite link will work, but acceptance will be
  // blocked (402) until billing is set up.
  const needsBilling = await nextInviteNeedsBilling(workspaceId);

  return (
    <div className="flex min-h-screen items-center justify-center bg-paper px-6">
      <div className="w-full max-w-md">
        <div className="mb-8 text-center">
          <h1 className="text-3xl font-bold tracking-tight text-ink">Invite a teammate</h1>
          <p className="mt-2 text-base text-sub">to {workspace.name}</p>
        </div>
        {needsBilling ? (
          <div className="mb-6 rounded-md border border-line bg-panel px-4 py-3 text-sm text-sub">
            This workspace is on the free single-user plan. Your teammate won&apos;t be able to
            accept this invite until you{' '}
            <Link href={`/workspaces/${workspaceId}/billing`} className="text-cobalt underline">
              add a payment method
            </Link>
            .
          </div>
        ) : null}
        <InviteForm workspaceId={workspaceId} />
      </div>
    </div>
  );
}
