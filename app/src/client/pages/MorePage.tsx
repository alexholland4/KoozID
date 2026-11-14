import { useState } from "react";
import { api, errorMessage } from "../api";
import type { ContributeAdmin } from "../../shared/types";
import { Confirm, fmtNum, Icon, Spinner, TopBar, useToast } from "../components/ui";
import { exportCsv, exportZip } from "../exporter";
import { useAsync } from "../hooks";
import { Link } from "../router";

/** Loop the resumable reindex endpoint until done or stuck. */
export async function runReindex(onProgress: (msg: string) => void, reset = false) {
  let first = true;
  let totals = { embedded: 0, indexed: 0, failed: 0 };
  for (;;) {
    const r = await api.reindex(10, reset && first);
    first = false;
    totals = { embedded: totals.embedded + r.embedded, indexed: totals.indexed + r.indexed, failed: totals.failed + r.failed };
    onProgress(`${fmtNum(totals.indexed)} indexed, ${fmtNum(r.remaining)} remaining`);
    if (r.stopped_reason) return { ...totals, remaining: r.remaining, stopped: r.stopped_reason };
    if (r.remaining === 0 || r.embedded + r.indexed === 0) return { ...totals, remaining: r.remaining, stopped: undefined };
  }
}

export function MorePage() {
  const me = useAsync(() => api.me(), []);
  const stats = useAsync(() => api.stats(), []);
  const toast = useToast();
  const [task, setTask] = useState<{ label: string; msg: string; frac?: number } | null>(null);
  const [zipOpen, setZipOpen] = useState(false);
  const [range, setRange] = useState({ from: "", to: "" });
  const [confirmDemo, setConfirmDemo] = useState(false);
  const [confirmRebuild, setConfirmRebuild] = useState(false);
  const [goalDraft, setGoalDraft] = useState<string | null>(null);

  const guard = async (label: string, fn: (set: (msg: string, frac?: number) => void) => Promise<string>) => {
    if (task) return;
    setTask({ label, msg: "Starting…" });
    try {
      toast(await fn((msg, frac) => setTask({ label, msg, frac })));
    } catch (e) {
      toast(errorMessage(e));
    } finally {
      setTask(null);
      stats.reload();
    }
  };

  const isAdmin = me.data?.is_admin;
  const s = stats.data;

  return (
    <>
      <TopBar title="Tools" back="/" />
      <main className="page no-dock">
        {task && (
          <div className="card pad stack" role="status" aria-live="polite">
            <div className="row" style={{ gap: 12 }}>
              <Spinner /> <span>{task.label}</span>
            </div>
            <span className="small secondary mono">{task.msg}</span>
            {task.frac !== undefined && (
              <div className="progressbar">
                <div style={{ transform: `scaleX(${task.frac})` }} />
              </div>
            )}
            <span className="small muted">Keep this screen open until it finishes</span>
          </div>
        )}

        <section className="section">
          <h2 className="section-title">Export and backup</h2>
          <div className="list">
            <button className="list-row" disabled={!!task} onClick={() => guard("Exporting CSV", async (set) => `Exported ${fmtNum(await exportCsv(set))} records`)}>
              <Icon name="download" />
              <span className="grow">
                Export spreadsheet
                <div className="sub">CSV of every record, opens in Excel or Google Sheets</div>
              </span>
            </button>
            <button className="list-row" disabled={!!task} onClick={() => setZipOpen((o) => !o)}>
              <Icon name="download" />
              <span className="grow">
                Full backup
                <div className="sub">ZIP with the spreadsheet, JSON and every full-size photo</div>
              </span>
              <Icon name="chevron" size={16} />
            </button>
            {zipOpen && (
              <div className="stack" style={{ padding: 16 }}>
                <p className="small secondary">Large collections are easiest in batches of about 1,000 items, roughly 300 MB each. Leave blank for everything.</p>
                <div className="grid-2">
                  <label className="field">
                    From number
                    <input className="input" inputMode="numeric" value={range.from} onChange={(e) => setRange({ ...range, from: e.target.value.replace(/\D/g, "") })} />
                  </label>
                  <label className="field">
                    To number
                    <input className="input" inputMode="numeric" value={range.to} onChange={(e) => setRange({ ...range, to: e.target.value.replace(/\D/g, "") })} />
                  </label>
                </div>
                <button
                  className="btn"
                  disabled={!!task}
                  onClick={() =>
                    guard("Building backup", async (set) => {
                      const r = await exportZip({ fromId: Number(range.from) || undefined, toId: Number(range.to) || undefined }, set);
                      return `Backed up ${fmtNum(r.items)} records, ${fmtNum(r.photos)} photos${r.missing ? ` (${r.missing} missing, listed in MISSING.txt)` : ""}`;
                    })
                  }
                >
                  Download ZIP
                </button>
              </div>
            )}
          </div>
        </section>

        <section className="section">
          <h2 className="section-title">Collection</h2>
          <div className="list">
            <div className="list-row" style={{ cursor: "default" }}>
              <span className="grow">
                Goal
                <div className="sub">{s?.goal ? `Shown on the home screen as progress toward ${fmtNum(s.goal)}` : "A target count to show progress toward, like a record to beat"}</div>
              </span>
              {goalDraft === null ? (
                <button className="btn small" onClick={() => setGoalDraft(s?.goal ? String(s.goal) : "")}>
                  {s?.goal ? fmtNum(s.goal) : "Set"}
                </button>
              ) : (
                <form
                  className="row"
                  style={{ gap: 8 }}
                  onSubmit={async (e) => {
                    e.preventDefault();
                    try {
                      await api.setGoal(goalDraft ? Number(goalDraft) : null);
                      setGoalDraft(null);
                      stats.reload();
                    } catch (err) {
                      toast(errorMessage(err));
                    }
                  }}
                >
                  <input
                    className="input"
                    style={{ width: 96 }}
                    inputMode="numeric"
                    autoFocus
                    aria-label="Goal"
                    placeholder="None"
                    value={goalDraft}
                    onChange={(e) => setGoalDraft(e.target.value.replace(/\D/g, ""))}
                  />
                  <button className="btn small primary">Save</button>
                </form>
              )}
            </div>
            <Link className="list-row" href="/collection?status=needs_review">
              <Icon name="alert" />
              <span className="grow">Awaiting review</span>
              <span className="muted mono small">{s ? fmtNum(s.needs_review) : ""}</span>
              <Icon name="chevron" size={16} />
            </Link>
            <Link className="list-row" href="/trash">
              <Icon name="trash" />
              <span className="grow">Recently deleted</span>
              <span className="muted mono small">{s ? fmtNum(s.deleted) : ""}</span>
              <Icon name="chevron" size={16} />
            </Link>
          </div>
        </section>

        <ContributeSettings offers={s?.offers ?? 0} />

        {isAdmin && (
          <section className="section">
            <h2 className="section-title">Admin</h2>
            <div className="list">
              <Link className="list-row" href="/import">
                <Icon name="upload" />
                <span className="grow">
                  Import
                  <div className="sub">An existing catalogue as CSV, plus its photos</div>
                </span>
                <Icon name="chevron" size={16} />
              </Link>
              <Link className="list-row" href="/photo-import">
                <Icon name="image" />
                <span className="grow">
                  Match photos to records
                  <div className="sub">Upload a folder of photos; the AI suggests which record each one is</div>
                </span>
                <Icon name="chevron" size={16} />
              </Link>
              <button
                className="list-row"
                disabled={!!task}
                onClick={() =>
                  guard("Updating search index", async (set) => {
                    const r = await runReindex((m) => set(m));
                    return r.stopped
                      ? `Paused: ${r.stopped}`
                      : r.remaining
                        ? `${fmtNum(r.remaining)} photo(s) couldn't be indexed. Open them to see why`
                        : `Search index up to date (${fmtNum(r.indexed)} added)`;
                  })
                }
              >
                <Icon name="refresh" />
                <span className="grow">
                  Update search index
                  <div className="sub">{s ? (s.pending_index ? `${fmtNum(s.pending_index)} photo(s) waiting` : "Every photo is searchable") : " "}</div>
                </span>
              </button>
              <button className="list-row" disabled={!!task} onClick={() => setConfirmRebuild(true)}>
                <Icon name="restore" />
                <span className="grow">
                  Rebuild search index
                  <div className="sub">After a model change, or if matches look wrong</div>
                </span>
              </button>
              <button className="list-row danger" disabled={!!task} onClick={() => setConfirmDemo(true)}>
                <Icon name="trash" />
                <span className="grow">
                  Remove demo data
                  <div className="sub">Deletes items imported as demo data</div>
                </span>
              </button>
            </div>
          </section>
        )}

        <section className="section">
          <h2 className="section-title">Account</h2>
          <div className="card pad stack small">
            {me.data && (
              <div className="row">
                <span className="grow">
                  <span className="secondary">Signed in as</span> {me.data.email}
                  {me.data.auth_mode === "dev" && <span className="muted"> (local dev)</span>}
                </span>
                {me.data.auth_mode === "access" && (
                  <a className="btn ghost small" href="/cdn-cgi/access/logout">
                    Sign out
                  </a>
                )}
              </div>
            )}
            <div className="row">
              <span className="grow secondary">Anyone with the link sees a read-only guest view: the count, search, photos, sources and stats. Notes and the review queue stay private</span>
              <a className="btn ghost small" href="/?guest=1" style={{ whiteSpace: "nowrap" }}>
                View as guest
              </a>
            </div>
            {me.data && (
              <p className="muted mono tiny">
                {me.data.ai_provider} · {me.data.vector_backend}
              </p>
            )}
            <p className="secondary">
              KoozID suggests possible duplicates from visual similarity. It doesn't verify uniqueness. You decide which items count and whether they meet any
              official record rules.
            </p>
          </div>
        </section>
      </main>

      {confirmDemo && (
        <Confirm
          title="Remove all demo data?"
          body="Every item imported as demo data, and its photos, will be permanently deleted. Your real items are not affected."
          confirmLabel="Remove demo data"
          danger
          onClose={() => setConfirmDemo(false)}
          onConfirm={async () => {
            setConfirmDemo(false);
            await guard("Removing demo data", async (set) => {
              let total = 0;
              for (;;) {
                const r = await api.purgeDemo();
                total += r.purged;
                set(`${total} removed, ${r.remaining} left`);
                if (r.remaining === 0 || r.purged === 0) break;
              }
              return `Removed ${total} demo item(s)`;
            });
          }}
        />
      )}
      {confirmRebuild && (
        <Confirm
          title="Rebuild the search index?"
          body="Every photo is re-added to the index. Photos with an embedding from the current model are reused; others are re-embedded (this uses AI quota)."
          confirmLabel="Rebuild"
          onClose={() => setConfirmRebuild(false)}
          onConfirm={async () => {
            setConfirmRebuild(false);
            await guard("Rebuilding search index", async (set) => {
              const r = await runReindex((m) => set(m), true);
              return r.stopped ? `Paused: ${r.stopped}` : `Rebuilt (${fmtNum(r.indexed)} photos)`;
            });
          }}
        />
      )}
    </>
  );
}

/** Contributions: offers to review, the private mailing address, the wish list and its picks. */
function ContributeSettings({ offers }: { offers: number }) {
  const { data, setData } = useAsync(() => api.contributeAdmin(), []);
  const [draft, setDraft] = useState<Pick<ContributeAdmin, "mailing_address" | "wishlist_url"> | null>(null);
  const [pick, setPick] = useState({ title: "", url: "", note: "", image_url: "" });
  const [busy, setBusy] = useState(false);
  const [testing, setTesting] = useState(false);
  const [testResult, setTestResult] = useState<string | null>(null);
  const toast = useToast();
  const run = async (fn: () => Promise<ContributeAdmin>, msg: string) => {
    setBusy(true);
    try {
      setData(await fn());
      toast(msg);
      return true;
    } catch (e) {
      toast(errorMessage(e));
      return false;
    } finally {
      setBusy(false);
    }
  };
  if (!data) return null;
  const d = draft ?? { mailing_address: data.mailing_address, wishlist_url: data.wishlist_url };
  return (
    <section className="section">
      <h2 className="section-title">Contributions</h2>
      <div className="list">
        <Link className="list-row" href="/requests">
          <Icon name="box" />
          <span className="grow">
            Koozie offers
            <div className="sub">Approve offers, then thank people when their koozie arrives</div>
          </span>
          {offers > 0 && <span className="count-pill">{fmtNum(offers)}</span>}
          <Icon name="chevron" size={16} />
        </Link>
        <Link className="list-row" href="/groups">
          <Icon name="people" />
          <span className="grow">
            Leaderboard groups
            <div className="sub">Count several sources as one contributor</div>
          </span>
          <Icon name="chevron" size={16} />
        </Link>
      </div>
      <div className="card pad stack">
        <p className="small secondary">
          What visitors see when they contribute.{" "}
          <Link href="/contribute" style={{ textDecoration: "underline", textUnderlineOffset: 3 }}>
            See the page
          </Link>
        </p>
        <label className="field">
          Mailing address (private)
          <textarea
            className="textarea"
            style={{ minHeight: 88 }}
            value={d.mailing_address ?? ""}
            placeholder={"Your name\n123 Main St\nCity, ST 12345"}
            onChange={(e) => setDraft({ ...d, mailing_address: e.target.value })}
            maxLength={500}
          />
          <span className="small muted" style={{ fontWeight: 400 }}>
            Never shown on the site. Only emailed to someone after you approve their offer.
          </span>
        </label>
        <label className="field">
          Amazon wish list link
          <input className="input" value={d.wishlist_url ?? ""} placeholder="https://www.amazon.com/hz/wishlist/ls/…" onChange={(e) => setDraft({ ...d, wishlist_url: e.target.value })} />
        </label>
        {draft && (
          <button className="btn primary" disabled={busy} onClick={async () => (await run(() => api.setContribute(draft), "Saved")) && setDraft(null)}>
            {busy ? <Spinner /> : "Save"}
          </button>
        )}
        <p className="small muted">
          {data.email_enabled
            ? "Email is connected: approvals and thank-yous are sent automatically."
            : "Email isn't connected yet: approvals and thank-yous open in your own mail app, ready to send."}
        </p>
        {data.email_enabled && (
          <>
            <button
              className="btn small"
              style={{ alignSelf: "flex-start" }}
              disabled={testing}
              onClick={async () => {
                setTesting(true);
                setTestResult(null);
                try {
                  const r = await api.emailTest();
                  setTestResult(r.sent ? `Sent to ${r.to}. Check that inbox (and spam).` : `Didn't send: ${r.error}`);
                } catch (e) {
                  setTestResult(`Didn't send: ${errorMessage(e)}`);
                } finally {
                  setTesting(false);
                }
              }}
            >
              {testing ? <Spinner /> : <><Icon name="mail" size={16} /> Send me a test email</>}
            </button>
            {testResult && (
              <p className="small secondary" role="status" style={{ overflowWrap: "anywhere" }}>
                {testResult}
              </p>
            )}
          </>
        )}

        <h3 className="small" style={{ marginTop: 8 }}>
          Featured wish list picks ({data.items.length})
        </h3>
        {data.items.length > 0 && (
          <div className="list">
            {data.items.map((w) => (
              <div key={w.id} className="list-row compact">
                <span className="grow clamp-1">{w.title}</span>
                <button className="btn ghost small danger" disabled={busy} onClick={() => run(() => api.deleteWish(w.id), "Removed")}>
                  Remove
                </button>
              </div>
            ))}
          </div>
        )}
        <div className="stack tight">
          <input className="input" placeholder="Title, e.g. Pickle Rick koozie" value={pick.title} onChange={(e) => setPick({ ...pick, title: e.target.value })} aria-label="Pick title" />
          <input className="input" placeholder="Link to the item (https://…)" value={pick.url} onChange={(e) => setPick({ ...pick, url: e.target.value })} aria-label="Pick link" />
          <input className="input" placeholder="Short note (optional)" value={pick.note} onChange={(e) => setPick({ ...pick, note: e.target.value })} aria-label="Pick note" />
          <input className="input" placeholder="Image link (optional)" value={pick.image_url} onChange={(e) => setPick({ ...pick, image_url: e.target.value })} aria-label="Pick image link" />
          <span className="small muted">For the photo: on the Amazon page, right-click the product picture (long-press on a phone) and choose Copy image address.</span>
          <button
            className="btn"
            disabled={busy || !pick.title.trim() || !pick.url.trim()}
            onClick={async () =>
              (await run(() => api.addWish({ ...pick, note: pick.note || null, image_url: pick.image_url || null }), "Pick added")) &&
              setPick({ title: "", url: "", note: "", image_url: "" })
            }
          >
            Add pick
          </button>
        </div>
      </div>
    </section>
  );
}
