import { Fragment, useEffect, useRef, useState } from "react";
import type { ItemSummary, PublicCheck } from "../../shared/types";
import { errorMessage, pub, photoUrl } from "../api";
import { BandBadge, Dock, ErrorState, Icon, Logo, ScanFrame, Spinner, Thumb, TopBar, useToast } from "../components/ui";
import { SEARCH_HINTS, useAsync, useTypewriter } from "../hooks";
import { prepareImage } from "../image";
import { Link, navigate } from "../router";
import { paceLine, sharedInsights, standing, standingLabel } from "../standing";
import { Hero } from "./HomePage";

const SIDE_LABEL = { front: "Front", back: "Back", other: "Other view" } as const;
const CAROUSEL_SPEED = 28; // px per second
const TOUCH_RESUME_MS = 2500;

/**
 * Recently added koozies, drifting sideways on their own. Pauses while the pointer is over it,
 * while it's touched (resuming shortly after) or focused, and stays still for reduced motion.
 * The list is rendered twice so the drift can wrap around seamlessly; it can still be swiped.
 */
function Carousel({ items }: { items: ItemSummary[] }) {
  const ref = useRef<HTMLDivElement>(null);
  const paused = useRef(false);
  const resumeTimer = useRef<number | undefined>(undefined);
  const loop = items.length > 2;

  useEffect(() => {
    const el = ref.current;
    if (!el || !loop || matchMedia("(prefers-reduced-motion: reduce)").matches) return;
    let raf = 0;
    let last = performance.now();
    // Browsers round scrollLeft, so the fractional position is kept here.
    let pos = el.scrollLeft;
    const tick = (now: number) => {
      const dt = Math.min(now - last, 100);
      last = now;
      // Follow manual scrolling (swipes, trackpads, keyboard) instead of snapping back.
      if (paused.current || document.hidden || Math.abs(el.scrollLeft - pos) > 2) pos = el.scrollLeft;
      else {
        const half = el.scrollWidth / 2;
        pos += (CAROUSEL_SPEED * dt) / 1000;
        if (pos >= half) pos -= half;
        el.scrollLeft = pos;
      }
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => {
      cancelAnimationFrame(raf);
      clearTimeout(resumeTimer.current);
    };
  }, [loop, items]);

  const pause = () => {
    clearTimeout(resumeTimer.current);
    paused.current = true;
  };
  const resume = (delay = 0) => {
    clearTimeout(resumeTimer.current);
    resumeTimer.current = window.setTimeout(() => (paused.current = false), delay);
  };

  const tile = (it: ItemSummary, copy: boolean) => (
    <Link key={`${copy ? "b" : "a"}${it.id}`} href={`/items/${it.id}`} className="tile" aria-hidden={copy || undefined} tabIndex={copy ? -1 : undefined}>
      <Thumb photoId={it.thumb_photo_id} alt={copy ? "" : it.description || it.code} />
      <div className="meta">
        <span className="code">{it.code}</span>
        <span className="desc clamp-2">{it.description || "No description"}</span>
      </div>
    </Link>
  );

  return (
    <div
      ref={ref}
      className="carousel"
      aria-label="Recently added koozies"
      onPointerEnter={(e) => e.pointerType === "mouse" && pause()}
      onPointerLeave={(e) => e.pointerType === "mouse" && resume()}
      onTouchStart={pause}
      onTouchEnd={() => resume(TOUCH_RESUME_MS)}
      onFocus={pause}
      onBlur={() => resume()}
    >
      {items.map((it) => tile(it, false))}
      {loop && items.map((it) => tile(it, true))}
    </div>
  );
}

/** The public front page: the count, a search box and the latest additions. */
export function GuestHome() {
  const { data, error, loading, reload } = useAsync(() => pub.stats(), []);
  // A fresh random handful each visit.
  const sample = useAsync(() => pub.sample(12), []);
  const today = new Date().toLocaleDateString("en-CA"); // the visitor's own date, YYYY-MM-DD
  const otd = useAsync(() => pub.onThisDay(today), [today]);
  const [q, setQ] = useState("");
  const hint = useTypewriter(SEARCH_HINTS, !q);
  const [rolling, setRolling] = useState(false);
  const toast = useToast();

  const random = async () => {
    setRolling(true);
    try {
      navigate(`/items/${(await pub.random()).id}`);
    } catch (e) {
      toast(errorMessage(e));
      setRolling(false);
    }
  };

  return (
    <>
      <header className="brandbar">
        <Logo />
        <span className="wordmark">KoozID</span>
        <span className="spacer" />
        <a href="/signin" className="btn ghost small">
          Sign in
        </a>
      </header>

      <main className="page">
        <Hero data={data} loading={loading} note={data && paceLine(data.total, data.goal, data.last_90_days)} />

        <form
          className="search"
          role="search"
          onSubmit={(e) => {
            e.preventDefault();
            navigate(`/collection${q.trim() ? `?q=${encodeURIComponent(q.trim())}` : ""}`);
          }}
        >
          <Icon name="search" size={20} />
          <input
            className="input"
            type="search"
            inputMode="search"
            enterKeyHint="search"
            placeholder={hint}
            value={q}
            onChange={(e) => setQ(e.target.value)}
            aria-label="Search the collection"
          />
        </form>

        {/* Contributing starts with checking the koozie is new, so it covers "Do we have it?" too. */}
        <nav className="home-actions" aria-label="Things to do">
          <Link href="/contribute" className="btn primary big block">
            <Icon name="plus" /> Contribute a koozie
          </Link>
          <div className="grid-2">
            <button className="btn big" onClick={random} disabled={rolling}>
              {rolling ? <Spinner /> : <Icon name="shuffle" />} Random koozie
            </button>
            <Link href="/stats" className="btn big">
              <Icon name="chart" /> Stats
            </Link>
          </div>
        </nav>

        {error && !data && <ErrorState message={error} onRetry={reload} />}

        {sample.data && sample.data.items.length > 0 && (
          <section className="section">
            <div className="row">
              <h2 className="section-title spacer">From the collection</h2>
              <Link href="/collection" className="btn ghost small">
                View all
              </Link>
            </div>
            <Carousel items={sample.data.items} />
          </section>
        )}

        {otd.data && otd.data.groups.length > 0 && (
          <section className="section otd">
            <h2 className="section-title">On this day</h2>
            {otd.data.groups.map((g) => (
              <div key={g.date} className="group">
                <span className="small">
                  {g.label} <span className="muted">· {g.count === 1 ? "1 koozie" : `${g.count} koozies`}</span>
                </span>
                <div className="strip">
                  {g.items.map((it) => (
                    <Link key={it.id} href={`/items/${it.id}`} aria-label={`${it.code}: ${it.description}`}>
                      <Thumb photoId={it.thumb_photo_id} alt="" />
                    </Link>
                  ))}
                </div>
              </div>
            ))}
          </section>
        )}
      </main>

      <Dock>
        <Link href="/collection" className="btn primary big">
          Browse the collection
        </Link>
      </Dock>
    </>
  );
}

/** One koozie, read-only, with only the fields guests may see. */
export function GuestItemPage({ id }: { id: number }) {
  const { data: item, error, loading, reload } = useAsync(() => pub.item(id), [id]);
  const [photoIdx, setPhotoIdx] = useState(0);

  if (!item) {
    return (
      <>
        <TopBar title="Koozie" back="/collection" />
        <main className="page no-dock">
          {loading ? (
            <div className="center">
              <Spinner large />
            </div>
          ) : (
            <ErrorState message={error ?? "Not found"} onRetry={reload} />
          )}
        </main>
      </>
    );
  }

  const photo = item.photos[Math.min(photoIdx, item.photos.length - 1)];
  const where = [item.city, item.state, item.country].filter(Boolean).join(", ");
  const hasBack = item.photos.some((p) => p.side === "back");
  const facts: [string, string | null][] = [
    ["Source", item.acquired_from],
    ["Color", item.color],
    ["Size", item.size],
    ["Base", item.base],
    ["Where", where || null],
    ["Printed text", item.visible_text],
    ["Back", item.back_same && !hasBack ? "Same as the front" : null],
  ];

  return (
    <>
      <TopBar title={item.code} back="/collection" />
      <main className="page no-dock">
        <div className="stack">
          <div className="viewer">
            {photo ? (
              <img src={photoUrl(photo.id, "full")} alt={item.description || item.code} />
            ) : (
              <div className="center" style={{ height: "100%" }}>
                <p className="secondary small">No photo yet</p>
              </div>
            )}
            {photo && <span className="side">{SIDE_LABEL[photo.side]}</span>}
          </div>
          {item.photos.length > 1 && (
            <div className="photo-strip">
              {item.photos.map((p, i) => (
                <button key={p.id} aria-current={i === photoIdx} onClick={() => setPhotoIdx(i)} aria-label={`${SIDE_LABEL[p.side]} photo`}>
                  <Thumb photoId={p.id} alt="" />
                </button>
              ))}
            </div>
          )}
        </div>

        <section className="stack tight">
          <span className="code" style={{ fontSize: 15 }}>
            {item.code}
          </span>
          <p style={{ fontSize: 17, lineHeight: "24px" }}>{item.description || <span className="muted">No description</span>}</p>
        </section>

        {facts.some(([, v]) => v) && (
          <section className="card kv">
            {facts
              .filter(([, v]) => v)
              .map(([k, v]) => (
                <Fragment key={k}>
                  <div className="k">{k}</div>
                  {k === "Source" ? (
                    <div className="stack tight">
                      <Link href={`/collection?source=${encodeURIComponent(v!)}`} style={{ textDecoration: "underline", textUnderlineOffset: 3 }}>
                        {v}
                      </Link>
                      <StandingBadge name={v!} />
                    </div>
                  ) : (
                    <div>{v}</div>
                  )}
                </Fragment>
              ))}
          </section>
        )}
      </main>
    </>
  );
}

/** "A top 5 contributor (#4)" for the notable sources; nothing for the rest. */
export function StandingBadge({ name }: { name: string }) {
  const [label, setLabel] = useState<string | null>(null);
  useEffect(() => {
    let live = true;
    sharedInsights().then(
      (ins) => {
        const st = standing(ins, name);
        if (live) setLabel(st && standingLabel(st) ? `${standingLabel(st)} · ${st.count} koozies` : null);
      },
      () => {},
    );
    return () => {
      live = false;
    };
  }, [name]);
  if (!label) return null;
  return (
    <span className="badge-line">
      <Icon name="star" size={14} /> {label}
    </span>
  );
}

type CheckState = { k: "idle"; error?: string } | { k: "checking"; url: string } | { k: "done"; url: string; res: PublicCheck };

/**
 * "Do we have this one?" for visitors: photograph a koozie and see whether it's in the collection.
 * One AI call per check, capped per day on the server; the photo isn't saved.
 */
export function CheckPage() {
  const [st, setSt] = useState<CheckState>({ k: "idle" });
  const cameraRef = useRef<HTMLInputElement>(null);
  const libraryRef = useRef<HTMLInputElement>(null);
  const url = st.k === "idle" ? null : st.url;
  useEffect(() => () => void (url && URL.revokeObjectURL(url)), [url]);

  const onFile = async (file: File | undefined) => {
    if (!file) return;
    try {
      const img = await prepareImage(file);
      setSt({ k: "checking", url: img.previewUrl });
      const res = await pub.check(img.full);
      setSt({ k: "done", url: img.previewUrl, res });
    } catch (e) {
      setSt({ k: "idle", error: errorMessage(e) });
    }
  };

  let content: React.ReactNode;
  if (st.k === "idle") {
    content = (
      <div className="capture">
        {st.error && (
          <div className="notice" role="alert">
            <span className="dot strong" />
            <span className="body">{st.error}</span>
          </div>
        )}
        <ScanFrame />
        <div className="stack tight">
          <h2 style={{ fontSize: 20, lineHeight: "26px" }}>Found a koozie?</h2>
          <span className="secondary small">Snap the front and we'll check the collection. Your photo isn't saved.</span>
        </div>
        <div className="capture-actions">
          <button className="btn primary big block" onClick={() => cameraRef.current?.click()}>
            <Icon name="camera" /> Take photo
          </button>
          <button className="btn big block" onClick={() => libraryRef.current?.click()}>
            Choose from library
          </button>
        </div>
      </div>
    );
  } else if (st.k === "checking") {
    content = (
      <div className="processing">
        <div className="shot">
          <img src={st.url} alt="Your photo" />
        </div>
        <div className="status" role="status" aria-live="polite">
          <Spinner /> <span>Checking the collection</span>
        </div>
      </div>
    );
  } else {
    const { res } = st;
    const top = res.matches[0];
    const [title, sub] =
      res.verdict === "have"
        ? ["Yep, it's in the collection!", `Looks like ${top.item.code}`]
        : res.verdict === "maybe"
          ? ["Maybe! These look close", "Compare them and see"]
          : ["Nope, not in the collection yet!", "It would make a great addition"];
    content = (
      <>
        <section className="check-result" aria-live="polite">
          <div className="shot">
            <img src={st.url} alt="Your photo" />
          </div>
          <div className="stack tight">
            <div className="row" style={{ gap: 8, alignItems: "flex-start" }}>
              <span className={`dot ${res.verdict === "have" ? "ok" : res.verdict === "maybe" ? "possible" : ""}`} style={{ marginTop: 9 }} />
              <h1 className="verdict">{title}</h1>
            </div>
            <p className="secondary small">{sub}</p>
          </div>
        </section>
        {res.matches.length > 0 && (
          <div className="rows">
            {res.matches.map((m) => (
              <Link key={m.item.id} href={`/items/${m.item.id}`} className="item-row">
                <div className="pic">
                  <Thumb photoId={m.item.thumb_photo_id} alt="" />
                </div>
                <div className="body">
                  <div className="row" style={{ gap: 8 }}>
                    <span className="code">{m.item.code}</span>
                    <BandBadge band={m.band} />
                  </div>
                  <div className="clamp-2">{m.item.description || <span className="muted">No description</span>}</div>
                </div>
              </Link>
            ))}
          </div>
        )}
        {res.verdict !== "have" && (
          <Link href={`/contribute/send?checked=${res.verdict}`} className="notice contribute-cta">
            <Icon name="box" size={18} />
            <span className="body">
              <strong>{res.verdict === "new" ? "Want to add it to the collection?" : "If it's not one of these, it could be new!"}</strong>
              <span>Send it in and be part of the world record</span>
            </span>
            <Icon name="chevron" size={16} />
          </Link>
        )}
        <div className="stack tight">
          <span className="small secondary">Check another</span>
          <div className="grid-2">
            <button className="btn big" onClick={() => cameraRef.current?.click()}>
              <Icon name="camera" /> Take photo
            </button>
            <button className="btn big" onClick={() => libraryRef.current?.click()}>
              <Icon name="image" /> From library
            </button>
          </div>
        </div>
      </>
    );
  }

  return (
    <>
      <TopBar title="Do we have this one?" back="/" />
      <main className="page no-dock">{content}</main>
      {/* Mounted once, outside the changing content, so a photo taken from any screen arrives. */}
      <input ref={cameraRef} type="file" accept="image/*" capture="environment" hidden onChange={(e) => (onFile(e.target.files?.[0]), (e.target.value = ""))} />
      <input ref={libraryRef} type="file" accept="image/*" hidden onChange={(e) => (onFile(e.target.files?.[0]), (e.target.value = ""))} />
    </>
  );
}
