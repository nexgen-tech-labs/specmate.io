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

## Custom domain (specmate.io)

`specmate-web`'s custom domain binding is a **two-phase rollout** because Azure requires DNS proof-of-ownership (a TXT record) to exist _before_ it will issue the Managed Certificate that `webCustomDomain` binds — you can't do both in one deployment.

`specmate-api` has no equivalent: its ingress is internal-only (no VNet/private DNS zone provisioned for this environment), so Azure custom-domain binding doesn't apply there. `api.specmate.io` below is DNS-only — a purely cosmetic CNAME that nothing ever resolves or routes through; `WEB_BASE_URL`/`API_BASE_URL_EXTERNAL`-style config always uses the real internal `*.azurecontainerapps.io` FQDN regardless.

### Phase 1 — deploy without the custom domain (already done)

```bash
az deployment group create \
  --resource-group rg-specmate-prod \
  --template-file infra/main.bicep \
  --parameters environmentName=production postgresAdminLogin=<login> postgresAdminPassword=<password>
```

Get the verification ID for the TXT record:

```bash
az deployment group show --resource-group rg-specmate-prod --name main --query "properties.outputs.webCustomDomainVerificationId.value" -o tsv
# or, if the app already exists independent of this deployment name:
az containerapp show --name specmate-web --resource-group rg-specmate-prod --query "properties.customDomainVerificationId" -o tsv
```

### DNS records to add at Hostinger

| Type  | Host/Name                                                                   | Value                                                                                                                         | Purpose                                                                                      |
| ----- | --------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------- |
| TXT   | `asuid.specmate.io` (or `asuid` if Hostinger wants just the subdomain part) | the `webCustomDomainVerificationId` value above                                                                               | Proves ownership to Azure before it will issue the cert                                      |
| CNAME | `specmate.io` (apex — see note below)                                       | `specmate-web.<containerAppsEnv defaultDomain>` (e.g. `specmate-web.delightfuldune-a8032f46.centralus.azurecontainerapps.io`) | Routes traffic to the Container App                                                          |
| CNAME | `api.specmate.io`                                                           | `specmate-api.internal.<containerAppsEnv defaultDomain>`                                                                      | Cosmetic only — not publicly routable, apps/api has no external ingress; safe to add or skip |

**Apex domain (`specmate.io` with no subdomain) can't take a CNAME per the DNS spec.** Hostinger's panel usually offers an "ALIAS" or "CNAME flattening" record type for the apex that behaves like a CNAME — use that if available. If Hostinger only supports true CNAME at the apex indirectly via their own forwarding feature, or you'd rather avoid the apex-CNAME question entirely, use `www.specmate.io` as the bound custom domain instead (change `webCustomDomain` accordingly) and set up a simple domain forward from the apex to `www` in Hostinger's panel — that's supported everywhere with no DNS-spec workaround needed.

Wait for DNS propagation (`dig TXT asuid.specmate.io` and `dig CNAME specmate.io` should return the values above — can take minutes to a few hours) before phase 2.

### Phase 2 — bind the domain + issue the certificate

```bash
az deployment group create \
  --resource-group rg-specmate-prod \
  --template-file infra/main.bicep \
  --parameters environmentName=production postgresAdminLogin=<login> postgresAdminPassword=<password> webCustomDomain=specmate.io
```

This creates the Managed Certificate (`webCertificate` in main.bicep) and binds it to `specmate-web`'s ingress. `NEXTAUTH_URL` and `WEB_BASE_URL` (on both apps) automatically switch from the default `*.azurecontainerapps.io` FQDN to `https://specmate.io` in this same deployment — no separate step needed. `deploy.yml`'s subsequent deploys don't need `webCustomDomain` passed again as long as the Bicep template isn't the thing doing routine deploys (it isn't — `deploy.yml` uses `az containerapp update --image ...` directly, not a full Bicep redeploy); re-run this `az deployment group create` command only if you need to change domain-related config again.

Verify: `curl -I https://specmate.io` should return a valid TLS response (no cert warning) once the Managed Certificate finishes issuing (can take several more minutes after binding).

### Existing GitHub/Atlassian OAuth App callback URLs

Once `specmate.io` is live, update the callback/redirect URLs registered with each OAuth provider to match (they were previously pointed at the `*.azurecontainerapps.io` FQDN, if set at all):

- **GitHub OAuth App** (Settings → Developer settings → OAuth Apps): Authorization callback URL → `https://specmate.io/api/auth/callback/github` (Auth.js login) and confirm the separate connector OAuth App (Issue #101, different registration) doesn't hardcode the old FQDN anywhere either.
- **Atlassian OAuth App** (developer.atlassian.com/console/myapps): callback URL is `apps/api`'s `/connectors/jira/oauth/callback`, reachable via `API_BASE_URL_EXTERNAL` — this is a **separate, still-unresolved** question (see `apps/api/.env.example`'s `API_BASE_URL_EXTERNAL` comment) about whether `specmate-api`'s ingress needs to go external or the callback needs to route through `apps/web`'s proxy; the `specmate.io` domain work here doesn't resolve it.

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
