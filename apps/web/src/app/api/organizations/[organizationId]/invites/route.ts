import { randomUUID } from 'node:crypto';
import { NextResponse } from 'next/server';
import { prisma } from '@/lib/prisma';
import { requireOrganizationRole } from '@/lib/workspace-context';

type Params = { params: Promise<{ organizationId: string }> };
const INVITE_TTL_MS = 7 * 24 * 60 * 60 * 1000;

export async function POST(request: Request, { params }: Params) {
  const { organizationId } = await params;
  const access = await requireOrganizationRole(organizationId, ['OWNER', 'ADMIN']);
  if (!access.ok) return NextResponse.json({ error: 'Forbidden' }, { status: access.status });

  const body = (await request.json().catch(() => ({}))) as { email?: unknown; role?: unknown };
  const email = typeof body.email === 'string' ? body.email.trim() : '';
  const role = body.role === 'OWNER' || body.role === 'ADMIN' ? body.role : null;
  if (!email || !role) {
    return NextResponse.json({ error: 'A valid email and role are required.' }, { status: 400 });
  }
  if (role === 'OWNER' && access.membership.role !== 'OWNER') {
    return NextResponse.json({ error: 'Only an OWNER can invite a new OWNER.' }, { status: 403 });
  }

  const invite = await prisma.organizationInvite.create({
    data: {
      organizationId,
      email,
      role,
      token: randomUUID(),
      invitedByUserId: access.membership.userId,
      expiresAt: new Date(Date.now() + INVITE_TTL_MS),
    },
  });

  return NextResponse.json({ id: invite.id, token: invite.token }, { status: 201 });
}
