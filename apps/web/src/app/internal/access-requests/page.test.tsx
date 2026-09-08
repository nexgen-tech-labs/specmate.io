import { render, screen } from '@testing-library/react';
import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import { prisma } from '@/lib/prisma';

let currentSession: { user: { email: string } } | null = null;
vi.mock('@/lib/auth', () => ({
  auth: async () => currentSession,
}));
vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: vi.fn(), refresh: vi.fn() }),
  notFound: () => {
    throw new Error('NEXT_HTTP_ERROR_FALLBACK;404');
  },
}));

const { default: AccessRequestsPage } = await import('./page');

describe('AccessRequestsPage', () => {
  const createdEmails: string[] = [];

  beforeEach(() => {
    vi.stubEnv('INTERNAL_ADMIN_EMAILS', 'admin@specmate.io');
  });

  afterEach(async () => {
    await prisma.signupToken.deleteMany({ where: { email: { in: createdEmails } } });
    await prisma.accessRequest.deleteMany({ where: { email: { in: createdEmails } } });
    createdEmails.length = 0;
  });

  it('renders the request queue for an admin session', async () => {
    currentSession = { user: { email: 'admin@specmate.io' } };
    const email = `page-test-${Date.now()}@acmecorp.com`;
    createdEmails.push(email);
    await prisma.accessRequest.create({
      data: { email, companyName: 'Acme Corp', companySize: 'SMALL', howHeard: 'LinkedIn' },
    });

    const result = await AccessRequestsPage();
    render(result);

    expect(screen.getByText('Access Requests')).toBeInTheDocument();
    expect(screen.getByText(email)).toBeInTheDocument();
    expect(screen.getByText('Acme Corp')).toBeInTheDocument();
  });

  it('shows PENDING requests before APPROVED/REJECTED ones regardless of date', async () => {
    currentSession = { user: { email: 'admin@specmate.io' } };
    const oldPendingEmail = `old-pending-${Date.now()}@acmecorp.com`;
    const newApprovedEmail = `new-approved-${Date.now()}@acmecorp.com`;
    createdEmails.push(oldPendingEmail, newApprovedEmail);

    await prisma.accessRequest.create({
      data: {
        email: oldPendingEmail,
        companyName: 'Old Pending Co',
        companySize: 'SMALL',
        createdAt: new Date(Date.now() - 1000 * 60 * 60 * 24),
      },
    });
    await prisma.accessRequest.create({
      data: {
        email: newApprovedEmail,
        companyName: 'New Approved Co',
        companySize: 'SMALL',
        status: 'APPROVED',
        reviewedAt: new Date(),
      },
    });

    const result = await AccessRequestsPage();
    const { container } = render(result);
    const text = container.textContent ?? '';
    expect(text.indexOf('Old Pending Co')).toBeLessThan(text.indexOf('New Approved Co'));
  });

  it('persistently shows the signup link for an APPROVED request across a fresh page load', async () => {
    // Regression test: the signup URL used to only be visible transiently in
    // AccessRequestRowActions' client state right after clicking Approve —
    // router.refresh() re-renders the row without it once status flips to
    // APPROVED, so a founder navigating back to this page later saw nothing.
    currentSession = { user: { email: 'admin@specmate.io' } };
    const email = `approved-link-${Date.now()}@acmecorp.com`;
    createdEmails.push(email);
    const accessRequest = await prisma.accessRequest.create({
      data: {
        email,
        companyName: 'Acme Corp',
        companySize: 'SMALL',
        status: 'APPROVED',
        reviewedAt: new Date(),
      },
    });
    await prisma.signupToken.create({
      data: {
        accessRequestId: accessRequest.id,
        email,
        token: `page-signup-tok-${Date.now()}`,
        expiresAt: new Date(Date.now() + 1000 * 60 * 60 * 24),
      },
    });

    const result = await AccessRequestsPage();
    render(result);

    expect(screen.getByText(/\/signup-invite\/page-signup-tok-/)).toBeInTheDocument();
  });
});

describe('AccessRequestsPage authorization', () => {
  beforeEach(() => {
    vi.stubEnv('INTERNAL_ADMIN_EMAILS', 'admin@specmate.io');
  });

  it('calls notFound (throws NEXT_HTTP_ERROR_FALLBACK;404) for a non-admin session', async () => {
    currentSession = { user: { email: 'not-admin@example.com' } };
    await expect(AccessRequestsPage()).rejects.toThrow();
  });

  it('calls notFound when no session exists', async () => {
    currentSession = null;
    await expect(AccessRequestsPage()).rejects.toThrow();
  });
});
