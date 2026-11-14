import { useMemo, useRef, useState } from "react";
import { parseCsv } from "../../shared/csv";
import { buildPlan, findGoal, guessMapping, photosOnlyPlan, TARGETS, type Mapping, type Plan, type PlannedRow, type Target } from "../../shared/importer";
import { api, errorMessage, SessionExpired } from "../api";
import { fmtNum, Icon, Spinner, TopBar } from "../components/ui";
import { prepareImage } from "../image";
import { runReindex } from "./MorePage";

type RowState = { status: "pending" | "done" | "exists" | "error"; error?: string };

export function ImportPage() {
  const [mode, setMode] = useState<"sheet" | "photos">("sheet");
  const [csvName, setCsvName] = useState<string>("");
  const [table, setTable] = useState<{ headers: string[]; rows: string[][] } | null>(null);
  const [mapping, setMapping] = useState<Mapping>({});
  const [files, setFiles] = useState<File[]>([]);
  const [demo, setDemo] = useState(false);
  const [useGoal, setUseGoal] = useState(true);
  const [csvError, setCsvError] = useState<string | null>(null);
  const [states, setStates] = useState<Record<number, RowState>>({});
  const [running, setRunning] = useState(false);
  const [indexMsg, setIndexMsg] = useState<string | null>(null);
  const stopRef = useRef(false);

  const onCsv = async (f: File | undefined) => {
    if (!f) return;
    setCsvError(null);
    try {
      const rows = parseCsv(await f.text());
      if (rows.length < 2) throw new Error("The file needs a header row and at least one data row.");
      const headers = rows[0].map((h) => h.trim());
      setCsvName(f.name);
      setTable({ headers, rows: rows.slice(1) });
      setMapping(guessMapping(headers));
      setStates({});
    } catch (e) {
      setCsvError(/xlsx?$/i.test(f.name) ? "Please save the spreadsheet as CSV first (File → Save As → CSV UTF-8)." : errorMessage(e));
    }
  };

  const plan: Plan<File> | null = useMemo(() => {
    const fl = files.map((f) => ({ file: f, name: (f as File & { webkitRelativePath?: string }).name }));
    if (mode === "photos") return fl.length ? photosOnlyPlan(fl) : null;
    if (!table) return null;
    const p = buildPlan(table.headers, table.rows, mapping, fl);
    // Rows need a stable reference so a re-run skips what was already imported.
    p.rows.forEach((r) => (r.externalRef ??= `${csvName}#${r.row}`));
    return p;
  }, [mode, table, mapping, files, csvName]);

  const goal = mode === "sheet" && table ? findGoal(table.headers, table.rows) : null;

  const counts = plan && {
    rows: plan.rows.length,
    withPhotos: plan.rows.filter((r) => r.files.length).length,
    photos: plan.rows.reduce((n, r) => n + r.files.length, 0),
    missing: plan.rows.filter((r) => r.missing.length).length,
    warnings: plan.rows.filter((r) => r.warnings.length).length,
  };
  const done = Object.values(states).filter((s) => s.status === "done" || s.status === "exists").length;
  const failed = Object.entries(states).filter(([, s]) => s.status === "error");

  const importRow = async (r: PlannedRow<File>) => {
    const fd = new FormData();
    fd.set(
      "meta",
      JSON.stringify({
        external_ref: r.externalRef,
        number: r.number ?? undefined,
        ...r.fields,
        acquired_on: r.acquiredOn ?? undefined,
        extra: Object.keys(r.extra).length ? r.extra : undefined,
        demo,
      }),
    );
    for (let i = 0; i < r.files.length; i++) {
      const p = await prepareImage(r.files[i].file);
      URL.revokeObjectURL(p.previewUrl);
      fd.set(`full_${i}`, p.full, "full.jpg");
      fd.set(`thumb_${i}`, p.thumb, "thumb.jpg");
      fd.set(`name_${i}`, r.files[i].name);
      fd.set(`side_${i}`, r.files[i].side);
    }
    const res = await api.importItem(fd);
    return res.status;
  };

  const run = async (onlyFailed = false) => {
    if (!plan) return;
    setRunning(true);
    if (goal && useGoal && !onlyFailed) await api.setGoal(goal.value).catch(() => {});
    stopRef.current = false;
    const queue = plan.rows.filter((r) => (onlyFailed ? states[r.row]?.status === "error" : !states[r.row] || states[r.row].status === "pending"));
    const worker = async () => {
      while (queue.length && !stopRef.current) {
        const r = queue.shift()!;
        try {
          const status = await importRow(r);
          setStates((s) => ({ ...s, [r.row]: { status: status === "created" ? "done" : "exists" } }));
        } catch (e) {
          if (e instanceof SessionExpired) {
            stopRef.current = true;
            return;
          }
          setStates((s) => ({ ...s, [r.row]: { status: "error", error: errorMessage(e) } }));
        }
      }
    };
    await Promise.all([worker(), worker()]);
    setRunning(false);
  };

  const index = async () => {
    setIndexMsg("Starting…");
    try {
      const r = await runReindex(setIndexMsg);
      setIndexMsg(
        r.stopped
          ? `Paused: ${r.stopped}. Run it again later (Tools → Update search index) to continue.`
          : r.remaining
            ? `Done, but ${r.remaining} photo(s) couldn't be indexed.`
            : r.indexed
              ? `All photos are searchable (${fmtNum(r.indexed)} indexed).`
              : "Nothing to index: every photo is already searchable.",
      );
    } catch (e) {
      setIndexMsg(errorMessage(e));
    }
  };

  const setMap = (t: Target, v: string) => setMapping((m) => ({ ...m, [t]: v === "" ? undefined : Number(v) }));

  return (
    <>
      <TopBar title="Import" back="/more" />
      <main className="page no-dock">
        <div className="segmented">
          <button aria-pressed={mode === "sheet"} onClick={() => setMode("sheet")} disabled={running}>
            Spreadsheet + photos
          </button>
          <button aria-pressed={mode === "photos"} onClick={() => setMode("photos")} disabled={running}>
            Photos only
          </button>
        </div>

        <p className="small secondary">
          {mode === "sheet"
            ? "Upload the catalogue as CSV, then select its photos. Photos match rows by a file-name column or by the row's ID, like 123.jpg or 123_back.jpg. Re-running an import skips rows already imported."
            : "Each photo becomes one item. Files that share a name apart from a _front, _back or _2 suffix become one koozie."}
        </p>

        {mode === "sheet" && (
          <section className="card pad stack">
            <h2 className="section-title">1. Spreadsheet</h2>
            <label className="btn" style={{ alignSelf: "flex-start" }}>
              {table ? "Choose a different CSV" : "Choose CSV file"}
              <input type="file" accept=".csv,text/csv,.xlsx,.xls" hidden onChange={(e) => (onCsv(e.target.files?.[0]), (e.target.value = ""))} disabled={running} />
            </label>
            {csvError && <p className="small" style={{ color: "var(--neg)" }}>{csvError}</p>}
            {table && (
              <p className="small muted">
                {csvName}: {fmtNum(table.rows.length)} rows, {table.headers.length} columns
              </p>
            )}
          </section>
        )}

        {mode === "sheet" && table && (
          <section className="card pad stack">
            <h2 className="section-title">2. Match columns</h2>
            <p className="small muted">Columns left unmatched are kept with each item, so nothing is lost.</p>
            {TARGETS.map((t) => (
              <label key={t.key} className="row small" style={{ justifyContent: "space-between" }}>
                <span>{t.label}</span>
                <select className="select" style={{ maxWidth: "58%" }} value={mapping[t.key] ?? ""} onChange={(e) => setMap(t.key, e.target.value)} disabled={running}>
                  <option value="">Not imported</option>
                  {table.headers.map((h, i) => (
                    <option key={i} value={i}>
                      {h || `Column ${i + 1}`}
                    </option>
                  ))}
                </select>
              </label>
            ))}
            <div className="table-wrap">
              <table className="mini">
                <thead>
                  <tr>
                    {table.headers.map((h, i) => (
                      <th key={i}>{h}</th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {table.rows.slice(0, 4).map((r, ri) => (
                    <tr key={ri}>
                      {table.headers.map((_, ci) => (
                        <td key={ci}>{r[ci]}</td>
                      ))}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </section>
        )}

        <section className="card pad stack">
          <h2 className="section-title">{mode === "photos" ? "1. Photos" : table ? "3. Photos" : "2. Photos"}</h2>
          <div className="row" style={{ flexWrap: "wrap" }}>
            <label className="btn">
              Select photos
              <input type="file" accept="image/*" multiple hidden onChange={(e) => setFiles([...(e.target.files ?? [])])} disabled={running} />
            </label>
            <label className="btn">
              Select folder
              <input
                type="file"
                multiple
                hidden
                // @ts-expect-error non-standard but widely supported
                webkitdirectory=""
                onChange={(e) => setFiles([...(e.target.files ?? [])].filter((f) => /^image\//.test(f.type) || /\.(jpe?g|png|webp|heic)$/i.test(f.name)))}
                disabled={running}
              />
            </label>
          </div>
          {files.length > 0 && <p className="small muted">{fmtNum(files.length)} photos selected</p>}
        </section>

        {plan && counts && (
          <section className="card pad stack">
            <h2 className="section-title">{mode === "photos" ? "2. Review" : "4. Review"}</h2>
            <ul className="small" style={{ margin: 0, paddingLeft: 18 }}>
              <li>
                {fmtNum(counts.rows)} item(s) to import, {fmtNum(counts.withPhotos)} with photos ({fmtNum(counts.photos)} photos)
              </li>
              {plan.blankRows > 0 && <li>{fmtNum(plan.blankRows)} empty row(s) with only an ID are skipped</li>}
              {plan.ignored.length > 0 && <li>Not imported: {plan.ignored.filter((h) => !/^Column \d+$/.test(h)).join(", ") || "blank columns"}</li>}
              {counts.rows - counts.withPhotos > 0 && <li>{fmtNum(counts.rows - counts.withPhotos)} item(s) have no photo (they'll be imported without one)</li>}
              {counts.missing > 0 && <li style={{ color: "var(--warn)" }}>{fmtNum(counts.missing)} row(s) list photo files that weren't selected</li>}
              {plan.unusedFiles.length > 0 && <li style={{ color: "var(--warn)" }}>{fmtNum(plan.unusedFiles.length)} selected photo(s) didn't match any row</li>}
              {plan.duplicateRefs.length > 0 && (
                <li style={{ color: "var(--neg)" }}>
                  Duplicate IDs in the sheet (only the first of each is imported): {plan.duplicateRefs.slice(0, 8).join(", ")}
                  {plan.duplicateRefs.length > 8 ? "…" : ""}
                </li>
              )}
              {counts.warnings > 0 && <li>{fmtNum(counts.warnings)} row(s) with warnings</li>}
            </ul>
            {(counts.missing > 0 || plan.unusedFiles.length > 0 || counts.warnings > 0) && (
              <details className="more">
                <summary>
                  <Icon name="chevron" size={18} /> Details
                </summary>
                <div className="small stack" style={{ gap: 4, maxHeight: 240, overflow: "auto" }}>
                  {plan.rows
                    .filter((r) => r.missing.length || r.warnings.length)
                    .slice(0, 200)
                    .map((r) => (
                      <div key={r.row}>
                        Row {r.row}
                        {r.externalRef ? ` (${r.externalRef})` : ""}: {[...r.missing.map((m) => `missing ${m}`), ...r.warnings].join("; ")}
                      </div>
                    ))}
                  {plan.unusedFiles.length > 0 && <div>Unmatched photos: {plan.unusedFiles.slice(0, 50).join(", ")}</div>}
                </div>
              </details>
            )}
            {goal && (
              <label className="check small">
                <input type="checkbox" checked={useGoal} onChange={(e) => setUseGoal(e.target.checked)} disabled={running} />
                <span>
                  Set the collection goal to {fmtNum(goal.value)}, from the {goal.column} column
                </span>
              </label>
            )}
            <label className="check small">
              <input type="checkbox" checked={demo} onChange={(e) => setDemo(e.target.checked)} disabled={running} />
              <span>Mark as demo data (can be removed in one step later)</span>
            </label>

            {Object.keys(states).length > 0 && (
              <>
                <div className="progressbar">
                  <div style={{ transform: `scaleX(${(done + failed.length) / counts.rows})` }} />
                </div>
                <p className="small muted">
                  {fmtNum(done)} of {fmtNum(counts.rows)} imported{failed.length ? `, ${failed.length} failed` : ""}
                </p>
              </>
            )}
            {failed.length > 0 && !running && (
              <div className="small stack" style={{ gap: 4, maxHeight: 160, overflow: "auto", color: "var(--neg)" }}>
                {failed.slice(0, 50).map(([row, s]) => (
                  <div key={row}>
                    Row {row}: {s.error}
                  </div>
                ))}
              </div>
            )}
            <div className="row" style={{ flexWrap: "wrap" }}>
              {!running && done + failed.length < counts.rows && (
                <button className="btn primary" onClick={() => run(false)} disabled={counts.rows === 0}>
                  {done ? "Resume import" : `Import ${fmtNum(counts.rows)} item(s)`}
                </button>
              )}
              {running && (
                <button className="btn" onClick={() => (stopRef.current = true)}>
                  <Spinner /> Pause
                </button>
              )}
              {!running && failed.length > 0 && (
                <button className="btn" onClick={() => run(true)}>
                  Retry failed
                </button>
              )}
            </div>
          </section>
        )}

        {/* Only rows that brought photos have anything to index. */}
        {done > 0 && !running && (counts?.photos ?? 0) > 0 && (
          <section className="card pad stack">
            <h2 className="section-title">Make photos searchable</h2>
            <p className="small muted">Imported photos need an image embedding before scans can match them. Runs in small batches and can be resumed.</p>
            <button className="btn primary" onClick={index} disabled={indexMsg !== null && !/^(Paused|Done|All)/.test(indexMsg)}>
              Update search index
            </button>
            {indexMsg && <p className="small">{indexMsg}</p>}
          </section>
        )}
      </main>
    </>
  );
}
