import { useEffect, useRef, useState } from "react";
import type { ItemSummary } from "../../shared/types";
import { api, errorMessage, pub } from "../api";
import { BarList } from "../components/charts";
import { ErrorState, fmtDate, fmtNum, Icon, Sheet, Spinner, Thumb, TopBar } from "../components/ui";
import { SEARCH_HINTS, useAsync, useDebounced, useTypewriter } from "../hooks";
import { StandingBadge } from "./GuestPages";
import { Link, navigate, useLocation } from "../router";
import { matchesSource } from "../standing";

const SORTS = [
  { v: "id:desc", label: "Newest" },
  { v: "id:asc", label: "Oldest" },
  { v: "acquired:desc", label: "Acquired" },
  { v: "updated:desc", label: "Edited" },
  { v: "description:asc", label: "A to Z" },
];

// Guests can't sort by edit date; that's private bookkeeping.
const GUEST_SORTS = SORTS.filter((s) => s.v !== "updated:desc");

// Spreadsheet columns: header, sort key, and the direction a first click sorts in.
const COLUMNS: [string, string, "asc" | "desc"][] = [
  ["Koozie ID", "id", "asc"],
  ["Date Acquired", "acquired", "desc"],
  ["Source", "source", "asc"],
  ["Description", "description", "asc"],
  ["Color", "color", "asc"],
  ["Size", "size", "asc"],
  ["Base", "base", "asc"],
  ["City", "city", "asc"],
  ["State", "state", "asc"],
  ["Country", "country", "asc"],
  ["Photo", "photos", "desc"],
];

type Filter = "all" | "needs_review" | "no_photo";
const FILTERS: [Filter, string][] = [
  ["all", "All"],
  ["needs_review", "Review"],
  ["no_photo", "No photo"],
];

type View = "list" | "grid" | "sheet";
const VIEWS: [View, string, string][] = [
  ["list", "list", "Show as list"],
  ["grid", "grid", "Show as grid"],
  ["sheet", "table", "Show as spreadsheet"],
];
const VIEW_KEY = "koozid:collection-view";
const savedView = (): View => {
  try {
    const v = localStorage.getItem(VIEW_KEY);
    return v === "grid" || v === "sheet" ? v : "list";
  } catch {
    return "list";
  }
};

/** Dates as the original spreadsheet writes them: 11/18/2025. */
const sheetDate = (iso: string) => {
  const [y, m, d] = iso.split("-").map(Number);
  return `${m}/${d}/${y}`;
};

export function CollectionPage({ deleted = false, guest = false }: { deleted?: boolean; guest?: boolean }) {
  const { search } = useLocation();
  const params = new URLSearchParams(search);
  const [q, setQ] = useState(params.get("q") ?? "");
  const [filter, setFilter] = useState<Filter>(params.get("photo") === "none" ? "no_photo" : params.get("status") === "needs_review" ? "needs_review" : "all");
  const [sort, setSort] = useState(params.get("sort") ?? "id:desc");
  const [source, setSource] = useState(params.get("source") ?? "");
  const [pickSource, setPickSource] = useState(false);
  const typed = useTypewriter(SEARCH_HINTS, guest && !q);
  const [view, setView] = useState(savedView);
  const dq = useDebounced(q.trim(), 300);

  const [items, setItems] = useState<ItemSummary[]>([]);
  const [total, setTotal] = useState<number | null>(null);
  const [next, setNext] = useState<number | null>(0);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const seq = useRef(0);
  const sentinel = useRef<HTMLDivElement>(null);

  // Keep filters in the URL so "back" from an item restores the view.
  useEffect(() => {
    const p = new URLSearchParams();
    if (dq) p.set("q", dq);
    if (filter === "needs_review") p.set("status", "needs_review");
    if (filter === "no_photo") p.set("photo", "none");
    if (sort !== "id:desc") p.set("sort", sort);
    if (source) p.set("source", source);
    const qs = p.toString();
    history.replaceState(null, "", `${location.pathname}${qs ? `?${qs}` : ""}`);
  }, [dq, filter, sort, source]);

  const load = async (offset: number) => {
    const id = ++seq.current;
    setLoading(true);
    setError(null);
    const [s, o] = sort.split(":");
    try {
      const res = guest
        ? await pub.list({ q: dq, source: source || undefined, sort: s, order: o as "asc" | "desc", offset, limit: 48 })
        : await api.list({
            q: dq,
            status: filter === "needs_review" ? "needs_review" : "all",
            photo: filter === "no_photo" ? "none" : undefined,
            sort: s,
            order: o as "asc" | "desc",
            offset,
            limit: 48,
            deleted,
            source: source || undefined,
          });
      if (id !== seq.current) return;
      setItems((prev) => (offset === 0 ? res.items : [...prev, ...res.items]));
      setTotal(res.total);
      setNext(res.next_offset);
    } catch (e) {
      if (id === seq.current) setError(errorMessage(e));
    } finally {
      if (id === seq.current) setLoading(false);
    }
  };

  useEffect(() => {
    load(0);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [dq, filter, sort, deleted, source]);

  // Infinite scroll.
  useEffect(() => {
    const el = sentinel.current;
    if (!el) return;
    const io = new IntersectionObserver((entries) => {
      if (entries[0].isIntersecting && next !== null && next > 0 && !loading) load(next);
    });
    io.observe(el);
    return () => io.disconnect();
  });

  const title = deleted ? "Recently deleted" : "Collection";

  return (
    <>
      <TopBar
        title={title}
        back="/"
        end={
          <div className="view-switch" role="group" aria-label="View">
            {VIEWS.map(([v, icon, label]) => (
              <button
                key={v}
                className="icon-btn"
                aria-label={label}
                aria-pressed={view === v}
                onClick={() => {
                  setView(v);
                  try {
                    localStorage.setItem(VIEW_KEY, v);
                  } catch {
                    // Not remembered; fine.
                  }
                }}
              >
                <Icon name={icon} />
              </button>
            ))}
          </div>
        }
      />
      <main className="page no-dock">
        <div className="search">
          <Icon name="search" size={20} />
          <input
            className="input"
            type="search"
            inputMode="search"
            placeholder={guest ? typed : "Search"}
            value={q}
            onChange={(e) => setQ(e.target.value)}
            aria-label="Search the collection"
          />
        </div>

        {!deleted && (
          <div className="row" style={{ marginTop: -12 }}>
            {!guest && (
              <div className="tabs" role="group" aria-label="Filter">
                {FILTERS.map(([v, l]) => (
                  <button key={v} className="tab" aria-pressed={filter === v} onClick={() => setFilter(v)}>
                    {l}
                  </button>
                ))}
              </div>
            )}
            <span className="spacer" />
            <select className="select compact" value={sort} onChange={(e) => setSort(e.target.value)} aria-label="Sort">
              {/* A column sort from the spreadsheet headers shows as its own entry. */}
              {!SORTS.some((s) => s.v === sort) && <option value={sort}>By {COLUMNS.find(([, k]) => k === sort.split(":")[0])?.[0] ?? "column"}</option>}
              {(guest ? GUEST_SORTS : SORTS).map((s) => (
                <option key={s.v} value={s.v}>
                  {s.label}
                </option>
              ))}
            </select>
          </div>
        )}

        {!deleted && (
          <div className="row" style={{ marginTop: -12 }}>
            {source ? (
              <div className="stack tight" style={{ minWidth: 0 }}>
                <button className="chip" onClick={() => setSource("")} aria-label={`Stop filtering by ${source}`}>
                  <span className="clamp-1">From: {source}</span>
                  <Icon name="x" size={14} />
                </button>
                <StandingBadge name={source} />
              </div>
            ) : (
              <button className="chip ghost" onClick={() => setPickSource(true)}>
                <Icon name="plus" size={14} /> Filter by source
              </button>
            )}
          </div>
        )}

        {deleted && (
          <p className="small secondary">Deleted koozies don't count and aren't matched. They and their photos are erased automatically after 30 days. Open one to restore it or erase it now.</p>
        )}

        <div className="row small muted" style={{ marginTop: -12, minHeight: 20 }} aria-live="polite">
          {total !== null && (
            <span>
              {fmtNum(total)} {dq ? "match" : deleted ? "deleted item" : "koozie"}
              {total === 1 ? "" : dq ? "es" : "s"}
            </span>
          )}
          {loading && <Spinner />}
        </div>

        {error && items.length === 0 ? (
          <ErrorState message={error} onRetry={() => load(0)} />
        ) : items.length === 0 && !loading ? (
          <div className="center empty">
            <p>{dq ? `Nothing matches “${dq}”` : deleted ? "Nothing here" : "No koozies yet"}</p>
            {!deleted && !dq && !guest && (
              <button className="btn primary" onClick={() => navigate("/scan")}>
                <Icon name="camera" /> Scan a koozie
              </button>
            )}
          </div>
        ) : view === "sheet" ? (
          // The original spreadsheet's columns, in its order (Color now has its own column).
          <div className="sheet-wrap">
            <table className="sheet-table">
              <thead>
                <tr>
                  {COLUMNS.map(([h, key, first]) => {
                    const [sk, so] = sort.split(":");
                    const on = sk === key;
                    return (
                      <th key={h} scope="col" aria-sort={on ? (so === "asc" ? "ascending" : "descending") : "none"}>
                        <button className="sort-head" onClick={() => setSort(`${key}:${on ? (so === "asc" ? "desc" : "asc") : first}`)}>
                          {h}
                          <span className="arrow" aria-hidden="true">
                            {on ? (so === "asc" ? "▲" : "▼") : ""}
                          </span>
                        </button>
                      </th>
                    );
                  })}
                </tr>
              </thead>
              <tbody>
                {items.map((it) => (
                  <tr key={it.id} onClick={() => navigate(`/items/${it.id}`)}>
                    <th scope="row">
                      <Link href={`/items/${it.id}`} className="code" onClick={(e) => e.stopPropagation()}>
                        {it.code}
                      </Link>
                      {it.status === "needs_review" && <span className="dot review" title="Needs review" />}
                    </th>
                    <td>{sheetDate(it.acquired_on)}</td>
                    <td className="wide">{it.acquired_from}</td>
                    <td className="wide">{it.description}</td>
                    <td>{it.color}</td>
                    <td>{it.size}</td>
                    <td>{it.base}</td>
                    <td>{it.city}</td>
                    <td>{it.state}</td>
                    <td>{it.country}</td>
                    <td className="pic">{it.thumb_photo_id ? <Thumb photoId={it.thumb_photo_id} alt="" /> : null}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : view === "list" ? (
          <div className="rows">
            {items.map((it) => (
              <Link key={it.id} href={`/items/${it.id}`} className="item-row">
                <div className="pic">
                  <Thumb photoId={it.thumb_photo_id} alt="" />
                </div>
                <div className="body">
                  <div className="row" style={{ gap: 8 }}>
                    <span className="code">{it.code}</span>
                    {it.status === "needs_review" && <span className="dot review" title="Needs review" />}
                  </div>
                  <div className="clamp-2">{it.description || <span className="muted">No description</span>}</div>
                  <div className="small muted clamp-1">{[it.acquired_from, fmtDate(it.acquired_on)].filter(Boolean).join(" · ")}</div>
                </div>
              </Link>
            ))}
          </div>
        ) : (
          <div className="grid">
            {items.map((it) => (
              <Link key={it.id} href={`/items/${it.id}`} className="tile">
                <div style={{ position: "relative" }}>
                  <Thumb photoId={it.thumb_photo_id} alt={it.description || it.code} />
                  {it.status === "needs_review" && <span className="flag" title="Needs review" />}
                </div>
                <div className="meta">
                  <span className="code">{it.code}</span>
                  <span className="desc clamp-2">{it.description || "No description"}</span>
                </div>
              </Link>
            ))}
          </div>
        )}
        {error && items.length > 0 && (
          <button className="btn block" onClick={() => next !== null && load(next)}>
            Couldn't load more. Retry
          </button>
        )}
        {/* overflow-anchor: none, or the browser keeps this in view as rows load and loads everything. */}
        {pickSource && (
          <SourcePicker
            onClose={() => setPickSource(false)}
            onPick={(name) => {
              setSource(name);
              setPickSource(false);
            }}
          />
        )}
        <div ref={sentinel} style={{ height: 1, overflowAnchor: "none" }} />
      </main>
    </>
  );
}

/** Every source (who gave it / where it was bought) with its count, searchable. */
function SourcePicker({ onClose, onPick }: { onClose: () => void; onPick: (name: string) => void }) {
  const { data, error, reload } = useAsync(() => pub.insights(), []);
  const [find, setFind] = useState("");
  const f = find.trim().toLowerCase();
  const rows = (data?.sources ?? []).filter((s) => !f || matchesSource(data!, s, f));
  return (
    <Sheet title="Filter by source" onClose={onClose}>
      <div className="search">
        <Icon name="search" size={20} />
        <input className="input" type="search" autoFocus placeholder="A name, a store, a trip" value={find} onChange={(e) => setFind(e.target.value)} aria-label="Find a source" />
      </div>
      {error && !data ? (
        <ErrorState message={error} onRetry={reload} />
      ) : !data ? (
        <div className="center">
          <Spinner />
        </div>
      ) : rows.length ? (
        <BarList rows={rows} onPick={onPick} stacked />
      ) : (
        <p className="small muted">No source matches “{find.trim()}”</p>
      )}
    </Sheet>
  );
}
