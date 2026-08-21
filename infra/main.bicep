// SpecMate Azure infrastructure.
// This defines the target-state resources for staging/production. It is NOT deployed
// automatically — run `az deployment group create` manually/interactively (see README.md
// in this directory) since it provisions billable resources on the Azure account.

@description('Short name used as a prefix for all resources, e.g. "specmate"')
param namePrefix string = 'specmate'

@description('Deployment environment: staging or production')
@allowed(['staging', 'production'])
param environmentName string = 'staging'

@description('Azure region for all resources')
param location string = resourceGroup().location

@description('Postgres administrator login')
param postgresAdminLogin string

@secure()
@description('Postgres administrator password — pass via --parameters at deploy time, never commit')
param postgresAdminPassword string

@description('''
Custom domain for the web app (e.g. www.specmate.io). Leave empty on first
deploy — Azure requires the domain to be DNS-verified (TXT record for
customDomainVerificationId, then CNAME to the default *.azurecontainerapps.io
FQDN) *before* a Managed Certificate can be issued and bound, and Azure also
requires the hostname to exist as an unbound custom domain before the
certificate can be created against it — so this parameter only drives the
webPublicUrl env-var wiring (NEXTAUTH_URL/WEB_BASE_URL); the actual hostname
add / certificate issue / certificate bind sequence is run manually via the
CLI (not modeled as a Bicep resource — see infra/README.md for why and for
the exact commands actually run for both webApp and apiApp).
''')
param webCustomDomain string = ''

@description('''
Custom domain for the api app (e.g. api.specmate.io). apiApp's ingress is
external (flipped from internal-only — see infra/README.md for why: Atlassian
and GitHub's connector OAuth apps call this API's /oauth/callback endpoint
directly server-to-server, which requires a public URL). Same manual
hostname-add/cert-issue/cert-bind sequence as webCustomDomain; this parameter
only drives apiExternalUrl (API_BASE_URL_EXTERNAL).
''')
param apiCustomDomain string = ''

var suffix = environmentName == 'production' ? '' : '-${environmentName}'
var resourceName = '${namePrefix}${suffix}'

resource logAnalytics 'Microsoft.OperationalInsights/workspaces@2023-09-01' = {
  name: '${resourceName}-logs'
  location: location
  properties: {
    sku: { name: 'PerGB2018' }
  }
}

resource containerAppsEnv 'Microsoft.App/managedEnvironments@2024-03-01' = {
  name: '${resourceName}-env'
  location: location
  properties: {
    appLogsConfiguration: {
      destination: 'log-analytics'
      logAnalyticsConfiguration: {
        customerId: logAnalytics.properties.customerId
        sharedKey: logAnalytics.listKeys().primarySharedKey
      }
    }
  }
}

resource acr 'Microsoft.ContainerRegistry/registries@2023-11-01-preview' = {
  name: replace('${resourceName}acr', '-', '')
  location: location
  sku: { name: 'Basic' }
  properties: {
    adminUserEnabled: false
  }
}

resource keyVault 'Microsoft.KeyVault/vaults@2023-07-01' = {
  name: '${resourceName}-kv'
  location: location
  properties: {
    sku: { family: 'A', name: 'standard' }
    tenantId: subscription().tenantId
    enableRbacAuthorization: true
  }
}

resource postgres 'Microsoft.DBforPostgreSQL/flexibleServers@2023-06-01-preview' = {
  name: '${resourceName}-pg'
  location: location
  sku: {
    name: 'Standard_B1ms'
    tier: 'Burstable'
  }
  properties: {
    administratorLogin: postgresAdminLogin
    administratorLoginPassword: postgresAdminPassword
    version: '16'
    storage: { storageSizeGB: 32 }
    backup: { backupRetentionDays: 7 }
  }
}

resource containerAppIdentity 'Microsoft.ManagedIdentity/userAssignedIdentities@2023-01-31' = {
  name: '${resourceName}-identity'
  location: location
}

// Blob storage for uploaded Source files (Issue #7). Blob-only StorageV2, cheapest redundancy
// tier — fine for early-stage document uploads, revisit if durability requirements change.
resource storageAccount 'Microsoft.Storage/storageAccounts@2023-01-01' = {
  name: replace('${resourceName}st', '-', '')
  location: location
  kind: 'StorageV2'
  sku: { name: 'Standard_LRS' }
  properties: {
    minimumTlsVersion: 'TLS1_2'
    allowBlobPublicAccess: false
  }
}

resource blobService 'Microsoft.Storage/storageAccounts/blobServices@2023-01-01' = {
  parent: storageAccount
  name: 'default'
}

resource sourcesContainer 'Microsoft.Storage/storageAccounts/blobServices/containers@2023-01-01' = {
  parent: blobService
  name: 'sources'
  properties: {
    publicAccess: 'None'
  }
}

// Secret name -> Key Vault secret name, for apps/web (matches apps/web/.env.example).
// Values live in Key Vault only; this just maps container-app secret names to them.
var webKeyVaultSecrets = [
  { secretRef: 'database-url', kvSecretName: 'DATABASE-URL-WEB' }
  { secretRef: 'nextauth-secret', kvSecretName: 'NEXTAUTH-SECRET' }
  { secretRef: 'azure-storage-connection-string', kvSecretName: 'AZURE-STORAGE-CONNECTION-STRING' }
  { secretRef: 'stripe-secret-key', kvSecretName: 'STRIPE-SECRET-KEY' }
  { secretRef: 'stripe-webhook-secret', kvSecretName: 'STRIPE-WEBHOOK-SECRET' }
  { secretRef: 'stripe-starter-price-id', kvSecretName: 'STRIPE-STARTER-PRICE-ID' }
  { secretRef: 'stripe-starter-overage-price-id', kvSecretName: 'STRIPE-STARTER-OVERAGE-PRICE-ID' }
  { secretRef: 'atlassian-connect-app-key', kvSecretName: 'ATLASSIAN-CONNECT-APP-KEY' }
]

// Same, for apps/api (matches apps/api/.env.example).
var apiKeyVaultSecrets = [
  { secretRef: 'database-url', kvSecretName: 'DATABASE-URL-API' }
  { secretRef: 'anthropic-api-key', kvSecretName: 'ANTHROPIC-API-KEY' }
  { secretRef: 'azure-storage-connection-string', kvSecretName: 'AZURE-STORAGE-CONNECTION-STRING' }
  { secretRef: 'atlassian-email', kvSecretName: 'ATLASSIAN-EMAIL' }
  { secretRef: 'atlassian-api-token', kvSecretName: 'ATLASSIAN-API-TOKEN' }
  { secretRef: 'jira-base-url', kvSecretName: 'JIRA-BASE-URL' }
  { secretRef: 'confluence-base-url', kvSecretName: 'CONFLUENCE-BASE-URL' }
  { secretRef: 'ado-org-url', kvSecretName: 'ADO-ORG-URL' }
  { secretRef: 'ado-pat', kvSecretName: 'ADO-PAT' }
  { secretRef: 'azure-ad-client-id', kvSecretName: 'AZURE-AD-CLIENT-ID' }
  { secretRef: 'azure-ad-client-secret', kvSecretName: 'AZURE-AD-CLIENT-SECRET' }
  { secretRef: 'azure-ad-tenant-id', kvSecretName: 'AZURE-AD-TENANT-ID' }
  { secretRef: 'github-token', kvSecretName: 'GITHUB-TOKEN' }
  { secretRef: 'slack-bot-token', kvSecretName: 'SLACK-BOT-TOKEN' }
  { secretRef: 'stripe-secret-key', kvSecretName: 'STRIPE-SECRET-KEY' }
]

// Precomputed env-var arrays (secretRef-backed) — kept as separate vars because
// Bicep for-expressions can't be nested inside concat() inline in a resource body.
var webSecretEnvVars = [
  for s in webKeyVaultSecrets: {
    name: toUpper(replace(s.secretRef, '-', '_'))
    secretRef: s.secretRef
  }
]
var webStaticEnvVars = [
  { name: 'AZURE_STORAGE_CONTAINER', value: 'sources' }
]
var apiSecretEnvVars = [
  for s in apiKeyVaultSecrets: {
    name: toUpper(replace(s.secretRef, '-', '_'))
    secretRef: s.secretRef
  }
]
// Effective public hostnames: the custom domain once bound, else the default
// *.azurecontainerapps.io FQDN. apiApp's ingress is external (not internal —
// see apiCustomDomain's description above), so apps/web's server-to-server
// calls to it now use the same FQDN a browser would reach it at; there is no
// separate "internal" hostname anymore (Container Apps environments don't
// expose a distinct internal-only FQDN once ingress is external — the plain
// FQDN is reachable both from other apps in the environment and publicly).
var webPublicUrl = empty(webCustomDomain)
  ? 'https://${resourceName}-web.${containerAppsEnv.properties.defaultDomain}'
  : 'https://${webCustomDomain}'
var apiPublicUrl = empty(apiCustomDomain)
  ? 'https://${resourceName}-api.${containerAppsEnv.properties.defaultDomain}'
  : 'https://${apiCustomDomain}'

var apiStaticEnvVars = [
  { name: 'ENVIRONMENT', value: environmentName }
  { name: 'AZURE_STORAGE_CONTAINER', value: 'sources' }
  { name: 'STRIPE_USAGE_EVENT_NAME', value: 'published_item' }
  // Closes a pre-existing gap: apps/api's Settings.web_base_url (used to build
  // OAuth-callback redirect targets back into the wizard UI) had no Bicep env
  // var wiring at all before this, so it silently fell back to its
  // http://localhost:3000 default in every real deployment.
  { name: 'WEB_BASE_URL', value: webPublicUrl }
  // Atlassian (and the GitHub connector OAuth app) call this API's
  // /connectors/{tool}/oauth/callback endpoint directly, server-to-server —
  // needs apiApp's real externally-reachable URL, not apps/web's.
  { name: 'API_BASE_URL_EXTERNAL', value: apiPublicUrl }
]

// Custom domain binding is NOT modeled as a Bicep resource here, despite an
// earlier attempt to do so. Azure requires a strict imperative order this
// declarative template can't express cleanly:
//   1. az containerapp hostname add (adds the hostname UNBOUND — Azure
//      rejects `managedCertificates` creation with RequireCustomHostnameInEnvironment
//      if the hostname isn't already added to an app first)
//   2. az containerapp env certificate create (issues the Managed
//      Certificate — Azure auto-generates its resource name, e.g.
//      mc-<rg>-<domain-with-dashes>-<random suffix>; NOT a name this
//      template can predict, so a Bicep resource block for it would create
//      a *second*, duplicate certificate and fail with
//      DuplicateManagedCertificateInEnvironment on any redeploy)
//   3. az containerapp hostname bind (binds the cert from step 2 to the
//      hostname from step 1)
// webCustomDomain's only remaining job in this template is to switch
// NEXTAUTH_URL/WEB_BASE_URL to the real domain once you've done the 3 steps
// above manually — see infra/README.md for the exact commands. Re-running
// this deployment after that is safe (idempotent) as long as webCustomDomain
// matches what you actually bound; it does NOT create or touch the
// certificate/binding itself.

resource webApp 'Microsoft.App/containerApps@2024-03-01' = {
  name: '${resourceName}-web'
  location: location
  identity: {
    type: 'UserAssigned'
    userAssignedIdentities: {
      '${containerAppIdentity.id}': {}
    }
  }
  properties: {
    managedEnvironmentId: containerAppsEnv.id
    configuration: {
      ingress: {
        external: true
        targetPort: 3000
        // Deliberately NOT managing customDomains here — see the comment
        // above this resource for why (Azure's imperative ordering
        // requirement for hostname-add / cert-create / cert-bind doesn't fit
        // this template's declarative model). The binding is applied via the
        // CLI steps in infra/README.md and left alone by subsequent
        // redeploys of this template.
      }
      registries: [
        {
          server: acr.properties.loginServer
          identity: containerAppIdentity.id
        }
      ]
      secrets: [
        for s in webKeyVaultSecrets: {
          name: s.secretRef
          keyVaultUrl: '${keyVault.properties.vaultUri}secrets/${s.kvSecretName}'
          identity: containerAppIdentity.id
        }
      ]
    }
    template: {
      containers: [
        {
          name: 'web'
          image: '${acr.properties.loginServer}/specmate-web:latest'
          resources: { cpu: json('0.5'), memory: '1Gi' }
          env: concat(
            [
              { name: 'NEXTAUTH_URL', value: webPublicUrl }
              { name: 'API_BASE_URL', value: apiPublicUrl }
            ],
            webStaticEnvVars,
            webSecretEnvVars
          )
        }
      ]
      // minReplicas: 0 (the original setting) caused ~90s cold starts on
      // every request after a ~5min idle period — confirmed live via Log
      // Analytics (ContainerAppSystemLogs_CL "Scaled ... from 0 to 1" events,
      // dozens/day on low traffic) and reported as "app very slow all over".
      // minReplicas: 1 keeps one warm replica running at all times — trades
      // a small continuous cost (this plan uses free credits) for
      // eliminating cold starts entirely; confirmed post-change response
      // times dropped from ~90s to ~0.35s.
      scale: { minReplicas: 1, maxReplicas: 3 }
    }
  }
}

resource apiApp 'Microsoft.App/containerApps@2024-03-01' = {
  name: '${resourceName}-api'
  location: location
  identity: {
    type: 'UserAssigned'
    userAssignedIdentities: {
      '${containerAppIdentity.id}': {}
    }
  }
  properties: {
    managedEnvironmentId: containerAppsEnv.id
    configuration: {
      ingress: {
        // Flipped from internal-only: Atlassian's and GitHub's connector
        // OAuth apps call this API's /oauth/callback endpoint directly,
        // server-to-server, which requires a public URL — see
        // infra/README.md's "Custom domain" section for the incident this
        // was found from and apiCustomDomain's description above.
        external: true
        targetPort: 8000
      }
      registries: [
        {
          server: acr.properties.loginServer
          identity: containerAppIdentity.id
        }
      ]
      secrets: [
        for s in apiKeyVaultSecrets: {
          name: s.secretRef
          keyVaultUrl: '${keyVault.properties.vaultUri}secrets/${s.kvSecretName}'
          identity: containerAppIdentity.id
        }
      ]
    }
    template: {
      containers: [
        {
          name: 'api'
          image: '${acr.properties.loginServer}/specmate-api:latest'
          resources: { cpu: json('0.5'), memory: '1Gi' }
          env: concat(apiStaticEnvVars, apiSecretEnvVars)
        }
      ]
      // minReplicas: 0 (the original setting) caused ~90s cold starts on
      // every request after a ~5min idle period — confirmed live via Log
      // Analytics (ContainerAppSystemLogs_CL "Scaled ... from 0 to 1" events,
      // dozens/day on low traffic) and reported as "app very slow all over".
      // minReplicas: 1 keeps one warm replica running at all times — trades
      // a small continuous cost (this plan uses free credits) for
      // eliminating cold starts entirely; confirmed post-change response
      // times dropped from ~90s to ~0.35s.
      scale: { minReplicas: 1, maxReplicas: 3 }
    }
  }
}

output acrLoginServer string = acr.properties.loginServer
output postgresFqdn string = postgres.properties.fullyQualifiedDomainName
output containerAppIdentityId string = containerAppIdentity.id
output webAppFqdn string = webApp.properties.configuration.ingress.fqdn
output apiAppFqdn string = apiApp.properties.configuration.ingress.fqdn
output storageAccountName string = storageAccount.name
// Phase 1: value for the DNS TXT record (asuid.<webCustomDomain>) required
// before webCustomDomain can be set on a phase-2 redeploy. See infra/README.md.
output webCustomDomainVerificationId string = webApp.properties.customDomainVerificationId
