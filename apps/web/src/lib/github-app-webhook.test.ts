import { createHmac } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { GitHubWebhookSignatureError, verifyGitHubWebhookSignature } from './github-app-webhook';

const SECRET = 'test-webhook-secret';

function sign(body: string, secret: string): string {
  return `sha256=${createHmac('sha256', secret).update(body, 'utf8').digest('hex')}`;
}

describe('verifyGitHubWebhookSignature', () => {
  it('accepts a correctly signed body', () => {
    const body = JSON.stringify({ action: 'created' });
    expect(() => verifyGitHubWebhookSignature(body, sign(body, SECRET), SECRET)).not.toThrow();
  });

  it('rejects a missing signature header', () => {
    expect(() => verifyGitHubWebhookSignature('{}', null, SECRET)).toThrow(
      GitHubWebhookSignatureError,
    );
  });

  it('rejects a malformed signature header (no sha256= prefix)', () => {
    expect(() => verifyGitHubWebhookSignature('{}', 'not-a-real-signature', SECRET)).toThrow(
      GitHubWebhookSignatureError,
    );
  });

  it('rejects a signature computed with the wrong secret', () => {
    const body = JSON.stringify({ action: 'created' });
    expect(() => verifyGitHubWebhookSignature(body, sign(body, 'wrong-secret'), SECRET)).toThrow(
      GitHubWebhookSignatureError,
    );
  });

  it('rejects a signature for a tampered body', () => {
    const originalBody = JSON.stringify({ action: 'created' });
    const signature = sign(originalBody, SECRET);
    const tamperedBody = JSON.stringify({ action: 'deleted' });
    expect(() => verifyGitHubWebhookSignature(tamperedBody, signature, SECRET)).toThrow(
      GitHubWebhookSignatureError,
    );
  });

  it('rejects a signature of the wrong length without throwing an unrelated error', () => {
    expect(() => verifyGitHubWebhookSignature('{}', 'sha256=abcd', SECRET)).toThrow(
      GitHubWebhookSignatureError,
    );
  });
});
