-- Visitors offering koozies. "send" offers wait for the collector's approval before the (private)
-- mailing address is emailed to them; "gift" offers (bought from the wish list) need no approval.
-- Once the koozie arrives and is catalogued, the collector sends a thank-you naming the koozie(s).
CREATE TABLE contributions (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  kind         TEXT NOT NULL DEFAULT 'send' CHECK (kind IN ('send', 'gift')),
  name         TEXT NOT NULL,
  email        TEXT NOT NULL,
  quantity     TEXT,             -- "1", "2-5", "6-10", "10+"; optional
  checked      TEXT,             -- the visitor's photo check said 'new' or 'maybe' before offering
  status       TEXT NOT NULL DEFAULT 'new' CHECK (status IN ('new', 'approved', 'declined', 'thanked')),
  item_ids     TEXT,             -- JSON array of catalogue numbers named in the thank-you
  created_at   TEXT NOT NULL,
  decided_at   TEXT,
  thanked_at   TEXT
);
CREATE INDEX contributions_status ON contributions (status, id);
CREATE INDEX contributions_email ON contributions (email);

-- Leaderboard groups: several exact "Source" values counted as one contributor. Items keep their
-- precise source; only the leaderboard, standing badges and source filters use the group.
CREATE TABLE source_groups (
  source       TEXT PRIMARY KEY COLLATE NOCASE,
  contributor  TEXT NOT NULL
);
CREATE INDEX source_groups_contributor ON source_groups (contributor COLLATE NOCASE);

-- The collector's Amazon wish list (ships to him without showing his address). Replaces any earlier placeholder.
INSERT OR REPLACE INTO settings (key, value) VALUES ('contribute_wishlist_url', 'https://www.amazon.com/hz/wishlist/ls/EXAMPLE');
