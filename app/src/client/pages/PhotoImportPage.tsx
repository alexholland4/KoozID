import { useEffect, useRef, useState } from "react";
import { ApiError, api, errorMessage, SessionExpired } from "../api";
import { fmtNum, Spinner, TopBar } from "../components/ui";
import { prepareImage } from "../image";
import { Link } from "../router";

type Progress = { total: number; uploaded: number; duplicates: number; matched: number; failed: string[] };
const IMAGE = /\.(jpe?g|png|webp|heic|heif)$/i;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * One-time bulk import: upload photos of koozies already in the list and let the AI suggest which
 * record each one shows. Matching runs two at a time and waits out the AI's rate limits, so the
 * screen has to stay open; anything unfinished can be resumed later from here.
 */
export function PhotoImportPage() {
  const [files, setFiles] = useState<File[]>([]);
  const [p, setP] = useState<Progress | null>(null);
  const [running, setRunning] = useState(false);
  const [waiting, setWaiting] = useState<string | null>(null);
  const [stopped, setStopped] = useState<string | null>(null);
  const [pendingOnServer, setPendingOnServer] = useState<number | null>(null);
  const [toReview, setToReview] = useState<number | null>(null);
  const stopRef = useRef(false);

  const refreshCounts = () =>
    api.bulkQueue({ limit: 1 }).then(
      (q) => (setPendingOnServer(q.counts.pending), setToReview(q.counts.suggested + q.counts.failed)),
      () => {},
    );
  useEffect(() => {
    refreshCounts();
  }, []);

  const bump = (k: keyof Omit<Progress, "failed" | "total">) => setP((x) => x && { ...x, [k]: x[k] + 1 });
  const fail = (msg: string) => setP((x) => x && { ...x, failed: [...x.failed, msg] });

  /** Match one photo, waiting and retrying while the AI asks us to slow down. */
  const matchOne = async (id: string, label: string) => {
    for (let attempt = 0; !stopRef.current; attempt++) {
      try {
        await api.bulkMatch(id);
        bump("matched");
        return;
      } catch (e) {
        if (e instanceof SessionExpired) throw e;
        if (e instanceof ApiError && e.code === "rate_limited" && attempt < 20) {
          setWaiting("The AI is rate-limiting requests. Waiting a moment, then continuing");
          await sleep(15_000 + attempt * 5_000);
          setWaiting(null);
          continue;
        }
        if (e instanceof ApiError && (e.code === "quota" || e.code === "unavailable")) {
          stopRef.current = true;
          setStopped(`${e.message} The rest stay uploaded; come back and resume.`);
          return;
        }
        fail(`${label}: ${errorMessage(e)}`);
        return;
      }
    }
  };

  /** Uploads feed a matching queue; both run concurrently with small worker pools. */
  const run = async (toUpload: File[], toMatch: { id: string; label: string }[]) => {
    stopRef.current = false;
    setStopped(null);
    setRunning(true);
    setP({ total: toUpload.length + toMatch.length, uploaded: 0, duplicates: 0, matched: 0, failed: [] });
    const matchQueue = [...toMatch];
    let uploadsDone = toUpload.length === 0;
    const uploadQueue = [...toUpload];

    const uploader = async () => {
      while (uploadQueue.length && !stopRef.current) {
        const f = uploadQueue.shift()!;
        try {
          const img = await prepareImage(f);
          URL.revokeObjectURL(img.previewUrl);
          const r = await api.bulkUpload(img);
          bump("uploaded");
          if (r.status === "duplicate") bump("duplicates");
          else matchQueue.push({ id: r.photo_id, label: f.name });
        } catch (e) {
          if (e instanceof SessionExpired) return void (stopRef.current = true);
          fail(`${f.name}: ${errorMessage(e)}`);
        }
      }
    };
    const matcher = async () => {
      while (!stopRef.current) {
        const next = matchQueue.shift();
        if (next) await matchOne(next.id, next.label);
        else if (uploadsDone) return;
        else await sleep(300);
      }
    };
    const uploads = Promise.all([uploader(), uploader(), uploader()]).then(() => (uploadsDone = true));
    try {
      await Promise.all([uploads, matcher(), matcher()]);
    } catch {
      // Session expired: the app shows the sign-in screen.
    }
    setRunning(false);
    setFiles([]);
    refreshCounts();
  };

  const resume = async () => {
    const q = await api.bulkQueue({ pending: true, limit: 500 });
    await run([], q.items.map((b) => ({ id: b.photo_id, label: b.original_name ?? b.photo_id })));
  };

  const pick = (list: FileList | null) => setFiles([...(list ?? [])].filter((f) => /^image\//.test(f.type) || IMAGE.test(f.name)));

  return (
    <>
      <TopBar title="Match photos" back="/more" />
      <main className="page no-dock">
        <p className="secondary small">
          For photographing the existing collection in one go. Upload a photo of each koozie that's already in the list. The AI suggests
          which record each photo shows, then they're reviewed one by one.
        </p>
        <ul className="small secondary" style={{ margin: 0, paddingLeft: 18 }}>
          <li>One koozie per photo, front side, filling most of the frame</li>
          <li>Any file names work. Photos already uploaded are skipped</li>
          <li>Keep this screen open while it runs. About 3 seconds per photo</li>
        </ul>

        {!running && (
          <section className="card pad stack">
            <div className="row" style={{ flexWrap: "wrap" }}>
              <label className="btn">
                Select photos
                <input type="file" accept="image/*" multiple hidden onChange={(e) => (pick(e.target.files), (e.target.value = ""))} />
              </label>
              <label className="btn">
                Select folder
                <input
                  type="file"
                  multiple
                  hidden
                  // @ts-expect-error non-standard but widely supported
                  webkitdirectory=""
                  onChange={(e) => (pick(e.target.files), (e.target.value = ""))}
                />
              </label>
            </div>
            {files.length > 0 && (
              <button className="btn primary big block" onClick={() => run(files, [])}>
                Upload and match {fmtNum(files.length)} photo{files.length === 1 ? "" : "s"}
              </button>
            )}
            {pendingOnServer !== null && pendingOnServer > 0 && files.length === 0 && (
              <div className="stack tight">
                <span className="small secondary">{fmtNum(pendingOnServer)} uploaded photo(s) haven't been matched yet</span>
                <button className="btn" onClick={resume}>
                  Match them now
                </button>
              </div>
            )}
          </section>
        )}

        {p && (
          <section className="card pad stack" aria-live="polite">
            <div className="row" style={{ gap: 12 }}>
              {running ? <Spinner /> : <span className="dot ok" />}
              <span>{running ? "Working" : stopped ? "Paused" : "Finished"}</span>
            </div>
            <div className="progressbar">
              <div style={{ transform: `scaleX(${p.total ? (p.matched + p.duplicates + p.failed.length) / p.total : 1})` }} />
            </div>
            <div className="kv-lite small">
              {p.uploaded > 0 && <span>{fmtNum(p.uploaded)} uploaded</span>}
              <span>{fmtNum(p.matched)} matched</span>
              {p.duplicates > 0 && <span>{fmtNum(p.duplicates)} already uploaded, skipped</span>}
              {p.failed.length > 0 && <span style={{ color: "var(--neg)" }}>{fmtNum(p.failed.length)} failed</span>}
            </div>
            {waiting && <p className="small muted">{waiting}</p>}
            {stopped && <p className="small" style={{ color: "var(--warn)" }}>{stopped}</p>}
            {p.failed.length > 0 && (
              <details className="more">
                <summary className="small">Show failures</summary>
                <div className="small muted stack tight" style={{ maxHeight: 200, overflow: "auto" }}>
                  {p.failed.map((f, i) => (
                    <div key={i}>{f}</div>
                  ))}
                </div>
              </details>
            )}
            {running && (
              <button className="btn" onClick={() => (stopRef.current = true)}>
                Pause
              </button>
            )}
          </section>
        )}

        {!running && (toReview ?? 0) > 0 && (
          <Link href="/review" className="btn primary big block">
            Review {fmtNum(toReview!)} match{toReview === 1 ? "" : "es"}
          </Link>
        )}
      </main>
    </>
  );
}
