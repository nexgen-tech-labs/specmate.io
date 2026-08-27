import { NextResponse } from 'next/server';
import { requireOrganizationRole } from '@/lib/workspace-context';

type Params = { params: Promise<{ organizationId: string }> };

export async function GET(request: Request, { params }: Params) {
  const { organizationId } = await params;
  const access = await requireOrganizationRole(organizationId, ['OWNER', 'ADMIN']);
  if (!access.ok) {
    return NextResponse.json({ error: 'Forbidden' }, { status: access.status });
  }

  const toolKey = new URL(request.url).searchParams.get('tool_key');
  if (!toolKey) {
    return NextResponse.json({ error: 'tool_key is required.' }, { status: 400 });
  }

  try {
    const response = await fetch(
      `${process.env.API_BASE_URL}/organizations/${organizationId}/wizard-sessions/resume?tool_key=${encodeURIComponent(toolKey)}`,
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
