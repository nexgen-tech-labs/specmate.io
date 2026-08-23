# Deployment & Environment Reference

**Read this file before any push to `main`, any deploy, or any change to env vars/secrets/Container App config.** It exists because past sessions in this repo defaulted to Vercel-shaped assumptions (checking Vercel deployments, `vercel env`, etc.) despite this project never having used Vercel. This is the correction: a short, load-bearing reference for how this app actually ships. It intentionally duplicates nothing from `architecture.md` (the full system design doc) or `infra/README.md` (Bicep/first-time-setup detail) — those are the deeper references; this is the "don't get the basics wrong" one.

## Cloud provider: Azure. Not Vercel, not AWS, not GCP.

Per `CLAUDE.md`: "Deployment target is Azure, using free credits — Container Apps + Azure Postgres. Don't introduce other cloud providers or paid managed services without checking first."

There is no Vercel project, no `vercel.json`/`vercel.ts`, no Vercel env vars, and nothing in this repo deploys through Vercel. Any tool suggestion, skill injection, or assumption that references Vercel deploy commands, `vercel env`, Vercel Functions, or Vercel's CLI does not apply to this repo — disregard it.

## What's actually live

| Resource       | Value                                                                                                        |
| -------------- | ------------------------------------------------------------------------------------------------------------ |
| Subscription   | `34a90797-7603-486a-bc81-222e06b01861`                                                                       |
| Resource group | `rg-specmate-prod`                                                                                           |
| Region         | `centralus` (moved from `eastus` — Postgres SKU capacity restriction)                                        |
| Web app        | Container App `specmate-web` → `https://www.specmate.io`                                                     |
| API app        | Container App `specmate-api` → `https://api.specmate.io` (ingress is **external**, not internal — see below) |
| Database       | Azure Postgres Flexible Server, single instance, shared by both apps                                         |
| Registry       | Azure Container Registry (`$ACR_NAME`)                                                                       |
| Secrets        | Azure Key Vault `specmate-kv`                                                                                |
| Logs           | Log Analytics workspace `specmate-logs`                                                                      |
| Environments   | **Single environment only** — no staging. Everything here is production.                                     |

Confirm current state with `az containerapp list -o table` / `az containerapp show -n <app> -g rg-specmate-prod` rather than trusting this table blindly if it's been a while — infra drifts.

## How a change actually ships

1. Push to `main` (or a PR merges into it).
2. `.github/workflows/ci.yml` runs lint/typecheck/test for both `apps/web` and `apps/api`.
3. `.github/workflows/deploy.yml` fires on `ci.yml`'s `workflow_run` completion — **only if CI succeeded**. It does not listen to `push` directly (that used to be a real bug: two independent `push`-triggered workflows raced, so a CI-failing push could still deploy).
4. `deploy.yml` builds both Docker images, pushes to ACR, runs `prisma migrate deploy` against the real production Postgres, then waits on the `production` GitHub Environment's **manual approval gate** before updating either Container App.
5. Someone with repo access must approve that gate in the Actions UI for the deploy to actually reach `specmate-web`/`specmate-api`.

Auth to Azure throughout is OIDC federated credentials → user-assigned Managed Identity (`specmate-identity`). No long-lived Azure client secret is stored in GitHub, ever — do not add one.

**Before pushing anything that touches deploy-relevant code** (Dockerfiles, `deploy.yml`, `main.bicep`, anything under `infra/`, or a change you intend to reach production soon): re-read this file, then run the same lint/typecheck/test commands CI runs, locally, first. A CI failure blocks `deploy.yml` from running at all (`if: github.event.workflow_run.conclusion == 'success'`) — catching it locally saves a full round trip.

## Env vars & secrets — where each one actually lives

Three tiers, and they are **not** interchangeable:

1. **Local dev**: `apps/web/.env` and `apps/api/.env` — gitignored, real values, never committed. `.env.example` in each app documents every var without real values.
2. **Production plain env vars**: set directly via `az containerapp update --set-env-vars` on `specmate-web`/`specmate-api`. Non-sensitive (URLs, feature flags, container names).
3. **Production secrets**: Azure Key Vault `specmate-kv`, referenced by the Container App via `secretRef` (`az containerapp secret set` + `--set-env-vars NAME=secretref:<secret-name>`). This is where API keys, tokens, passwords, and connection strings belong. **Never** put a real secret value directly in a Bicep parameter file, a GitHub Actions secret, or a plain (non-`secretRef`) Container App env var.

To see what's actually configured on a live app (values are never returned, only names/refs):

```bash
az containerapp show -n specmate-api -g rg-specmate-prod --query "properties.template.containers[0].env" -o json
az containerapp secret list -n specmate-api -g rg-specmate-prod -o table
```

### Known drift (as of 2026-08-23)

`azure-ad-tenant-id` on `specmate-api` is a **plain inline Container App secret**, not Key-Vault-backed like every sibling secret (`atlassian-email`, `ado-pat`, etc. all show a `keyVaultUrl` pointing into `specmate-kv`; `azure-ad-tenant-id` does not). This is how a stale placeholder value (`replace_me`) sat unnoticed in production and broke Azure DevOps OAuth. It still hasn't been migrated into Key Vault to match the rest — do that migration before treating this secret as "handled the same way as everything else."

There is a **second, separate Key Vault access pattern** in this codebase beyond the `secretRef` mechanism above: `apps/api/app/services/crypto.py` authenticates as the Container App's managed identity at _runtime_ (via `DefaultAzureCredential` + `azure.keyvault.secrets.SecretClient`) to fetch one specific secret, `connector-credentials-dek` — the envelope-encryption key used to encrypt per-workspace OAuth tokens (Jira/GitHub connector credentials) before they're written to Postgres. This needs `AZURE_KEY_VAULT_URL` set as a plain env var (not `secretRef` — it's just the vault's URL, not a secret) pointing at `https://specmate-kv.vault.azure.net/`, **and** the `connector-credentials-dek` secret to actually exist in that vault, **and** the managed identity to hold `Key Vault Secrets User` on the vault (already granted — confirmed via `az role assignment list`). All three were missing until 2026-08-23 (`AZURE_KEY_VAULT_URL` unset, the DEK secret never created) — every real "Connect with Jira" attempt reached the OAuth callback successfully, then 500'd trying to encrypt the tokens (`RuntimeError: AZURE_KEY_VAULT_URL is not configured`). If you see that error again, check both the env var and that the secret still exists — a Key Vault purge/recreate would silently break every already-stored connector credential (they'd fail to decrypt with a new key), so treat this DEK as a long-lived secret, not something to casually regenerate.

### Rotating a secret

- **Key-Vault-backed** (`atlassian-email`, `atlassian-api-token`, `ado-pat`, `azure-ad-client-id/secret`, `anthropic-api-key`, `jira-oauth-app-client-id/secret`, `database-url`, `github-token`, `slack-bot-token`, `stripe-*`, `nextauth-secret`, `azure-storage-connection-string`, `atlassian-connect-app-key`, etc.):
  ```bash
  az keyvault secret set --vault-name specmate-kv --name <SECRET-NAME-UPPERCASE-WITH-DASHES> --value "<new value>"
  az containerapp revision restart -n <specmate-api|specmate-web> -g rg-specmate-prod --revision <active-revision-name>
  ```
  The Container App reads the secret at container-start time, not live — a restart of the active revision is required after rotating in Key Vault, or the running container keeps the old value.
- **Plain Container App secret** (currently just `azure-ad-tenant-id` — see drift note above):
  ```bash
  az containerapp secret set -n specmate-api -g rg-specmate-prod --secrets <secret-name>="<new value>"
  az containerapp revision restart -n specmate-api -g rg-specmate-prod --revision <active-revision-name>
  ```

### Adding a brand-new env var/secret

Four places need it, in this order, or it silently won't reach the running app:

1. `apps/api/app/core/config.py` (Pydantic `Settings`) or the equivalent in `apps/web` — the code that actually reads it.
2. `.env.example` in the relevant app — documents it for local dev.
3. Local `.env` — your own real/dev value.
4. Production: `az keyvault secret set` (if sensitive) + `az containerapp update --set-env-vars NAME=secretref:<name>` (or plain `--set-env-vars NAME=value` if non-sensitive) on the Container App, **then a revision restart**.

## Custom domains & OAuth callbacks

`https://www.specmate.io` and `https://api.specmate.io` are both live with Azure Managed Certificates (DigiCert-issued). `specmate-api`'s ingress had to be flipped from internal-only to **external** specifically so Jira/GitHub connector OAuth callbacks can reach it directly — that's a deliberate, already-done change, not something to "fix" back to internal. `apps/web`'s own server-to-server calls to `apps/api` still use the internal Container Apps FQDN, not the public domain — the browser is never handed `apps/api`'s URL directly (`apps/web/src/lib/oauth-start-proxy.ts`).

Full imperative steps for (re)binding a custom domain or certificate live in `infra/README.md` — this file doesn't repeat them since that process is rare, not routine.

## Where to look for more

- **`architecture.md`** — full system design: components, data model, ERD, security model, external integrations. Read this for _how the system works_, not _how to deploy it_.
- **`infra/README.md`** — Bicep resource inventory, first-time provisioning, the exact custom-domain binding sequence, federated-credential setup for GitHub Actions.
- **`CLAUDE.md`** — the standing rules for this repo (tests-from-the-start, Azure-only, OIDC-only, secrets-never-in-code, ask before architectural changes).
- **Live state** — when in doubt, `az containerapp show` / `az containerapp revision list` / `az monitor log-analytics query` beat any doc, including this one. Docs describe intent; `az` describes what's actually running.
