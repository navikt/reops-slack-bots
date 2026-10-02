CREATE TABLE IF NOT EXISTS settings (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

INSERT INTO settings (key, value) VALUES
  ('nag_frequency_days', '7'),
  ('enabled', 'true')
ON CONFLICT (key) DO NOTHING;

CREATE TABLE IF NOT EXISTS ignore_list (
  id SERIAL PRIMARY KEY,
  slack_id TEXT NOT NULL UNIQUE, -- user ID (U...) or usergroup ID (S...)
  kind TEXT NOT NULL CHECK (kind IN ('user', 'usergroup')),
  label TEXT, -- human-readable name for display in admin UI
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS nag_log (
  message_ts TEXT PRIMARY KEY, -- Slack message timestamp, unique per channel in practice
  channel_id TEXT NOT NULL,
  last_nagged_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
