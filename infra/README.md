# Infrastructure (Azure)

Bicep templates defining SpecMate's Azure footprint: Container Apps (web + api), Azure Postgres Flexible Server, Container Registry, Key Vault, Log Analytics, a Blob Storage account (uploaded Source files), and a user-assigned Managed Identity for the Container Apps.

**Nothing here is deployed automatically.** These files are scaffolding only — run deployments interactively so you can review cost/impact before anything is provisioned.

## First-time setup (run manually, with the user present)

```bash
az login
az group create --name specmate-staging-rg --location <region>

az deployment group create \
  --resource-group specmate-staging-rg \
  --template-file infra/main.bicep \
  --parameters environmentName=staging postgresAdminLogin=<login> postgresAdminPassword=<generate-a-strong-password>
```

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

Grant the identity `AcrPush` on the registry and `Container Apps Contributor` on the resource group.

## Secrets

Runtime secrets (`DATABASE_URL`, `ANTHROPIC_API_KEY`, `NEXTAUTH_SECRET`, Postgres admin password, `AZURE_STORAGE_CONNECTION_STRING`) go into **Azure Key Vault**, referenced from Container App secrets — never into Bicep parameters files or GitHub Actions secrets in plaintext.

## Local dev: file uploads

Uploaded Source files (Issue #7) need a Blob-compatible endpoint locally. Run the **Azurite** emulator rather than a real Storage Account:

```bash
docker run -p 10000:10000 mcr.microsoft.com/azure-storage/azurite
```

Point `apps/web/.env`'s `AZURE_STORAGE_CONNECTION_STRING` at Azurite's well-known dev connection string (already set in that file for local dev).
