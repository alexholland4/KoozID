// Export: CSV (opens in Excel) and a ZIP backup (CSV + JSON + full-size photos), built in the
// browser from paged API calls so no Worker request does heavy work.

import { Zip, ZipPassThrough, strToU8 } from "fflate";
import { toCsv } from "../shared/csv";
import type { Item } from "../shared/types";
import { api, photoUrl } from "./api";

export const photoFileName = (item: Item, idx: number) => `${item.code}_${item.photos[idx].side}_${idx + 1}.jpg`;

// The first ten columns match the collector's original spreadsheet, so an export can be pasted
// back into it (or re-imported here). Everything else follows.
const COLUMNS = [
  "Koozie ID",
  "Date Acquired",
  "Source",
  "Description",
  "Size",
  "Base",
  "City",
  "State",
  "Country",
  "Photo",
  "Color",
  "Status",
  "Printed Text",
  "Notes",
  "Review Note",
  "Photo Count",
  "Added Via",
  "Original Ref",
  "Created At",
  "Updated At",
  "Deleted At",
  "Extra Columns (JSON)",
];

/** M/D/YYYY, as the original spreadsheet writes dates. */
const sheetDate = (iso: string) => {
  const [y, m, d] = iso.split("-").map(Number);
  return `${m}/${d}/${y}`;
};

function row(it: Item): unknown[] {
  return [
    it.code,
    sheetDate(it.acquired_on),
    it.acquired_from,
    it.description,
    it.size,
    it.base,
    it.city,
    it.state,
    it.country,
    it.photos.map((_, i) => `photos/${photoFileName(it, i)}`).join("; "),
    it.color,
    it.status === "active" ? "Counted" : "Needs review",
    it.visible_text,
    it.notes,
    it.review_note,
    it.photos.length,
    it.origin,
    it.external_ref,
    it.created_at,
    it.updated_at,
    it.deleted_at,
    it.extra ? JSON.stringify(it.extra) : "",
  ];
}

export async function fetchAllItems(onProgress?: (n: number) => void): Promise<Item[]> {
  const all: Item[] = [];
  let offset: number | null = 0;
  while (offset !== null) {
    const page = await api.exportPage(offset, 500);
    all.push(...page.items);
    onProgress?.(all.length);
    offset = page.next_offset;
  }
  return all;
}

export function itemsToCsv(items: Item[]): string {
  return toCsv([COLUMNS, ...items.map(row)]);
}

export function download(blob: Blob, name: string) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = name;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 10_000);
}

const stamp = () => new Date().toISOString().slice(0, 10);

export async function exportCsv(onProgress?: (msg: string) => void) {
  const items = await fetchAllItems((n) => onProgress?.(`Loaded ${n} records…`));
  download(new Blob([itemsToCsv(items)], { type: "text/csv;charset=utf-8" }), `koozid-${stamp()}.csv`);
  return items.length;
}

/**
 * ZIP backup of items with catalogue numbers in [fromId, toId]. Photos are stored uncompressed
 * (JPEGs don't compress). Missing photos are listed in MISSING.txt rather than failing the export.
 */
export async function exportZip(range: { fromId?: number; toId?: number }, onProgress: (msg: string, frac: number) => void) {
  onProgress("Loading records…", 0);
  const items = (await fetchAllItems()).filter((it) => (range.fromId ? it.id >= range.fromId : true) && (range.toId ? it.id <= range.toId : true));
  const chunks: Uint8Array[] = [];
  let zipErr: Error | null = null;
  const zip = new Zip((err, data) => {
    if (err) zipErr = err;
    else chunks.push(data);
  });
  const add = (name: string, data: Uint8Array) => {
    const f = new ZipPassThrough(name);
    zip.add(f);
    f.push(data, true);
  };
  add("koozid.csv", strToU8(itemsToCsv(items)));
  add("koozid.json", strToU8(JSON.stringify({ exported_at: new Date().toISOString(), items }, null, 1)));
  const missing: string[] = [];
  const totalPhotos = items.reduce((n, it) => n + it.photos.length, 0);
  let done = 0;
  for (const it of items) {
    for (let i = 0; i < it.photos.length; i++) {
      const name = `photos/${photoFileName(it, i)}`;
      try {
        const res = await fetch(photoUrl(it.photos[i].id, "full"), { credentials: "same-origin" });
        if (!res.ok) throw new Error(String(res.status));
        add(name, new Uint8Array(await res.arrayBuffer()));
      } catch (e) {
        missing.push(`${name} (${(e as Error).message})`);
      }
      done++;
      onProgress(`Photos ${done} / ${totalPhotos}`, totalPhotos ? done / totalPhotos : 1);
    }
  }
  if (missing.length) add("MISSING.txt", strToU8(missing.join("\n")));
  zip.end();
  if (zipErr) throw zipErr;
  const suffix = range.fromId || range.toId ? `-${range.fromId ?? 1}-${range.toId ?? "end"}` : "";
  download(new Blob(chunks as BlobPart[], { type: "application/zip" }), `koozid-backup-${stamp()}${suffix}.zip`);
  return { items: items.length, photos: done - missing.length, missing: missing.length };
}
