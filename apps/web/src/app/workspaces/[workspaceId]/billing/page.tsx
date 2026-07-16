import { notFound } from 'next/navigation';
import { requireWorkspaceRole } from '@/lib/workspace-context';
import { prisma } from '@/lib/prisma';
import { BillingSettings } from './billing-settings';

// Billing settings (Issue 10.9 amendment — free while solo): the entry point
// into Stripe Checkout, now that onboarding no longer forces a plan choice at
// signup. A workspace only needs this once it's about to add a second member.
export default async function WorkspaceBillingPage({
  params,
}: {
  params: Promise<{ workspaceId: string }>;
}) {
  const { workspaceId } = await params;

  const access = await requireWorkspaceRole(workspaceId, ['ADMIN']);
  if (!access.ok) notFound();

  const workspace = await prisma.workspace.findUnique({
    where: { id: workspaceId },
    select: { name: true, pricingTier: true, subscriptionStatus: true },
  });
  if (!workspace) notFound();

  return (
    <div className="flex min-h-screen items-center justify-center bg-paper px-6">
      <div className="w-full max-w-md">
        <div className="mb-8 text-center">
          <h1 className="text-3xl font-bold tracking-tight text-ink">Billing</h1>
          <p className="mt-2 text-base text-sub">for {workspace.name}</p>
        </div>
        <BillingSettings
          workspaceId={workspaceId}
          pricingTier={workspace.pricingTier}
          subscriptionStatus={workspace.subscriptionStatus}
        />
      </div>
    </div>
  );
}
