import { render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { prisma } from '@/lib/prisma';

vi.mock('next/navigation', () => ({
  notFound: () => {
    throw new Error('NEXT_HTTP_ERROR_FALLBACK;404');
  },
  useRouter: () => ({ push: vi.fn(), refresh: vi.fn() }),
}));
vi.mock('next-auth/react', () => ({ signIn: vi.fn() }));

const { default: SignupInvitePage } = await import('./page');

async function createRequestAndToken(email: string, overrides: Record<string, unknown> = {}) {
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
      token: `page-tok-${Date.now()}-${Math.random()}`,
      expiresAt: new Date(Date.now() + 1000 * 60 * 60 * 24),
      ...overrides,
    },
  });
  return { accessRequest, token };
}

describe('SignupInvitePage', () => {
  const createdAccessRequestIds: string[] = [];

  afterEach(async () => {
    await prisma.signupToken.deleteMany({
      where: { accessRequestId: { in: createdAccessRequestIds } },
    });
    await prisma.accessRequest.deleteMany({ where: { id: { in: createdAccessRequestIds } } });
    createdAccessRequestIds.length = 0;
  });

  it('renders the form pre-filled with the requester email and company for a valid token', async () => {
    const email = `page-valid-${Date.now()}@acmecorp.com`;
    const { accessRequest, token } = await createRequestAndToken(email);
    createdAccessRequestIds.push(accessRequest.id);

    const result = await SignupInvitePage({ params: Promise.resolve({ token: token.token }) });
    render(result);

    expect(screen.getByText(email)).toBeInTheDocument();
    expect(screen.getAllByText('Acme Corp').length).toBeGreaterThan(0);
  });

  it('calls notFound for an unknown token', async () => {
    await expect(
      SignupInvitePage({ params: Promise.resolve({ token: 'nope' }) }),
    ).rejects.toThrow();
  });

  it('calls notFound for an already-used token', async () => {
    const email = `page-used-${Date.now()}@acmecorp.com`;
    const { accessRequest, token } = await createRequestAndToken(email, { usedAt: new Date() });
    createdAccessRequestIds.push(accessRequest.id);

    await expect(
      SignupInvitePage({ params: Promise.resolve({ token: token.token }) }),
    ).rejects.toThrow();
  });

  it('calls notFound for an expired token', async () => {
    const email = `page-expired-${Date.now()}@acmecorp.com`;
    const { accessRequest, token } = await createRequestAndToken(email, {
      expiresAt: new Date(Date.now() - 1000),
    });
    createdAccessRequestIds.push(accessRequest.id);

    await expect(
      SignupInvitePage({ params: Promise.resolve({ token: token.token }) }),
    ).rejects.toThrow();
  });
});
