-- Some koozies print the same design on both sides; this records that instead of a duplicate photo.
ALTER TABLE items ADD COLUMN back_same INTEGER NOT NULL DEFAULT 0;
