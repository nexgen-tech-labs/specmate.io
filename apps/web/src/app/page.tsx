import { redirect } from 'next/navigation';
import { auth } from '@/lib/auth';
import { getPrimaryWorkspaceIdForUser } from '@/lib/workspace-context';
import { LandingPage } from '@/components/landing/landing-page';

// Onboarding Flow redesign: "The demo lives here, for visitors. Signed-in
// users land in their workspace." — a signed-in user should never see the
// marketing/demo landing page.
export default async function Home() {
  const session = await auth();
  if (session?.user?.id) {
    const workspaceId = await getPrimaryWorkspaceIdForUser(session.user.id);
    redirect(workspaceId ? `/workspaces/${workspaceId}` : '/onboarding');
  }
  return <LandingPage />;
}
