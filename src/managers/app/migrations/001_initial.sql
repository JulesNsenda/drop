-- Migration 001: Initial Schema
-- DROP internal database schema

-- Applications table
CREATE TABLE IF NOT EXISTS apps (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name VARCHAR(255) NOT NULL UNIQUE,
  type VARCHAR(50) NOT NULL,
  framework VARCHAR(100),
  status VARCHAR(50) DEFAULT 'stopped',
  port INTEGER,
  hostname VARCHAR(255),
  path TEXT NOT NULL,
  config JSONB DEFAULT '{}',
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_apps_name ON apps(name);
CREATE INDEX IF NOT EXISTS idx_apps_status ON apps(status);
CREATE INDEX IF NOT EXISTS idx_apps_hostname ON apps(hostname);
CREATE INDEX IF NOT EXISTS idx_apps_type ON apps(type);

-- Domains table
CREATE TABLE IF NOT EXISTS domains (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  hostname VARCHAR(255) NOT NULL UNIQUE,
  app_id UUID REFERENCES apps(id) ON DELETE CASCADE,
  ssl_enabled BOOLEAN DEFAULT true,
  ssl_certificate TEXT,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_domains_app_id ON domains(app_id);
CREATE INDEX IF NOT EXISTS idx_domains_hostname ON domains(hostname);

-- Environment variables (encrypted values)
CREATE TABLE IF NOT EXISTS env_vars (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  app_id UUID REFERENCES apps(id) ON DELETE CASCADE,
  key VARCHAR(255) NOT NULL,
  value TEXT NOT NULL,
  encrypted BOOLEAN DEFAULT false,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE(app_id, key)
);

CREATE INDEX IF NOT EXISTS idx_env_vars_app_id ON env_vars(app_id);

-- Deployments history
CREATE TABLE IF NOT EXISTS deployments (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  app_id UUID REFERENCES apps(id) ON DELETE CASCADE,
  version VARCHAR(100),
  status VARCHAR(50) DEFAULT 'pending',
  started_at TIMESTAMPTZ DEFAULT NOW(),
  completed_at TIMESTAMPTZ,
  duration_ms INTEGER,
  build_logs TEXT,
  error TEXT
);

CREATE INDEX IF NOT EXISTS idx_deployments_app_id ON deployments(app_id);
CREATE INDEX IF NOT EXISTS idx_deployments_status ON deployments(status);
CREATE INDEX IF NOT EXISTS idx_deployments_started_at ON deployments(started_at DESC);

-- Platform configuration
CREATE TABLE IF NOT EXISTS platform_config (
  key VARCHAR(255) PRIMARY KEY,
  value JSONB NOT NULL,
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- Migrations tracking table
CREATE TABLE IF NOT EXISTS migrations (
  id SERIAL PRIMARY KEY,
  name VARCHAR(255) NOT NULL UNIQUE,
  applied_at TIMESTAMPTZ DEFAULT NOW()
);

-- Function to update updated_at timestamp
CREATE OR REPLACE FUNCTION update_updated_at()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = NOW();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- Trigger for apps updated_at
DROP TRIGGER IF EXISTS apps_updated_at ON apps;
CREATE TRIGGER apps_updated_at
  BEFORE UPDATE ON apps
  FOR EACH ROW EXECUTE FUNCTION update_updated_at();

-- Trigger for platform_config updated_at
DROP TRIGGER IF EXISTS platform_config_updated_at ON platform_config;
CREATE TRIGGER platform_config_updated_at
  BEFORE UPDATE ON platform_config
  FOR EACH ROW EXECUTE FUNCTION update_updated_at();
