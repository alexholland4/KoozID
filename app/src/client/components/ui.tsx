import { createContext, useCallback, useContext, useEffect, useRef, useState, type ReactNode } from "react";
import { photoUrl } from "../api";
import { goBack } from "../router";
import type { ItemStatus, MatchBand } from "../../shared/types";

// ---------------------------------------------------------------- icons (inline, 24px grid)

const PATHS: Record<string, ReactNode> = {
  camera: (
    <>
      <path d="M4 8.5A2.5 2.5 0 0 1 6.5 6h1.6l1.2-1.8A2 2 0 0 1 11 3.3h2a2 2 0 0 1 1.7.9L15.9 6h1.6A2.5 2.5 0 0 1 20 8.5v9a2.5 2.5 0 0 1-2.5 2.5h-11A2.5 2.5 0 0 1 4 17.5z" />
      <circle cx="12" cy="13" r="3.6" />
    </>
  ),
  image: (
    <>
      <rect x="3.5" y="4.5" width="17" height="15" rx="2.5" />
      <circle cx="9" cy="10" r="1.7" />
      <path d="m20.5 15.5-4.8-4.6-8.7 8.6" />
    </>
  ),
  search: (
    <>
      <circle cx="11" cy="11" r="6.5" />
      <path d="m20 20-4.2-4.2" />
    </>
  ),
  grid: (
    <>
      <rect x="4" y="4" width="6.5" height="6.5" rx="1.5" />
      <rect x="13.5" y="4" width="6.5" height="6.5" rx="1.5" />
      <rect x="4" y="13.5" width="6.5" height="6.5" rx="1.5" />
      <rect x="13.5" y="13.5" width="6.5" height="6.5" rx="1.5" />
    </>
  ),
  list: <path d="M8.5 6.5h11M8.5 12h11M8.5 17.5h11M4.5 6.5h.01M4.5 12h.01M4.5 17.5h.01" />,
  back: <path d="M15 5l-7 7 7 7" />,
  chevron: <path d="m9 6 6 6-6 6" />,
  check: <path d="m5 12.5 4.5 4.5L19 7.5" />,
  x: <path d="M6 6l12 12M18 6 6 18" />,
  trash: (
    <>
      <path d="M4.5 7h15M9.5 7V5.2c0-.7.5-1.2 1.2-1.2h2.6c.7 0 1.2.5 1.2 1.2V7" />
      <path d="M6.5 7l.9 11.4a2 2 0 0 0 2 1.6h5.2a2 2 0 0 0 2-1.6L17.5 7" />
    </>
  ),
  edit: <path d="M4 20h4L19 9l-4-4L4 16zM13.5 6.5l4 4" />,
  plus: <path d="M12 5v14M5 12h14" />,
  download: <path d="M12 4v11m0 0-4.5-4.5M12 15l4.5-4.5M5 19.5h14" />,
  upload: <path d="M12 16V5m0 0L7.5 9.5M12 5l4.5 4.5M5 19.5h14" />,
  refresh: <path d="M19.5 12a7.5 7.5 0 1 1-2.2-5.3M19.5 4.5v4h-4" />,
  alert: (
    <>
      <path d="M12 4 2.8 19.5h18.4z" />
      <path d="M12 10v4.2M12 17.2v.3" />
    </>
  ),
  info: (
    <>
      <circle cx="12" cy="12" r="8.5" />
      <path d="M12 11v5.5M12 7.8v.3" />
    </>
  ),
  more: (
    <>
      <circle cx="5.5" cy="12" r="1.3" />
      <circle cx="12" cy="12" r="1.3" />
      <circle cx="18.5" cy="12" r="1.3" />
    </>
  ),
  sparkle: <path d="M12 3.5 13.8 9l5.7 1.9-5.7 1.9L12 18.5l-1.8-5.7-5.7-1.9L10.2 9zM18.5 3v3M17 4.5h3" />,
  swap: <path d="M7 7h11l-3-3M17 17H6l3 3" />,
  shuffle: <path d="M4 7h3c2 0 3.2.9 4.2 2.6l1.6 2.8c1 1.7 2.2 2.6 4.2 2.6h3M17 12l3 3-3 3M4 15h3c1.2 0 2.1-.3 2.8-1M13.2 8c.7-.7 1.6-1 2.8-1h4M17 4l3 3-3 3" />,
  table: <path d="M4.5 5.5h15v13h-15zM4.5 10h15M4.5 14.5h15M10 5.5v13" />,
  chart: <path d="M4 20h16M7.5 16.5v-4M12 16.5v-9M16.5 16.5v-6" />,
  restore: <path d="M4.5 12a7.5 7.5 0 1 0 2.2-5.3M4.5 4.5v4h4" />,
  logout: <path d="M14 4.5h3.5a2 2 0 0 1 2 2v11a2 2 0 0 1-2 2H14M10 16l4-4-4-4M14 12H4" />,
  star: <path d="m12 4 2.4 5 5.4.6-4 3.7 1.1 5.4L12 16l-4.9 2.7 1.1-5.4-4-3.7 5.4-.6z" />,
  box: (
    <>
      <path d="M12 3 4 7.5v9L12 21l8-4.5v-9z" />
      <path d="m4 7.5 8 4.5 8-4.5M12 12v9" />
    </>
  ),
  gift: (
    <>
      <rect x="4" y="8.5" width="16" height="4" rx="1" />
      <path d="M5.5 12.5V19a1.5 1.5 0 0 0 1.5 1.5h10a1.5 1.5 0 0 0 1.5-1.5v-6.5M12 8.5v12" />
      <path d="M12 8.5S10.8 4 8.3 4a2.2 2.2 0 0 0 0 4.5zM12 8.5S13.2 4 15.7 4a2.2 2.2 0 0 1 0 4.5z" />
    </>
  ),
  arrow: <path d="M5 12h14m0 0-5.5-5.5M19 12l-5.5 5.5" />,
  external: <path d="M8 16 16.5 7.5M9 7h8v8" />,
  mail: (
    <>
      <rect x="3.5" y="5.5" width="17" height="13" rx="2.5" />
      <path d="m4.5 7 7.5 6 7.5-6" />
    </>
  ),
  people: (
    <>
      <circle cx="9" cy="8.5" r="3" />
      <path d="M3.5 19c.6-3 2.8-4.8 5.5-4.8s4.9 1.8 5.5 4.8" />
      <path d="M15 5.7a3 3 0 0 1 0 5.6M17 14.6c1.8.6 3 2.1 3.5 4.4" />
    </>
  ),
  copy: (
    <>
      <rect x="8.5" y="8.5" width="11" height="11" rx="2" />
      <path d="M15.5 8.5V6a1.5 1.5 0 0 0-1.5-1.5H6A1.5 1.5 0 0 0 4.5 6v8A1.5 1.5 0 0 0 6 15.5h2.5" />
    </>
  ),
};

export function Icon({ name, size = 18, strokeWidth = 1.5 }: { name: keyof typeof PATHS | string; size?: number; strokeWidth?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={strokeWidth} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      {PATHS[name]}
    </svg>
  );
}

/** Flat mark: scan corners around a koozie, one solid color. */
export function Logo({ size = 22 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" aria-hidden="true">
      <path d="M3 8V4.5A1.5 1.5 0 0 1 4.5 3H8M16 3h3.5A1.5 1.5 0 0 1 21 4.5V8M3 16v3.5A1.5 1.5 0 0 0 4.5 21H8M16 21h3.5a1.5 1.5 0 0 0 1.5-1.5V16" stroke="var(--accent)" strokeWidth="2" strokeLinecap="round" />
      <path d="M8 8.2c0-.9 1.8-1.6 4-1.6s4 .7 4 1.6V16a1.5 1.5 0 0 1-1.5 1.5h-5A1.5 1.5 0 0 1 8 16z" fill="var(--accent)" />
    </svg>
  );
}

/** Large scan-frame illustration used on the capture screen. */
export function ScanFrame() {
  return (
    <svg className="frame" viewBox="0 0 120 120" fill="none" aria-hidden="true">
      <path d="M16 40V22a6 6 0 0 1 6-6h18M80 16h18a6 6 0 0 1 6 6v18M16 80v18a6 6 0 0 0 6 6h18M80 104h18a6 6 0 0 0 6-6V80" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
      <g className="mark" stroke="currentColor" strokeWidth="1.5">
        <ellipse cx="60" cy="40" rx="18" ry="5" />
        <path d="M42 40v38a5 5 0 0 0 5 5h26a5 5 0 0 0 5-5V40M42 56h36M42 66h36" />
      </g>
    </svg>
  );
}

export const Spinner = ({ large }: { large?: boolean }) => <span className={`spinner${large ? " lg" : ""}`} role="status" aria-label="Loading" />;

// ---------------------------------------------------------------- layout

export function TopBar({ title, back, end }: { title?: ReactNode; back?: string | true | (() => void); end?: ReactNode }) {
  return (
    <header className="topbar">
      <div className="slot">
        {back && (
          <button className="icon-btn" onClick={() => (typeof back === "function" ? back() : goBack(typeof back === "string" ? back : "/"))} aria-label="Back">
            <Icon name="back" />
          </button>
        )}
      </div>
      <h1>{title}</h1>
      <div className="slot end">{end}</div>
    </header>
  );
}

export function Dock({ children }: { children: ReactNode }) {
  return (
    <div className="dock">
      <div className="dock-inner">{children}</div>
    </div>
  );
}

export function Sheet({ title, onClose, children }: { title?: ReactNode; onClose: () => void; children: ReactNode }) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    document.addEventListener("keydown", onKey);
    const prev = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    ref.current?.focus();
    return () => {
      document.removeEventListener("keydown", onKey);
      document.body.style.overflow = prev;
    };
  }, [onClose]);
  return (
    <div className="scrim" onClick={(e) => e.target === e.currentTarget && onClose()}>
      <div className="sheet" role="dialog" aria-modal="true" tabIndex={-1} ref={ref}>
        <div className="grabber" />
        {title && (
          <div className="row">
            <h2 className="spacer">{title}</h2>
            <button className="icon-btn" onClick={onClose} aria-label="Close">
              <Icon name="x" />
            </button>
          </div>
        )}
        {children}
      </div>
    </div>
  );
}

export function Confirm({
  title,
  body,
  confirmLabel,
  danger,
  onConfirm,
  onClose,
}: {
  title: string;
  body: ReactNode;
  confirmLabel: string;
  danger?: boolean;
  onConfirm: () => Promise<void> | void;
  onClose: () => void;
}) {
  const [busy, setBusy] = useState(false);
  return (
    <Sheet title={title} onClose={() => !busy && onClose()}>
      <div className="muted">{body}</div>
      <div className="stack">
        <button
          className={`btn big block ${danger ? "danger solid" : "primary"}`}
          disabled={busy}
          onClick={async () => {
            setBusy(true);
            try {
              await onConfirm();
            } finally {
              setBusy(false);
            }
          }}
        >
          {busy ? <Spinner /> : confirmLabel}
        </button>
        <button className="btn big block" onClick={onClose} disabled={busy}>
          Cancel
        </button>
      </div>
    </Sheet>
  );
}

// ---------------------------------------------------------------- toasts

const ToastCtx = createContext<(msg: string) => void>(() => {});
export const useToast = () => useContext(ToastCtx);

export function ToastProvider({ children }: { children: ReactNode }) {
  const [msg, setMsg] = useState<string | null>(null);
  const timer = useRef<number>(undefined);
  const show = useCallback((m: string) => {
    setMsg(m);
    window.clearTimeout(timer.current);
    timer.current = window.setTimeout(() => setMsg(null), 2800);
  }, []);
  return (
    <ToastCtx.Provider value={show}>
      {children}
      {msg && (
        <div className="toast" role="status" aria-live="polite">
          {msg}
        </div>
      )}
    </ToastCtx.Provider>
  );
}

// ---------------------------------------------------------------- photos & badges

export function Thumb({ photoId, alt, variant = "thumb", className = "" }: { photoId: string | null; alt: string; variant?: "thumb" | "full"; className?: string }) {
  // State is keyed by photo id so a cached image that loads before effects run is never hidden.
  const [loadedId, setLoadedId] = useState<string | null>(null);
  const [failedId, setFailedId] = useState<string | null>(null);
  const failed = !!photoId && failedId === photoId;
  return (
    <div className={`thumb ${className}`}>
      {photoId && !failed && (
        <img
          ref={(el) => {
            if (el?.complete && el.naturalWidth) setLoadedId(photoId);
          }}
          src={photoUrl(photoId, variant)}
          alt={alt}
          loading="lazy"
          decoding="async"
          className={loadedId === photoId ? "loaded" : ""}
          onLoad={() => setLoadedId(photoId)}
          onError={() => setFailedId(photoId)}
        />
      )}
      {(!photoId || failed) && (
        <div className="ph" title={photoId ? "Photo unavailable" : "No photo"}>
          <Icon name="image" size={20} />
        </div>
      )}
    </div>
  );
}

const BAND_LABEL: Record<MatchBand, string> = { strong: "Very similar", possible: "Similar", weak: "Loose match" };
export const BandBadge = ({ band }: { band: MatchBand }) => (
  <span className="tag">
    <span className={`dot ${band}`} />
    {BAND_LABEL[band]}
  </span>
);

export const StatusBadge = ({ status }: { status: ItemStatus }) =>
  status === "needs_review" ? (
    <span className="tag">
      <span className="dot review" />
      Needs review
    </span>
  ) : null;

export function ErrorState({ message, onRetry }: { message: string; onRetry?: () => void }) {
  return (
    <div className="center">
      <p className="secondary">{message}</p>
      {onRetry && (
        <button className="btn" onClick={onRetry}>
          Try again
        </button>
      )}
    </div>
  );
}

export const fmtDate = (iso: string) => {
  const d = new Date(iso.length === 10 ? `${iso}T12:00:00` : iso);
  return d.toLocaleDateString(undefined, { year: "numeric", month: "short", day: "numeric" });
};
export const fmtNum = (n: number) => n.toLocaleString();
