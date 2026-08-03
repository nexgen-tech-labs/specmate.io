import { NextResponse } from 'next/server';
import { auth } from '@/lib/auth';
import { prisma } from '@/lib/prisma';

export async function GET(_request: Request) {
  const session = await auth();
  if (!session?.user?.id) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const [accounts, user] = await Promise.all([
    prisma.account.findMany({
      where: { userId: session.user.id },
      select: { id: true, provider: true, createdAt: true },
      orderBy: { createdAt: 'asc' },
    }),
    prisma.user.findUniqueOrThrow({
      where: { id: session.user.id },
      select: { passwordHash: true },
    }),
  ]);

  return NextResponse.json({ accounts, hasPassword: user.passwordHash !== null });
}
