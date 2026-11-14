-- One-time bulk photo matching. Photos uploaded in bulk stay unclaimed (photos.item_id IS NULL)
-- and wait here, with the AI's suggested record, until someone confirms where they belong.
-- Rows are deleted once the photo is attached, saved as a new koozie or discarded.
CREATE TABLE bulk_photos (
  photo_id      TEXT PRIMARY KEY REFERENCES photos (id),
  status        TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'suggested', 'failed')),
  item_id       INTEGER,          -- suggested record (may since have been deleted)
  confidence    TEXT,             -- high | medium | low
  alternatives  TEXT,             -- JSON array of other plausible item ids
  reason        TEXT,
  suggestion    TEXT,             -- JSON description/size/base/visible_text, for "it's a new koozie"
  error         TEXT,
  skipped_at    TEXT,             -- "Skip for now" moves it to the back of the queue
  created_at    TEXT NOT NULL
);
CREATE INDEX bulk_photos_queue ON bulk_photos (status, skipped_at, created_at);
