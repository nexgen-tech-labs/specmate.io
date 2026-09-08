import { NextResponse } from 'next/server';
import { auth } from '@/lib/auth';
import { isInternalAdmin } from '@/lib/admin-access';
import { prisma } from '@/lib/prisma';

interface RejectBody {
  reviewNote?: string;
}

export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const session = await auth();
  if (!isInternalAdmin(session?.user?.email)) {
    return NextResponse.json({ error: 'Not found.' }, { status: 404 });
  }

  const { id } = await params;
  const accessRequest = await prisma.accessRequest.findUnique({ where: { id } });
  if (!accessRequest) {
    return NextResponse.json({ error: 'Request not found.' }, { status: 404 });
  }

  const body: unknown = await request.json().catch(() => ({}));
  const reviewNote =
    typeof (body as RejectBody)?.reviewNote === 'string'
      ? (body as RejectBody).reviewNote!.slice(0, 2000)
      : null;

  await prisma.accessRequest.update({
    where: { id },
    data: { status: 'REJECTED', reviewedAt: new Date(), reviewNote },
  });

  return NextResponse.json({ ok: true });
}
