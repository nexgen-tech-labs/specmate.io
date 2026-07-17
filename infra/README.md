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
