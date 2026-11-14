import { useEffect, useState } from "react";
import { checkSession, errorMessage, setGuestPhotos } from "./api";
import { ErrorState, Logo, Spinner, ToastProvider } from "./components/ui";
import { CollectionPage } from "./pages/CollectionPage";
import { ContributePage, GiftKooziePage, SendKooziePage } from "./pages/ContributePage";
import { GroupsPage } from "./pages/GroupsPage";
import { RequestsPage } from "./pages/RequestsPage";
import { CheckPage, GuestHome, GuestItemPage } from "./pages/GuestPages";
import { HomePage } from "./pages/HomePage";
import { ImportPage } from "./pages/ImportPage";
import { ItemPage } from "./pages/ItemPage";
import { MorePage } from "./pages/MorePage";
import { PhotoImportPage } from "./pages/PhotoImportPage";
import { ReviewPage } from "./pages/ReviewPage";
import { ScanPage } from "./pages/ScanPage";
import { StatsPage } from "./pages/StatsPage";
import { Link, useLocation } from "./router";

export const SESSION_EVENT = "koozid:session-expired";
const PREVIEW_KEY = "koozid:guest-preview";

function SessionExpiredScreen() {
  return (
    <div className="center" style={{ minHeight: "100dvh" }}>
      <Logo size={40} />
      <h1 style={{ fontSize: 20 }}>Sign in again</h1>
      <p className="secondary">Your session expired</p>
      <a className="btn primary big" href="/signin">
        Sign in
      </a>
    </div>
  );
}

function NotFound() {
  return (
    <div className="center" style={{ minHeight: "70dvh" }}>
      <p>That page doesn't exist.</p>
      <a className="btn" href="/">
        Go home
      </a>
    </div>
  );
}

/** A guest followed a link into the signed-in part of the app. */
function SignInPrompt() {
  return (
    <div className="center" style={{ minHeight: "70dvh" }}>
      <Logo size={40} />
      <p className="secondary">This part of KoozID is for the collectors.</p>
      <a className="btn primary big" href="/signin">
        Sign in
      </a>
      <Link className="btn ghost" href="/">
        Browse the collection
      </Link>
    </div>
  );
}

function route(path: string) {
  if (path === "/") return <HomePage />;
  if (path === "/scan") return <ScanPage />;
  if (path === "/collection") return <CollectionPage />;
  if (path === "/trash") return <CollectionPage deleted />;
  if (path === "/more") return <MorePage />;
  if (path === "/import") return <ImportPage />;
  if (path === "/photo-import") return <PhotoImportPage />;
  if (path === "/review") return <ReviewPage />;
  if (path === "/stats") return <StatsPage />;
  if (path === "/contribute") return <ContributePage />;
  if (path === "/contribute/send") return <SendKooziePage />;
  if (path === "/contribute/gift") return <GiftKooziePage />;
  if (path === "/check") return <CheckPage />;
  if (path === "/requests") return <RequestsPage />;
  if (path === "/groups") return <GroupsPage />;
  const m = path.match(/^\/items\/(\d+)$/);
  if (m) return <ItemPage key={m[1]} id={Number(m[1])} />;
  return <NotFound />;
}

function guestRoute(path: string) {
  if (path === "/") return <GuestHome />;
  if (path === "/collection") return <CollectionPage guest />;
  if (path === "/check") return <CheckPage />;
  if (path === "/contribute") return <ContributePage />;
  if (path === "/contribute/send") return <SendKooziePage />;
  if (path === "/contribute/gift") return <GiftKooziePage />;
  if (path === "/stats") return <StatsPage />;
  const m = path.match(/^\/items\/(\d+)$/);
  if (m) return <GuestItemPage key={m[1]} id={Number(m[1])} />;
  return <SignInPrompt />;
}

/** "?guest=1" lets a signed-in collector see the site as guests do, until they exit. */
function wantsPreview(): boolean {
  try {
    if (new URLSearchParams(location.search).get("guest") === "1") sessionStorage.setItem(PREVIEW_KEY, "1");
    return sessionStorage.getItem(PREVIEW_KEY) === "1";
  } catch {
    return false;
  }
}

function exitPreview() {
  try {
    sessionStorage.removeItem(PREVIEW_KEY);
  } catch {
    // Nothing stored; fine.
  }
  location.href = "/more";
}

type Mode = { k: "loading" } | { k: "member" } | { k: "guest"; preview: boolean } | { k: "error"; message: string };

export function App() {
  const { path } = useLocation();
  const [mode, setMode] = useState<Mode>({ k: "loading" });
  const [expired, setExpired] = useState(false);

  const detect = () => {
    setMode({ k: "loading" });
    checkSession().then(
      (me) => {
        const preview = !!me && wantsPreview();
        setGuestPhotos(!me || preview);
        setMode(me && !preview ? { k: "member" } : { k: "guest", preview });
      },
      (e) => setMode({ k: "error", message: errorMessage(e) }),
    );
  };
  useEffect(detect, []);

  useEffect(() => {
    const onExpired = () => setExpired(true);
    window.addEventListener(SESSION_EVENT, onExpired);
    return () => window.removeEventListener(SESSION_EVENT, onExpired);
  }, []);

  let body;
  if (mode.k === "loading")
    body = (
      <div className="center" style={{ minHeight: "100dvh" }}>
        <Spinner />
      </div>
    );
  else if (mode.k === "error")
    body = (
      <div className="center" style={{ minHeight: "100dvh" }}>
        <ErrorState message={mode.message} onRetry={detect} />
      </div>
    );
  else if (mode.k === "guest")
    body = (
      <>
        {mode.preview && (
          <div className="preview-bar">
            <span>Previewing the guest view</span>
            <button className="btn ghost small" onClick={exitPreview}>
              Exit
            </button>
          </div>
        )}
        {guestRoute(path)}
      </>
    );
  else body = expired ? <SessionExpiredScreen /> : route(path);

  return (
    <ToastProvider>
      <div className="app">{body}</div>
    </ToastProvider>
  );
}
