import { NextResponse } from 'next/server';
import { auth } from '@/lib/auth';

type Params = { params: Promise<{ id: string }> };

// Mirrors /api/wizard-sessions/[id]/route.ts's reasoning exactly: this route
// isn't org-scoped in the URL — the OrgWizardSession row already encodes the
// organization internally, and apps/api validates the session id on every
// call. The wizard session id itself is the effective capability token here,
// same as the workspace-scoped wizard session's — OrgWizardSession never
// stores secrets either (see models.py).
async function requireSignedIn(): Promise<NextResponse | null> {
  const session = await auth();
  if (!session?.user?.id) {
    return NextResponse.json({ error: 'Sign in required.' }, { status: 401 });
  }
  return null;
}

export async function PATCH(request: Request, { params }: Params) {
  const unauthorized = await requireSignedIn();
  if (unauthorized) return unauthorized;
  const { id } = await params;
  const body: unknown = await request.json().catch(() => ({}));

  try {
    const response = await fetch(`${process.env.API_BASE_URL}/org-wizard-sessions/${id}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    const payload: unknown = await response.json();
    return NextResponse.json(payload, { status: response.status });
  } catch {
    return NextResponse.json(
      { error: 'Wizard service is unreachable — try again shortly.' },
      { status: 502 },
    );
  }
}
