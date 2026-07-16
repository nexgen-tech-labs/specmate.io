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
var apiStaticEnvVars = [
  { name: 'ENVIRONMENT', value: environmentName }
  { name: 'AZURE_STORAGE_CONTAINER', value: 'sources' }
  { name: 'STRIPE_USAGE_EVENT_NAME', value: 'published_item' }
]

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
              { name: 'NEXTAUTH_URL', value: 'https://${resourceName}-web.${containerAppsEnv.properties.defaultDomain}' }
              { name: 'API_BASE_URL', value: 'https://${resourceName}-api.internal.${containerAppsEnv.properties.defaultDomain}' }
            ],
            webStaticEnvVars,
            webSecretEnvVars
          )
        }
      ]
      scale: { minReplicas: 0, maxReplicas: 3 }
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
        external: false
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
      scale: { minReplicas: 0, maxReplicas: 3 }
    }
  }
}

output acrLoginServer string = acr.properties.loginServer
output postgresFqdn string = postgres.properties.fullyQualifiedDomainName
output containerAppIdentityId string = containerAppIdentity.id
output webAppFqdn string = webApp.properties.configuration.ingress.fqdn
output storageAccountName string = storageAccount.name
