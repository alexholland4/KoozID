// A tiny History-API router; the app has a handful of routes and no nested layouts.

import { useEffect, useState, type AnchorHTMLAttributes, type MouseEvent } from "react";

const listeners = new Set<() => void>();
// Depth of in-app history, so "back" never leaves the app (e.g. when opened from a home-screen icon).
let depth = 0;
window.addEventListener("popstate", () => (depth = Math.max(0, depth - 1)));

export function navigate(to: string, opts: { replace?: boolean } = {}) {
  if (to === location.pathname + location.search) return;
  if (opts.replace) history.replaceState(null, "", to);
  else {
    history.pushState(null, "", to);
    depth++;
  }
  window.scrollTo(0, 0);
  listeners.forEach((l) => l());
}

export function goBack(fallback = "/") {
  if (depth > 0) history.back();
  else navigate(fallback, { replace: true });
}

export function useLocation() {
  const [loc, setLoc] = useState(() => ({ path: location.pathname, search: location.search }));
  useEffect(() => {
    const update = () => setLoc({ path: location.pathname, search: location.search });
    listeners.add(update);
    window.addEventListener("popstate", update);
    return () => {
      listeners.delete(update);
      window.removeEventListener("popstate", update);
    };
  }, []);
  return loc;
}

export function Link({ href, onClick, ...rest }: AnchorHTMLAttributes<HTMLAnchorElement> & { href: string }) {
  const handle = (e: MouseEvent<HTMLAnchorElement>) => {
    onClick?.(e);
    if (e.defaultPrevented || e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
    e.preventDefault();
    navigate(href);
  };
  return <a href={href} onClick={handle} {...rest} />;
}
