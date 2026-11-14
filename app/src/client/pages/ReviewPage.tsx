import { useCallback, useEffect, useState } from "react";
import type { BulkPhoto, ItemSummary } from "../../shared/types";
import { api, errorMessage, photoUrl } from "../api";
import { emptyValues, ItemForm, type FormValues } from "../components/ItemForm";
import { Confirm, ErrorState, fmtDate, fmtNum, Icon, Sheet, Spinner, Thumb, TopBar, useToast } from "../components/ui";
import { Link } from "../router";
import { SearchSheet } from "./ScanPage";

const CONFIDENCE = {
  high: { dot: "ok", label: "Confident match" },
  medium: { dot: "possible", label: "Likely match" },
  low: { dot: "strong", label: "Unsure, check carefully" },
} as const;

/**
 * Confirm the AI's suggestion for each bulk-uploaded photo, one at a time. Most confident first,
 * so the bulk of them is a single tap.
 */
export function ReviewPage() {
  const [queue, setQueue] = useState<BulkPhoto[] | null>(null);
  const [left, setLeft] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [dialog, setDialog] = useState<null | "pick" | "new" | "discard">(null);
  const [newValues, setNewValues] = useState<FormValues>(emptyValues);
  const [reviewed, setReviewed] = useState(0);
  const [showBack, setShowBack] = useState(false);
  const toast = useToast();

  const load = useCallback(async () => {
    try {
      const q = await api.bulkQueue({ limit: 30 });
      setQueue(q.items);
      setLeft(q.counts.suggested + q.counts.failed);
      setError(null);
    } catch (e) {
      setError(errorMessage(e));
    }
  }, []);
  useEffect(() => {
    load();
  }, [load]);

  const current = queue?.[0];
  const next = queue?.[1];

  /** Drop the current photo from the local queue, topping it up from the server when it runs low. */
  const advance = (counted = true) => {
    setDialog(null);
    setShowBack(false);
    if (counted) {
      setReviewed((n) => n + 1);
      setLeft((n) => Math.max(n - 1, 0));
    }
    setQueue((q) => {
      const rest = q?.slice(1) ?? [];
      if (rest.length < 5) load();
      return rest;
    });
  };

  const act = async (fn: () => Promise<string | void>, counted = true) => {
    setBusy(true);
    try {
      const msg = await fn();
      if (msg) toast(msg);
      advance(counted);
    } catch (e) {
      toast(errorMessage(e));
    } finally {
      setBusy(false);
    }
  };

  const accept = (item: ItemSummary) => act(async () => (await api.bulkAccept(current!.photo_id, item.id), `Photo added to ${item.code}`));

  if (error && !queue) {
    return (
      <>
        <TopBar title="Review photos" back="/" />
        <main className="page no-dock">
          <ErrorState message={error} onRetry={load} />
        </main>
      </>
    );
  }
  if (!queue) {
    return (
      <>
        <TopBar title="Review photos" back="/" />
        <main className="page no-dock center">
          <Spinner large />
        </main>
      </>
    );
  }
  if (!current) {
    return (
      <>
        <TopBar title="Review photos" back="/" />
        <main className="page no-dock">
          <div className="center" style={{ minHeight: "60dvh" }}>
            <div className="result-mark">
              <Icon name="check" size={24} />
            </div>
            <h1 style={{ fontSize: 20, lineHeight: "26px" }}>All photos reviewed</h1>
            {reviewed > 0 && <p className="secondary">{fmtNum(reviewed)} done this session</p>}
            <Link href="/" className="btn big" style={{ marginTop: 16 }}>
              Done
            </Link>
          </div>
        </main>
      </>
    );
  }

  const c = current.item ? CONFIDENCE[current.confidence ?? "low"] : null;
  const s = current.suggestion;

  return (
    <>
      <TopBar title="Review photos" back="/" end={<span className="small muted mono" style={{ paddingRight: 8, whiteSpace: "nowrap" }}>{fmtNum(left)} left</span>} />
      <main className="page no-dock review">
        <div className="viewer">
          {showBack && current.back_photo_id ? (
            <img key={current.back_photo_id} src={photoUrl(current.back_photo_id, "full")} alt="Back of the uploaded koozie" />
          ) : (
            <img key={current.photo_id} src={photoUrl(current.photo_id, "full")} alt="Uploaded koozie" />
          )}
          {current.back_photo_id && <span className="side">{showBack ? "Back" : "Front"}</span>}
        </div>
        {current.back_photo_id && (
          <div className="photo-strip" aria-label="Sides">
            <button aria-current={!showBack} onClick={() => setShowBack(false)} aria-label="Front">
              <Thumb photoId={current.photo_id} alt="" />
            </button>
            <button aria-current={showBack} onClick={() => setShowBack(true)} aria-label="Back">
              <Thumb photoId={current.back_photo_id} alt="" />
            </button>
          </div>
        )}
        {/* Warm the cache so the next photo appears instantly. */}
        {next && <link rel="prefetch" href={photoUrl(next.photo_id, "full")} />}
        {current.back_photo_id && <link rel="prefetch" href={photoUrl(current.back_photo_id, "full")} />}

        {current.item ? (
          <section className="stack tight">
            <div className="row" style={{ gap: 8 }}>
              <span className={`dot ${c!.dot}`} />
              <span className="small secondary">{c!.label}</span>
            </div>
            <div className="suggested">
              <span className="code">{current.item.code}</span>
              <p>{current.item.description}</p>
              <p className="small muted">
                {[current.item.size, current.item.acquired_from, fmtDate(current.item.acquired_on)].filter(Boolean).join(" · ")}
              </p>
            </div>
            {current.reason && <p className="small muted">{current.reason}</p>}
            {current.item.photo_count > 0 && (
              // Another photo was already confirmed for this record: probably a lookalike (another colour or size).
              <div className="notice">
                <span className="dot possible" />
                <span className="body">
                  {current.item.code} already has photos from another koozie. This may be a lookalike; check the colour and size, or pick another.
                </span>
              </div>
            )}
          </section>
        ) : (
          <section className="stack tight">
            <div className="row" style={{ gap: 8 }}>
              <span className="dot" />
              <span className="small secondary">{current.status === "failed" ? "The AI couldn't check this photo" : "No matching record found"}</span>
            </div>
            {s?.description && <p className="secondary">Looks like: {s.description}</p>}
          </section>
        )}

        <div className="stack tight">
          {current.item ? (
            <>
              <button className="btn primary big block" disabled={busy} onClick={() => accept(current.item!)}>
                {busy ? <Spinner /> : `Yes, it's ${current.item.code}`}
              </button>
              <button className="btn big block" disabled={busy} onClick={() => setDialog("pick")}>
                No, pick another
              </button>
            </>
          ) : (
            <button className="btn primary big block" disabled={busy} onClick={() => setDialog("pick")}>
              Find the record
            </button>
          )}
          <div className="row" style={{ justifyContent: "space-between" }}>
            <button
              className="btn ghost small"
              disabled={busy}
              onClick={() => {
                setNewValues({ ...emptyValues(), description: s?.description ?? "", color: s?.color ?? null, size: s?.size ?? null, base: s?.base ?? null, visible_text: s?.visible_text ?? null });
                setDialog("new");
              }}
            >
              Not in the list
            </button>
            <button className="btn ghost small" disabled={busy || queue.length < 2} onClick={() => act(() => api.bulkSkip(current.photo_id).then(() => {}), false)}>
              Skip for now
            </button>
            <button className="btn ghost small danger" disabled={busy} onClick={() => setDialog("discard")}>
              Delete photo
            </button>
          </div>
        </div>
      </main>

      {dialog === "pick" && (
        <SearchSheet title="Which koozie is it?" suggested={current.alternatives} onClose={() => setDialog(null)} onPick={(it) => accept(it)} />
      )}
      {dialog === "new" && (
        <Sheet title="Add as a new koozie" onClose={() => !busy && setDialog(null)}>
          <p className="small secondary">For a koozie that isn't in the spreadsheet yet. It gets the next K-number.</p>
          <ItemForm values={newValues} onChange={setNewValues} />
          <button
            className="btn primary big block"
            disabled={busy}
            onClick={() => act(async () => `Added as ${(await api.bulkNew(current.photo_id, newValues)).code}`)}
          >
            {busy ? <Spinner /> : "Add to collection"}
          </button>
        </Sheet>
      )}
      {dialog === "discard" && (
        <Confirm
          title="Delete this photo?"
          body="Use this for blurry shots or photos of something else. Nothing in the collection changes."
          confirmLabel="Delete photo"
          danger
          onClose={() => setDialog(null)}
          onConfirm={() => act(async () => (await api.bulkDiscard(current.photo_id), "Photo deleted"))}
        />
      )}
    </>
  );
}
