-- Bulk-imported koozies are photographed front then back; the back travels with its front.
ALTER TABLE bulk_photos ADD COLUMN back_photo_id TEXT REFERENCES photos (id);
