import { NextResponse } from 'next/server';
import { auth } from '@/lib/auth';

type Params = { params: Promise<{ id: string }> };

// This route isn't workspace/project-scoped in the URL — the WizardSession
// row already encodes both internally, and apps/api validates the session id
// on every call. Gating on requireProjectRole would need an extra round trip
// just to learn which project the session belongs to before we could even
// check the role, so instead this gates on "is anyone signed in" (Issue #101,
// Task 9) — the wizard session id itself is the effective capability token
// here, same as a password-reset token or invite link. A signed-out request
// can't do anything with it; a signed-in-but-wrong-workspace user could only
// see/mutate wizard progress, never any actual connector credentials or
// created data (WizardSession never stores secrets — see models.py).
async function requireSignedIn(): Promise<NextResponse | null> {
  const session = await auth();
  if (!session?.user?.id) {
    return NextResponse.json({ error: 'Sign in required.' }, { status: 401 });
  }
  return null;
}

export async function GET(_request: Request, { params }: Params) {
  const unauthorized = await requireSignedIn();
  if (unauthorized) return unauthorized;
  const { id } = await params;

  try {
    const response = await fetch(`${process.env.API_BASE_URL}/wizard-sessions/${id}`);
    const payload: unknown = await response.json();
    return NextResponse.json(payload, { status: response.status });
  } catch {
    return NextResponse.json(
      { error: 'Wizard service is unreachable — try again shortly.' },
      { status: 502 },
    );
  }
}

export async function PATCH(request: Request, { params }: Params) {
  const unauthorized = await requireSignedIn();
  if (unauthorized) return unauthorized;
  const { id } = await params;
  const body: unknown = await request.json().catch(() => ({}));

  try {
    const response = await fetch(`${process.env.API_BASE_URL}/wizard-sessions/${id}`, {
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
