CREATE TABLE IF NOT EXISTS settings (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

INSERT INTO settings (key, value) VALUES
  ('scan_window_days', '14'),
  ('min_age_hours', '1'),
  ('frozen', 'true')  -- bot starts OFF; team configures channels first
ON CONFLICT (key) DO NOTHING;

CREATE TABLE IF NOT EXISTS ignore_list (
  id SERIAL PRIMARY KEY,
  kind TEXT NOT NULL CHECK (kind IN ('person')),
  label TEXT, -- display name
  nav_ident TEXT, -- Team Catalog identity
  email TEXT NOT NULL, -- resolved to a Slack user via users.lookupByEmail
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Team Catalog groups (team / cluster / productarea) whose members count as
-- team. Members are resolved live each scan: group -> member emails -> Slack.
CREATE TABLE IF NOT EXISTS groups (
  id TEXT NOT NULL, -- Team Catalog UUID
  kind TEXT NOT NULL CHECK (kind IN ('team', 'cluster', 'productarea')),
  label TEXT NOT NULL,
  PRIMARY KEY (id, kind)
);

CREATE TABLE IF NOT EXISTS nag_log (
  message_ts TEXT PRIMARY KEY, -- Slack message timestamp, unique per channel in practice
  channel_id TEXT NOT NULL,
  last_nagged_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
