// Invite-only beta (access requests must come from a company, not a personal
// inbox) — a hardcoded blocklist of common consumer/free email providers.
// This is a heuristic, not exhaustive (won't catch every disposable-email
// service): it's a soft gate backed by the founder's own manual review of
// company name/size before final approval, not the sole line of defense.
const CONSUMER_EMAIL_DOMAINS = new Set([
  'gmail.com',
  'googlemail.com',
  'yahoo.com',
  'yahoo.co.uk',
  'yahoo.co.in',
  'ymail.com',
  'rocketmail.com',
  'outlook.com',
  'hotmail.com',
  'hotmail.co.uk',
  'live.com',
  'msn.com',
  'icloud.com',
  'me.com',
  'mac.com',
  'aol.com',
  'protonmail.com',
  'proton.me',
  'pm.me',
  'gmx.com',
  'gmx.net',
  'zoho.com',
  'mail.com',
  'yandex.com',
  'yandex.ru',
  'qq.com',
  '163.com',
  '126.com',
  'inbox.com',
  'fastmail.com',
]);

const EMAIL_SHAPE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export function isBusinessEmail(email: string): boolean {
  const trimmed = email.trim().toLowerCase();
  if (!EMAIL_SHAPE.test(trimmed)) return false;
  const domain = trimmed.split('@')[1];
  if (!domain) return false;
  return !CONSUMER_EMAIL_DOMAINS.has(domain);
}
