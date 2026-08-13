import { NextResponse } from 'next/server';

// apps/api isn't directly browser-reachable in this deployment (Azure
// Container Apps — apps/web talks to it over API_BASE_URL, a
// server-only/internal-networking URL never exposed to the browser; there is
// no NEXT_PUBLIC_* equivalent anywhere in this codebase). So the wizard's
// "Connect with GitHub" button can't navigate the browser straight to
// apps/api's OAuth start endpoint. This thin route does a full-page 307
// redirect to it instead, keeping the real apps/api URL server-side while
// still giving the browser something to navigate to (Issue #101, Task 9).
export async function GET(request: Request) {
  const wizardSessionId = new URL(request.url).searchParams.get('wizard_session_id');
  if (!wizardSessionId) {
    return NextResponse.json({ error: 'wizard_session_id is required.' }, { status: 400 });
  }
  const target = `${process.env.API_BASE_URL}/connectors/github/oauth/start?wizard_session_id=${encodeURIComponent(wizardSessionId)}`;
  return NextResponse.redirect(target, 307);
}
