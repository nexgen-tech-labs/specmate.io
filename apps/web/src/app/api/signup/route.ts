import { NextResponse } from 'next/server';
import { prisma } from '@/lib/prisma';
import { hashPassword } from '@/lib/password';

interface SignupBody {
  name: string;
  email: string;
  password: string;
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

  // Full hierarchy at signup (Issue 12.10): Organization → Workspace → User,
  // with the signing-up user as org OWNER + workspace ADMIN. The org is named
  // after the workspace (implicit single-workspace org) — renaming/growing it
  // into a multi-workspace org happens later via org management.
  const { workspace } = await prisma.$transaction(async (tx) => {
    const user = await tx.user.create({
      data: { name: body.name, email: body.email, passwordHash },
    });
    const organization = await tx.organization.create({
      data: { name: body.workspaceName },
    });
    const workspace = await tx.workspace.create({
      data: { name: body.workspaceName, organizationId: organization.id },
    });
    await tx.organizationMember.create({
      data: { organizationId: organization.id, userId: user.id, role: 'OWNER' },
    });
    await tx.workspaceMember.create({
      data: { workspaceId: workspace.id, userId: user.id, role: 'ADMIN' },
    });
    return { user, workspace };
  });

  // workspaceId lets the client route straight into the workspace dashboard
  // (Issue 10.10) instead of dead-ending on a static "done" screen.
  return NextResponse.json({ ok: true, workspaceId: workspace.id }, { status: 201 });
}
