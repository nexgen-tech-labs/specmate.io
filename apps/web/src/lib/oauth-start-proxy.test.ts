import { afterEach, describe, expect, it, vi } from 'vitest';
import { proxyOAuthStart } from './oauth-start-proxy';

describe('proxyOAuthStart', () => {
  const originalFetch = global.fetch;
  const originalApiBaseUrl = process.env.API_BASE_URL;

  afterEach(() => {
    global.fetch = originalFetch;
    process.env.API_BASE_URL = originalApiBaseUrl;
    vi.restoreAllMocks();
  });

  it('returns 400 when neither wizard_session_id nor org_wizard_session_id is present', async () => {
    const request = new Request('http://localhost/api/connectors/jira/oauth/start');
    const res = await proxyOAuthStart(request, 'jira');
    expect(res.status).toBe(400);
  });

  it('supports org_wizard_session_id for the org-level Connect a Tool flow', async () => {
    process.env.API_BASE_URL = 'https://specmate-api.internal.example.azurecontainerapps.io';
    const fetchMock = vi.fn(
      async () =>
        new Response(null, {
          status: 307,
          headers: { location: 'https://auth.atlassian.com/authorize?client_id=abc&state=org-1' },
        }),
    );
    global.fetch = fetchMock as unknown as typeof fetch;

    const request = new Request(
      'http://localhost/api/connectors/jira/oauth/start?org_wizard_session_id=org-1',
    );
    const res = await proxyOAuthStart(request, 'jira');

    expect(res.status).toBe(307);
    expect(fetchMock).toHaveBeenCalledWith(
      'https://specmate-api.internal.example.azurecontainerapps.io/connectors/jira/oauth/start?org_wizard_session_id=org-1',
      { redirect: 'manual' },
    );
  });

  it("redirects the browser to apps/api's Location header, not apps/api's own (internal, browser-unreachable) URL", async () => {
    process.env.API_BASE_URL = 'https://specmate-api.internal.example.azurecontainerapps.io';
    const fetchMock = vi.fn(
      async () =>
        new Response(null, {
          status: 307,
          headers: { location: 'https://auth.atlassian.com/authorize?client_id=abc&state=wiz-1' },
        }),
    );
    global.fetch = fetchMock as unknown as typeof fetch;

    const request = new Request(
      'http://localhost/api/connectors/jira/oauth/start?wizard_session_id=wiz-1',
    );
    const res = await proxyOAuthStart(request, 'jira');

    expect(res.status).toBe(307);
    expect(res.headers.get('location')).toBe(
      'https://auth.atlassian.com/authorize?client_id=abc&state=wiz-1',
    );
    // The internal apps/api URL must never be handed to the browser as a
    // redirect target — this is the exact bug being fixed here.
    expect(res.headers.get('location')).not.toContain('internal');

    expect(fetchMock).toHaveBeenCalledWith(
      'https://specmate-api.internal.example.azurecontainerapps.io/connectors/jira/oauth/start?wizard_session_id=wiz-1',
      { redirect: 'manual' },
    );
  });

  it('returns 502 when apps/api responds without a Location header', async () => {
    process.env.API_BASE_URL = 'https://specmate-api.internal.example.azurecontainerapps.io';
    global.fetch = vi.fn(
      async () => new Response(null, { status: 503 }),
    ) as unknown as typeof fetch;

    const request = new Request(
      'http://localhost/api/connectors/github/oauth/start?wizard_session_id=wiz-1',
    );
    const res = await proxyOAuthStart(request, 'github');

    expect(res.status).toBe(502);
  });
});
