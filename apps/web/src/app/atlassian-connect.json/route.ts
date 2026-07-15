import { NextResponse } from 'next/server';

// Atlassian Connect app descriptor (Issue 10.2) — served at a well-known path
// Atlassian's Marketplace/install flow fetches to learn the app's identity,
// lifecycle callback URLs, and required scopes. Distinct from the direct
// OAuth/API-token connection (Issue 5.1) — this is the multi-tenant
// app-install surface: any Jira Cloud site's admin can install straight from
// this descriptor (or the Marketplace listing once published), no
// per-customer manual setup required.
//
// ATLASSIAN_CONNECT_APP_KEY must be a globally-unique reverse-DNS-style key
// (Atlassian enforces uniqueness across the whole Marketplace) — placeholder
// below until a real one is registered.
export async function GET() {
  const baseUrl = (process.env.NEXTAUTH_URL ?? 'http://localhost:3000').replace(/\/$/, '');
  const appKey = process.env.ATLASSIAN_CONNECT_APP_KEY ?? 'io.specmate.jira-connect.PLACEHOLDER';

  const descriptor = {
    key: appKey,
    name: 'SpecMate',
    description: 'AI spec layer — turns raw requirements into structured, traceable Jira issues.',
    vendor: {
      name: 'SpecMate',
      url: baseUrl,
    },
    baseUrl,
    links: {
      self: `${baseUrl}/atlassian-connect.json`,
    },
    authentication: {
      type: 'jwt',
    },
    lifecycle: {
      installed: '/api/atlassian-connect/installed',
      uninstalled: '/api/atlassian-connect/uninstalled',
    },
    scopes: ['READ', 'WRITE'],
    apiVersion: 1,
    modules: {
      // A generic link module is enough to prove the install/uninstall
      // lifecycle end-to-end; a real project-admin UI panel (linking this
      // install to a SpecMate workspace inline, rather than via the settings
      // page claim flow) is a natural follow-up once this is live-verified.
      generalPages: [
        {
          key: 'specmate-workspace-link',
          name: { value: 'SpecMate' },
          url: '/atlassian-connect/link',
          location: 'system.top.navigation.bar',
        },
      ],
    },
  };

  return NextResponse.json(descriptor);
}
