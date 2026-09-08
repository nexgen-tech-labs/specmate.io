import { NextResponse } from 'next/server';
import { prisma } from '@/lib/prisma';
import { hashPassword } from '@/lib/password';
import { createTenantForNewUser } from '@/lib/create-tenant';

interface CompleteBody {
  name: string;
  password: string;
}

function isValidBody(body: unknown): body is CompleteBody {
  if (typeof body !== 'object' || body === null) return false;
  const b = body as Record<string, unknown>;
  return (
    typeof b.name === 'string' &&
    b.name.trim().length > 0 &&
    typeof b.password === 'string' &&
    b.password.length >= 8
  );
}

// The only way to complete signup while self-serve is disabled (invite-only
// beta) — deliberately does not go through /api/signup (flag-gated shut).
// Scoped to one pre-approved, single-use token tied to a specific email that
// can't be substituted.
export async function POST(request: Request, { params }: { params: Promise<{ token: string }> }) {
  const { token } = await params;
  const body: unknown = await request.json().catch(() => null);
  if (!isValidBody(body)) {
    return NextResponse.json({ error: 'Invalid signup details.' }, { status: 400 });
  }

  const signupToken = await prisma.signupToken.findUnique({
    where: { token },
    include: { accessRequest: true },
  });
  if (!signupToken || signupToken.usedAt || signupToken.expiresAt < new Date()) {
    return NextResponse.json(
      { error: 'This signup link is invalid or has expired.' },
      { status: 404 },
    );
  }

  const existing = await prisma.user.findUnique({ where: { email: signupToken.email } });
  if (existing) {
    return NextResponse.json(
      { error: 'An account with this email already exists.' },
      { status: 409 },
    );
  }

  const passwordHash = await hashPassword(body.password);
  const { accessRequest } = signupToken;
  const { workspace } = await createTenantForNewUser({
    name: body.name,
    email: signupToken.email,
    passwordHash,
    orgName: accessRequest.companyName,
    orgSize: accessRequest.companySize,
    workspaceName: accessRequest.companySize === 'SOLO' ? 'My Workspace' : 'Engineering',
  });

  await prisma.signupToken.update({
    where: { id: signupToken.id },
    data: { usedAt: new Date() },
  });

  return NextResponse.json({ ok: true, workspaceId: workspace.id }, { status: 201 });
}
