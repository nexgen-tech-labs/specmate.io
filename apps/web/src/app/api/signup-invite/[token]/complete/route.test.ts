// @vitest-environment node
import { afterEach, describe, expect, it } from 'vitest';
import { prisma } from '@/lib/prisma';

const { POST } = await import('./route');

function makeRequest(body: unknown) {
  return new Request('http://localhost/api/signup-invite/x/complete', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
}

async function createApprovedRequest(email: string, overrides: Record<string, unknown> = {}) {
  const accessRequest = await prisma.accessRequest.create({
    data: {
      email,
      companyName: 'Acme Corp',
      companySize: 'SMALL',
      status: 'APPROVED',
      reviewedAt: new Date(),
    },
  });
  const token = await prisma.signupToken.create({
    data: {
      accessRequestId: accessRequest.id,
      email,
      token: `tok-${Date.now()}-${Math.random()}`,
      expiresAt: new Date(Date.now() + 1000 * 60 * 60 * 24),
      ...overrides,
    },
  });
  return { accessRequest, token };
}

describe('POST /api/signup-invite/[token]/complete', () => {
  const createdUserIds: string[] = [];
  const createdWorkspaceIds: string[] = [];
  const createdOrgIds: string[] = [];
  const createdAccessRequestIds: string[] = [];

  afterEach(async () => {
    await prisma.signupToken.deleteMany({
      where: { accessRequestId: { in: createdAccessRequestIds } },
    });
    await prisma.workspaceMember.deleteMany({
      where: { workspaceId: { in: createdWorkspaceIds } },
    });
    await prisma.organizationMember.deleteMany({
      where: { organizationId: { in: createdOrgIds } },
    });
    await prisma.workspace.deleteMany({ where: { id: { in: createdWorkspaceIds } } });
    await prisma.organization.deleteMany({ where: { id: { in: createdOrgIds } } });
    await prisma.accessRequest.deleteMany({ where: { id: { in: createdAccessRequestIds } } });
    await prisma.user.deleteMany({ where: { id: { in: createdUserIds } } });
    createdUserIds.length = 0;
    createdWorkspaceIds.length = 0;
    createdOrgIds.length = 0;
    createdAccessRequestIds.length = 0;
  });

  it('completes signup, creates the tenant scoped to the approved request, and marks the token used', async () => {
    const email = `complete-${Date.now()}@acmecorp.com`;
    const { accessRequest, token } = await createApprovedRequest(email);
    createdAccessRequestIds.push(accessRequest.id);

    const res = await POST(makeRequest({ name: 'Jane Doe', password: 'password123' }), {
      params: Promise.resolve({ token: token.token }),
    });
    expect(res.status).toBe(201);
    const { workspaceId }: { workspaceId: string } = await res.json();
    createdWorkspaceIds.push(workspaceId);

    const workspace = await prisma.workspace.findUniqueOrThrow({
      where: { id: workspaceId },
      include: { organization: true },
    });
    createdOrgIds.push(workspace.organizationId!);
    expect(workspace.organization?.name).toBe('Acme Corp');
    expect(workspace.organization?.size).toBe('SMALL');

    const user = await prisma.user.findUniqueOrThrow({ where: { email } });
    createdUserIds.push(user.id);
    expect(user.name).toBe('Jane Doe');

    const updatedToken = await prisma.signupToken.findUniqueOrThrow({
      where: { id: token.id },
    });
    expect(updatedToken.usedAt).not.toBeNull();
  });

  it('returns 404 for an unknown token', async () => {
    const res = await POST(makeRequest({ name: 'Jane', password: 'password123' }), {
      params: Promise.resolve({ token: 'does-not-exist' }),
    });
    expect(res.status).toBe(404);
  });

  it('returns 404 for an already-used token', async () => {
    const email = `used-${Date.now()}@acmecorp.com`;
    const { accessRequest, token } = await createApprovedRequest(email, { usedAt: new Date() });
    createdAccessRequestIds.push(accessRequest.id);

    const res = await POST(makeRequest({ name: 'Jane', password: 'password123' }), {
      params: Promise.resolve({ token: token.token }),
    });
    expect(res.status).toBe(404);
  });

  it('returns 404 for an expired token', async () => {
    const email = `expired-${Date.now()}@acmecorp.com`;
    const { accessRequest, token } = await createApprovedRequest(email, {
      expiresAt: new Date(Date.now() - 1000),
    });
    createdAccessRequestIds.push(accessRequest.id);

    const res = await POST(makeRequest({ name: 'Jane', password: 'password123' }), {
      params: Promise.resolve({ token: token.token }),
    });
    expect(res.status).toBe(404);
  });

  it('rejects a password shorter than 8 characters', async () => {
    const email = `short-pw-${Date.now()}@acmecorp.com`;
    const { accessRequest, token } = await createApprovedRequest(email);
    createdAccessRequestIds.push(accessRequest.id);

    const res = await POST(makeRequest({ name: 'Jane', password: 'short' }), {
      params: Promise.resolve({ token: token.token }),
    });
    expect(res.status).toBe(400);
  });

  it('returns 409 if a User with this email already exists', async () => {
    const email = `already-exists-${Date.now()}@acmecorp.com`;
    const { accessRequest, token } = await createApprovedRequest(email);
    createdAccessRequestIds.push(accessRequest.id);
    const existingUser = await prisma.user.create({
      data: { name: 'Existing', email, passwordHash: 'x' },
    });
    createdUserIds.push(existingUser.id);

    const res = await POST(makeRequest({ name: 'Jane', password: 'password123' }), {
      params: Promise.resolve({ token: token.token }),
    });
    expect(res.status).toBe(409);
  });
});
