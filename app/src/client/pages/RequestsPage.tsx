import { useState } from "react";
import type { Contribution, ContributionResult, EmailOutcome, ItemSummary } from "../../shared/types";
import { itemCode } from "../../shared/types";
import { fmtQuantity } from "../../shared/contribute";
import { api, errorMessage, type OfferTab } from "../api";
import { ErrorState, fmtDate, Icon, Sheet, Spinner, Thumb, TopBar, useToast } from "../components/ui";
import { useAsync } from "../hooks";
import { Link, useLocation } from "../router";

const TABS: [OfferTab, string][] = [
  ["new", "New"],
  ["approved", "Waiting"],
  ["done", "Done"],
];

/**
 * Koozie offers from visitors. New ones need approving (which emails the private mailing address);
 * approved ones wait for the koozie to arrive, then get a thank-you naming the cataloged koozie(s).
 */
export function RequestsPage() {
  const params = new URLSearchParams(useLocation().search);
  const [tab, setTab] = useState<OfferTab>((["new", "approved", "done"] as const).find((t) => t === params.get("tab")) ?? "new");
  const { data, error, reload, loading } = useAsync(() => api.offers(tab), [tab]);
  const [busy, setBusy] = useState<number | null>(null);
  const [thanking, setThanking] = useState<Contribution | null>(null);
  const [draft, setDraft] = useState<EmailOutcome | null>(null);
  const toast = useToast();

  const act = async (c: Contribution, fn: () => Promise<ContributionResult>, done: string) => {
    setBusy(c.id);
    try {
      const r = await fn();
      if (r.email && !r.email.sent) setDraft(r.email);
      else toast(r.email?.sent ? `Emailed ${c.email}` : done);
      reload();
    } catch (e) {
      toast(errorMessage(e));
    } finally {
      setBusy(null);
    }
  };

  return (
    <>
      <TopBar title="Koozie offers" back="/more" />
      <main className="page no-dock">
        {data && !data.email_enabled && (
          <div className="notice">
            <Icon name="mail" size={18} />
            <span className="body">
              <span>
                <strong>Email isn't connected yet.</strong> Approving or thanking opens the email ready to send from your own mail app.
              </span>
            </span>
          </div>
        )}

        <div className="segmented" role="tablist">
          {TABS.map(([t, label]) => (
            <button key={t} role="tab" aria-pressed={tab === t} aria-selected={tab === t} onClick={() => setTab(t)}>
              {label}
              {data && data.counts[t] > 0 && t !== "done" ? <span className="count-pill">{data.counts[t]}</span> : null}
            </button>
          ))}
        </div>

        {!data ? (
          error ? (
            <ErrorState message={error} onRetry={reload} />
          ) : (
            <div className="center">
              <Spinner large />
            </div>
          )
        ) : data.offers.length === 0 ? (
          <p className="secondary small center">
            {tab === "new"
              ? "No new offers. When a visitor asks to send a koozie, it shows up here."
              : tab === "approved"
                ? "Nothing on its way. Approved offers and wish list gifts wait here until the koozie arrives."
                : "Nothing finished yet."}
          </p>
        ) : (
          <div className="stack" style={{ opacity: loading ? 0.6 : 1 }}>
            {data.offers.map((c) => (
              <OfferCard
                key={c.id}
                c={c}
                busy={busy === c.id}
                onApprove={() => act(c, () => api.offerAction(c.id, "approve"), "Approved")}
                onDecline={() => act(c, () => api.offerAction(c.id, "decline"), "Declined")}
                onReopen={() => act(c, () => api.offerAction(c.id, "reopen"), "Moved back")}
                onResend={() => act(c, () => api.offerAction(c.id, "resend"), "Sent")}
                onThank={() => setThanking(c)}
              />
            ))}
          </div>
        )}
      </main>

      {thanking && (
        <ThankSheet
          c={thanking}
          onClose={() => setThanking(null)}
          onDone={(r) => {
            setThanking(null);
            if (!r.email?.sent && r.email) setDraft(r.email);
            else toast(`Thank-you sent to ${thanking.email}`);
            reload();
          }}
        />
      )}
      {draft && <DraftSheet outcome={draft} onClose={() => setDraft(null)} />}
    </>
  );
}

function OfferCard({
  c,
  busy,
  onApprove,
  onDecline,
  onReopen,
  onResend,
  onThank,
}: {
  c: Contribution;
  busy: boolean;
  onApprove: () => void;
  onDecline: () => void;
  onReopen: () => void;
  onResend: () => void;
  onThank: () => void;
}) {
  const facts = [
    c.kind === "gift" ? "Gift from the wish list" : fmtQuantity(c.quantity) || "Didn't say how many",
    c.checked === "new" ? "Photo check: new" : c.checked === "maybe" ? "Photo check: maybe" : null,
  ].filter(Boolean);
  return (
    <article className="card pad stack offer">
      <div className="row" style={{ alignItems: "flex-start" }}>
        <Icon name={c.kind === "gift" ? "gift" : "box"} size={20} />
        <div className="grow">
          <strong className="offer-name">{c.name}</strong>
          <a href={`mailto:${c.email}`} className="small secondary clamp-1">
            {c.email}
          </a>
        </div>
        <span className="small muted">{fmtDate(c.created_at)}</span>
      </div>
      <div className="row wrap small secondary" style={{ gap: "4px 12px" }}>
        {facts.map((f) => (
          <span key={f}>{f}</span>
        ))}
        {c.status === "approved" && c.kind === "send" && c.decided_at && <span>Address sent {fmtDate(c.decided_at)}</span>}
        {c.status === "declined" && <span>Declined</span>}
        {c.status === "thanked" && c.thanked_at && <span>Thanked {fmtDate(c.thanked_at)}</span>}
      </div>
      {c.item_ids.length > 0 && (
        <div className="row wrap" style={{ gap: 6 }}>
          {c.item_ids.map((id) => (
            <Link key={id} href={`/items/${id}`} className="chip mono">
              {itemCode(id)}
            </Link>
          ))}
        </div>
      )}

      {busy ? (
        <div className="row" style={{ justifyContent: "center", minHeight: 48 }}>
          <Spinner />
        </div>
      ) : c.status === "new" ? (
        <div className="grid-2 offer-actions">
          <button className="btn big" onClick={onDecline}>
            Decline
          </button>
          <button className="btn primary big" onClick={onApprove}>
            Approve
          </button>
        </div>
      ) : c.status === "approved" ? (
        <div className="stack tight">
          <button className="btn primary big block" onClick={onThank}>
            <Icon name="check" /> It arrived: send thank-you
          </button>
          {c.kind === "send" && (
            <button className="btn ghost small" style={{ alignSelf: "center" }} onClick={onResend}>
              Email the mailing address again
            </button>
          )}
        </div>
      ) : (
        <div className="row" style={{ justifyContent: "flex-end" }}>
          {c.status === "thanked" && (
            <button className="btn ghost small" onClick={onResend}>
              Send thank-you again
            </button>
          )}
          <button className="btn ghost small" onClick={onReopen}>
            {c.status === "declined" ? "Undo decline" : "Move back to waiting"}
          </button>
        </div>
      )}
    </article>
  );
}

/** "K-0412, 413 k0414" -> [412, 413, 414] */
function parseCodes(s: string): number[] {
  return [...s.matchAll(/\d+/g)].map((m) => Number(m[0])).filter((n) => n > 0 && Number.isSafeInteger(n));
}

/** Pick the cataloged koozie(s) this person sent, from the latest additions or by number. */
function ThankSheet({ c, onClose, onDone }: { c: Contribution; onClose: () => void; onDone: (r: ContributionResult) => void }) {
  const recent = useAsync(() => api.list({ sort: "id", order: "desc", limit: 12, status: "active" }), []);
  const [picked, setPicked] = useState<number[]>([]);
  const [typed, setTyped] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const ids = [...new Set([...picked, ...parseCodes(typed)])];
  const toggle = (id: number) => setPicked((p) => (p.includes(id) ? p.filter((x) => x !== id) : [...p, id]));
  const first = c.name.split(" ")[0];

  const send = async () => {
    setBusy(true);
    setError(null);
    try {
      onDone(await api.thankOffer(c.id, ids));
    } catch (e) {
      setError(errorMessage(e));
      setBusy(false);
    }
  };

  return (
    <Sheet title={`Thank ${first}`} onClose={() => !busy && onClose()}>
      <p className="small secondary">
        Which koozie{c.quantity && c.quantity !== "1" ? "s" : ""} did {first} send? {first} gets an email with a photo of each and a link to its page.
      </p>
      {recent.data ? (
        <div className="pick-grid">
          {recent.data.items.map((it: ItemSummary) => (
            <button key={it.id} className="pick" aria-pressed={picked.includes(it.id)} onClick={() => toggle(it.id)}>
              <Thumb photoId={it.thumb_photo_id} alt="" />
              <span className="code">{it.code}</span>
              <span className="tiny muted clamp-1">{it.description || "No description"}</span>
              {picked.includes(it.id) && (
                <span className="tick">
                  <Icon name="check" size={14} strokeWidth={2.5} />
                </span>
              )}
            </button>
          ))}
        </div>
      ) : (
        <div className="center">
          <Spinner />
        </div>
      )}
      <label className="field">
        Or type catalogue numbers
        <input className="input" inputMode="text" placeholder="e.g. K-0412, 413" value={typed} onChange={(e) => setTyped(e.target.value)} />
      </label>
      {error && (
        <p className="small form-error" role="alert">
          {error}
        </p>
      )}
      <button className="btn primary big block" disabled={!ids.length || busy} onClick={send}>
        {busy ? <Spinner /> : ids.length ? `Send thank-you for ${ids.map(itemCode).join(", ")}` : "Pick at least one koozie"}
      </button>
    </Sheet>
  );
}

/** Email isn't connected (or the send failed): the email, ready to go from the collector's own app. */
function DraftSheet({ outcome, onClose }: { outcome: EmailOutcome; onClose: () => void }) {
  const { draft } = outcome;
  const toast = useToast();
  const mailto = `mailto:${encodeURIComponent(draft.to)}?subject=${encodeURIComponent(draft.subject)}&body=${encodeURIComponent(draft.text)}`;
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(draft.text);
      toast("Message copied");
    } catch {
      toast("Couldn't copy. Select the text instead");
    }
  };
  return (
    <Sheet title="Send this email yourself" onClose={onClose}>
      <p className="small secondary">{outcome.error ?? "Email isn't connected yet, so here it is, ready to go. It's saved as done here either way."}</p>
      <div className="card draft">
        <div className="small">
          <span className="muted">To</span> {draft.to}
        </div>
        <div className="small">
          <span className="muted">Subject</span> {draft.subject}
        </div>
        <pre>{draft.text}</pre>
      </div>
      <a className="btn primary big block" href={mailto} onClick={() => setTimeout(onClose, 300)}>
        <Icon name="mail" /> Open in Mail
      </a>
      <button className="btn big block" onClick={copy}>
        <Icon name="copy" /> Copy message
      </button>
    </Sheet>
  );
}
