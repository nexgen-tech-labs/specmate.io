import { randomUUID } from 'node:crypto';
import { NextResponse } from 'next/server';
import { prisma } from '@/lib/prisma';
import { requireWorkspaceRole } from '@/lib/workspace-context';
import type { Role } from '@prisma/client';

const VALID_ROLES: Role[] = ['ADMIN', 'REVIEWER', 'VIEWER'];
const INVITE_TTL_MS = 7 * 24 * 60 * 60 * 1000;

interface CreateInviteBody {
  email: string;
  role: Role;
}

function isValidBody(body: unknown): body is CreateInviteBody {
  if (typeof body !== 'object' || body === null) return false;
  const b = body as Record<string, unknown>;
  return (
    typeof b.email === 'string' &&
    b.email.includes('@') &&
    typeof b.role === 'string' &&
    VALID_ROLES.includes(b.role as Role)
  );
}

export async function POST(
  request: Request,
  { params }: { params: Promise<{ workspaceId: string }> },
) {
  const { workspaceId } = await params;

  const access = await requireWorkspaceRole(workspaceId, ['ADMIN']);
  if (!access.ok) {
    return NextResponse.json({ error: 'Forbidden' }, { status: access.status });
  }

  const body: unknown = await request.json();
  if (!isValidBody(body)) {
    return NextResponse.json({ error: 'Invalid invite details.' }, { status: 400 });
  }

  const invite = await prisma.workspaceInvite.create({
    data: {
      workspaceId,
      email: body.email,
      role: body.role,
      token: randomUUID(),
      invitedByUserId: access.membership.userId,
      expiresAt: new Date(Date.now() + INVITE_TTL_MS),
    },
  });

  return NextResponse.json(
    { token: invite.token, inviteUrl: `/invite/${invite.token}` },
    { status: 201 },
  );
}
