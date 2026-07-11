from pydantic_settings import BaseSettings, SettingsConfigDict


class Settings(BaseSettings):
    model_config = SettingsConfigDict(env_file=".env", extra="ignore")

    database_url: str = "postgresql+asyncpg://postgres:postgres@localhost:5434/specmate"
    anthropic_api_key: str = ""
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
    github_token: str = ""
    slack_bot_token: str = ""
    # Duplicate-detection default similarity threshold (Issue 3.5); Workspace.duplicateThreshold overrides.
    duplicate_similarity_threshold: float = 0.55


settings = Settings()
