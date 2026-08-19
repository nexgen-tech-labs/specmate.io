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

## Custom domain (www.specmate.io) — LIVE

`https://www.specmate.io` is bound and serving production traffic (verified: valid DigiCert-issued cert via `curl -v`, `NEXTAUTH_URL`/`WEB_BASE_URL` both set). Bound to `www`, not the bare `specmate.io` apex — Hostinger had a pre-existing A record (their default parking page) at the apex, which conflicts with the ALIAS/CNAME-flattening record Azure's custom domain needs there (`RRset specmate.io IN ALIAS must not be used with A on the same name`). Rather than delete Hostinger's apex record, `www` was used instead — simpler, no apex-record surgery required. The apex (`specmate.io`) currently still serves Hostinger's own page; if you want it to redirect to `www.specmate.io`, set that up as a domain forward in Hostinger's panel (unrelated to anything in this repo).

`specmate-api` has no custom domain: its ingress is internal-only (no VNet/private DNS zone provisioned for this environment), so Azure custom-domain binding doesn't apply there. `WEB_BASE_URL`/`API_BASE_URL_EXTERNAL`-style config always uses the real internal `*.azurecontainerapps.io` FQDN.

### How it was actually done (imperative CLI, not a single Bicep deploy)

Azure's custom-domain + Managed Certificate flow has a strict order that doesn't fit Bicep's declarative model cleanly (a Bicep `managedCertificates` resource attempt was tried first and reverted — see git history — after hitting `RequireCustomHostnameInEnvironment` on first apply, since the hostname has to already exist as an _unbound_ custom domain before a certificate can be created against it, and Azure auto-generates the certificate's resource name so a template can't predict it for reuse on redeploy without risking `DuplicateManagedCertificateInEnvironment`):

```bash
# 1. DNS records at Hostinger (TXT verification + CNAME), added BEFORE any of the below:
#    TXT   asuid.www.specmate.io  ->  <az containerapp show --query properties.customDomainVerificationId>
#    CNAME www.specmate.io        ->  specmate-web.<containerAppsEnv defaultDomain>
#    (verify with: dig TXT asuid.www.specmate.io  /  dig CNAME www.specmate.io — check against
#     the zone's own authoritative nameserver, e.g. `dig @<ns> ...`, if a public resolver still
#     shows a stale cached answer)

# 2. Add the hostname, unbound
az containerapp hostname add --name specmate-web --resource-group rg-specmate-prod --hostname www.specmate.io

# 3. Issue the Managed Certificate (Azure auto-names it, e.g. mc-<rg>-www-specmate-io-<random>)
az containerapp env certificate create --name specmate-env --resource-group rg-specmate-prod \
  --hostname www.specmate.io --validation-method CNAME
# poll until Succeeded:
az containerapp env certificate list --name specmate-env --resource-group rg-specmate-prod \
  --managed-certificates-only --query "[?properties.subjectName=='www.specmate.io'].properties.provisioningState" -o tsv

# 4. Bind the issued cert to the hostname
CERT_ID=$(az containerapp env certificate list --name specmate-env --resource-group rg-specmate-prod \
  --managed-certificates-only --query "[?properties.subjectName=='www.specmate.io'].id" -o tsv)
az containerapp hostname bind --name specmate-web --resource-group rg-specmate-prod \
  --hostname www.specmate.io --certificate "$CERT_ID" --environment specmate-env

# 5. Point NEXTAUTH_URL / WEB_BASE_URL at the real domain
az containerapp update --name specmate-web --resource-group rg-specmate-prod \
  --set-env-vars "NEXTAUTH_URL=https://www.specmate.io"
az containerapp update --name specmate-api --resource-group rg-specmate-prod \
  --set-env-vars "WEB_BASE_URL=https://www.specmate.io"
```

`main.bicep`'s `webCustomDomain` parameter (when set to `www.specmate.io` on a redeploy) only drives step 5 (`webPublicUrl` → `NEXTAUTH_URL`/`WEB_BASE_URL`) — it deliberately does NOT create or touch the certificate/hostname binding, which stay owned by steps 2-4 above and are left alone by any Bicep redeploy. If the domain ever needs to move to a different app or be re-bound (e.g. cert renewal issues), redo steps 2-4 manually.

Verify: `curl -v https://www.specmate.io/ 2>&1 | grep -i "subject\|issuer"` should show a cert with `CN=www.specmate.io` issued by DigiCert, and `curl https://www.specmate.io/api/auth/providers` should show every OAuth provider's `signinUrl`/`callbackUrl` using `www.specmate.io`, not the old `*.azurecontainerapps.io` FQDN.

### Existing GitHub/Atlassian OAuth App callback URLs

- **GitHub OAuth App** (Settings → Developer settings → OAuth Apps): Authorization callback URL → `https://www.specmate.io/api/auth/callback/github` (Auth.js login) and confirm the separate connector OAuth App (Issue #101, different registration) doesn't hardcode the old FQDN anywhere either.
- **Atlassian OAuth App** (developer.atlassian.com/console/myapps): callback URL is `apps/api`'s `/connectors/jira/oauth/callback`, reachable via `API_BASE_URL_EXTERNAL` — this is a **separate, still-unresolved** question (see `apps/api/.env.example`'s `API_BASE_URL_EXTERNAL` comment) about whether `specmate-api`'s ingress needs to go external or the callback needs to route through `apps/web`'s proxy; the domain work here doesn't resolve it.

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
