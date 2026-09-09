'use client';

import { useState } from 'react';
import { ORG_SIZE_OPTIONS } from '@/lib/org-size';
import type { OrgSize } from '@prisma/client';

// First-touch UTM attribution (Issue 10.1) — captured once by LandingPage at
// mount and passed down here, rather than re-read from the URL at submit
// time (which may have already been stripped by the ?request-access=1
// deep-link handling).
export interface UtmParams {
  utmSource: string | null;
  utmMedium: string | null;
  utmCampaign: string | null;
}

export function RequestAccessModal({
  onClose,
  utmParams,
}: {
  onClose: () => void;
  utmParams?: UtmParams;
}) {
  const [email, setEmail] = useState('');
  const [companyName, setCompanyName] = useState('');
  const [companySize, setCompanySize] = useState<OrgSize>('SMALL');
  const [howHeard, setHowHeard] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [submitted, setSubmitted] = useState(false);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    setSubmitting(true);
    const res = await fetch('/api/access-requests', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email, companyName, companySize, howHeard, ...utmParams }),
    });
    setSubmitting(false);
    if (!res.ok) {
      const body: { error?: string } = await res.json().catch(() => ({}));
      setError(body.error ?? 'Something went wrong submitting your request.');
      return;
    }
    setSubmitted(true);
  }

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 px-4"
      onClick={onClose}
    >
      <div
        className="w-full max-w-md rounded-lg border border-line bg-panel p-8"
        onClick={(e) => e.stopPropagation()}
      >
        {submitted ? (
          <div className="text-center">
            <h2 className="text-2xl font-bold tracking-tight text-ink">Request received</h2>
            <p className="mt-3 text-base text-sub">
              Thanks — we&apos;ll review your request and follow up by email.
            </p>
            <button
              type="button"
              onClick={onClose}
              className="mt-6 rounded-md bg-cobalt px-5 py-3 text-sm font-semibold text-white"
            >
              Close
            </button>
          </div>
        ) : (
          <>
            <div className="mb-6">
              <h2 className="text-2xl font-bold tracking-tight text-ink">Request access</h2>
              <p className="mt-2 text-sm text-sub">
                We&apos;re onboarding a limited number of companies during our beta. Tell us about
                your team and we&apos;ll follow up.
              </p>
            </div>

            <form onSubmit={(e) => void handleSubmit(e)}>
              {error ? <p className="mb-4 text-sm text-red">{error}</p> : null}

              <label
                htmlFor="request-access-email"
                className="mb-1.5 block text-sm font-semibold text-ink"
              >
                Work email
              </label>
              <input
                id="request-access-email"
                type="email"
                required
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                placeholder="you@company.com"
                className="mb-4 w-full rounded-md border border-line bg-paper px-3.5 py-3 text-sm text-ink focus-visible:outline focus-visible:outline-2 focus-visible:outline-cobalt"
              />

              <label
                htmlFor="request-access-company"
                className="mb-1.5 block text-sm font-semibold text-ink"
              >
                Company name
              </label>
              <input
                id="request-access-company"
                type="text"
                required
                value={companyName}
                onChange={(e) => setCompanyName(e.target.value)}
                placeholder="Acme Corp"
                className="mb-4 w-full rounded-md border border-line bg-paper px-3.5 py-3 text-sm text-ink focus-visible:outline focus-visible:outline-2 focus-visible:outline-cobalt"
              />

              <label
                htmlFor="request-access-size"
                className="mb-1.5 block text-sm font-semibold text-ink"
              >
                Company size
              </label>
              <select
                id="request-access-size"
                value={companySize}
                onChange={(e) => setCompanySize(e.target.value as OrgSize)}
                className="mb-4 w-full rounded-md border border-line bg-paper px-3.5 py-3 text-sm text-ink focus-visible:outline focus-visible:outline-2 focus-visible:outline-cobalt"
              >
                {ORG_SIZE_OPTIONS.map((o) => (
                  <option key={o.value} value={o.value}>
                    {o.label}
                  </option>
                ))}
              </select>

              <label
                htmlFor="request-access-how-heard"
                className="mb-1.5 block text-sm font-semibold text-ink"
              >
                How did you hear about us? What would you use SpecMate for?{' '}
                <span className="font-normal text-sub">(optional)</span>
              </label>
              <textarea
                id="request-access-how-heard"
                rows={3}
                value={howHeard}
                onChange={(e) => setHowHeard(e.target.value)}
                className="mb-6 w-full rounded-md border border-line bg-paper px-3.5 py-3 text-sm text-ink focus-visible:outline focus-visible:outline-2 focus-visible:outline-cobalt"
              />

              <div className="flex gap-3">
                <button
                  type="submit"
                  disabled={submitting}
                  className="flex-1 rounded-md bg-cobalt px-5 py-3 text-sm font-semibold text-white disabled:opacity-50"
                >
                  {submitting ? 'Submitting…' : 'Request access →'}
                </button>
                <button
                  type="button"
                  onClick={onClose}
                  className="rounded-md border border-line px-5 py-3 text-sm text-ink"
                >
                  Cancel
                </button>
              </div>
            </form>
          </>
        )}
      </div>
    </div>
  );
}
