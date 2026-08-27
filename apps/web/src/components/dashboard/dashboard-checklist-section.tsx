'use client';

import { OnboardingChecklist, type ChecklistItem } from './onboarding-checklist';

interface DashboardChecklistSectionProps {
  workspaceId: string;
  items: ChecklistItem[];
  dismissedInitially: boolean;
  onSelectConnectTool: () => void;
  onSelectAddSource: () => void;
  onSelectInvite: () => void;
}

// Owns the checklist's dismiss side-effect (persisted server-side) — the
// checklist card itself stays a presentation component. Tile clicks open the
// matching modal via DashboardClientShell's lifted activeModal state.
export function DashboardChecklistSection({
  workspaceId,
  items,
  dismissedInitially,
  onSelectConnectTool,
  onSelectAddSource,
  onSelectInvite,
}: DashboardChecklistSectionProps) {
  async function handleDismiss() {
    try {
      await fetch(`/api/workspaces/${workspaceId}/dismiss-checklist`, { method: 'POST' });
    } catch {
      // Best-effort — the card already hid itself client-side; a failed
      // persist just means it reappears on next load, not a broken UI now.
    }
  }

  function handleSelect(key: ChecklistItem['key']) {
    if (key === 'tool') onSelectConnectTool();
    if (key === 'source') onSelectAddSource();
    if (key === 'invite') onSelectInvite();
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
