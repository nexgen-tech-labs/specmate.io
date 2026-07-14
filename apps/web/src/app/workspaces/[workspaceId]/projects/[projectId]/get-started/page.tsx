import { notFound } from 'next/navigation';
import { requireWorkspaceRole } from '@/lib/workspace-context';
import { prisma } from '@/lib/prisma';
import { OnboardingWizard } from '@/components/onboarding/onboarding-wizard';

// Guided first-run wizard (Issue 10.10): connect a tool → upload a source →
// generate → land in review, with a step indicator. Sensible defaults mean a
// new user isn't blocked on configuration decisions before seeing value —
// connecting a tool is explicitly skippable (generation only needs a source).
export default async function GetStartedPage({
  params,
}: {
  params: Promise<{ workspaceId: string; projectId: string }>;
}) {
  const { workspaceId, projectId } = await params;

  const access = await requireWorkspaceRole(workspaceId, ['ADMIN', 'REVIEWER']);
  if (!access.ok) notFound();

  const project = await prisma.project.findFirst({ where: { id: projectId, workspaceId } });
  if (!project) notFound();

  const [sourceCount, mappingCount] = await Promise.all([
    prisma.source.count({ where: { projectId, deletedAt: null } }),
    prisma.publishMapping.count({ where: { projectId } }),
  ]);

  return (
    <div className="min-h-screen bg-paper px-6 py-16">
      <div className="mx-auto max-w-2xl">
        <h1 className="text-3xl font-bold tracking-tight text-ink">
          Get started with {project.name}
        </h1>
        <p className="mt-2 text-base text-sub">
          Three steps to your first generated items — usually under 15 minutes.
        </p>
        <OnboardingWizard
          workspaceId={workspaceId}
          projectId={projectId}
          hasConnectedTool={mappingCount > 0}
          hasSource={sourceCount > 0}
        />
      </div>
    </div>
  );
}
