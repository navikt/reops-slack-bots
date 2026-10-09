-- Admin access control: Team Catalog groups + individual nav-idents.
-- Separate from 001 because deployed DBs already recorded 001 as applied.
CREATE TABLE IF NOT EXISTS admin_groups (
  id TEXT NOT NULL, -- Team Catalog UUID
  kind TEXT NOT NULL CHECK (kind IN ('team', 'cluster', 'productarea')),
  label TEXT NOT NULL,
  PRIMARY KEY (id, kind)
);

CREATE TABLE IF NOT EXISTS admin_idents (
  nav_ident TEXT PRIMARY KEY,
  label TEXT, -- display name
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
