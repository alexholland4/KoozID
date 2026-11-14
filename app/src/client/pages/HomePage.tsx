import { api } from "../api";
import { Dock, ErrorState, fmtNum, Icon, Logo } from "../components/ui";
import { useAsync } from "../hooks";
import { Link } from "../router";

/** The count, and progress toward the goal when one is set. Shared with the guest home page. */
export function Hero({ data, loading, note }: { data: { total: number; goal: number | null } | null; loading: boolean; note?: string | null }) {
  return (
    <section className="hero" aria-label="Collection size">
      {loading && !data ? (
        <div className="placeholder-block" style={{ height: 88, width: 160 }} />
      ) : (
        <div className="count" aria-live="polite">
          <span className="figure">{data ? fmtNum(data.total) : "0"}</span>
          {data?.goal ? <span className="of">/ {fmtNum(data.goal)}</span> : null}
        </div>
      )}
      <span className="label">Unique koozies</span>
      {data?.goal ? (
        <div className="goal">
          <div className="progressbar" aria-hidden="true">
            <div style={{ transform: `scaleX(${Math.min(data.total / data.goal, 1)})` }} />
          </div>
          <div className="row small secondary">
            <span className="spacer">{data.total >= data.goal ? "Goal reached" : `${fmtNum(data.goal - data.total)} to go`}</span>
            <span className="mono">{Math.floor((100 * data.total) / data.goal)}%</span>
          </div>
        </div>
      ) : null}
      {note && <p className="small secondary pace">{note}</p>}
    </section>
  );
}

export function HomePage() {
  const { data, error, loading, reload } = useAsync(() => api.stats(), []);

  return (
    <>
      <header className="brandbar">
        <Logo />
        <span className="wordmark">KoozID</span>
        <span className="spacer" />
        <Link href="/collection" className="icon-btn" aria-label="Search the collection">
          <Icon name="search" />
        </Link>
        <Link href="/more" className="icon-btn" aria-label="Tools">
          <Icon name="more" />
        </Link>
      </header>

      <main className="page">
        <Hero data={data} loading={loading} />

        {error && !data && <ErrorState message={error} onRetry={reload} />}

        {data && (data.offers > 0 || data.bulk_review > 0 || data.needs_review > 0 || data.no_photo > 0 || data.pending_index > 0) && (
          <div className="list">
            {data.offers > 0 && (
              <Link href="/requests" className="list-row compact">
                <span className="dot review" />
                <span className="grow">Koozie offers to approve</span>
                <span className="mono small secondary">{fmtNum(data.offers)}</span>
                <Icon name="chevron" size={16} />
              </Link>
            )}
            {data.bulk_review > 0 && (
              <Link href="/review" className="list-row compact">
                <span className="dot review" />
                <span className="grow">Photos to review</span>
                <span className="mono small secondary">{fmtNum(data.bulk_review)}</span>
                <Icon name="chevron" size={16} />
              </Link>
            )}
            {data.needs_review > 0 && (
              <Link href="/collection?status=needs_review" className="list-row compact">
                <span className="dot review" />
                <span className="grow">Awaiting review</span>
                <span className="mono small secondary">{fmtNum(data.needs_review)}</span>
                <Icon name="chevron" size={16} />
              </Link>
            )}
            {data.no_photo > 0 && (
              <Link href="/collection?photo=none" className="list-row compact">
                <span className="dot" />
                <span className="grow">Without a photo</span>
                <span className="mono small secondary">{fmtNum(data.no_photo)}</span>
                <Icon name="chevron" size={16} />
              </Link>
            )}
            {data.pending_index > 0 && (
              <Link href="/more" className="list-row compact">
                <span className="dot" />
                <span className="grow">Photos not searchable yet</span>
                <span className="mono small secondary">{fmtNum(data.pending_index)}</span>
                <Icon name="chevron" size={16} />
              </Link>
            )}
          </div>
        )}

        {data && data.recent.length > 0 && (
          <section className="section">
            <div className="row">
              <h2 className="section-title spacer">Recently added</h2>
              <Link href="/collection" className="btn ghost small">
                View all
              </Link>
            </div>
            <div className="recent">
              {data.recent.slice(0, 4).map((it) => (
                <Link key={it.id} href={`/items/${it.id}`}>
                  <span className="code">{it.code}</span>
                  <span className="clamp-1">{it.description || "No description"}</span>
                </Link>
              ))}
            </div>
          </section>
        )}

        {data && data.total === 0 && data.needs_review === 0 && (
          <p className="secondary small">
            Nothing catalogued yet. Scan a koozie to start, or import an existing spreadsheet from <Link href="/more" style={{ textDecoration: "underline" }}>Tools</Link>.
          </p>
        )}
      </main>

      <Dock>
        <Link href="/collection" className="btn big" style={{ flex: "0 0 auto", paddingInline: 20 }}>
          Collection
        </Link>
        <Link href="/scan" className="btn primary big">
          <Icon name="camera" /> Scan koozie
        </Link>
      </Dock>
    </>
  );
}
