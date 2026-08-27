import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import { prisma } from '@/lib/prisma';

let currentSession: { user: { id: string } } | null = null;

vi.mock('@/lib/auth', () => ({
  auth: async () => currentSession,
}));

vi.mock('next/navigation', () => ({
  notFound: () => {
    throw new Error('NOT_FOUND');
  },
  useRouter: () => ({ push: vi.fn(), refresh: vi.fn(), replace: vi.fn() }),
  useSearchParams: () => new URLSearchParams(),
}));

vi.mock('@/components/tour/tour-provider', () => ({
  useTour: () => ({ startTour: vi.fn() }),
}));

const { default: WorkspaceDashboardPage } = await import('./page');

describe('WorkspaceDashboardPage', () => {
  let org: { id: string };
  let workspace: { id: string };
  let admin: { id: string };
  let viewer: { id: string };

  beforeAll(async () => {
    org = await prisma.organization.create({ data: { name: 'Dashboard Page Test Org' } });
    workspace = await prisma.workspace.create({
      data: { name: 'Dashboard Page Test WS', organizationId: org.id },
    });
    admin = await prisma.user.create({
      data: { email: `dash-page-admin-${Date.now()}@test.local`, name: 'Admin', passwordHash: 'x' },
    });
    viewer = await prisma.user.create({
      data: {
        email: `dash-page-viewer-${Date.now()}@test.local`,
        name: 'Viewer',
        passwordHash: 'x',
      },
    });
    await prisma.workspaceMember.create({
      data: { workspaceId: workspace.id, userId: admin.id, role: 'ADMIN' },
    });
    await prisma.workspaceMember.create({
      data: { workspaceId: workspace.id, userId: viewer.id, role: 'VIEWER' },
    });
  });

  afterAll(async () => {
    await prisma.draftItem.deleteMany({ where: { project: { workspaceId: workspace.id } } });
    await prisma.source.deleteMany({ where: { project: { workspaceId: workspace.id } } });
    await prisma.project.deleteMany({ where: { workspaceId: workspace.id } });
    await prisma.workspaceMember.deleteMany({ where: { workspaceId: workspace.id } });
    await prisma.user.deleteMany({ where: { id: { in: [admin.id, viewer.id] } } });
    await prisma.workspace.deleteMany({ where: { id: workspace.id } });
    await prisma.organization.deleteMany({ where: { id: org.id } });
  });

  const params = () => Promise.resolve({ workspaceId: workspace.id });

  it('renders empty states for every card when the workspace is brand new', async () => {
    currentSession = { user: { id: admin.id } };
    render(await WorkspaceDashboardPage({ params: params() }));

    expect(screen.getByRole('heading', { name: 'Dashboard Page Test WS' })).toBeDefined();
    expect(screen.getByText(/no sources yet/i)).toBeDefined();
    expect(screen.getByText(/drop a source here/i)).toBeDefined();
    expect(screen.getByText(/drafted items land here for approval/i)).toBeDefined();
    expect(screen.getByText(/approved batches appear here/i)).toBeDefined();
    expect(screen.getByText(/every drafted item gets scored/i)).toBeDefined();
    expect(screen.getByText(/ingests, approvals, and publishes/i)).toBeDefined();
    expect(screen.getAllByText('Not connected').length).toBe(3);

    // Onboarding checklist shows for an ADMIN on a fresh workspace (0/3 done).
    expect(screen.getByText(/set up your workspace/i)).toBeDefined();
  });

  it('shows the org breadcrumb', async () => {
    currentSession = { user: { id: admin.id } };
    render(await WorkspaceDashboardPage({ params: params() }));
    expect(screen.getByText(/Dashboard Page Test Org/)).toBeDefined();
  });

  it('does not show Connect a tool / Add source actions for a VIEWER', async () => {
    currentSession = { user: { id: viewer.id } };
    render(await WorkspaceDashboardPage({ params: params() }));
    expect(screen.queryByRole('button', { name: /connect a tool/i })).toBeNull();
    expect(screen.queryByRole('button', { name: /\+ add source/i })).toBeNull();
    // A VIEWER doesn't trigger the lazy default-project creation, so the
    // checklist also shouldn't render for them (no meaningful action to take).
    expect(screen.queryByText(/set up your workspace/i)).toBeNull();
  });

  it('renders populated pipeline counts once sources/items/publishes exist', async () => {
    currentSession = { user: { id: admin.id } };
    const project = await prisma.project.create({
      data: { workspaceId: workspace.id, name: 'Populated Project' },
    });
    await prisma.source.create({
      data: { projectId: project.id, name: 'Populated Source', kind: 'DOCX', status: 'PARSED' },
    });
    const draft = await prisma.draftItem.create({
      data: {
        projectId: project.id,
        type: 'STORY',
        title: 's',
        description: 'd',
        status: 'PENDING',
        qualityScore: 88,
      },
    });

    render(await WorkspaceDashboardPage({ params: params() }));

    expect(screen.getByText(/1 source · 1 items drafted/i)).toBeDefined();
    expect(screen.getByText('Populated Source')).toBeDefined();
    expect(screen.getByText(/items drafted, none published yet/i)).toBeDefined();

    await prisma.draftItem.deleteMany({ where: { id: draft.id } });
  });
});
