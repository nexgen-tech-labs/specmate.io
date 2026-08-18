from pydantic_settings import BaseSettings, SettingsConfigDict


class Settings(BaseSettings):
    model_config = SettingsConfigDict(env_file=".env", extra="ignore")

    database_url: str = "postgresql+asyncpg://postgres:postgres@localhost:5434/specmate"
    anthropic_api_key: str = ""
    max_concurrent_ai_calls: int = 4
    environment: str = "local"
    azure_storage_connection_string: str = ""
    azure_storage_container: str = "sources"
    # Connector credentials (Issues #12-16) — single-tenant, ops-configured via env for
    # now; a per-workspace connection store + OAuth is future work (see architecture.md).
    atlassian_email: str = ""
    atlassian_api_token: str = ""
    jira_base_url: str = ""  # e.g. https://yourorg.atlassian.net
    confluence_base_url: str = ""  # e.g. https://yourorg.atlassian.net (wiki path added by client)
    ado_org_url: str = ""  # e.g. https://dev.azure.com/yourorg
    ado_pat: str = ""
    # Azure AD app registration for ADO OAuth (Issue 6.1) — optional; when all three
    # are set, ado_auth.get_ado_connection() prefers OAuth over the PAT above.
    azure_ad_client_id: str = ""
    azure_ad_client_secret: str = ""
    azure_ad_tenant_id: str = ""
    github_token: str = ""
    slack_bot_token: str = ""
    # Duplicate-detection default similarity threshold (Issue 3.5); Workspace.duplicateThreshold overrides.
    duplicate_similarity_threshold: float = 0.55
    # Envelope encryption for per-workspace connector credentials (Issue #101).
    # AZURE_KEY_VAULT_URL is the production path — app/services/crypto.py fetches the
    # data-encryption key from this vault via DefaultAzureCredential. CONNECTOR_DEK_B64
    # is a local-dev-only override (a base64-encoded 32-byte key set directly via env)
    # that bypasses Key Vault entirely; never used in production.
    azure_key_vault_url: str = ""
    connector_dek_b64: str = ""
    # GitHub OAuth App (Issue #101) — for per-workspace delegated connector auth,
    # distinct from GITHUB_TOKEN (the existing single-tenant PAT fallback) AND
    # distinct from Issue #95's GITHUB_OAUTH_CLIENT_ID (that's for SpecMate USER
    # LOGIN via GitHub — a completely different OAuth App registration/purpose,
    # and lives in apps/web, not here).
    github_oauth_app_client_id: str = ""
    github_oauth_app_client_secret: str = ""
    # Base URL of the apps/web frontend (Issue #101) — used only to build the
    # redirect target after the GitHub OAuth callback completes, so the user
    # lands back in the wizard UI instead of seeing raw JSON. Not used for
    # anything auth-sensitive; the wizard session id embedded in the redirect
    # is validated server-side same as before.
    web_base_url: str = "http://localhost:3000"
    # Atlassian OAuth App (fast-follow to Issue #101) — for per-workspace
    # delegated Jira connector auth, distinct from JIRA_BASE_URL/
    # ATLASSIAN_EMAIL/ATLASSIAN_API_TOKEN (the existing single-tenant
    # env-configured fallback, kept unchanged). Register at
    # https://developer.atlassian.com/console/myapps/ with OAuth 2.0 (3LO),
    # scopes read:jira-work + write:jira-work + offline_access, callback URL
    # {this API's own external URL}/connectors/jira/oauth/callback.
    jira_oauth_app_client_id: str = ""
    jira_oauth_app_client_secret: str = ""
    # This API's own externally-reachable base URL (Atlassian calls the Jira
    # OAuth redirect_uri directly, unlike GitHub's OAuth flow, whose
    # redirect_uri is configured once in the GitHub OAuth App's settings and
    # never sent by SpecMate at request time). specmate-api's Container App
    # ingress is currently internal-only — see Task 3's open infrastructure
    # question about whether ingress needs to become external, or the
    # callback should route through apps/web's proxy instead, before this
    # setting's production value can be finalized.
    api_base_url_external: str = "http://localhost:8000"
    # Stripe usage-based billing (Issues 10.9/12.5). Issue #110: moved from raw
    # os.environ.get(...) reads in stripe_reporting.py to match every other
    # external credential in this codebase. stripe_usage_event_name/
    # stripe_usage_meter_id predate Issue #92 (already existed as raw env
    # reads); stripe_usage_meter_id was added by #92, extending the existing
    # inconsistency rather than introducing a new one — all three are cleaned
    # up together here rather than piecemeal.
    stripe_secret_key: str = ""
    stripe_usage_event_name: str = "published_item"
    stripe_usage_meter_id: str = ""


settings = Settings()
