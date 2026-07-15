/**
 * Stripe client (Issue 10.9). Test-mode only until a real Stripe account and
 * live keys exist — see .env.example for setup. `getStripeClient()` throws a
 * clear error rather than silently no-op'ing if STRIPE_SECRET_KEY is unset, so
 * a misconfigured deploy fails loudly at the call site instead of pretending
 * to bill successfully.
 */
import Stripe from 'stripe';

let client: Stripe | null = null;

export function getStripeClient(): Stripe {
  if (client) return client;
  const key = process.env.STRIPE_SECRET_KEY;
  if (!key) {
    throw new Error(
      'STRIPE_SECRET_KEY is not set — billing is unavailable until Stripe test-mode keys are configured (see .env.example).',
    );
  }
  client = new Stripe(key, { apiVersion: '2026-06-24.dahlia' });
  return client;
}

export function isStripeConfigured(): boolean {
  return Boolean(process.env.STRIPE_SECRET_KEY);
}
