import { useState } from "react";
import { pub } from "../api";
import { BarList, GrowthChart, MonthlyChart } from "../components/charts";
import { ErrorState, fmtDate, fmtNum, Icon, Spinner, TopBar } from "../components/ui";
import { useAsync } from "../hooks";
import { navigate } from "../router";
import { matchesSource } from "../standing";

/** Collection stats for everyone: counts, growth, months, places and contributors. */
export function StatsPage() {
  const { data, error, loading, reload } = useAsync(() => pub.insights(), []);
  const [allStates, setAllStates] = useState(false);
  const [who, setWho] = useState("");

  if (!data) {
    return (
      <>
        <TopBar title="Stats" back="/" />
        <main className="page no-dock">
          {loading ? (
            <div className="center">
              <Spinner large />
            </div>
          ) : (
            <ErrorState message={error ?? "Couldn't load the stats"} onRetry={reload} />
          )}
        </main>
      </>
    );
  }

  const biggest = data.days.reduce<{ day: string; count: number } | null>((b, d) => (!b || d.count > b.count ? d : b), null);
  const thisMonth = new Date().toISOString().slice(0, 7);
  const monthCount = data.days.filter((d) => d.day.startsWith(thisMonth)).reduce((n, d) => n + d.count, 0);
  const q = who.trim().toLowerCase();
  // Ranks come from the full list, so a search still shows where someone stands; ties share a rank.
  const ranked = data.sources.map((s) => ({ ...s, rank: 1 + data.sources.filter((o) => o.count > s.count).length }));
  // A search finds a group by any of its combined sources too ("Ana" finds "The Rivera family").
  const people = q ? ranked.filter((s) => matchesSource(data, s, q)) : ranked.slice(0, 10);
  const bySource = (name: string) => navigate(`/collection?source=${encodeURIComponent(name)}`);

  const tiles: [string, string, string?][] = [
    ["Koozies", fmtNum(data.total), data.goal ? `of ${fmtNum(data.goal)} goal` : undefined],
    ["Added this month", fmtNum(monthCount)],
    ["Biggest day", biggest ? fmtNum(biggest.count) : "–", biggest ? fmtDate(biggest.day) : undefined],
    ["Contributors & sources", fmtNum(data.sources.length)],
    ["States", fmtNum(data.unique_states), data.unique_countries > 1 ? `${fmtNum(data.unique_countries)} countries` : undefined],
    ["Cities", fmtNum(data.unique_cities)],
  ];

  return (
    <>
      <TopBar title="Stats" back="/" />
      <main className="page no-dock">
        <div className="grid-2">
          {tiles.map(([label, value, sub]) => (
            <div key={label} className="card pad stat-tile">
              <span className="small secondary">{label}</span>
              <span className="value">{value}</span>
              {sub && <span className="small muted">{sub}</span>}
            </div>
          ))}
        </div>

        <section className="card pad stack">
          <h2 className="section-title">Collection growth</h2>
          <GrowthChart days={data.days} />
        </section>

        <section className="card pad stack">
          <h2 className="section-title">Added per month</h2>
          <MonthlyChart days={data.days} />
        </section>

        {data.states.length > 0 && (
          <section className="card pad stack">
            <h2 className="section-title">Top states</h2>
            <BarList rows={allStates ? data.states : data.states.slice(0, 10)} />
            {data.states.length > 10 && (
              <button className="btn ghost small" style={{ alignSelf: "flex-start" }} onClick={() => setAllStates((v) => !v)}>
                {allStates ? "Show top 10" : `Show all ${data.states.length}`}
              </button>
            )}
          </section>
        )}

        {data.sources.length > 0 && (
          <section className="card pad stack">
            <h2 className="section-title">Leaderboard: contributors & sources</h2>
            <div className="search">
              <Icon name="search" size={20} />
              <input
                className="input"
                type="search"
                placeholder="Find a name or place"
                value={who}
                onChange={(e) => setWho(e.target.value)}
                aria-label="Find a contributor or source"
              />
            </div>
            {people.length ? <BarList rows={people} onPick={bySource} stacked /> : <p className="small muted">Nobody matches “{who.trim()}”</p>}
            <p className="small muted">Tap a name to see their koozies</p>
          </section>
        )}
      </main>
    </>
  );
}
