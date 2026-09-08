import { describe, expect, it } from 'vitest';
import { isBusinessEmail } from './business-email';

describe('isBusinessEmail', () => {
  it('accepts a plausible business domain', () => {
    expect(isBusinessEmail('jane@acmecorp.com')).toBe(true);
  });

  it('rejects common consumer email domains', () => {
    expect(isBusinessEmail('jane@gmail.com')).toBe(false);
    expect(isBusinessEmail('jane@yahoo.com')).toBe(false);
    expect(isBusinessEmail('jane@outlook.com')).toBe(false);
    expect(isBusinessEmail('jane@hotmail.com')).toBe(false);
    expect(isBusinessEmail('jane@icloud.com')).toBe(false);
    expect(isBusinessEmail('jane@protonmail.com')).toBe(false);
  });

  it('is case-insensitive on the domain', () => {
    expect(isBusinessEmail('Jane@GMAIL.com')).toBe(false);
    expect(isBusinessEmail('Jane@AcmeCorp.COM')).toBe(true);
  });

  it('trims surrounding whitespace', () => {
    expect(isBusinessEmail('  jane@acmecorp.com  ')).toBe(true);
  });

  it('rejects malformed email shapes', () => {
    expect(isBusinessEmail('not-an-email')).toBe(false);
    expect(isBusinessEmail('missing-domain@')).toBe(false);
    expect(isBusinessEmail('@nodomainpart.com')).toBe(false);
    expect(isBusinessEmail('')).toBe(false);
  });

  it('does not false-positive a business domain that merely contains a consumer domain as a substring', () => {
    expect(isBusinessEmail('jane@notgmail.com')).toBe(true);
    expect(isBusinessEmail('jane@gmail.com.evil.example')).toBe(true);
  });
});
