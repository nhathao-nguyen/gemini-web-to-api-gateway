-- Gemini Web-to-API Gateway PostgreSQL Production Schema
-- Compatible with PostgreSQL 14+

CREATE TABLE IF NOT EXISTS accounts (
    id VARCHAR(64) PRIMARY KEY,
    name VARCHAR(255) NOT NULL,
    email_label VARCHAR(255) NOT NULL,
    encrypted_cookie TEXT NOT NULL,
    auth_user VARCHAR(32) NOT NULL DEFAULT '0',
    status VARCHAR(32) NOT NULL DEFAULT 'ACTIVE',
    priority INT NOT NULL DEFAULT 10,
    weight INT NOT NULL DEFAULT 1,
    supported_models JSONB NOT NULL DEFAULT '[]',
    proxy_url TEXT,
    profile_dir TEXT,
    user_agent TEXT,
    locale VARCHAR(32) DEFAULT 'en-US',
    timezone VARCHAR(64) DEFAULT 'America/New_York',
    last_keepalive_at TIMESTAMPTZ,
    keepalive_status VARCHAR(32) NOT NULL DEFAULT 'IDLE',
    last_success_at TIMESTAMPTZ,
    last_error_at TIMESTAMPTZ,
    last_error TEXT,
    cooldown_until TIMESTAMPTZ,
    consecutive_errors INT NOT NULL DEFAULT 0,
    request_count BIGINT NOT NULL DEFAULT 0,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_accounts_status ON accounts(status);
CREATE INDEX IF NOT EXISTS idx_accounts_cooldown ON accounts(cooldown_until);
CREATE INDEX IF NOT EXISTS idx_accounts_keepalive ON accounts(keepalive_status);

CREATE TABLE IF NOT EXISTS api_keys (
    id VARCHAR(64) PRIMARY KEY,
    name VARCHAR(255) NOT NULL,
    key_prefix VARCHAR(32) NOT NULL,
    key_hash VARCHAR(128) NOT NULL UNIQUE,
    enabled BOOLEAN NOT NULL DEFAULT TRUE,
    allowed_models JSONB NOT NULL DEFAULT '[]',
    rpm_limit INT NOT NULL DEFAULT 60,
    concurrent_limit INT NOT NULL DEFAULT 5,
    daily_request_limit INT NOT NULL DEFAULT 5000,
    expires_at TIMESTAMPTZ,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    last_used_at TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS idx_api_keys_prefix ON api_keys(key_prefix);
CREATE INDEX IF NOT EXISTS idx_api_keys_hash ON api_keys(key_hash);

CREATE TABLE IF NOT EXISTS request_logs (
    request_id VARCHAR(64) PRIMARY KEY,
    api_key_id VARCHAR(64),
    account_id VARCHAR(64),
    model VARCHAR(64) NOT NULL,
    status INT NOT NULL,
    latency_ms INT NOT NULL,
    error_code VARCHAR(64),
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_request_logs_created ON request_logs(created_at);
CREATE INDEX IF NOT EXISTS idx_request_logs_api_key ON request_logs(api_key_id);
CREATE INDEX IF NOT EXISTS idx_request_logs_account ON request_logs(account_id);

CREATE TABLE IF NOT EXISTS account_events (
    id VARCHAR(64) PRIMARY KEY,
    account_id VARCHAR(64) NOT NULL,
    event_type VARCHAR(64) NOT NULL,
    from_status VARCHAR(32),
    to_status VARCHAR(32) NOT NULL,
    reason TEXT NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_account_events_account ON account_events(account_id);

CREATE TABLE IF NOT EXISTS settings (
    key VARCHAR(64) PRIMARY KEY,
    value JSONB NOT NULL,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS conversations (
    id VARCHAR(64) PRIMARY KEY,
    title VARCHAR(255) NOT NULL DEFAULT 'New Conversation',
    model VARCHAR(64) NOT NULL,
    account_id VARCHAR(64) NOT NULL,
    upstream_cid VARCHAR(128),
    upstream_rid VARCHAR(128),
    upstream_rcid VARCHAR(128),
    api_key_id VARCHAR(64),
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_conversations_api_key ON conversations(api_key_id);
CREATE INDEX IF NOT EXISTS idx_conversations_account ON conversations(account_id);

CREATE TABLE IF NOT EXISTS messages (
    id VARCHAR(64) PRIMARY KEY,
    conversation_id VARCHAR(64) NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
    role VARCHAR(32) NOT NULL,
    content TEXT NOT NULL,
    reasoning_content TEXT,
    attachments JSONB NOT NULL DEFAULT '[]',
    generated_media JSONB NOT NULL DEFAULT '[]',
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_messages_conv ON messages(conversation_id);

CREATE TABLE IF NOT EXISTS media_cache (
    id VARCHAR(64) PRIMARY KEY,
    account_id VARCHAR(64) NOT NULL,
    upstream_url TEXT NOT NULL,
    mime_type VARCHAR(64) NOT NULL DEFAULT 'image/png',
    file_name VARCHAR(255) NOT NULL DEFAULT 'image.png',
    data_b64 TEXT NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_media_cache_account ON media_cache(account_id);

