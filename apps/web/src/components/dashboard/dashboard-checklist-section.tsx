'use client';

import { useRouter } from 'next/navigation';
import { OnboardingChecklist, type ChecklistItem } from './onboarding-checklist';

interface DashboardChecklistSectionProps {
  workspaceId: string;
  items: ChecklistItem[];
  dismissedInitially: boolean;
  connectHref: string;
  addSourceHref: string;
  inviteHref: string;
}

// Owns the checklist's dismiss side-effect (persisted server-side) — the
// checklist card itself stays a presentation component. Tile clicks navigate
// to the existing project-scoped pages for now (PR 5 swaps these for real
// modals opened in-place).
export function DashboardChecklistSection({
  workspaceId,
  items,
  dismissedInitially,
  connectHref,
  addSourceHref,
  inviteHref,
}: DashboardChecklistSectionProps) {
  const router = useRouter();

  async function handleDismiss() {
    try {
      await fetch(`/api/workspaces/${workspaceId}/dismiss-checklist`, { method: 'POST' });
    } catch {
      // Best-effort — the card already hid itself client-side; a failed
      // persist just means it reappears on next load, not a broken UI now.
    }
  }

  function handleSelect(key: ChecklistItem['key']) {
    if (key === 'tool') router.push(connectHref);
    if (key === 'source') router.push(addSourceHref);
    if (key === 'invite') router.push(inviteHref);
  }

  return (
    <OnboardingChecklist
      items={items}
      dismissedInitially={dismissedInitially}
      onDismiss={() => void handleDismiss()}
      onSelect={handleSelect}
    />
  );
}
