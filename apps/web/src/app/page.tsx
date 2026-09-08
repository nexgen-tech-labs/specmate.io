import { redirect } from 'next/navigation';
import { auth } from '@/lib/auth';
import { getPrimaryWorkspaceIdForUser } from '@/lib/workspace-context';
import { LandingPage } from '@/components/landing/landing-page';

// Organization + SoftwareApplication JSON-LD (AI SEO) — the entity-recognition
// signal AI Overviews/ChatGPT/Perplexity use to identify what SpecMate is,
// independent of prose parsing. Rendered only on this public/unauthenticated
// page, never on the authenticated app. Content is a fixed, hardcoded literal
// below — never user- or request-derived — so JSON.stringify-into-script is
// the standard safe pattern here, not an XSS surface.
const STRUCTURED_DATA = [
  {
    '@context': 'https://schema.org',
    '@type': 'Organization',
    name: 'SpecMate',
    url: 'https://www.specmate.io',
    description:
      'AI Spec Layer for Humans and Coding Agents — ingests raw requirement sources and generates structured, human-reviewed epics, stories, tasks, and acceptance criteria published to Jira, Azure DevOps, or GitHub.',
  },
  {
    '@context': 'https://schema.org',
    '@type': 'SoftwareApplication',
    name: 'SpecMate',
    applicationCategory: 'BusinessApplication',
    operatingSystem: 'Web',
    description:
      'Ingests raw requirement sources — documents, meeting transcripts, existing backlogs — and uses AI to generate structured epics, user stories, tasks, and acceptance criteria, then publishes them to Jira, Azure DevOps, or GitHub with full traceability back to the original source material.',
  },
];

// Onboarding Flow redesign: "The demo lives here, for visitors. Signed-in
// users land in their workspace." — a signed-in user should never see the
// marketing/demo landing page.
export default async function Home() {
  const session = await auth();
  if (session?.user?.id) {
    const workspaceId = await getPrimaryWorkspaceIdForUser(session.user.id);
    redirect(workspaceId ? `/workspaces/${workspaceId}` : '/onboarding');
  }
  return (
    <>
      <script
        type="application/ld+json"
        dangerouslySetInnerHTML={{ __html: JSON.stringify(STRUCTURED_DATA) }}
      />
      <LandingPage />
    </>
  );
}
