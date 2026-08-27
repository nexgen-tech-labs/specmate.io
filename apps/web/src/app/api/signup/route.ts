import { NextResponse } from 'next/server';
import { prisma } from '@/lib/prisma';
import { hashPassword } from '@/lib/password';
import { createTenantForNewUser } from '@/lib/create-tenant';
import type { OrgSize } from '@prisma/client';

const VALID_ORG_SIZES: OrgSize[] = ['SOLO', 'SMALL', 'MEDIUM', 'LARGE', 'ENTERPRISE'];

interface SignupBody {
  name: string;
  email: string;
  password: string;
  orgName: string;
  orgSize: OrgSize;
  workspaceName: string;
}

function isValidBody(body: unknown): body is SignupBody {
  if (typeof body !== 'object' || body === null) return false;
  const b = body as Record<string, unknown>;
  return (
    typeof b.name === 'string' &&
    b.name.trim().length > 0 &&
    typeof b.email === 'string' &&
    b.email.includes('@') &&
    typeof b.password === 'string' &&
    b.password.length >= 8 &&
    typeof b.orgName === 'string' &&
    b.orgName.trim().length > 0 &&
    typeof b.orgSize === 'string' &&
    VALID_ORG_SIZES.includes(b.orgSize as OrgSize) &&
    typeof b.workspaceName === 'string' &&
    b.workspaceName.trim().length > 0
  );
}

export async function POST(request: Request) {
  const body: unknown = await request.json();
  if (!isValidBody(body)) {
    return NextResponse.json({ error: 'Invalid signup details.' }, { status: 400 });
  }

  const existing = await prisma.user.findUnique({ where: { email: body.email } });
  if (existing) {
    return NextResponse.json(
      { error: 'An account with this email already exists.' },
      { status: 409 },
    );
  }

  const passwordHash = await hashPassword(body.password);

  // Full hierarchy at signup (Issue 12.10, extended by the Onboarding Flow
  // redesign): Organization → Workspace → User, with the signing-up user as
  // org OWNER + workspace ADMIN. Organization carries its own name + size as
  // collected by the 3-step signup form, rather than defaulting to the
  // workspace's name. Inviting teammates happens later, from the dashboard's
  // onboarding checklist — the signup form itself no longer collects invites.
  const { workspace } = await createTenantForNewUser({
    name: body.name,
    email: body.email,
    passwordHash,
    orgName: body.orgName,
    orgSize: body.orgSize,
    workspaceName: body.workspaceName,
  });

  // workspaceId lets the client route straight into the workspace dashboard
  // (Issue 10.10) instead of dead-ending on a static "done" screen.
  return NextResponse.json({ ok: true, workspaceId: workspace.id }, { status: 201 });
}
