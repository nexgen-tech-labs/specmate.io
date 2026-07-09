import { afterEach, describe, expect, it, vi } from 'vitest';
import { isInternalAdmin } from './admin-access';

describe('isInternalAdmin', () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it('returns false when the allowlist env var is unset', () => {
    vi.stubEnv('INTERNAL_ADMIN_EMAILS', '');
    expect(isInternalAdmin('anyone@acme.com')).toBe(false);
  });

  it('returns false for a null or undefined email', () => {
    vi.stubEnv('INTERNAL_ADMIN_EMAILS', 'staff@specmate.io');
    expect(isInternalAdmin(null)).toBe(false);
    expect(isInternalAdmin(undefined)).toBe(false);
  });

  it('matches an allowlisted email', () => {
    vi.stubEnv('INTERNAL_ADMIN_EMAILS', 'staff@specmate.io, other@specmate.io');
    expect(isInternalAdmin('staff@specmate.io')).toBe(true);
    expect(isInternalAdmin('other@specmate.io')).toBe(true);
  });

  it('is case-insensitive', () => {
    vi.stubEnv('INTERNAL_ADMIN_EMAILS', 'Staff@Specmate.io');
    expect(isInternalAdmin('staff@specmate.io')).toBe(true);
  });

  it('rejects an email not on the allowlist', () => {
    vi.stubEnv('INTERNAL_ADMIN_EMAILS', 'staff@specmate.io');
    expect(isInternalAdmin('customer@acme.com')).toBe(false);
  });
});
