import { NextResponse } from 'next/server';
import { prisma } from '@/lib/prisma';
import { requireOrganizationRole } from '@/lib/workspace-context';

type Params = { params: Promise<{ organizationId: string }> };

export async function GET(_request: Request, { params }: Params) {
  const { organizationId } = await params;
  const access = await requireOrganizationRole(organizationId, ['OWNER', 'ADMIN']);
  if (!access.ok) return NextResponse.json({ error: 'Forbidden' }, { status: access.status });

  const members = await prisma.organizationMember.findMany({
    where: { organizationId },
    select: { userId: true, role: true, user: { select: { name: true, email: true } } },
    orderBy: { createdAt: 'asc' },
  });

  return NextResponse.json({
    members: members.map((m) => ({
      userId: m.userId,
      role: m.role,
      name: m.user.name,
      email: m.user.email,
    })),
  });
}
