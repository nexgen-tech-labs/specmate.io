import { NextResponse } from 'next/server';
import { requireOrganizationRole } from '@/lib/workspace-context';

type Params = { params: Promise<{ organizationId: string; toolKey: string }> };

export async function GET(_request: Request, { params }: Params) {
  const { organizationId, toolKey } = await params;
  const access = await requireOrganizationRole(organizationId, ['OWNER', 'ADMIN']);
  if (!access.ok) {
    return NextResponse.json({ error: 'Forbidden' }, { status: access.status });
  }

  try {
    const response = await fetch(
      `${process.env.API_BASE_URL}/organizations/${organizationId}/connectors/${toolKey}/scope-options`,
    );
    const payload: unknown = await response.json();
    return NextResponse.json(payload, { status: response.status });
  } catch {
    return NextResponse.json(
      { error: 'Connector service is unreachable — try again shortly.' },
      { status: 502 },
    );
  }
}
