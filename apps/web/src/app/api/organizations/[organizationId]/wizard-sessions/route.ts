import { NextResponse } from 'next/server';
import { requireOrganizationRole } from '@/lib/workspace-context';

type Params = { params: Promise<{ organizationId: string }> };

// Org-level connector authorization is an OWNER/ADMIN concern, mirroring the
// ADMIN gate on the workspace-scoped wizard-sessions route.
export async function POST(request: Request, { params }: Params) {
  const { organizationId } = await params;
  const access = await requireOrganizationRole(organizationId, ['OWNER', 'ADMIN']);
  if (!access.ok) {
    return NextResponse.json({ error: 'Forbidden' }, { status: access.status });
  }

  const body: unknown = await request.json().catch(() => ({}));

  try {
    const response = await fetch(
      `${process.env.API_BASE_URL}/organizations/${organizationId}/wizard-sessions`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      },
    );
    const payload: unknown = await response.json();
    return NextResponse.json(payload, { status: response.status });
  } catch {
    return NextResponse.json(
      { error: 'Wizard service is unreachable — try again shortly.' },
      { status: 502 },
    );
  }
}
