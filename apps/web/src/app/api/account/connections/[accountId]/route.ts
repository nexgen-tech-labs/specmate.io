import { NextResponse } from 'next/server';
import { auth } from '@/lib/auth';
import { prisma } from '@/lib/prisma';
import { withSerializableRetry } from '@/lib/serializable-transaction';

type Params = { params: Promise<{ accountId: string }> };

class LastSignInMethodError extends Error {}

export async function DELETE(_request: Request, { params }: Params) {
  const session = await auth();
  if (!session?.user?.id) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }
  const userId = session.user.id;
  const { accountId } = await params;

  const account = await prisma.account.findUnique({ where: { id: accountId } });
  // 404 (not 403) for out-of-scope resources, matching this repo's established
  // convention (see workspace-context.ts) — a caller can't distinguish "not
  // yours" from "doesn't exist".
  if (!account || account.userId !== userId) {
    return NextResponse.json({ error: 'Not found.' }, { status: 404 });
  }

  // Re-check the "would this leave zero sign-in methods" condition and the
  // delete itself inside one serializable transaction — otherwise two
  // concurrent DELETEs for a user's last two Accounts (no password) could
  // both read count=2, both pass the check, and both delete, leaving the
  // user locked out.
  const runTransaction = () =>
    prisma.$transaction(
      async (tx) => {
        const user = await tx.user.findUniqueOrThrow({
          where: { id: userId },
          select: { passwordHash: true, _count: { select: { accounts: true } } },
        });
        if (user.passwordHash === null && user._count.accounts <= 1) {
          throw new LastSignInMethodError();
        }
        await tx.account.delete({ where: { id: accountId } });
      },
      { isolationLevel: 'Serializable' },
    );

  try {
    // Postgres can abort either side of a Serializable conflict, not just the
    // "loser," and can abort a retried transaction too under contention — a
    // bounded retry loop re-reads current state each time and reaches the
    // correct outcome (delete, or LastSignInMethodError if the other
    // transaction already won).
    await withSerializableRetry(runTransaction);
  } catch (err) {
    if (err instanceof LastSignInMethodError) {
      return NextResponse.json(
        {
          error:
            'This is your only sign-in method — set a password or link another provider first.',
        },
        { status: 409 },
      );
    }
    throw err;
  }

  return NextResponse.json({ ok: true });
}
