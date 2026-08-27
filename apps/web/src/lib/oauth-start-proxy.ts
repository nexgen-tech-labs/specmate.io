import { NextResponse } from 'next/server';

// apps/api isn't directly browser-reachable in this deployment (Azure
// Container Apps — apps/web talks to it over API_BASE_URL, a
// server-only/internal-networking URL never exposed to the browser; there is
// no NEXT_PUBLIC_* equivalent anywhere in this codebase). A wizard "Connect
// with X" button therefore can't navigate the browser straight to apps/api's
// OAuth start endpoint, and apps/api's own /start handler responds with a
// redirect (to github.com / auth.atlassian.com / etc), NOT the data needed
// to build that URL client-side — so the browser can't be pointed at
// apps/api's internal URL and just "follow the redirect" itself either; the
// internal FQDN isn't resolvable outside Azure's network at all (confirmed
// live — hitting it directly 404s in a browser).
//
// This helper calls apps/api's /start endpoint server-side instead (server-
// to-server traffic over the internal URL works fine) with redirect: 'manual'
// so fetch doesn't itself follow the 3xx, reads the real provider authorize
// URL off the Location header apps/api returned, and redirects the browser
// straight there. The internal apps/api URL is never exposed to or touched
// by the browser at any point.
export async function proxyOAuthStart(request: Request, toolKey: string): Promise<NextResponse> {
  const searchParams = new URL(request.url).searchParams;
  const wizardSessionId = searchParams.get('wizard_session_id');
  const orgWizardSessionId = searchParams.get('org_wizard_session_id');
  if (!wizardSessionId && !orgWizardSessionId) {
    return NextResponse.json(
      { error: 'wizard_session_id or org_wizard_session_id is required.' },
      { status: 400 },
    );
  }

  const sessionParam = wizardSessionId
    ? `wizard_session_id=${encodeURIComponent(wizardSessionId)}`
    : `org_wizard_session_id=${encodeURIComponent(orgWizardSessionId!)}`;
  const apiUrl = `${process.env.API_BASE_URL}/connectors/${toolKey}/oauth/start?${sessionParam}`;
  const apiResponse = await fetch(apiUrl, { redirect: 'manual' });

  const location = apiResponse.headers.get('location');
  if (!location) {
    // apps/api returns a non-3xx (e.g. 503 with {"detail": "..."}) when the
    // OAuth app isn't configured, rather than a redirect — surface that
    // reason instead of a generic message, since it's the actionable part.
    const body = await apiResponse.json().catch(() => null);
    const reason = body && typeof body === 'object' && 'detail' in body ? body.detail : undefined;
    return NextResponse.json(
      {
        error: `${toolKey} OAuth start failed: no redirect returned by apps/api.`,
        reason,
        status: apiResponse.status,
      },
      { status: 502 },
    );
  }

  return NextResponse.redirect(location, 307);
}
