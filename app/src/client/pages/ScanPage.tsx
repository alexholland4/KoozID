import { useCallback, useEffect, useRef, useState } from "react";
import type { Candidate, DescribeResponse, Item, ItemSummary, PhotoSide, ScanResponse } from "../../shared/types";
import { api, errorMessage, photoUrl, SessionExpired } from "../api";
import { ItemForm, newValues, rememberAcquisition, whereLine, type FormValues } from "../components/ItemForm";
import { BandBadge, Dock, fmtDate, fmtNum, Icon, ScanFrame, Sheet, Spinner, StatusBadge, Thumb, TopBar, useToast } from "../components/ui";
import { useDebounced } from "../hooks";
import { prepareImage, type PreparedImage } from "../image";
import { Link } from "../router";

type Phase =
  | { k: "capture"; error?: string }
  | { k: "processing" }
  | { k: "back"; error?: string }
  | { k: "results" }
  | { k: "details" }
  | { k: "added"; item: Item; total: number | null }
  | { k: "owned"; item: ItemSummary; attached: boolean };

type DescribeState = { status: "idle" | "loading" | "done" | "error"; data?: DescribeResponse };

/** The back of the koozie: a photo, "same design as the front", or skipped. */
type Back = { kind: "photo"; img: PreparedImage } | { kind: "same" } | { kind: "none" };
type BackInfo = { scanId: string | null; same: boolean };

/**
 * Photograph the front (which searches the collection), then the back, then decide. The front's
 * search runs while the back is being photographed; the back uploads in the background and is
 * only stored, never searched, so it costs no AI call until it's saved.
 */
export function ScanPage() {
  const [phase, setPhase] = useState<Phase>({ k: "capture" });
  const [img, setImg] = useState<PreparedImage | null>(null);
  const [back, setBack] = useState<Back | null>(null);
  const [scan, setScan] = useState<ScanResponse | null>(null);
  const [searchError, setSearchError] = useState<string | null>(null);
  const [describe, setDescribe] = useState<DescribeState>({ status: "idle" });
  const [compare, setCompare] = useState<Candidate | ItemSummary | null>(null);
  const [ownedOpen, setOwnedOpen] = useState(false);
  const [searchOpen, setSearchOpen] = useState(false);
  // Items the user opened from a text search, so they can be picked as "already owned".
  const [picked, setPicked] = useState<ItemSummary[]>([]);
  const cameraRef = useRef<HTMLInputElement>(null);
  const libraryRef = useRef<HTMLInputElement>(null);
  const backCameraRef = useRef<HTMLInputElement>(null);
  const backLibraryRef = useRef<HTMLInputElement>(null);
  // Ignores results from a search started before a retake.
  const searchSeq = useRef(0);
  const backUpload = useRef<{ id?: string; p: Promise<string>; retry: () => Promise<string> } | null>(null);

  // Revoke preview object URLs when the photo changes or the page unmounts.
  useEffect(
    () => () => {
      if (img) URL.revokeObjectURL(img.previewUrl);
    },
    [img],
  );
  useEffect(
    () => () => {
      if (back?.kind === "photo") URL.revokeObjectURL(back.img.previewUrl);
    },
    [back],
  );

  const reset = useCallback(() => {
    searchSeq.current++;
    backUpload.current = null;
    describedFor.current = null;
    setImg(null);
    setBack(null);
    setSearchError(null);
    setScan(null);
    setDescribe({ status: "idle" });
    setCompare(null);
    setOwnedOpen(false);
    setSearchOpen(false);
    setPicked([]);
    setPhase({ k: "capture" });
  }, []);

  /** Search with the front photo. Runs in the background; the results screen waits for it. */
  const startSearch = useCallback((prepared: PreparedImage) => {
    const seq = ++searchSeq.current;
    setScan(null);
    setSearchError(null);
    api.scan(prepared).then(
      (res) => {
        if (seq !== searchSeq.current) return;
        setScan(res);
      },
      (e) => {
        if (seq !== searchSeq.current || e instanceof SessionExpired) return;
        setSearchError(errorMessage(e));
      },
    );
  }, []);

  const onFront = async (file: File | undefined) => {
    if (!file) return;
    reset();
    setPhase({ k: "processing" });
    try {
      const prepared = await prepareImage(file);
      setImg(prepared);
      startSearch(prepared);
      setPhase({ k: "back" });
    } catch (e) {
      setPhase({ k: "capture", error: errorMessage(e) });
    }
  };

  const onBack = async (file: File | undefined) => {
    if (!file) return;
    try {
      const prepared = await prepareImage(file);
      const u = {} as NonNullable<typeof backUpload.current>;
      u.retry = () => api.scan(prepared, false).then((r) => (u.id = r.scan_id));
      u.p = u.retry();
      u.p.catch(() => {}); // surfaced when saving, which retries
      backUpload.current = u;
      setBack({ kind: "photo", img: prepared });
      setPhase({ k: "results" });
    } catch (e) {
      setPhase({ k: "back", error: errorMessage(e) });
    }
  };

  const chooseBack = (b: Back) => {
    backUpload.current = null;
    setBack(b);
    setPhase({ k: "results" });
  };

  /** The back photo's upload id (retrying a failed upload once), or whether the back matches the front. */
  const getBack = async (): Promise<BackInfo> => {
    if (back?.kind === "same") return { scanId: null, same: true };
    const u = backUpload.current;
    if (back?.kind !== "photo" || !u) return { scanId: null, same: false };
    if (u.id) return { scanId: u.id, same: false };
    try {
      return { scanId: await u.p, same: false };
    } catch {
      u.p = u.retry();
      return { scanId: await u.p, same: false };
    }
  };

  /** Read the koozie's text (front and back) in the background while the user reviews matches. */
  const describeNow = (scanId: string) => {
    const seq = searchSeq.current;
    setDescribe({ status: "loading" });
    getBack()
      .catch((): BackInfo => ({ scanId: null, same: false })) // a failed back upload: read the front alone
      .then((b) => api.describe(scanId, b.scanId))
      .then(
        (d) => seq === searchSeq.current && setDescribe({ status: d.suggestion ? "done" : "error", data: d }),
        () => seq === searchSeq.current && setDescribe({ status: "error" }),
      );
  };
  // Waits for both the front's search and the back step, so the back's printed text is read too.
  const describedFor = useRef<string | null>(null);
  useEffect(() => {
    if (!scan || !back || describedFor.current === scan.scan_id) return;
    describedFor.current = scan.scan_id;
    describeNow(scan.scan_id);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [scan, back]);
  const retryDescribe = () => scan && describeNow(scan.scan_id);

  const openCamera = () => cameraRef.current?.click();
  const scanNext = () => {
    reset();
    openCamera(); // still inside the click gesture, so the camera opens immediately
  };
  const pickNext = () => {
    reset();
    libraryRef.current?.click();
  };

  const inputs = (
    <>
      <input ref={cameraRef} type="file" accept="image/*" capture="environment" hidden onChange={(e) => (onFront(e.target.files?.[0]), (e.target.value = ""))} />
      <input ref={libraryRef} type="file" accept="image/*" hidden onChange={(e) => (onFront(e.target.files?.[0]), (e.target.value = ""))} />
      <input ref={backCameraRef} type="file" accept="image/*" capture="environment" hidden onChange={(e) => (onBack(e.target.files?.[0]), (e.target.value = ""))} />
      <input ref={backLibraryRef} type="file" accept="image/*" hidden onChange={(e) => (onBack(e.target.files?.[0]), (e.target.value = ""))} />
    </>
  );

  const content = ((): React.ReactNode => {
  if (phase.k === "capture") {
    return (
      <>
        <TopBar title="Scan" back="/" end={<span className="small muted" style={{ paddingRight: 8, whiteSpace: "nowrap" }}>1 of 2</span>} />
        <main className="page no-dock">
          {phase.error && (
            <div className="notice" role="alert">
              <span className="dot strong" />
              <span className="body">{phase.error}</span>
            </div>
          )}
          <div className="capture">
            <ScanFrame />
            <div className="stack tight">
              <h2 style={{ fontSize: 20, lineHeight: "26px" }}>Photograph the front</h2>
              <span className="secondary small">Filling the frame, in even light. The back is next</span>
            </div>
            <div className="capture-actions">
              <button className="btn primary big block" onClick={openCamera}>
                <Icon name="camera" /> Take photo
              </button>
              <button className="btn big block" onClick={() => libraryRef.current?.click()}>
                Choose from library
              </button>
            </div>
          </div>
        </main>
      </>
    );
  }

  if (phase.k === "back" && img) {
    return (
      <>
        <TopBar title="Scan" back={reset} end={<span className="small muted" style={{ paddingRight: 8, whiteSpace: "nowrap" }}>2 of 2</span>} />
        <main className="page no-dock">
          {phase.error && (
            <div className="notice" role="alert">
              <span className="dot strong" />
              <span className="body">{phase.error}</span>
            </div>
          )}
          <div className="capture">
            <figure className="front-done">
              <img src={img.previewUrl} alt="Front of the koozie" />
              <figcaption>
                <Icon name="check" size={16} /> Front
              </figcaption>
            </figure>
            <div className="stack tight">
              <h2 style={{ fontSize: 20, lineHeight: "26px" }}>Now the back</h2>
              <span className="secondary small">Flip it over and photograph the other side</span>
            </div>
            <div className="capture-actions">
              <button className="btn primary big block" onClick={() => backCameraRef.current?.click()}>
                <Icon name="camera" /> Take photo of back
              </button>
              <button className="btn big block" onClick={() => chooseBack({ kind: "same" })}>
                Same as front
              </button>
              <div className="row" style={{ justifyContent: "space-between" }}>
                <button className="btn ghost small" onClick={() => backLibraryRef.current?.click()}>
                  Choose from library
                </button>
                <button className="btn ghost small" onClick={() => chooseBack({ kind: "none" })}>
                  Skip the back
                </button>
              </div>
            </div>
            <div className="row small muted" style={{ gap: 8, justifyContent: "center" }} role="status" aria-live="polite">
              {scan ? (
                <>
                  <span className="dot ok" /> Search finished
                </>
              ) : searchError ? (
                <>
                  <span className="dot strong" /> Search didn't finish. You can retry next
                </>
              ) : (
                <>
                  <Spinner /> Searching the collection meanwhile
                </>
              )}
            </div>
          </div>
        </main>
      </>
    );
  }

  // Preparing the front photo, or waiting for its search once the back is done.
  if (phase.k === "processing" || phase.k === "back" || (phase.k === "results" && !scan)) {
    const failed = phase.k === "results" && !!searchError;
    return (
      <>
        <TopBar title="Scan" back="/" />
        <main className="page no-dock">
          <div className="processing">
            <div className="shot">{img && <img src={img.previewUrl} alt="Your photo" />}</div>
            <div className="status" role="status" aria-live="polite">
              {failed ? <span className="dot strong" /> : <Spinner />}
              <span>{failed ? "Search didn't finish" : phase.k === "results" ? "Searching the collection" : "Preparing photo"}</span>
            </div>
          </div>
          {failed && (
            <div className="stack">
              <p className="secondary small" role="alert">
                {searchError}
              </p>
              {img && (
                <button className="btn primary big block" onClick={() => startSearch(img)}>
                  Try again
                </button>
              )}
              <button className="btn big block" onClick={reset}>
                Start over
              </button>
            </div>
          )}
        </main>
      </>
    );
  }

  if (phase.k === "added") {
    return (
      <main className="page no-dock">
        <div className="center" style={{ minHeight: "72dvh" }}>
          <div className="result-mark">
            <Icon name="check" size={24} />
          </div>
          <h1 style={{ fontSize: 20, lineHeight: "26px" }}>{phase.item.status === "needs_review" ? "Saved for review" : "Added to the collection"}</h1>
          <div className="code" style={{ fontSize: 28, lineHeight: "32px" }}>
            {phase.item.code}
          </div>
          <p className="secondary">
            {phase.item.status === "needs_review"
              ? "Not counted until you confirm it's unique"
              : phase.total !== null
                ? `${fmtNum(phase.total)} unique koozie${phase.total === 1 ? "" : "s"} in total`
                : ""}
          </p>
          <div className="stack tight" style={{ width: "100%", maxWidth: 360, marginTop: 16 }}>
            <div className="grid-2">
              <button className="btn primary big" onClick={scanNext}>
                <Icon name="camera" /> Scan next
              </button>
              <button className="btn big" onClick={pickNext}>
                <Icon name="image" /> From library
              </button>
            </div>
            <Link className="btn big block" href={`/items/${phase.item.id}`}>
              View {phase.item.code}
            </Link>
            <Link className="btn ghost block" href="/">
              Done
            </Link>
          </div>
        </div>
      </main>
    );
  }

  if (phase.k === "owned") {
    return (
      <main className="page no-dock">
        <div className="center" style={{ minHeight: "72dvh" }}>
          <div className="result-mark">
            <Icon name="check" size={24} />
          </div>
          <h1 style={{ fontSize: 20, lineHeight: "26px" }}>Already owned</h1>
          <div className="code" style={{ fontSize: 28, lineHeight: "32px" }}>
            {phase.item.code}
          </div>
          <p className="secondary">{phase.attached ? "Nothing counted. The photo was added to that record" : "Nothing new was counted"}</p>
          <div className="stack tight" style={{ width: "100%", maxWidth: 360, marginTop: 16 }}>
            <div className="grid-2">
              <button className="btn primary big" onClick={scanNext}>
                <Icon name="camera" /> Scan next
              </button>
              <button className="btn big" onClick={pickNext}>
                <Icon name="image" /> From library
              </button>
            </div>
            <Link className="btn big block" href={`/items/${phase.item.id}`}>
              View {phase.item.code}
            </Link>
            <Link className="btn ghost block" href="/">
              Done
            </Link>
          </div>
        </div>
      </main>
    );
  }

  if (!scan || !img) return null;

  if (phase.k === "details") {
    return (
      <DetailsStep
        img={img}
        back={back}
        getBack={getBack}
        scan={scan}
        describe={describe}
        onRetryDescribe={retryDescribe}
        onBack={() => setPhase({ k: "results" })}
        onSaved={(item, total) => setPhase({ k: "added", item, total })}
      />
    );
  }

  // ------------------------------------------------------------------ results
  const top = scan.candidates[0];
  const searchFailed = scan.search_status === "failed" || scan.search_status === "unavailable";
  const visualIds = new Set(scan.candidates.map((c) => c.item.id));
  const textOnly = (describe.data?.text_matches ?? []).filter((t) => !visualIds.has(t.id));

  // Koozies without photos are invisible to image search; only their descriptions can match.
  const bare = scan.unphotographed;
  const bareNote = bare > 0 ? `${fmtNum(bare)} koozie${bare === 1 ? " has" : "s have"} no photo yet, so check the matching descriptions too.` : "";

  let verdict: string;
  let tone: "strong" | "possible" | "new" | "unknown";
  if (scan.exact_photo_item) {
    verdict = "This exact photo is already catalogued";
    tone = "strong";
  } else if (searchFailed) {
    verdict = "Image search unavailable";
    tone = "unknown";
  } else if (scan.search_status === "empty") {
    verdict = bare > 0 ? "No photos to compare with yet" : "First koozie in the collection";
    tone = bare > 0 ? "unknown" : "new";
  } else if (top?.band === "strong") {
    verdict = "Probably already owned";
    tone = "strong";
  } else if (top?.band === "possible") {
    verdict = "Similar koozies found";
    tone = "possible";
  } else {
    verdict = "No close matches";
    tone = "new";
  }

  return (
    <>
      <TopBar
        title="Results"
        back="/"
        end={
          <button className="btn ghost small" onClick={scanNext}>
            Retake
          </button>
        }
      />
      <main className="page">
        <section className="scan-head pair">
          <Shots front={img} back={back} />
          <div className="stack" style={{ gap: 8 }}>
            <div className="row" style={{ alignItems: "flex-start", gap: 12 }}>
              <span className={`dot ${tone === "strong" ? "strong" : tone === "possible" ? "possible" : tone === "new" ? "ok" : ""}`} style={{ marginTop: 10 }} />
              <h1 className="verdict">{verdict}</h1>
            </div>
            <p className="secondary small">
              {searchFailed
                ? "You can still add it. Search the descriptions to double-check."
                : scan.search_status === "empty" && bare > 0
                  ? `None of the ${fmtNum(bare)} koozies have photos, so only their descriptions can be checked.`
                  : tone === "new" && scan.candidates.length
                    ? `The nearest koozies are below if you want to double-check. ${bareNote}`
                    : scan.candidates.length
                      ? "Similar isn't always the same. Compare before deciding."
                      : `Nothing with a photo looks like this. ${bareNote}`}
            </p>
          </div>
        </section>

        {scan.exact_photo_item && !visualIds.has(scan.exact_photo_item.id) && (
          <CandidateCard summary={scan.exact_photo_item} label={<span className="tag"><span className="dot strong" />Same photo file</span>} onOpen={() => setCompare(scan.exact_photo_item!)} />
        )}

        {scan.candidates.length > 0 && (
          <section className="section" aria-label="Closest matches">
            <h2 className="section-title">{tone === "new" ? "Nearest, not close" : "Closest in the collection"}</h2>
            {scan.candidates.map((c) => (
              <CandidateCard key={c.item.id} summary={c.item} photoId={c.matched_photo_id} label={<BandBadge band={c.band} />} side={c.matched_side} onOpen={() => setCompare(c)} />
            ))}
          </section>
        )}

        {(describe.status === "loading" || textOnly.length > 0 || bare > 0) && (
          <section className="section" aria-label="Matching descriptions">
            <h2 className="section-title">Matching descriptions</h2>
            {describe.status === "loading" && (
              <div className="row muted small" style={{ gap: 12 }}>
                <Spinner /> Reading the printed text
              </div>
            )}
            {describe.status !== "loading" && textOnly.length === 0 && (
              <p className="small muted">
                {describe.status === "error" ? (
                  <>
                    Couldn't read the koozie's text.{" "}
                    <button className="btn ghost small inline" onClick={retryDescribe}>
                      Try again
                    </button>
                  </>
                ) : (
                  "No description mentions the text on this koozie"
                )}
              </p>
            )}
            {textOnly.length > 0 && (
              <div className="list">
                {textOnly.map((t) => (
                  <button key={t.id} className="list-row" onClick={() => setCompare(t)}>
                    <div style={{ width: 40, flex: "none" }}>
                      <Thumb photoId={t.thumb_photo_id} alt="" />
                    </div>
                    <span className="grow">
                      <span className="code">{t.code}</span>
                      <div className="sub clamp-2">{t.description || "No description"}</div>
                    </span>
                    <Icon name="chevron" size={16} />
                  </button>
                ))}
              </div>
            )}
          </section>
        )}

        <button className="btn block" onClick={() => setSearchOpen(true)}>
          <Icon name="search" /> Search descriptions
        </button>
      </main>

      <Dock>
        <button className="btn big" onClick={() => setOwnedOpen(true)}>
          Already owned
        </button>
        <button className="btn primary big" onClick={() => setPhase({ k: "details" })}>
          Add to collection
        </button>
      </Dock>

      {compare && (
        <CompareSheet
          newPhotoUrl={img.previewUrl}
          target={compare}
          onClose={() => setCompare(null)}
          onSame={() => setOwnedOpen(true)}
        />
      )}
      {searchOpen && (
        <SearchSheet
          onClose={() => setSearchOpen(false)}
          onPick={(it) => {
            setPicked((p) => dedupe([it, ...p]));
            setSearchOpen(false);
            setCompare(it);
          }}
        />
      )}
      {ownedOpen && (
        <OwnedSheet
          scan={scan}
          back={back}
          getBack={getBack}
          options={dedupe([...picked, ...(scan.exact_photo_item ? [scan.exact_photo_item] : []), ...scan.candidates.map((c) => c.item), ...textOnly])}
          preselect={compare ? ("item" in compare ? compare.item.id : compare.id) : (scan.exact_photo_item?.id ?? top?.item.id)}
          onClose={() => setOwnedOpen(false)}
          onDone={(item, attached) => {
            setCompare(null);
            setOwnedOpen(false);
            if (item) setPhase({ k: "owned", item, attached });
            else reset();
          }}
        />
      )}
    </>
  );
  })();

  // The file inputs stay mounted across screens: "Scan next" opens the camera from the "Added"
  // screen, and the photo arrives after the screen has changed.
  return (
    <>
      {content}
      {inputs}
    </>
  );
}

const dedupe = (items: ItemSummary[]) => [...new Map(items.map((i) => [i.id, i])).values()];

/** Both sides of the new koozie, labelled. */
function Shots({ front, back }: { front: PreparedImage; back: Back | null }) {
  return (
    <div className="shots">
      <figure>
        <div className="shot">
          <img src={front.previewUrl} alt="Front of the new koozie" />
        </div>
        <figcaption>Front</figcaption>
      </figure>
      <figure>
        <div className="shot">
          {back?.kind === "photo" ? <img src={back.img.previewUrl} alt="Back of the new koozie" /> : <span>{back?.kind === "same" ? "Same as front" : "No photo"}</span>}
        </div>
        <figcaption>Back</figcaption>
      </figure>
    </div>
  );
}

/** Text search over the collection without leaving the current screen. `suggested` rows show before searching. */
export function SearchSheet({
  onClose,
  onPick,
  title = "Search descriptions",
  suggested = [],
}: {
  onClose: () => void;
  onPick: (item: ItemSummary) => void;
  title?: string;
  suggested?: ItemSummary[];
}) {
  const [q, setQ] = useState("");
  const dq = useDebounced(q.trim(), 250);
  const [res, setRes] = useState<{ q: string; items: ItemSummary[]; total: number } | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    if (!dq) return setRes(null);
    let live = true;
    api.list({ q: dq, limit: 30, sort: "id", order: "desc" }).then(
      (r) => live && (setRes({ q: dq, items: r.items, total: r.total }), setError(null)),
      (e) => live && setError(errorMessage(e)),
    );
    return () => {
      live = false;
    };
  }, [dq]);
  return (
    <Sheet title={title} onClose={onClose}>
      <div className="search">
        <Icon name="search" size={20} />
        <input className="input" type="search" autoFocus placeholder="Words on the koozie, a team, a place" value={q} onChange={(e) => setQ(e.target.value)} aria-label="Search descriptions" />
      </div>
      {error && <p className="small" style={{ color: "var(--neg)" }}>{error}</p>}
      {res && (
        <p className="small muted">
          {res.total === 0 ? `Nothing matches “${res.q}”` : `${fmtNum(res.total)} match${res.total === 1 ? "" : "es"}${res.total > res.items.length ? `, showing ${res.items.length}` : ""}`}
        </p>
      )}
      {!res && suggested.length > 0 && <p className="small muted">Other likely records</p>}
      {(res ? res.items : suggested).length > 0 && (
        <div className="list">
          {(res ? res.items : suggested).map((t) => (
            <button key={t.id} className="list-row" onClick={() => onPick(t)}>
              <div style={{ width: 40, flex: "none" }}>
                <Thumb photoId={t.thumb_photo_id} alt="" />
              </div>
              <span className="grow">
                <span className="code">{t.code}</span>
                <div className="sub clamp-2">{t.description || "No description"}</div>
              </span>
              <Icon name="chevron" size={16} />
            </button>
          ))}
        </div>
      )}
    </Sheet>
  );
}

function CandidateCard({ summary, photoId, label, side, onOpen }: { summary: ItemSummary; photoId?: string; label: React.ReactNode; side?: PhotoSide; onOpen: () => void }) {
  return (
    <button className="cand" onClick={onOpen}>
      <Thumb photoId={photoId ?? summary.thumb_photo_id} alt={summary.description || summary.code} />
      <div className="info">
        <div className="row" style={{ gap: 12, flexWrap: "wrap" }}>
          <span className="code">{summary.code}</span>
          {label}
        </div>
        <div className="desc">{summary.description || "No description"}</div>
        <div className="foot">
          <span>
            {side && side !== "front" ? `Matched its ${side === "back" ? "back" : "other"} photo` : `Acquired ${fmtDate(summary.acquired_on)}`}
            {summary.status === "needs_review" && " · needs review"}
          </span>
          <span className="spacer" />
          <span style={{ color: "var(--text-2)" }}>Compare</span>
          <Icon name="chevron" size={16} />
        </div>
      </div>
    </button>
  );
}

function CompareSheet({ newPhotoUrl, target, onClose, onSame }: { newPhotoUrl: string; target: Candidate | ItemSummary; onClose: () => void; onSame: () => void }) {
  const summary = "item" in target ? target.item : target;
  const [item, setItem] = useState<Item | null>(null);
  const [photoId, setPhotoId] = useState<string | null>("item" in target ? target.matched_photo_id : target.thumb_photo_id);
  const [stacked, setStacked] = useState(false);
  useEffect(() => {
    api.item(summary.id).then(setItem, () => {});
  }, [summary.id]);

  return (
    <Sheet title={<span className="code">{summary.code}</span>} onClose={onClose}>
      <div className={`compare${stacked ? " stacked" : ""}`}>
        <figure>
          <img src={newPhotoUrl} alt="Your new photo" />
          <figcaption>New photo</figcaption>
        </figure>
        <figure>
          {photoId ? (
            <img src={photoUrl(photoId, "full")} alt={`Photo of ${summary.code}`} />
          ) : (
            <div className="no-photo">No photo on file. Compare with the description</div>
          )}
          <figcaption>{summary.code}</figcaption>
        </figure>
      </div>
      {item && item.photos.length > 1 && (
        <div className="photo-strip" aria-label="Other photos of this koozie">
          {item.photos.map((p) => (
            <button key={p.id} aria-current={p.id === photoId} onClick={() => setPhotoId(p.id)} aria-label={`${p.side} photo`}>
              <Thumb photoId={p.id} alt="" />
            </button>
          ))}
        </div>
      )}
      <div className="row">
        {"band" in target && <BandBadge band={target.band} />}
        <StatusBadge status={summary.status} />
        <span className="spacer" />
        <button className="btn ghost small" onClick={() => setStacked((s) => !s)}>
          {stacked ? "Side by side" : "Larger"}
        </button>
      </div>
      <div className="stack tight">
        <p>{item?.description ?? summary.description ?? "No description"}</p>
        {item?.visible_text && <p className="small secondary">Printed text: {item.visible_text}</p>}
        <p className="small muted">
          {[item?.color, item?.size ?? summary.size, item?.acquired_from ?? summary.acquired_from, item ? whereLine(item) : null, fmtDate(summary.acquired_on)].filter(Boolean).join(" · ")}
        </p>
      </div>
      <div className="stack">
        <button className="btn primary big block" onClick={onSame}>
          Same koozie, already owned
        </button>
        <button className="btn big block" onClick={onClose}>
          Not the same
        </button>
      </div>
    </Sheet>
  );
}

function OwnedSheet({
  scan,
  back,
  getBack,
  options,
  preselect,
  onClose,
  onDone,
}: {
  scan: ScanResponse;
  back: Back | null;
  getBack: () => Promise<BackInfo>;
  options: ItemSummary[];
  preselect?: number;
  onClose: () => void;
  onDone: (item: ItemSummary | null, attached: boolean) => void;
}) {
  const [choice, setChoice] = useState<number | null>(preselect ?? options[0]?.id ?? null);
  const chosen = options.find((o) => o.id === choice);
  // A record without a photo should get this one: that's how the existing collection gets photographed.
  const [keepOverride, setKeepOverride] = useState<boolean | null>(null);
  const keepPhoto = keepOverride ?? chosen?.photo_count === 0;
  const setKeepPhoto = setKeepOverride;
  const both = back?.kind === "photo";
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const toast = useToast();

  const confirm = async () => {
    const item = options.find((o) => o.id === choice) ?? null;
    if (!item) return onDone(null, false);
    if (!keepPhoto) return onDone(item, false);
    setBusy(true);
    try {
      // Indexing runs after responding, so working through a pile of koozies stays quick.
      await api.attachPhoto(item.id, scan.scan_id, "front", true);
      const b = await getBack();
      if (b.scanId) await api.attachPhoto(item.id, b.scanId, "back", true);
      else if (b.same) await api.updateItem(item.id, { back_same: true });
      toast(both ? "Photos saved to record" : "Photo saved to record");
      onDone(item, true);
    } catch (e) {
      setError(errorMessage(e));
      setBusy(false);
    }
  };

  return (
    <Sheet title="Already owned" onClose={() => !busy && onClose()}>
      <p className="secondary small">Which koozie is it? Nothing is added to the count</p>
      {options.length > 0 ? (
        <div className="list" role="radiogroup">
          {options.map((o) => (
            <label key={o.id} className="list-row" style={{ cursor: "pointer" }}>
              <input className="radio" type="radio" name="owned" checked={choice === o.id} onChange={() => (setChoice(o.id), setKeepOverride(null))} />
              <div style={{ width: 40, flex: "none" }}>
                <Thumb photoId={o.thumb_photo_id} alt="" />
              </div>
              <span className="grow">
                <span className="code">{o.code}</span>
                <div className="sub clamp-1">{o.description || "No description"}</div>
              </span>
            </label>
          ))}
          <label className="list-row" style={{ cursor: "pointer" }}>
            <input className="radio" type="radio" name="owned" checked={choice === null} onChange={() => setChoice(null)} />
            <span className="grow secondary">Not listed, discard this scan</span>
          </label>
        </div>
      ) : (
        <p className="secondary">No candidates to link. The scan will be discarded.</p>
      )}
      {choice !== null && (
        <div className="stack">
          <label className="check">
            <input type="checkbox" checked={keepPhoto} onChange={(e) => setKeepPhoto(e.target.checked)} />
            <span>
              {both ? "Save both photos to that record" : "Save the photo to that record"}
              <div className="small muted">
                {chosen?.photo_count === 0
                  ? "It has no photo yet. Adding them lets future scans find it"
                  : `It already has ${chosen?.photo_count === 1 ? "a photo" : `${chosen?.photo_count} photos`}. Only add these if they're better or show something new`}
              </div>
            </span>
          </label>
        </div>
      )}
      {error && (
        <div className="notice" role="alert">
          <span className="dot strong" />
          <span className="body">{error}</span>
        </div>
      )}
      <button
        className="btn primary big block"
        disabled={busy}
        onClick={confirm}
      >
        {busy ? <Spinner /> : "Mark as owned"}
      </button>
    </Sheet>
  );
}

function DetailsStep({
  img,
  back,
  getBack,
  scan,
  describe,
  onRetryDescribe,
  onBack,
  onSaved,
}: {
  img: PreparedImage;
  back: Back | null;
  getBack: () => Promise<BackInfo>;
  scan: ScanResponse;
  describe: DescribeState;
  onRetryDescribe: () => void;
  onBack: () => void;
  onSaved: (item: Item, total: number | null) => void;
}) {
  const [initial] = useState(newValues);
  const [values, setValues] = useState<FormValues>(initial.values);
  const [touched, setTouched] = useState(false);
  const [applied, setApplied] = useState(false);
  const top = scan.candidates[0];
  const similar = scan.exact_photo_item ?? (top && top.band !== "weak" ? top.item : null);
  const [review, setReview] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Apply the AI suggestion once it arrives, unless the user already started typing.
  const suggestion = describe.data?.suggestion;
  useEffect(() => {
    if (!suggestion || applied || touched) return;
    // The model sees the koozie, so its size and base beat the carried-over guess.
    setValues((v) => ({
      ...v,
      description: v.description || suggestion.description,
      visible_text: v.visible_text ?? suggestion.visible_text,
      color: v.color ?? suggestion.color,
      size: suggestion.size ?? v.size,
      base: suggestion.base ?? v.base,
    }));
    setApplied(true);
  }, [suggestion, applied, touched]);

  const save = async () => {
    setSaving(true);
    setError(null);
    try {
      const b = await getBack();
      const item = await api.createItem({
        scan_id: scan.scan_id,
        ...values,
        status: review ? "needs_review" : "active",
        review_note: review && similar ? `Possible duplicate of ${similar.code}` : null,
        side: "front",
        back_scan_id: b.scanId,
        back_same: b.same,
      });
      rememberAcquisition(values);
      const total = await api.stats().then(
        (s) => s.total,
        () => null,
      );
      onSaved(item, total);
    } catch (e) {
      setError(errorMessage(e));
      setSaving(false);
    }
  };

  let hint: React.ReactNode = null;
  if (describe.status === "loading")
    hint = (
      <div className="row small muted" style={{ gap: 12 }}>
        <Spinner /> Writing a suggested description
      </div>
    );
  else if (applied)
    hint = (
      <div className="small muted">Suggested from the photo. Check it and edit as needed</div>
    );
  else if (suggestion && touched)
    hint = (
      <button
        className="btn ghost small"
        style={{ alignSelf: "flex-start", padding: 0 }}
        onClick={() => {
          setTouched(false);
          setValues((v) => ({ ...v, description: suggestion.description }));
          setApplied(true);
        }}
      >
        Use the suggested description
      </button>
    );
  else if (describe.status === "error")
    hint = (
      <div className="row small muted" style={{ gap: 8 }}>
        <span>The AI couldn't read it this time.</span>
        <button className="btn ghost small inline" onClick={onRetryDescribe}>
          Try again
        </button>
      </div>
    );

  return (
    <>
      <TopBar title="New koozie" back={onBack} />
      <main className="page">
        <div className="scan-head pair">
          <Shots front={img} back={back} />
          <span className="small secondary">
            {back?.kind === "photo" ? "Both photos are saved with it" : back?.kind === "same" ? "The back is the same as the front" : "No back photo. You can add one later"}
          </span>
        </div>

        {similar && (
          <div className="notice">
            <span className="dot possible" />
            <div className="body">
              <span>
                Similar to <strong className="code">{similar.code}</strong>. If you're unsure, save it for review. It won't count until confirmed.
              </span>
              <label className="check" style={{ color: "var(--text)" }}>
                <input type="checkbox" checked={review} onChange={(e) => setReview(e.target.checked)} />
                <span>Save for review</span>
              </label>
            </div>
          </div>
        )}

        <ItemForm
          values={values}
          carried={initial.carried}
          onChange={(v) => {
            if (v.description !== values.description) setTouched(true);
            setValues(v);
          }}
          descriptionHint={hint}
        />

        {error && (
          <div className="notice" role="alert">
            <span className="dot strong" />
            <span className="body">{error}</span>
          </div>
        )}
      </main>
      <Dock>
        <button className="btn primary big" disabled={saving} onClick={save}>
          {saving ? <Spinner /> : review ? "Save for review" : "Save to collection"}
        </button>
      </Dock>
    </>
  );
}

