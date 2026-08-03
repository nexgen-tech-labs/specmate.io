import { NextResponse } from 'next/server';
import { auth } from '@/lib/auth';
import { prisma } from '@/lib/prisma';

export async function POST(_request: Request, { params }: { params: Promise<{ token: string }> }) {
  const { token } = await params;

  const session = await auth();
  const userId = session?.user?.id;
  const userEmail = session?.user?.email;
  if (!userId || !userEmail) {
    return NextResponse.json({ error: 'Sign in required.' }, { status: 401 });
  }

  const invite = await prisma.organizationInvite.findUnique({ where: { token } });
  if (!invite || invite.status !== 'PENDING' || invite.expiresAt < new Date()) {
    return NextResponse.json({ error: 'Invite is invalid or has expired.' }, { status: 404 });
  }
  if (invite.email !== userEmail) {
    return NextResponse.json(
      { error: 'This invite was sent to a different email address.' },
      { status: 403 },
    );
  }

  // Billing stays workspace-scoped (Issue 10.9 amendment) — no seat-gate check
  // applies at the organization level.
  const existingMembership = await prisma.organizationMember.findUnique({
    where: { organizationId_userId: { organizationId: invite.organizationId, userId } },
  });
  if (existingMembership) {
    return NextResponse.json(
      { error: 'You are already a member of this organization.' },
      { status: 409 },
    );
  }

  await prisma.$transaction([
    prisma.organizationMember.create({
      data: { organizationId: invite.organizationId, userId, role: invite.role },
    }),
    prisma.organizationInvite.update({
      where: { id: invite.id },
      data: { status: 'ACCEPTED' },
    }),
  ]);

  return NextResponse.json({ organizationId: invite.organizationId }, { status: 200 });
}
