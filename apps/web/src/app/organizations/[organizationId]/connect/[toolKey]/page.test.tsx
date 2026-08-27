import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { prisma } from '@/lib/prisma';

let currentSession: { user: { id: string } } | null = null;

vi.mock('@/lib/auth', () => ({
  auth: async () => currentSession,
}));

const redirectMock = vi.fn((url: string) => {
  throw new Error(`REDIRECT:${url}`);
});
const notFoundMock = vi.fn(() => {
  throw new Error('NOT_FOUND');
});
vi.mock('next/navigation', () => ({
  redirect: (url: string) => redirectMock(url),
  notFound: () => notFoundMock(),
}));

const { default: OrgConnectReturnPage } = await import('./page');

describe('OrgConnectReturnPage', () => {
  let organization: { id: string };
  let workspace: { id: string };
  let member: { id: string };
  let outsider: { id: string };

  beforeAll(async () => {
    organization = await prisma.organization.create({ data: { name: 'Org Connect Return Test' } });
    workspace = await prisma.workspace.create({
      data: { name: 'Org Connect Return WS', organizationId: organization.id },
    });
    member = await prisma.user.create({
      data: { email: `org-connect-return-${Date.now()}@test.local`, name: 'M', passwordHash: 'x' },
    });
    outsider = await prisma.user.create({
      data: {
        email: `org-connect-return-outsider-${Date.now()}@test.local`,
        name: 'O',
        passwordHash: 'x',
      },
    });
    await prisma.workspaceMember.create({
      data: { workspaceId: workspace.id, userId: member.id, role: 'ADMIN' },
    });
  });

  afterAll(async () => {
    await prisma.workspaceMember.deleteMany({ where: { workspaceId: workspace.id } });
    await prisma.user.deleteMany({ where: { id: { in: [member.id, outsider.id] } } });
    await prisma.workspace.deleteMany({ where: { id: workspace.id } });
    await prisma.organization.deleteMany({ where: { id: organization.id } });
  });

  const paramsFor = () => Promise.resolve({ organizationId: organization.id, toolKey: 'jira' });

  it('calls notFound when no one is signed in', async () => {
    currentSession = null;
    await expect(
      OrgConnectReturnPage({ params: paramsFor(), searchParams: Promise.resolve({}) }),
    ).rejects.toThrow('NOT_FOUND');
  });

  it('calls notFound for a user with no workspace membership in this organization', async () => {
    currentSession = { user: { id: outsider.id } };
    await expect(
      OrgConnectReturnPage({ params: paramsFor(), searchParams: Promise.resolve({}) }),
    ).rejects.toThrow('NOT_FOUND');
  });

  it('redirects to the workspace with connect_tool set, dropping oauth param when absent', async () => {
    currentSession = { user: { id: member.id } };
    await expect(
      OrgConnectReturnPage({ params: paramsFor(), searchParams: Promise.resolve({}) }),
    ).rejects.toThrow(`REDIRECT:/workspaces/${workspace.id}?connect_tool=jira`);
  });

  it('forwards oauth=success so the dashboard reopens the Connect modal at the scope step', async () => {
    currentSession = { user: { id: member.id } };
    await expect(
      OrgConnectReturnPage({
        params: paramsFor(),
        searchParams: Promise.resolve({ oauth: 'success' }),
      }),
    ).rejects.toThrow(`REDIRECT:/workspaces/${workspace.id}?connect_tool=jira&oauth=success`);
  });
});
