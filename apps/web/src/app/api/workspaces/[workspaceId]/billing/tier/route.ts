import { NextResponse } from 'next/server';
import { prisma } from '@/lib/prisma';
import { requireWorkspaceRole } from '@/lib/workspace-context';

type Params = { params: Promise<{ workspaceId: string }> };

// Sets a workspace to ENTERPRISE (sales-assisted, no Stripe subscription created
// here — custom pricing is negotiated and billed outside self-serve Checkout).
// Issue 10.9's "tiers selectable at signup" AC, for the non-self-serve path.
export async function POST(request: Request, { params }: Params) {
  const { workspaceId } = await params;

  const access = await requireWorkspaceRole(workspaceId, ['ADMIN']);
  if (!access.ok) {
    return NextResponse.json({ error: 'Forbidden' }, { status: access.status });
  }

  const body = (await request.json().catch(() => ({}))) as { tier?: unknown };
  if (body.tier !== 'ENTERPRISE') {
    return NextResponse.json(
      { error: 'This endpoint only sets ENTERPRISE. Use /billing/checkout for STARTER.' },
      { status: 400 },
    );
  }

  await prisma.workspace.update({
    where: { id: workspaceId },
    data: { pricingTier: 'ENTERPRISE', subscriptionStatus: 'NONE' },
  });

  return NextResponse.json({ ok: true, tier: 'ENTERPRISE' });
}
