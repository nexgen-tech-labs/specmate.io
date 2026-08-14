/**
 * Issue #108, gap 3: UsageSection (component), the GET /api/workspaces/{id}/usage
 * route, getWorkspaceUsageSummary (lib), and real Postgres are each tested in
 * isolation elsewhere (billing-settings.test.tsx mocks fetch; the route's own
 * route.test.ts calls GET() directly against real Postgres; usage.test.ts
 * exercises the lib function directly against real Postgres). Nothing wires all
 * four together, so a seam-level drift (e.g. a UsageSummary field rename) could
 * slip through even with every individual layer's tests green.
 *
 * This test closes that gap without new test-server infrastructure (none
 * exists in this codebase): it stubs global fetch to call the real route
 * handler (GET()) and adapts its Response into what the browser's fetch API
 * shape gives the component, so the component's actual fetch().then(...) chain
 * runs against the real route -> real getWorkspaceUsageSummary -> real Postgres.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import { prisma } from '@/lib/prisma';
import { BillingSettings } from './billing-settings';

let currentSession: { user: { id: string } } | null = null;

vi.mock('@/lib/auth', () => ({
  auth: async () => currentSession,
}));

const { GET } = await import('@/app/api/workspaces/[workspaceId]/usage/route');

describe('BillingSettings usage section — real route + lib + DB integration', () => {
  let workspace: { id: string };
  let admin: { id: string };
  let project: { id: string };
  let draftItem: { id: string };

  beforeAll(async () => {
    workspace = await prisma.workspace.create({
      data: { name: 'Usage Integration Test WS', pricingTier: 'STARTER' },
    });
    admin = await prisma.user.create({
      data: {
        email: `usage-integration-admin-${Date.now()}@test.local`,
        name: 'Admin',
        passwordHash: 'x',
      },
    });
    await prisma.workspaceMember.create({
      data: { workspaceId: workspace.id, userId: admin.id, role: 'ADMIN' },
    });
    project = await prisma.project.create({
      data: { workspaceId: workspace.id, name: 'Usage Integration Project' },
    });
    draftItem = await prisma.draftItem.create({
      data: {
        projectId: project.id,
        type: 'STORY',
        title: 'x',
        description: 'x',
        status: 'APPROVED',
      },
    });
    // Real published items -- the route/lib chain counts these live, not a
    // stale cached field, so this is what proves the seam actually works.
    await prisma.publishedItem.createMany({
      data: Array.from({ length: 12 }, (_, i) => ({
        draftItemId: draftItem.id,
        targetTool: 'JIRA' as const,
        externalKey: `INT-${i}`,
        externalUrl: `https://example.atlassian.net/browse/INT-${i}`,
      })),
    });
    currentSession = { user: { id: admin.id } };
  });

  afterAll(async () => {
    await prisma.publishedItem.deleteMany({ where: { draftItemId: draftItem.id } });
    await prisma.draftItem.deleteMany({ where: { id: draftItem.id } });
    await prisma.project.deleteMany({ where: { id: project.id } });
    await prisma.workspaceMember.deleteMany({ where: { workspaceId: workspace.id } });
    await prisma.user.deleteMany({ where: { id: admin.id } });
    await prisma.workspace.deleteMany({ where: { id: workspace.id } });
  });

  it('renders the real, live-computed usage count from Postgres via the actual route', async () => {
    vi.stubGlobal('fetch', async (input: string | URL) => {
      const url = typeof input === 'string' ? input : input.toString();
      const res = await GET(new Request(`http://localhost${url}`), {
        params: Promise.resolve({ workspaceId: workspace.id }),
      });
      // Adapt the real NextResponse into the shape UsageSection's
      // fetch(...).then(res => res.ok ? res.json() : ...) expects.
      return { ok: res.ok, status: res.status, json: async () => res.json() };
    });

    render(
      <BillingSettings
        workspaceId={workspace.id}
        pricingTier="STARTER"
        subscriptionStatus="ACTIVE"
      />,
    );

    await waitFor(() => expect(screen.getByText(/12/)).toBeDefined());
    expect(screen.getByText(/50/)).toBeDefined(); // STARTER's included quota
    expect(screen.getByText(/38 remaining/i)).toBeDefined();

    vi.unstubAllGlobals();
  });
});
