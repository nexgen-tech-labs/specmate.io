/**
 * GitHub App webhook signature verification (Issue 10.3).
 *
 * GitHub signs every webhook delivery with HMAC-SHA256 over the raw request
 * body, sent as `X-Hub-Signature-256: sha256=<hex>` — a completely different
 * scheme from Atlassian Connect's JWT-based lifecycle auth (see
 * atlassian-connect.ts): there's no per-install shared secret here, just one
 * webhook secret configured once for the whole GitHub App at registration
 * time (GITHUB_APP_WEBHOOK_SECRET), shared by every installation's events.
 *
 * The raw body MUST be read as text (never JSON-parsed first) before
 * verification — re-serializing a parsed object would not byte-for-byte
 * match what GitHub actually signed.
 */
import { createHmac, timingSafeEqual } from 'node:crypto';

export class GitHubWebhookSignatureError extends Error {}

/** Verifies X-Hub-Signature-256 against the raw request body. Throws
 * GitHubWebhookSignatureError on any mismatch or malformed header — callers
 * must not proceed on a caught error. */
export function verifyGitHubWebhookSignature(
  rawBody: string,
  signatureHeader: string | null,
  webhookSecret: string,
): void {
  if (!signatureHeader) {
    throw new GitHubWebhookSignatureError('Missing X-Hub-Signature-256 header.');
  }
  const prefix = 'sha256=';
  if (!signatureHeader.startsWith(prefix)) {
    throw new GitHubWebhookSignatureError('Malformed X-Hub-Signature-256 header.');
  }
  const expected = createHmac('sha256', webhookSecret).update(rawBody, 'utf8').digest('hex');
  const provided = signatureHeader.slice(prefix.length);

  // timingSafeEqual requires equal-length buffers, and throws (not returns
  // false) on a length mismatch — checked separately so a malformed/forged
  // header of the wrong length surfaces as a clean verification failure
  // rather than an unhandled exception.
  const expectedBuf = Buffer.from(expected, 'hex');
  const providedBuf = Buffer.from(provided, 'hex');
  if (expectedBuf.length !== providedBuf.length || !timingSafeEqual(expectedBuf, providedBuf)) {
    throw new GitHubWebhookSignatureError('Signature does not match.');
  }
}
