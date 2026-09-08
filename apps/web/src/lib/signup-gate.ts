// Invite-only beta kill-switch (first feature-flag in this codebase). Defaults
// closed — anything other than the literal string 'true' is disabled, so an
// unset env var in any environment fails safe. Flipping SIGNUP_ENABLED=true
// fully restores today's self-serve signup with zero code changes: every
// gated call site (/api/signup, resolveOAuthSignIn, /onboarding) falls back
// to its original behavior.
export function isSignupEnabled(): boolean {
  return process.env.SIGNUP_ENABLED === 'true';
}
