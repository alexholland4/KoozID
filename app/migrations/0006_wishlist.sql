-- Featured picks for the guest "Contribute" page; each links out to a store (usually the collector's
-- Amazon wish list, which ships to him without showing his address).
CREATE TABLE wishlist (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  title      TEXT NOT NULL,
  url        TEXT NOT NULL,
  note       TEXT,
  image_url  TEXT,
  created_at TEXT NOT NULL
);
