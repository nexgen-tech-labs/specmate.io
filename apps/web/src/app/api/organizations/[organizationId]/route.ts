import { NextResponse } from 'next/server';
import { prisma } from '@/lib/prisma';
import { requireOrganizationRole } from '@/lib/workspace-context';

type Params = { params: Promise<{ organizationId: string }> };

const VALID_SIZES = ['SOLO', 'SMALL', 'MEDIUM', 'LARGE', 'ENTERPRISE'] as const;
type OrgSize = (typeof VALID_SIZES)[number];

// Org settings update (Issue 12.12): OWNER-only, matching the "OWNER:
// billing/org settings" split documented in workspace-context.ts.
export async function PATCH(request: Request, { params }: Params) {
  const { organizationId } = await params;
  const access = await requireOrganizationRole(organizationId, ['OWNER']);
  if (!access.ok) return NextResponse.json({ error: 'Forbidden' }, { status: access.status });

  const body = (await request.json().catch(() => ({}))) as { name?: unknown; size?: unknown };
  const data: { name?: string; size?: OrgSize } = {};
  if (typeof body.name === 'string' && body.name.trim()) data.name = body.name.trim();
  if (typeof body.size === 'string' && (VALID_SIZES as readonly string[]).includes(body.size)) {
    data.size = body.size as OrgSize;
  }
  if (Object.keys(data).length === 0) {
    return NextResponse.json({ error: 'No valid fields to update.' }, { status: 400 });
  }

  const organization = await prisma.organization.update({ where: { id: organizationId }, data });
  return NextResponse.json({
    id: organization.id,
    name: organization.name,
    size: organization.size,
  });
}
