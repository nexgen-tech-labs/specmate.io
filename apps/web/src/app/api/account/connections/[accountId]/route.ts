import { NextResponse } from 'next/server';
import { auth } from '@/lib/auth';
import { prisma } from '@/lib/prisma';

type Params = { params: Promise<{ accountId: string }> };

export async function DELETE(_request: Request, { params }: Params) {
  const session = await auth();
  if (!session?.user?.id) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }
  const { accountId } = await params;

  const account = await prisma.account.findUnique({ where: { id: accountId } });
  // 404 (not 403) for out-of-scope resources, matching this repo's established
  // convention (see workspace-context.ts) — a caller can't distinguish "not
  // yours" from "doesn't exist".
  if (!account || account.userId !== session.user.id) {
    return NextResponse.json({ error: 'Not found.' }, { status: 404 });
  }

  const user = await prisma.user.findUniqueOrThrow({
    where: { id: session.user.id },
    select: { passwordHash: true, _count: { select: { accounts: true } } },
  });
  const wouldLoseAllSignInMethods = user.passwordHash === null && user._count.accounts <= 1;
  if (wouldLoseAllSignInMethods) {
    return NextResponse.json(
      {
        error: 'This is your only sign-in method — set a password or link another provider first.',
      },
      { status: 409 },
    );
  }

  await prisma.account.delete({ where: { id: accountId } });
  return NextResponse.json({ ok: true });
}
