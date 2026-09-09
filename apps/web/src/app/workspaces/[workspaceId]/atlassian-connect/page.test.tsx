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

const { default: WorkspaceAtlassianConnectPage } = await import('./page');

describe('WorkspaceAtlassianConnectPage', () => {
  let workspace: { id: string };
  let admin: { id: string };
  let member: { id: string };
  let unclaimedInstall: { id: string };
  let claimedInstall: { id: string };

  beforeAll(async () => {
    workspace = await prisma.workspace.create({ data: { name: 'Connect Page Test WS' } });
    admin = await prisma.user.create({
      data: {
        email: `connect-page-admin-${Date.now()}@test.local`,
        name: 'Admin',
        passwordHash: 'x',
      },
    });
    member = await prisma.user.create({
      data: {
        email: `connect-page-member-${Date.now()}@test.local`,
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

    unclaimedInstall = await prisma.atlassianConnectInstall.create({
      data: {
        clientKey: `page-unclaimed-${Date.now()}`,
        sharedSecret: 's1',
        baseUrl: 'https://page-unclaimed.atlassian.net',
      },
    });
    claimedInstall = await prisma.atlassianConnectInstall.create({
      data: {
        clientKey: `page-claimed-${Date.now()}`,
        sharedSecret: 's2',
        baseUrl: 'https://page-claimed.atlassian.net',
        workspaceId: workspace.id,
        claimedAt: new Date(),
      },
    });
  });

  afterAll(async () => {
    await prisma.atlassianConnectInstall.deleteMany({
      where: { id: { in: [unclaimedInstall.id, claimedInstall.id] } },
    });
    await prisma.workspaceMember.deleteMany({ where: { workspaceId: workspace.id } });
    await prisma.workspace.deleteMany({ where: { id: workspace.id } });
    await prisma.user.deleteMany({ where: { id: { in: [admin.id, member.id] } } });
  });

  it('renders claimed and unclaimed installs for an admin', async () => {
    currentSession = { user: { id: admin.id } };
    const result = await WorkspaceAtlassianConnectPage({
      params: Promise.resolve({ workspaceId: workspace.id }),
    });
    render(result);

    expect(screen.getByText('https://page-claimed.atlassian.net')).toBeInTheDocument();
    expect(screen.getByText('https://page-unclaimed.atlassian.net')).toBeInTheDocument();
  });

  it('calls notFound for a non-admin member', async () => {
    currentSession = { user: { id: member.id } };
    await expect(
      WorkspaceAtlassianConnectPage({ params: Promise.resolve({ workspaceId: workspace.id }) }),
    ).rejects.toThrow();
  });

  it('calls notFound when no session exists', async () => {
    currentSession = null;
    await expect(
      WorkspaceAtlassianConnectPage({ params: Promise.resolve({ workspaceId: workspace.id }) }),
    ).rejects.toThrow();
  });
});
