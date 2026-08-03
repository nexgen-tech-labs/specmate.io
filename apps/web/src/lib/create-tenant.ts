import { prisma } from './prisma';
import type { OrgSize } from '@prisma/client';

interface CreateTenantInput {
  name: string;
  email: string;
  passwordHash: string | null;
  orgName: string;
  orgSize: OrgSize;
  workspaceName: string;
}

// Extracted from /api/signup (Issue 12.8) so both email/password signup and
// new-user OAuth signup create tenants identically — one org/workspace
// creation path, not two divergent ones.
//
// Full hierarchy at signup (Issue 12.10, extended by the Onboarding Flow
// redesign): Organization -> Workspace -> User, with the signing-up user as
// org OWNER + workspace ADMIN. Organization carries its own name + size as
// collected by the 4-step signup form, rather than defaulting to the
// workspace's name.
export async function createTenantForNewUser(input: CreateTenantInput) {
  return prisma.$transaction(async (tx) => {
    const user = await tx.user.create({
      data: { name: input.name, email: input.email, passwordHash: input.passwordHash },
    });
    const organization = await tx.organization.create({
      data: { name: input.orgName, size: input.orgSize },
    });
    const workspace = await tx.workspace.create({
      data: { name: input.workspaceName, organizationId: organization.id },
    });
    await tx.organizationMember.create({
      data: { organizationId: organization.id, userId: user.id, role: 'OWNER' },
    });
    await tx.workspaceMember.create({
      data: { workspaceId: workspace.id, userId: user.id, role: 'ADMIN' },
    });
    return { user, workspace, organization };
  });
}
