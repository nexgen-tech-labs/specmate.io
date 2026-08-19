# Infrastructure (Azure)

Bicep templates defining SpecMate's Azure footprint: Container Apps (web + api), Azure Postgres Flexible Server, Container Registry, Key Vault, Log Analytics, a Blob Storage account (uploaded Source files), and a user-assigned Managed Identity for the Container Apps.

**Nothing here is deployed automatically.** These files are scaffolding only — run deployments interactively so you can review cost/impact before anything is provisioned.

## Current live deployment

**Single environment only** — `environmentName=production` deployed to `rg-specmate-prod` (`centralus`; moved from `eastus` due to a Postgres capacity/quota restriction on this subscription). A separate `staging` environment was deliberately deferred — decide and deploy later if actually needed; until then, `deploy.yml` builds once and deploys straight to production behind the `production` GitHub Environment's manual-approval gate, with no intermediate staging deploy.

## First-time setup (run manually, with the user present)

```bash
az login
az group create --name rg-specmate-prod --location <region-with-postgres-capacity>

az deployment group create \
  --resource-group rg-specmate-prod \
  --template-file infra/main.bicep \
  --parameters environmentName=production postgresAdminLogin=<login> postgresAdminPassword=<generate-a-strong-password>
```

If Postgres Flexible Server provisioning fails with `LocationIsOfferRestricted`, check `az postgres flexible-server list-skus --location <region>` for alternate regions the subscription actually allows before retrying.

## Custom domains (www.specmate.io + api.specmate.io) — LIVE

`https://www.specmate.io` and `https://api.specmate.io` are both bound and serving production traffic (verified: valid DigiCert-issued certs via `curl -v`, all four of `NEXTAUTH_URL`/`WEB_BASE_URL`/`API_BASE_URL`/`API_BASE_URL_EXTERNAL` set). `www`, not the bare `specmate.io` apex — Hostinger had a pre-existing A record (their default parking page) at the apex, which conflicts with the ALIAS/CNAME-flattening record Azure's custom domain needs there (`RRset specmate.io IN ALIAS must not be used with A on the same name`). Rather than delete Hostinger's apex record, `www` was used instead — simpler, no apex-record surgery required. The apex (`specmate.io`) intentionally still serves Hostinger's own page (confirmed acceptable, not redirected).

`specmate-api`'s ingress was **flipped from internal-only to external** (`infra/main.bicep`'s `apiApp.properties.configuration.ingress.external`) specifically so Atlassian's and GitHub's connector OAuth apps can call `/connectors/{tool}/oauth/callback` directly, server-to-server — these providers call the callback URL themselves; it can't be proxied through `apps/web` the way `/oauth/start` is (`apps/web/src/lib/oauth-start-proxy.ts`), since that would require inventing a stateful callback-forwarding mechanism instead of a simple redirect. `apps/web`'s own server-to-server calls to `apps/api` still use the internal Container Apps FQDN (not the public `api.specmate.io` domain) — no reason to route that traffic over the public internet just because the ingress _can_ now accept it, and the browser is still never handed `apps/api`'s URL directly regardless of ingress reachability.

### How it was actually done (imperative CLI, not a single Bicep deploy)

Azure's custom-domain + Managed Certificate flow has a strict order that doesn't fit Bicep's declarative model cleanly (a Bicep `managedCertificates` resource attempt was tried first and reverted — see git history — after hitting `RequireCustomHostnameInEnvironment` on first apply, since the hostname has to already exist as an _unbound_ custom domain before a certificate can be created against it, and Azure auto-generates the certificate's resource name so a template can't predict it for reuse on redeploy without risking `DuplicateManagedCertificateInEnvironment`). The same 5-step sequence was run once for `specmate-web`/`www.specmate.io` and once for `specmate-api`/`api.specmate.io` (with an extra `az containerapp ingress update --type external` first for the api app, since its ingress started internal-only):

```bash
# 0. (api app only) flip ingress external first
az containerapp ingress update --name specmate-api --resource-group rg-specmate-prod --type external --target-port 8000

# 1. DNS records at Hostinger (TXT verification + CNAME), added BEFORE any of the below.
#    Substitute HOSTNAME for www.specmate.io or api.specmate.io as appropriate:
#    TXT   asuid.<HOSTNAME>  ->  <az containerapp show --query properties.customDomainVerificationId>
#      (same verification ID for both — it's per-environment, not per-app)
#    CNAME <HOSTNAME>        ->  <the app's ingress fqdn — specmate-web.<defaultDomain> or specmate-api.<defaultDomain>>
#    (verify with: dig TXT asuid.<HOSTNAME>  /  dig CNAME <HOSTNAME> — check against the zone's own
#     authoritative nameserver, e.g. `dig @<ns> ...`, if a public resolver still shows a stale cached answer)

# 2. Add the hostname, unbound
az containerapp hostname add --name <specmate-web|specmate-api> --resource-group rg-specmate-prod --hostname <HOSTNAME>

# 3. Issue the Managed Certificate (Azure auto-names it, e.g. mc-<rg>-<hostname-with-dashes>-<random>)
az containerapp env certificate create --name specmate-env --resource-group rg-specmate-prod \
  --hostname <HOSTNAME> --validation-method CNAME
# poll until Succeeded:
az containerapp env certificate list --name specmate-env --resource-group rg-specmate-prod \
  --managed-certificates-only --query "[?properties.subjectName=='<HOSTNAME>'].properties.provisioningState" -o tsv

# 4. Bind the issued cert to the hostname
CERT_ID=$(az containerapp env certificate list --name specmate-env --resource-group rg-specmate-prod \
  --managed-certificates-only --query "[?properties.subjectName=='<HOSTNAME>'].id" -o tsv)
az containerapp hostname bind --name <specmate-web|specmate-api> --resource-group rg-specmate-prod \
  --hostname <HOSTNAME> --certificate "$CERT_ID" --environment specmate-env

# 5. Point the relevant env vars at the real domain
az containerapp update --name specmate-web --resource-group rg-specmate-prod \
  --set-env-vars "NEXTAUTH_URL=https://www.specmate.io" "API_BASE_URL=https://specmate-api.<defaultDomain>"
az containerapp update --name specmate-api --resource-group rg-specmate-prod \
  --set-env-vars "WEB_BASE_URL=https://www.specmate.io" "API_BASE_URL_EXTERNAL=https://api.specmate.io"
```

`main.bicep`'s `webCustomDomain`/`apiCustomDomain` parameters (when set on a redeploy) only drive step 5's env-var wiring (`webPublicUrl`/`apiPublicUrl` → `NEXTAUTH_URL`/`WEB_BASE_URL`/`API_BASE_URL`/`API_BASE_URL_EXTERNAL`) — they deliberately do NOT create or touch the certificate/hostname binding, which stay owned by steps 2-4 above and are left alone by any Bicep redeploy. If a domain ever needs to move to a different app or be re-bound (e.g. cert renewal issues), redo steps 2-4 manually for that hostname.

Verify: `curl -v https://www.specmate.io/ 2>&1 | grep -i "subject\|issuer"` and the same for `https://api.specmate.io/health` should show certs with the matching `CN`, issued by DigiCert. `curl https://www.specmate.io/api/auth/providers` should show every OAuth provider's `signinUrl`/`callbackUrl` using `www.specmate.io`.

### Existing GitHub/Atlassian OAuth App callback URLs — updated

- **GitHub OAuth App** (Settings → Developer settings → OAuth Apps, user sign-in): Authorization callback URL → `https://www.specmate.io/api/auth/callback/github`.
- **GitHub connector OAuth App** (Issue #101, separate registration, "Connect with GitHub" in the wizard): Authorization callback URL → `https://api.specmate.io/connectors/github/oauth/callback`.
- **Atlassian OAuth App** (developer.atlassian.com/console/myapps): callback URL → `https://api.specmate.io/connectors/jira/oauth/callback` (this is `API_BASE_URL_EXTERNAL` + the fixed callback path from `jira_oauth.py`).

## Federated credentials for GitHub Actions (OIDC, no client secret)

After the Managed Identity (`containerAppIdentity` in main.bicep) is created, configure a federated credential so GitHub Actions can authenticate without a stored secret:

```bash
az identity federated-credential create \
  --name github-actions-main \
  --identity-name specmate-staging-identity \
  --resource-group specmate-staging-rg \
  --issuer https://token.actions.githubusercontent.com \
  --subject repo:nexgen-tech-labs/specmate.io:ref:refs/heads/main \
  --audience api://AzureADTokenExchange
```

Then set these as GitHub Actions repo/environment **variables** (not secrets — they're not sensitive):

- `AZURE_CLIENT_ID` — the Managed Identity's client ID
- `AZURE_TENANT_ID`
- `AZURE_SUBSCRIPTION_ID`
- `ACR_NAME`
- `AZURE_RESOURCE_GROUP`
- `CONTAINERAPPS_ENVIRONMENT`
- `KEY_VAULT_NAME` — used by the deploy job to fetch the Postgres admin password at migration time (see below)

Grant the identity `AcrPush` on the registry, `Container Apps Contributor` on the resource group, `Key Vault Secrets User` on the Key Vault (to read the DB password at deploy time), and `Reader` on the resource group (to look up the Postgres server's FQDN at deploy time — read-only, no secret access).

## Secrets

Runtime secrets (`DATABASE_URL`, `ANTHROPIC_API_KEY`, `NEXTAUTH_SECRET`, Postgres admin password, `AZURE_STORAGE_CONNECTION_STRING`) go into **Azure Key Vault**, referenced from Container App secrets — never into Bicep parameters files or GitHub Actions secrets in plaintext.

## Database migrations in CI/CD

`deploy.yml`'s `deploy-production` job runs `prisma migrate deploy` against the real production database **before** updating the Container Apps' image — schema changes land first, so a newly-deployed revision never queries a table/column that doesn't exist yet. The connection string is assembled at deploy time from Key Vault (`POSTGRES-ADMIN-PASSWORD`) and a live lookup of the Postgres server's FQDN — it is never stored as a GitHub secret or repo variable. This step was added after a real incident where the production database had never been migrated at all (18 migrations pending, `P2021: table does not exist` on every query) despite the app being deployed and "working" — the deploy pipeline only pushed code, it never touched schema, and nothing caught the mismatch until first real traffic hit it.

## Local dev: file uploads

Uploaded Source files (Issue #7) need a Blob-compatible endpoint locally. Run the **Azurite** emulator rather than a real Storage Account:

```bash
docker run -p 10000:10000 mcr.microsoft.com/azure-storage/azurite
```

Point `apps/web/.env`'s `AZURE_STORAGE_CONNECTION_STRING` at Azurite's well-known dev connection string (already set in that file for local dev).
