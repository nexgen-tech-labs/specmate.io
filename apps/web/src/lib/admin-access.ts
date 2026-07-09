/**
 * Internal-staff access gate for platform-wide (cross-workspace) pages, like
 * the AI cost dashboard. Deliberately separate from workspace-scoped Role
 * (ADMIN/REVIEWER/VIEWER) — there is no "platform staff" schema concept yet,
 * so this is an env-var email allowlist rather than a DB-backed role.
 */
export function isInternalAdmin(email: string | null | undefined): boolean {
  if (!email) return false;

  const allowlist = (process.env.INTERNAL_ADMIN_EMAILS ?? '')
    .split(',')
    .map((e) => e.trim().toLowerCase())
    .filter((e) => e.length > 0);

  return allowlist.includes(email.trim().toLowerCase());
}
