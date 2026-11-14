import { useState, type FormEvent } from "react";
import type { ContributeInfo, ContributionKind } from "../../shared/types";
import { EMAIL_RE, QUANTITY_LABEL } from "../../shared/contribute";
import { errorMessage, pub } from "../api";
import { ErrorState, fmtNum, Icon, Spinner, TopBar } from "../components/ui";
import { useAsync } from "../hooks";
import { Link, useLocation } from "../router";

const external = { target: "_blank", rel: "noopener noreferrer" } as const;
const ME_KEY = "koozid:me";

/** Name and email from an earlier offer on this device, so a second form is already filled in. */
function remembered(): { name: string; email: string } {
  try {
    const v = JSON.parse(localStorage.getItem(ME_KEY) ?? "{}");
    return { name: typeof v.name === "string" ? v.name : "", email: typeof v.email === "string" ? v.email : "" };
  } catch {
    return { name: "", email: "" };
  }
}

function useContribute() {
  return useAsync(() => pub.contribute(), []);
}

/** Loading and error states shared by the three pages. */
function Shell({ title, back, data, error, reload, children }: { title: string; back: string; data: ContributeInfo | null; error: string | null; reload: () => void; children: (d: ContributeInfo) => React.ReactNode }) {
  return (
    <>
      <TopBar title={title} back={back} />
      <main className="page no-dock">
        {data ? (
          children(data)
        ) : error ? (
          <ErrorState message={error} onRetry={reload} />
        ) : (
          <div className="center">
            <Spinner large />
          </div>
        )}
      </main>
    </>
  );
}

/** "Be part of the world record": send one you have, or gift one from the wish list. */
export function ContributePage() {
  const { data, error, reload } = useContribute();
  return (
    <Shell title="Contribute" back="/" data={data} error={error} reload={reload}>
      {(d) => (
        <>
          <section className="choice-card">
            <header className="choice-head">
              <h1>Be part of the world record</h1>
              <p>{d.goal && d.total < d.goal ? `Help us reach ${fmtNum(d.goal)} koozies!` : "Help the collection keep growing!"}</p>
            </header>
            <Link href="/contribute/send" className="choice">
              <Icon name="box" size={26} />
              <span className="text">
                <strong>Send a Koozie</strong>
                <span>Mail us one you already own</span>
              </span>
              <Icon name="chevron" size={18} />
            </Link>
            <Link href="/contribute/gift" className="choice">
              <Icon name="gift" size={26} />
              <span className="text">
                <strong>Gift a Koozie</strong>
                <span>Purchase one from our wish list</span>
              </span>
              <Icon name="chevron" size={18} />
            </Link>
          </section>

          <Link href="/check" className="notice contribute-cta">
            <Icon name="camera" size={18} />
            <span className="body">
              <strong>Not sure if we have yours?</strong>
              <span>Snap a photo and we'll check the collection</span>
            </span>
            <Icon name="chevron" size={16} />
          </Link>
        </>
      )}
    </Shell>
  );
}

/** Name, email and (for mailed koozies) how many; posts the offer and remembers who you are. */
function useOfferForm(kind: ContributionKind, checked: string | null) {
  const [f, setF] = useState(() => ({ ...remembered(), quantity: "", website: "" }));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [sent, setSent] = useState<{ name: string; email: string } | null>(null);
  const valid = f.name.trim().length > 0 && EMAIL_RE.test(f.email.trim());

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (!valid || busy) return;
    setBusy(true);
    setError(null);
    const who = { name: f.name.trim(), email: f.email.trim() };
    try {
      await pub.offer({ kind, ...who, quantity: kind === "send" ? f.quantity || null : null, checked, website: f.website });
      try {
        localStorage.setItem(ME_KEY, JSON.stringify(who));
      } catch {
        // Private browsing; nothing to remember.
      }
      setSent(who);
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  };

  const fields = (
    <>
      <label className="field">
        Your name
        <input className="input pill" value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} placeholder="John Smith" autoComplete="name" maxLength={100} />
      </label>
      <label className="field">
        Email address
        <input
          className="input pill"
          type="email"
          inputMode="email"
          value={f.email}
          onChange={(e) => setF({ ...f, email: e.target.value })}
          placeholder="john@example.com"
          autoComplete="email"
          maxLength={254}
        />
      </label>
      {/* Hidden from people; bots fill it in. */}
      <input className="hp" tabIndex={-1} autoComplete="off" aria-hidden="true" value={f.website} onChange={(e) => setF({ ...f, website: e.target.value })} name="website" />
    </>
  );
  return { f, setF, busy, error, sent, valid, submit, fields };
}

export function SendKooziePage() {
  const { data, error: loadError, reload } = useContribute();
  const checked = new URLSearchParams(useLocation().search).get("checked");
  const form = useOfferForm("send", checked === "new" || checked === "maybe" ? checked : null);
  const { f, setF } = form;

  return (
    <Shell title="Send a Koozie" back="/contribute" data={data} error={loadError} reload={reload}>
      {() =>
        form.sent ? (
          <section className="choice-card form-card done" aria-live="polite">
            <div className="done-mark">
              <Icon name="check" size={28} strokeWidth={2} />
            </div>
            <h1>Request sent!</h1>
            <p className="secondary">
              Bobby will look it over and email the mailing address to <strong>{form.sent.email}</strong>, usually within a day or two.
            </p>
            <p className="small muted">Tuck a note with your name in the package so you get credit on the leaderboard. Once it's cataloged, we'll email you a link to it.</p>
            <Link href="/" className="btn primary big block pill">
              Back to the collection
            </Link>
          </section>
        ) : (
          <section className="choice-card form-card">
            <h1 className="row" style={{ gap: 10 }}>
              Send a Koozie <Icon name="box" size={26} />
            </h1>
            <p className="secondary lead">Have a koozie you'd like to contribute? We'd love to add it to the collection!</p>
            {checked === "new" ? (
              <p className="checked-note">
                <Icon name="check" size={16} strokeWidth={2} /> You checked it: not in the collection yet
              </p>
            ) : checked === "maybe" ? (
              <p className="checked-note">
                <Icon name="check" size={16} strokeWidth={2} /> You checked it: if it's not one of the lookalikes, it's worth sending
              </p>
            ) : (
              <Link href="/check" className="small secondary check-link">
                <Icon name="camera" size={16} /> Not sure if we have it? <span>Check with a photo first</span>
              </Link>
            )}
            <form className="stack form-stack" onSubmit={form.submit} noValidate>
              {form.fields}
              <label className="field">
                Number of koozies (optional)
                <span className="select-wrap">
                  <select className="input pill" value={f.quantity} onChange={(e) => setF({ ...f, quantity: e.target.value })} data-empty={!f.quantity || undefined}>
                    <option value="">Select quantity</option>
                    {Object.entries(QUANTITY_LABEL).map(([v, label]) => (
                      <option key={v} value={v}>
                        {label}
                      </option>
                    ))}
                  </select>
                  <Icon name="chevron" size={18} />
                </span>
              </label>
              <button className="btn primary big block pill" disabled={!form.valid || form.busy}>
                {form.busy ? (
                  <Spinner />
                ) : (
                  <>
                    Get Mailing Instructions <Icon name="arrow" size={20} />
                  </>
                )}
              </button>
              {form.error && (
                <p className="small form-error" role="alert">
                  {form.error}
                </p>
              )}
              <p className="small muted">We'll email you where to send it once Bobby approves your request. Your email is only used for this.</p>
            </form>
          </section>
        )
      }
    </Shell>
  );
}

export function GiftKooziePage() {
  const { data, error, reload } = useContribute();
  const form = useOfferForm("gift", null);

  return (
    <Shell title="Gift a Koozie" back="/contribute" data={data} error={error} reload={reload}>
      {(d) => (
        <>
          <section className="choice-card form-card">
            <h1 className="row" style={{ gap: 10 }}>
              Gift a Koozie <Icon name="gift" size={26} />
            </h1>
            <p className="secondary lead">Pick one out from the wish list and it ships straight to Bobby.</p>
            {d.wishlist_url ? (
              <a href={d.wishlist_url} className="btn primary big block pill" {...external}>
                Open the wish list <Icon name="external" size={20} />
              </a>
            ) : (
              <p className="small muted">The wish list is coming soon.</p>
            )}
            <p className="small muted">Add a gift note with your name at checkout so you get credit on the leaderboard.</p>
          </section>

          {d.items.length > 0 && (
            <section className="section">
              <h2 className="section-title">Featured picks</h2>
              <div className="wish-grid">
                {d.items.map((w) => (
                  <a key={w.id} href={w.url} className="wish" {...external}>
                    <div className="thumb">{w.image_url ? <img src={w.image_url} alt="" loading="lazy" referrerPolicy="no-referrer" /> : <Icon name="gift" size={20} />}</div>
                    <span className="title clamp-2">{w.title}</span>
                    {w.note && <span className="small muted clamp-2">{w.note}</span>}
                    <span className="small link">View</span>
                  </a>
                ))}
              </div>
            </section>
          )}

          <section className="choice-card form-card">
            {form.sent ? (
              <div className="row" style={{ gap: 12, alignItems: "flex-start" }} aria-live="polite">
                <span className="done-mark small">
                  <Icon name="check" size={18} strokeWidth={2} />
                </span>
                <p className="secondary">
                  <strong className="text">Thanks, {form.sent.name.split(" ")[0]}!</strong> We'll email {form.sent.email} a link to your koozie once it arrives and is in the collection.
                </p>
              </div>
            ) : (
              <>
                <h2 className="choice-sub">Want a thank-you when it arrives?</h2>
                <p className="small secondary">Leave your name and email and we'll send you a link to your koozie once it's in the collection. Optional.</p>
                <form className="stack form-stack" onSubmit={form.submit} noValidate>
                  {form.fields}
                  <button className="btn big block pill" disabled={!form.valid || form.busy}>
                    {form.busy ? <Spinner /> : "Let us know it's coming"}
                  </button>
                  {form.error && (
                    <p className="small form-error" role="alert">
                      {form.error}
                    </p>
                  )}
                </form>
              </>
            )}
          </section>
        </>
      )}
    </Shell>
  );
}
