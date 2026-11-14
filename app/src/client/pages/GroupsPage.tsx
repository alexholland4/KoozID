import { useMemo, useState } from "react";
import type { SourceRow } from "../../shared/types";
import { api, errorMessage } from "../api";
import { Dock, ErrorState, fmtNum, Icon, Sheet, Spinner, TopBar, useToast } from "../components/ui";
import { useAsync } from "../hooks";

interface Group {
  name: string;
  total: number;
  members: SourceRow[];
}

/**
 * Leaderboard groups: count several exact sources as one contributor ("Gift from Ana Rivera",
 * "Gift from the Rivera family" -> "The Rivera family"). Each koozie keeps its precise source.
 */
export function GroupsPage() {
  const { data, error, reload, setData } = useAsync(() => api.sources(), []);
  const [find, setFind] = useState("");
  const [picked, setPicked] = useState<string[]>([]);
  const [naming, setNaming] = useState<{ sources: string[]; name: string; previous?: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const toast = useToast();

  const sources = data?.sources ?? [];
  const groups = useMemo(() => {
    const m = new Map<string, Group>();
    for (const s of sources) {
      if (!s.contributor) continue;
      const g = m.get(s.contributor) ?? { name: s.contributor, total: 0, members: [] };
      g.total += s.count;
      g.members.push(s);
      m.set(s.contributor, g);
    }
    return [...m.values()].sort((a, b) => b.total - a.total || a.name.localeCompare(b.name));
  }, [sources]);

  const q = find.trim().toLowerCase();
  const rows = q ? sources.filter((s) => s.name.toLowerCase().includes(q) || s.contributor?.toLowerCase().includes(q)) : sources;
  const toggle = (name: string) => setPicked((p) => (p.includes(name) ? p.filter((x) => x !== name) : [...p, name]));

  const run = async (fn: () => Promise<{ sources: SourceRow[] }>, msg: string) => {
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

  const startCombine = () => {
    const rows = sources.filter((s) => picked.includes(s.name));
    // Joining an existing group keeps its name; otherwise start from the biggest source.
    const existing = rows.find((r) => r.contributor)?.contributor;
    const biggest = [...rows].sort((a, b) => b.count - a.count)[0];
    setNaming({ sources: picked, name: existing ?? biggest?.name ?? "" });
  };

  return (
    <>
      <TopBar title="Leaderboard groups" back="/more" />
      <main className="page">
        <p className="small secondary">
          Combine sources that are really one contributor, like a family or every "Gift from Mom". Each koozie keeps its exact source; the leaderboard, standing badges and
          source filters count them together.
        </p>

        {!data ? (
          error ? (
            <ErrorState message={error} onRetry={reload} />
          ) : (
            <div className="center">
              <Spinner large />
            </div>
          )
        ) : (
          <>
            {groups.length > 0 && (
              <section className="section">
                <h2 className="section-title">Groups ({groups.length})</h2>
                {groups.map((g) => (
                  <div key={g.name} className="list">
                    <div className="list-row compact" style={{ cursor: "default" }}>
                      <Icon name="people" />
                      <span className="grow">
                        <strong className="text">{g.name}</strong>
                        <div className="sub">
                          {fmtNum(g.total)} koozies from {g.members.length} source{g.members.length === 1 ? "" : "s"}
                        </div>
                      </span>
                      <button className="btn ghost small" disabled={busy} onClick={() => setNaming({ sources: g.members.map((m) => m.name), name: g.name, previous: g.name })}>
                        Rename
                      </button>
                    </div>
                    {g.members.map((m) => (
                      <div key={m.name} className="list-row compact member">
                        <span className="grow clamp-2 secondary">{m.name}</span>
                        <span className="mono small muted">{fmtNum(m.count)}</span>
                        <button className="icon-btn" disabled={busy} aria-label={`Take ${m.name} out of ${g.name}`} onClick={() => run(() => api.ungroupSources([m.name]), "Taken out of the group")}>
                          <Icon name="x" size={16} />
                        </button>
                      </div>
                    ))}
                  </div>
                ))}
              </section>
            )}

            <section className="section">
              <h2 className="section-title">Pick sources to combine</h2>
              <div className="search">
                <Icon name="search" size={20} />
                <input className="input" type="search" placeholder="e.g. Rivera, mom" value={find} onChange={(e) => setFind(e.target.value)} aria-label="Find a source" />
              </div>
              {rows.length ? (
                <div className="list">
                  {rows.map((s) => (
                    <label key={s.name} className="list-row compact pick-row">
                      <input type="checkbox" className="radio" checked={picked.includes(s.name)} onChange={() => toggle(s.name)} />
                      <span className="grow">
                        <span className="clamp-2">{s.name}</span>
                        {s.contributor && s.contributor !== s.name && <div className="sub">In “{s.contributor}”</div>}
                      </span>
                      <span className="mono small muted">{fmtNum(s.count)}</span>
                    </label>
                  ))}
                </div>
              ) : (
                <p className="small muted">{q ? `No source matches “${find.trim()}”` : "No sources yet"}</p>
              )}
            </section>
          </>
        )}
      </main>

      {picked.length > 0 && (
        <Dock>
          <button className="btn big" style={{ flex: "0 0 auto" }} onClick={() => setPicked([])}>
            Clear
          </button>
          <button className="btn primary big" onClick={startCombine}>
            {picked.length === 1 ? "Rename on leaderboard" : `Combine ${picked.length} sources`}
          </button>
        </Dock>
      )}

      {naming && (
        <NameSheet
          naming={naming}
          groups={groups}
          sources={sources}
          busy={busy}
          onClose={() => setNaming(null)}
          onSave={async (name) => {
            const ok = await run(() => api.groupSources(name, naming.sources, naming.previous), naming.previous ? "Renamed" : `Combined as “${name}”`);
            if (ok) {
              setNaming(null);
              if (!naming.previous) setPicked([]);
            }
          }}
        />
      )}
    </>
  );
}

function NameSheet({
  naming,
  groups,
  sources,
  busy,
  onClose,
  onSave,
}: {
  naming: { sources: string[]; name: string; previous?: string };
  groups: Group[];
  sources: SourceRow[];
  busy: boolean;
  onClose: () => void;
  onSave: (name: string) => void;
}) {
  const [name, setName] = useState(naming.name);
  const n = name.trim();
  // Joining a group adds its other members to the total.
  const joined = groups.find((g) => g.name.toLowerCase() === n.toLowerCase());
  const counted = new Set([...naming.sources, ...(joined?.members.map((m) => m.name) ?? [])]);
  const total = sources.filter((s) => counted.has(s.name)).reduce((t, s) => t + s.count, 0);
  const others = groups.filter((g) => g.name !== naming.previous).slice(0, 8);

  return (
    <Sheet title={naming.previous ? "Rename group" : "Name on the leaderboard"} onClose={() => !busy && onClose()}>
      <form
        className="stack"
        onSubmit={(e) => {
          e.preventDefault();
          if (n) onSave(n);
        }}
      >
        <input className="input" autoFocus value={name} onChange={(e) => setName(e.target.value)} placeholder="e.g. The Rivera family" aria-label="Leaderboard name" maxLength={200} />
        {!naming.previous && others.length > 0 && (
          <div className="stack tight">
            <span className="small muted">Or add to a group</span>
            <div className="row wrap" style={{ gap: 6 }}>
              {others.map((g) => (
                <button type="button" key={g.name} className="chip" aria-pressed={g.name === n} onClick={() => setName(g.name)}>
                  {g.name}
                </button>
              ))}
            </div>
          </div>
        )}
        {n && (
          <p className="small secondary">
            Shows as one row: <strong className="text">{n}</strong> with {fmtNum(total)} koozie{total === 1 ? "" : "s"}.
          </p>
        )}
        <button className="btn primary big block" disabled={!n || busy}>
          {busy ? <Spinner /> : "Save"}
        </button>
      </form>
    </Sheet>
  );
}
