-- Colour gets its own field instead of living in brackets at the end of the description.
ALTER TABLE items ADD COLUMN color TEXT;

-- Rebuild the search-text triggers to include it.
DROP TRIGGER items_search_ins;
DROP TRIGGER items_search_upd;
CREATE TRIGGER items_search_ins AFTER INSERT ON items BEGIN
  UPDATE items SET search_text = lower(printf('K-%04d', NEW.id) || ' ' || NEW.description || ' ' || coalesce(NEW.color, '') || ' ' ||
    coalesce(NEW.size, '') || ' ' || coalesce(NEW.base, '') || ' ' || coalesce(NEW.acquired_from, '') || ' ' || coalesce(NEW.city, '') || ' ' ||
    coalesce(NEW.state, '') || ' ' || coalesce(NEW.country, '') || ' ' || coalesce(NEW.visible_text, '') || ' ' ||
    coalesce(NEW.notes, '') || ' ' || coalesce(NEW.external_ref, '') || ' ' || coalesce(NEW.extra_json, ''))
  WHERE id = NEW.id;
END;
CREATE TRIGGER items_search_upd AFTER UPDATE OF description, color, size, base, acquired_from, city, state, country, visible_text, notes, external_ref, extra_json ON items BEGIN
  UPDATE items SET search_text = lower(printf('K-%04d', NEW.id) || ' ' || NEW.description || ' ' || coalesce(NEW.color, '') || ' ' ||
    coalesce(NEW.size, '') || ' ' || coalesce(NEW.base, '') || ' ' || coalesce(NEW.acquired_from, '') || ' ' || coalesce(NEW.city, '') || ' ' ||
    coalesce(NEW.state, '') || ' ' || coalesce(NEW.country, '') || ' ' || coalesce(NEW.visible_text, '') || ' ' ||
    coalesce(NEW.notes, '') || ' ' || coalesce(NEW.external_ref, '') || ' ' || coalesce(NEW.extra_json, ''))
  WHERE id = NEW.id;
END;
