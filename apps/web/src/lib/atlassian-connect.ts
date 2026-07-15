/**
 * Atlassian Connect JWT verification (Issue 10.2).
 *
 * Two distinct auth moments in the Connect lifecycle, both handled here:
 * - `installed` callback: no shared secret exists yet for this site, so this
 *   is trust-on-first-use — the payload itself carries the sharedSecret to
 *   store. Callers MUST NOT trust the request body for anything else without
 *   separately validating it came from Atlassian's IP ranges or similar, per
 *   Atlassian's own security guidance; this codebase does not do that yet
 *   (documented gap, see architecture.md).
 * - Every other callback (`uninstalled`, and future request-time auth):
 *   verified against the sharedSecret already stored from the original
 *   `installed` callback — this is the trusted path.
 *
 * Uses @atlassian/atlassian-jwt (Atlassian's own reference implementation)
 * rather than hand-rolling the QSH (query-string-hash) canonicalization,
 * which is non-standard JWT and easy to get subtly wrong.
 */
import {
  decodeSymmetric,
  fromMethodAndUrl,
  createQueryStringHash,
  SymmetricAlgorithm,
} from '@atlassian/atlassian-jwt';

export interface ConnectJwtClaims {
  iss: string; // clientKey
  qsh?: string;
  [key: string]: unknown;
}

export class ConnectJwtError extends Error {}

/** Decodes and verifies a Connect JWT against a known sharedSecret, including
 * the query-string-hash claim (proves the token was minted for this exact
 * request, not replayed from a different one). Throws ConnectJwtError on any
 * verification failure — callers must not proceed on a caught error. */
export function verifyConnectJwt(
  token: string,
  sharedSecret: string,
  method: string,
  rawUrl: string,
): ConnectJwtClaims {
  let claims: ConnectJwtClaims;
  try {
    claims = decodeSymmetric(
      token,
      sharedSecret,
      SymmetricAlgorithm.HS256,
      false,
    ) as ConnectJwtClaims;
  } catch (err) {
    throw new ConnectJwtError(
      `Invalid Connect JWT: ${err instanceof Error ? err.message : 'unknown error'}`,
    );
  }

  if (claims.qsh) {
    const expectedQsh = createQueryStringHash(fromMethodAndUrl(method, rawUrl), false);
    if (claims.qsh !== expectedQsh) {
      throw new ConnectJwtError('Connect JWT query-string-hash mismatch — possible replay/tamper.');
    }
  }

  return claims;
}
