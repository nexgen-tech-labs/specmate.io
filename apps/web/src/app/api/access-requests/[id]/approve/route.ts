import { randomUUID } from 'node:crypto';
import { NextResponse } from 'next/server';
import { auth } from '@/lib/auth';
import { isInternalAdmin } from '@/lib/admin-access';
import { prisma } from '@/lib/prisma';
import { getRemainingAccessRequestSlots } from '@/lib/access-requests';

const SIGNUP_TOKEN_TTL_MS = 14 * 24 * 60 * 60 * 1000;

// Internal, staff-only — matches this codebase's established convention for
// /internal/* pages: unauthorized looks like not-found, not forbidden.
export async function POST(_request: Request, { params }: { params: Promise<{ id: string }> }) {
  const session = await auth();
  if (!isInternalAdmin(session?.user?.email)) {
    return NextResponse.json({ error: 'Not found.' }, { status: 404 });
  }

  const { id } = await params;
  const accessRequest = await prisma.accessRequest.findUnique({ where: { id } });
  if (!accessRequest) {
    return NextResponse.json({ error: 'Request not found.' }, { status: 404 });
  }
  if (accessRequest.status === 'APPROVED') {
    return NextResponse.json({ error: 'This request is already approved.' }, { status: 409 });
  }

  // A founder clicking Approve one request at a time, not concurrent
  // self-serve signups — a plain read-then-write check is enough here,
  // unlike the Serializable-transaction treatment used elsewhere in this
  // codebase for genuine concurrency bugs.
  const remaining = await getRemainingAccessRequestSlots();
  if (remaining <= 0) {
    return NextResponse.json(
      { error: 'The invite cap has been reached — no slots remaining.' },
      { status: 422 },
    );
  }

  const now = new Date();
  const token = randomUUID();
  await prisma.$transaction([
    prisma.accessRequest.update({
      where: { id },
      data: { status: 'APPROVED', reviewedAt: now },
    }),
    prisma.signupToken.create({
      data: {
        accessRequestId: id,
        email: accessRequest.email,
        token,
        expiresAt: new Date(now.getTime() + SIGNUP_TOKEN_TTL_MS),
      },
    }),
  ]);

  return NextResponse.json({ signupUrl: `/signup-invite/${token}` }, { status: 200 });
}
