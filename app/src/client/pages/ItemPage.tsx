import { useRef, useState } from "react";
import type { Item, PhotoSide } from "../../shared/types";
import { api, errorMessage, photoUrl } from "../api";
import { ItemForm, SidePicker, type FormValues } from "../components/ItemForm";
import { Confirm, Dock, ErrorState, fmtDate, Icon, Sheet, Spinner, StatusBadge, Thumb, TopBar, useToast } from "../components/ui";
import { useAsync } from "../hooks";
import { prepareImage } from "../image";
import { goBack, navigate } from "../router";

const toValues = (it: Item): FormValues => ({
  description: it.description,
  color: it.color,
  size: it.size,
  base: it.base,
  acquired_from: it.acquired_from,
  city: it.city,
  state: it.state,
  country: it.country,
  visible_text: it.visible_text,
  notes: it.notes,
  acquired_on: it.acquired_on,
});

export function ItemPage({ id }: { id: number }) {
  const { data: item, error, loading, reload, setData } = useAsync(() => api.item(id), [id]);
  const [photoIdx, setPhotoIdx] = useState(0);
  const [editing, setEditing] = useState<FormValues | null>(null);
  const [dialog, setDialog] = useState<null | "delete" | "purge" | "photo" | "add-photo">(null);
  const [busy, setBusy] = useState(false);
  const [pending, setPending] = useState<{ file: File; side: PhotoSide } | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);
  const toast = useToast();

  if (!item) {
    return (
      <>
        <TopBar title="Koozie" back="/collection" />
        <main className="page no-dock">{loading ? <div className="center"><Spinner large /></div> : <ErrorState message={error ?? "Not found"} onRetry={reload} />}</main>
      </>
    );
  }

  const photo = item.photos[Math.min(photoIdx, item.photos.length - 1)];
  const deleted = !!item.deleted_at;

  const run = async (fn: () => Promise<void>) => {
    setBusy(true);
    try {
      await fn();
    } catch (e) {
      toast(errorMessage(e));
    } finally {
      setBusy(false);
    }
  };

  const saveEdit = () =>
    run(async () => {
      const updated = await api.updateItem(item.id, editing!);
      setData(updated);
      setEditing(null);
      toast("Saved");
    });

  const uploadPhoto = () =>
    run(async () => {
      if (!pending) return;
      const prepared = await prepareImage(pending.file);
      URL.revokeObjectURL(prepared.previewUrl);
      const scan = await api.scan(prepared, false);
      const updated = await api.attachPhoto(item.id, scan.scan_id, pending.side);
      setData(updated);
      setPhotoIdx(updated.photos.length - 1);
      setPending(null);
      setDialog(null);
      toast("Photo added");
    });

  if (editing) {
    return (
      <>
        <TopBar title={`Edit ${item.code}`} back={() => setEditing(null)} />
        <main className="page">
          <ItemForm values={editing} onChange={setEditing} />
        </main>
        <Dock>
          <button className="btn big" onClick={() => setEditing(null)} disabled={busy}>
            Cancel
          </button>
          <button className="btn primary big" onClick={saveEdit} disabled={busy}>
            {busy ? <Spinner /> : "Save"}
          </button>
        </Dock>
      </>
    );
  }

  const where = [item.city, item.state, item.country].filter(Boolean).join(", ");
  const facts: [string, string | null][] = [
    ["Color", item.color],
    ["Size", item.size],
    ["Base", item.base],
    ["Source", item.acquired_from],
    ["Date acquired", fmtDate(item.acquired_on)],
    ["Where", where || null],
    ["Printed text", item.visible_text],
    ["Notes", item.notes],
    ["Added via", item.origin === "import" ? `Spreadsheet import${item.external_ref && item.external_ref !== item.code ? ` (${item.external_ref})` : ""}` : item.origin === "scan" ? "Scan" : "Manual"],
    ["Last edited", fmtDate(item.updated_at)],
  ];
  const extra = item.extra ? Object.entries(item.extra).filter(([, v]) => v) : [];

  return (
    <>
      <TopBar
        title={item.code}
        back="/collection"
        end={
          !deleted && (
            <button className="icon-btn" aria-label="Edit" onClick={() => setEditing(toValues(item))}>
              <Icon name="edit" />
            </button>
          )
        }
      />
      <main className="page no-dock">
        {deleted && (
          <div className="notice">
            <span className="dot strong" />
            <span className="body">Deleted {fmtDate(item.deleted_at!)}. Not counted or matched</span>
          </div>
        )}
        {item.status === "needs_review" && !deleted && (
          <div className="notice">
            <span className="dot review" />
            <div className="body">
              <span>
                <strong>Awaiting review.</strong> {item.review_note ?? "Saved as a possible duplicate"}. Not counted until confirmed
              </span>
              <div className="row">
                <button
                  className="btn primary"
                  disabled={busy}
                  onClick={() =>
                    run(async () => {
                      setData(await api.updateItem(item.id, { status: "active" }));
                      toast("Confirmed as unique");
                    })
                  }
                >
                  It's unique
                </button>
                <button className="btn" disabled={busy} onClick={() => setDialog("delete")}>
                  It's a duplicate
                </button>
              </div>
            </div>
          </div>
        )}

        <div className="stack">
          <div className="viewer">
            {photo ? (
              <a href={photoUrl(photo.id, "full")} target="_blank" rel="noreferrer" aria-label="Open full-size photo">
                <img src={photoUrl(photo.id, "full")} alt={item.description || item.code} />
              </a>
            ) : (
              <div className="center" style={{ height: "100%" }}>
                <p className="secondary small" style={{ maxWidth: 260 }}>
                  No photo yet. Scans can only match this koozie by its description until it has one
                </p>
                {!deleted && (
                  <button className="btn primary" onClick={() => fileRef.current?.click()}>
                    <Icon name="camera" /> Add photo
                  </button>
                )}
              </div>
            )}
            {photo && <span className="side">{photo.side === "front" ? "Front" : photo.side === "back" ? "Back" : "Other view"}</span>}
          </div>
          {item.photos.length > 0 && <div className="photo-strip">
            {item.photos.map((p, i) => (
              <button key={p.id} aria-current={i === photoIdx} onClick={() => setPhotoIdx(i)} aria-label={`Photo ${i + 1}`}>
                <Thumb photoId={p.id} alt="" />
              </button>
            ))}
            {!deleted && (
              <button aria-label="Add a photo" onClick={() => fileRef.current?.click()}>
                <div className="add">
                  <Icon name="plus" />
                </div>
              </button>
            )}
            <span className="spacer" />
            {photo && !deleted && (
              <button className="icon-btn" aria-label="Photo options" onClick={() => setDialog("photo")}>
                <Icon name="more" />
              </button>
            )}
          </div>}
          {item.back_same && !item.photos.some((p) => p.side === "back") && <p className="small muted">The back is the same as the front</p>}
          {photo && !photo.indexed && !deleted && (
            <p className="small muted">
              Not in the image search yet{photo.embed_error ? ` (${photo.embed_error.slice(0, 80)})` : ""}. Run Update search index in Tools
            </p>
          )}
        </div>

        <section className="stack tight">
          <div className="row" style={{ gap: 12 }}>
            <span className="code" style={{ fontSize: 15 }}>
              {item.code}
            </span>
            <StatusBadge status={item.status} />
            {item.is_demo && <span className="tag">Demo data</span>}
          </div>
          <p style={{ fontSize: 17, lineHeight: "24px" }}>{item.description || <span className="muted">No description</span>}</p>
        </section>

        <section className="card kv">
          {facts
            .filter(([, v]) => v)
            .map(([k, v]) => (
              <Fact key={k} k={k} v={v!} />
            ))}
        </section>

        {extra.length > 0 && (
          <section className="section">
            <h2 className="section-title">From the original spreadsheet</h2>
            <div className="card kv">
              {extra.map(([k, v]) => (
                <Fact key={k} k={k} v={v} />
              ))}
            </div>
          </section>
        )}

        {deleted ? (
          <div className="stack">
            <button
              className="btn primary big block"
              disabled={busy}
              onClick={() =>
                run(async () => {
                  setData(await api.restoreItem(item.id));
                  toast("Restored");
                })
              }
            >
              Restore
            </button>
            <button className="btn danger big block" onClick={() => setDialog("purge")}>
              Delete permanently
            </button>
          </div>
        ) : (
          <button className="btn ghost danger" style={{ alignSelf: "flex-start", paddingInline: 0 }} onClick={() => setDialog("delete")}>
            Delete koozie
          </button>
        )}
      </main>

      <input
        ref={fileRef}
        type="file"
        accept="image/*"
        hidden
        onChange={(e) => {
          const f = e.target.files?.[0];
          e.target.value = "";
          if (f) {
            setPending({ file: f, side: item.photos.some((p) => p.side === "front") ? "back" : "front" });
            setDialog("add-photo");
          }
        }}
      />

      {dialog === "delete" && (
        <Confirm
          title={`Delete ${item.code}?`}
          body="It moves to Recently deleted, stops counting toward the total and stops appearing in matches. You can restore it for 30 days; after that it and its photos are erased."
          confirmLabel="Delete"
          danger
          onClose={() => setDialog(null)}
          onConfirm={async () => {
            try {
              await api.deleteItem(item.id);
              toast(`${item.code} deleted`);
              goBack("/collection");
            } catch (e) {
              toast(errorMessage(e));
              setDialog(null);
            }
          }}
        />
      )}
      {dialog === "purge" && (
        <Confirm
          title={`Permanently delete ${item.code}?`}
          body="The record and its photos are erased. This can't be undone except from a backup."
          confirmLabel="Delete forever"
          danger
          onClose={() => setDialog(null)}
          onConfirm={async () => {
            try {
              await api.purgeItem(item.id);
              toast(`${item.code} permanently deleted`);
              navigate("/trash", { replace: true });
            } catch (e) {
              toast(errorMessage(e));
              setDialog(null);
            }
          }}
        />
      )}
      {dialog === "add-photo" && pending && (
        <Sheet title="Add photo" onClose={() => !busy && (setDialog(null), setPending(null))}>
          <p className="secondary small">Extra photos are searchable too, so a scan of either side finds this koozie.</p>
          <SidePicker value={pending.side} onChange={(side) => setPending({ ...pending, side })} />
          <button className="btn primary big block" onClick={uploadPhoto} disabled={busy}>
            {busy ? <Spinner /> : "Upload photo"}
          </button>
        </Sheet>
      )}
      {dialog === "photo" && photo && (
        <Sheet title="Photo options" onClose={() => !busy && setDialog(null)}>
          <SidePicker
            value={photo.side}
            onChange={(side) =>
              run(async () => {
                setData(await api.updatePhoto(photo.id, { side }));
              })
            }
          />
          <div className="list">
            {photoIdx !== 0 && (
              <button
                className="list-row"
                disabled={busy}
                onClick={() =>
                  run(async () => {
                    setData(await api.updatePhoto(photo.id, { primary: true }));
                    setPhotoIdx(0);
                    setDialog(null);
                  })
                }
              >
                <span className="grow">Use as main photo</span>
              </button>
            )}
            <a className="list-row" href={photoUrl(photo.id, "full")} download={`${item.code}-${photo.side}.jpg`}>
              <span className="grow">Download full size</span>
            </a>
            <button
              className="list-row danger"
              disabled={busy}
              onClick={() =>
                run(async () => {
                  if (item.photos.length === 1 && !confirm("This is the only photo. Remove it anyway?")) return;
                  setData(await api.deletePhoto(photo.id));
                  setPhotoIdx(0);
                  setDialog(null);
                  toast("Photo removed");
                })
              }
            >
              <span className="grow">Remove this photo</span>
            </button>
          </div>
        </Sheet>
      )}
    </>
  );
}

const Fact = ({ k, v }: { k: string; v: string }) => (
  <>
    <div className="k">{k}</div>
    <div style={{ whiteSpace: "pre-wrap" }}>{v}</div>
  </>
);
