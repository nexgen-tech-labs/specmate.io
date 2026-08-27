'use client';

import { useState } from 'react';

// Extracted from onboarding-form.tsx's now-removed "Invite team" step (PR3
// trimmed signup to 3 steps) — same minimal validation (non-empty, contains
// "@", no dupes), now shared between the Invite modal and any future reuse.
export function EmailChipInput({
  emails,
  onChange,
  placeholder = 'name@company.com',
}: {
  emails: string[];
  onChange: (emails: string[]) => void;
  placeholder?: string;
}) {
  const [input, setInput] = useState('');

  function addEmail() {
    const value = input.trim();
    if (!value || !value.includes('@') || emails.includes(value)) return;
    onChange([...emails, value]);
    setInput('');
  }

  function removeEmail(email: string) {
    onChange(emails.filter((e) => e !== email));
  }

  return (
    <div>
      <div className="flex gap-2">
        <input
          type="email"
          value={input}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') {
              e.preventDefault();
              addEmail();
            }
          }}
          placeholder={placeholder}
          className="flex-1 rounded-md border border-line bg-paper px-3.5 py-2.5 text-sm text-ink"
        />
        <button
          type="button"
          onClick={addEmail}
          className="rounded-md border border-line bg-panel px-4 py-2.5 text-sm font-semibold text-ink"
        >
          Add
        </button>
      </div>
      {emails.length > 0 ? (
        <div className="mt-3 flex flex-wrap gap-2">
          {emails.map((email) => (
            <span
              key={email}
              className="flex items-center gap-1.5 rounded-full bg-cobalt-soft py-1.5 pr-2 pl-3 text-sm font-semibold text-cobalt"
            >
              {email}
              <button
                type="button"
                onClick={() => removeEmail(email)}
                aria-label={`Remove ${email}`}
                className="border-none bg-transparent p-0 text-sm leading-none text-cobalt"
              >
                ✕
              </button>
            </span>
          ))}
        </div>
      ) : null}
    </div>
  );
}
