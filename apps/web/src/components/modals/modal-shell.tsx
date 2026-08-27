'use client';

// Shared overlay/panel primitive for the dashboard's 3 modals (Add Source,
// Connect a Tool, Invite). No portal/focus-trap library exists in this repo
// (grep confirms no Radix/Headless UI dependency) — this mirrors the one
// existing hand-rolled modal (landing/sign-in-modal.tsx)'s click-outside-to-
// close pattern rather than introducing a new dependency for 3 call sites.
export function ModalShell({
  title,
  onClose,
  children,
  maxWidthClassName = 'max-w-lg',
}: {
  title: string;
  onClose: () => void;
  children: React.ReactNode;
  maxWidthClassName?: string;
}) {
  return (
    <div onClick={onClose} className="fixed inset-0 z-50 grid place-items-center bg-ink/45 p-5">
      <div
        onClick={(e) => e.stopPropagation()}
        className={`relative w-full ${maxWidthClassName} rounded-lg border border-line bg-panel p-7`}
      >
        <button
          type="button"
          onClick={onClose}
          aria-label="Close"
          className="absolute top-4 right-4 border-none bg-transparent text-lg leading-none text-sub"
        >
          ✕
        </button>
        <h2 className="pr-8 text-lg font-semibold text-ink">{title}</h2>
        <div className="mt-5">{children}</div>
      </div>
    </div>
  );
}
