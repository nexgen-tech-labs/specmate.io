import { WorkspaceBreadcrumb } from '@/components/layout/workspace-breadcrumb';

export default async function WorkspaceLayout({
  children,
  params,
}: {
  children: React.ReactNode;
  params: Promise<{ workspaceId: string }>;
}) {
  const { workspaceId } = await params;
  return (
    <>
      <WorkspaceBreadcrumb workspaceId={workspaceId} />
      {children}
    </>
  );
}
