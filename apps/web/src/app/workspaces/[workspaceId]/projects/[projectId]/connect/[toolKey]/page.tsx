import { notFound } from 'next/navigation';
import { requireProjectRole } from '@/lib/workspace-context';
import { WizardShell } from './wizard-shell';

export default async function ConnectWizardPage({
  params,
}: {
  params: Promise<{ workspaceId: string; projectId: string; toolKey: string }>;
}) {
  const { workspaceId, projectId, toolKey } = await params;

  // Connector setup is an ADMIN concern (Issue 5.3).
  const access = await requireProjectRole(workspaceId, projectId, ['ADMIN']);
  if (!access.ok) notFound();

  return (
    <div className="min-h-screen bg-paper px-6 py-16">
      <div className="mx-auto max-w-2xl">
        <WizardShell workspaceId={workspaceId} projectId={projectId} toolKey={toolKey} />
      </div>
    </div>
  );
}
