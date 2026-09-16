import { render, screen } from '@testing-library/react';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { prisma } from '@/lib/prisma';

let currentSession: { user: { id: string } } | null = null;
vi.mock('@/lib/auth', () => ({
  auth: async () => currentSession,
}));
vi.mock('next/navigation', () => ({
  notFound: () => {
    throw new Error('NEXT_HTTP_ERROR_FALLBACK;404');
  },
  useRouter: () => ({ refresh: vi.fn() }),
}));

const { default: WorkspaceGitHubAppPage } = await import('./page');

describe('WorkspaceGitHubAppPage', () => {
  let workspace: { id: string };
  let admin: { id: string };
  let member: { id: string };
  let unclaimedInstall: { id: string };
  let claimedInstall: { id: string };

  beforeAll(async () => {
    workspace = await prisma.workspace.create({ data: { name: 'GH App Page Test WS' } });
    admin = await prisma.user.create({
      data: {
        email: `ghapp-page-admin-${Date.now()}@test.local`,
        name: 'Admin',
        passwordHash: 'x',
      },
    });
    member = await prisma.user.create({
      data: {
        email: `ghapp-page-member-${Date.now()}@test.local`,
        name: 'Member',
        passwordHash: 'x',
      },
    });
    await prisma.workspaceMember.create({
      data: { workspaceId: workspace.id, userId: admin.id, role: 'ADMIN' },
    });
    await prisma.workspaceMember.create({
      data: { workspaceId: workspace.id, userId: member.id, role: 'VIEWER' },
    });

    unclaimedInstall = await prisma.gitHubAppInstall.create({
      data: {
        installationId: BigInt(Date.now()),
        accountLogin: 'page-unclaimed-org',
        accountType: 'Organization',
        repositorySelection: 'all',
      },
    });
    claimedInstall = await prisma.gitHubAppInstall.create({
      data: {
        installationId: BigInt(Date.now() + 1),
        accountLogin: 'page-claimed-org',
        accountType: 'Organization',
        repositorySelection: 'all',
        workspaceId: workspace.id,
        claimedAt: new Date(),
      },
    });
  });

  afterAll(async () => {
    await prisma.gitHubAppInstall.deleteMany({
      where: { id: { in: [unclaimedInstall.id, claimedInstall.id] } },
    });
    await prisma.workspaceMember.deleteMany({ where: { workspaceId: workspace.id } });
    await prisma.workspace.deleteMany({ where: { id: workspace.id } });
    await prisma.user.deleteMany({ where: { id: { in: [admin.id, member.id] } } });
  });

  it('renders claimed and unclaimed installs for an admin', async () => {
    currentSession = { user: { id: admin.id } };
    const result = await WorkspaceGitHubAppPage({
      params: Promise.resolve({ workspaceId: workspace.id }),
    });
    render(result);

    expect(screen.getByText('page-claimed-org')).toBeInTheDocument();
    expect(screen.getByText('page-unclaimed-org')).toBeInTheDocument();
  });

  it('calls notFound for a non-admin member', async () => {
    currentSession = { user: { id: member.id } };
    await expect(
      WorkspaceGitHubAppPage({ params: Promise.resolve({ workspaceId: workspace.id }) }),
    ).rejects.toThrow();
  });

  it('calls notFound when no session exists', async () => {
    currentSession = null;
    await expect(
      WorkspaceGitHubAppPage({ params: Promise.resolve({ workspaceId: workspace.id }) }),
    ).rejects.toThrow();
  });
});
