'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { ModalShell } from '@/components/modals/modal-shell';
import { EmailChipInput } from '@/components/shared/email-chip-input';
import type { Role } from '@prisma/client';

const ROLE_OPTIONS: Array<{ value: Role; label: string }> = [
  { value: 'REVIEWER', label: 'Reviewer — approves items before they publish' },
  { value: 'VIEWER', label: 'Viewer — read-only' },
  { value: 'ADMIN', label: 'Admin — manages workspace settings' },
];

export function InviteModal({
  workspaceId,
  onClose,
}: {
  workspaceId: string;
  onClose: () => void;
}) {
  const router = useRouter();
  const [emails, setEmails] = useState<string[]>([]);
  const [role, setRole] = useState<Role>('REVIEWER');
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [sentCount, setSentCount] = useState<number | null>(null);

  // The existing /invites endpoint accepts one email per call — no batch
  // support to add for a 3-modal PR, so send them in parallel and report
  // partial failure rather than silently dropping any.
  async function handleSend() {
    if (emails.length === 0) return;
    setSending(true);
    setError(null);
    const results = await Promise.allSettled(
      emails.map((email) =>
        fetch(`/api/workspaces/${workspaceId}/invites`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ email, role }),
        }).then((res) => {
          if (!res.ok) throw new Error(email);
        }),
      ),
    );
    setSending(false);
    const failed = results.filter((r) => r.status === 'rejected').length;
    const succeeded = emails.length - failed;
    if (succeeded > 0) setSentCount(succeeded);
    if (failed > 0) {
      setError(
        succeeded > 0
          ? `${failed} invite${failed === 1 ? '' : 's'} failed to send — try again for those.`
          : 'Could not send invites — try again.',
      );
    }
    if (failed === 0) {
      router.refresh();
    }
  }

  if (sentCount !== null && !error) {
    return (
      <ModalShell title="Invites sent" onClose={onClose}>
        <p className="text-sm text-sub">
          {sentCount} invite{sentCount === 1 ? '' : 's'} sent. Reviewers approve items before they
          publish.
        </p>
        <button
          type="button"
          onClick={onClose}
          className="mt-6 rounded-md bg-cobalt px-4 py-2.5 text-sm font-bold text-white"
        >
          Done
        </button>
      </ModalShell>
    );
  }

  return (
    <ModalShell title="Invite your team" onClose={onClose}>
      <p className="mb-4 text-sm text-sub">
        Reviewers approve items before they publish. Add one or more emails below.
      </p>
      <EmailChipInput emails={emails} onChange={setEmails} />

      <label htmlFor="invite-role" className="mt-5 mb-2 block text-sm font-semibold text-ink">
        Role
      </label>
      <select
        id="invite-role"
        value={role}
        onChange={(e) => setRole(e.target.value as Role)}
        className="w-full rounded-md border border-line bg-paper px-3.5 py-2.5 text-sm text-ink"
      >
        {ROLE_OPTIONS.map((opt) => (
          <option key={opt.value} value={opt.value}>
            {opt.label}
          </option>
        ))}
      </select>

      {error ? <p className="mt-4 text-sm text-red">{error}</p> : null}

      <div className="mt-6 flex justify-end gap-3">
        <button
          type="button"
          onClick={onClose}
          className="rounded-md border border-line bg-panel px-4 py-2.5 text-sm font-semibold text-ink"
        >
          Cancel
        </button>
        <button
          type="button"
          onClick={() => void handleSend()}
          disabled={emails.length === 0 || sending}
          className="rounded-md bg-cobalt px-4 py-2.5 text-sm font-bold text-white disabled:opacity-50"
        >
          {sending ? 'Sending…' : `Send invite${emails.length === 1 ? '' : 's'}`}
        </button>
      </div>
    </ModalShell>
  );
}
