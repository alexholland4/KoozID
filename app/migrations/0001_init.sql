-- KoozID schema v1. D1 (SQLite) is the source of truth; the vector index is derived data.
--
-- Item fields follow the collector's existing spreadsheet (Koozie ID, Date Acquired, Source,
-- Description, Size, Base, City, State, Country) so it imports and exports one-to-one.

-- One row per catalogued koozie. `id` is the permanent catalogue number, shown as K-0001. An
-- import may set it explicitly (to keep the spreadsheet's numbers); otherwise AUTOINCREMENT
-- continues after the highest number ever used and never reuses one.
CREATE TABLE items (
  id               INTEGER PRIMARY KEY AUTOINCREMENT,
  status           TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'needs_review')),
  description      TEXT NOT NULL DEFAULT '',
  size             TEXT,             -- e.g. Standard Can, Tall Can, Large Can, Standard Bottle
  base             TEXT,             -- e.g. Collapsible, Structured, Slap, Metal
  acquired_from    TEXT,             -- the spreadsheet's "Source": who gave it or where it was bought
  acquired_on      TEXT NOT NULL,    -- YYYY-MM-DD; editable, may come from an import
  city             TEXT,             -- where it was acquired
  state            TEXT,
  country          TEXT,
  visible_text     TEXT,             -- printed text as read by the AI; helps text search find duplicates
  notes            TEXT,
  review_note      TEXT,             -- why it is awaiting review, e.g. "possible duplicate of K-0042"
  origin           TEXT NOT NULL DEFAULT 'scan' CHECK (origin IN ('scan', 'import', 'manual')),
  external_ref     TEXT,             -- identifier from an imported spreadsheet row
  extra_json       TEXT,             -- unmapped spreadsheet columns, preserved verbatim
  is_demo          INTEGER NOT NULL DEFAULT 0,
  search_text      TEXT NOT NULL DEFAULT '',  -- lowercase concatenation for LIKE search (FTS5 breaks `d1 export`)
  created_at       TEXT NOT NULL,    -- ISO timestamps, UTC
  updated_at       TEXT NOT NULL,
  deleted_at       TEXT              -- soft delete ("Recently deleted"); excluded from counts and search
);
CREATE UNIQUE INDEX items_external_ref ON items (external_ref) WHERE external_ref IS NOT NULL;
CREATE INDEX items_live ON items (deleted_at, status, id);
CREATE INDEX items_acquired ON items (deleted_at, acquired_on);

-- Keep search_text in sync with the searchable columns.
CREATE TRIGGER items_search_ins AFTER INSERT ON items BEGIN
  UPDATE items SET search_text = lower(printf('K-%04d', NEW.id) || ' ' || NEW.description || ' ' || coalesce(NEW.size, '') || ' ' ||
    coalesce(NEW.base, '') || ' ' || coalesce(NEW.acquired_from, '') || ' ' || coalesce(NEW.city, '') || ' ' ||
    coalesce(NEW.state, '') || ' ' || coalesce(NEW.country, '') || ' ' || coalesce(NEW.visible_text, '') || ' ' ||
    coalesce(NEW.notes, '') || ' ' || coalesce(NEW.external_ref, '') || ' ' || coalesce(NEW.extra_json, ''))
  WHERE id = NEW.id;
END;
CREATE TRIGGER items_search_upd AFTER UPDATE OF description, size, base, acquired_from, city, state, country, visible_text, notes, external_ref, extra_json ON items BEGIN
  UPDATE items SET search_text = lower(printf('K-%04d', NEW.id) || ' ' || NEW.description || ' ' || coalesce(NEW.size, '') || ' ' ||
    coalesce(NEW.base, '') || ' ' || coalesce(NEW.acquired_from, '') || ' ' || coalesce(NEW.city, '') || ' ' ||
    coalesce(NEW.state, '') || ' ' || coalesce(NEW.country, '') || ' ' || coalesce(NEW.visible_text, '') || ' ' ||
    coalesce(NEW.notes, '') || ' ' || coalesce(NEW.external_ref, '') || ' ' || coalesce(NEW.extra_json, ''))
  WHERE id = NEW.id;
END;

-- Photos. A photo with item_id NULL is an in-progress scan; abandoned scans are purged after 24h.
CREATE TABLE photos (
  id               TEXT PRIMARY KEY,           -- UUID; also the vector id
  item_id          INTEGER REFERENCES items (id),
  side             TEXT NOT NULL DEFAULT 'front' CHECK (side IN ('front', 'back', 'other')),
  position         INTEGER NOT NULL DEFAULT 0, -- 0 = primary photo shown in lists
  full_key         TEXT NOT NULL,
  thumb_key        TEXT NOT NULL,
  width            INTEGER NOT NULL,
  height           INTEGER NOT NULL,
  bytes            INTEGER NOT NULL,
  sha256           TEXT NOT NULL,
  original_name    TEXT,
  embedding        BLOB,                       -- float32 little-endian; regenerable, not authoritative
  embedding_model  TEXT,                       -- e.g. "gemini-embedding-2@768"
  indexed          INTEGER NOT NULL DEFAULT 0, -- 1 when present in the vector index
  embed_error      TEXT,
  created_at       TEXT NOT NULL
);
CREATE INDEX photos_item ON photos (item_id, position);
CREATE INDEX photos_sha ON photos (sha256);
CREATE INDEX photos_pending ON photos (indexed, item_id);

-- Per-day counters that cap AI spend if a client misbehaves.
CREATE TABLE ai_usage (
  day   TEXT NOT NULL,
  kind  TEXT NOT NULL,
  count INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (day, kind)
);

-- Small key/value settings, e.g. the collection goal shown on the home screen.
CREATE TABLE settings (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
