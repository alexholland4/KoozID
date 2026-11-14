import { useCallback, useEffect, useRef, useState } from "react";
import { errorMessage } from "./api";

export function useAsync<T>(fn: () => Promise<T>, deps: unknown[]) {
  const [state, setState] = useState<{ data: T | null; error: string | null; loading: boolean }>({ data: null, error: null, loading: true });
  const seq = useRef(0);
  const run = useCallback(() => {
    const id = ++seq.current;
    setState((s) => ({ ...s, loading: true, error: null }));
    fn().then(
      (data) => id === seq.current && setState({ data, error: null, loading: false }),
      (e) => id === seq.current && setState((s) => ({ data: s.data, error: errorMessage(e), loading: false })),
    );
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, deps);
  useEffect(run, [run]);
  return { ...state, reload: run, setData: (data: T) => setState({ data, error: null, loading: false }) };
}

export function useDebounced<T>(value: T, ms: number): T {
  const [v, setV] = useState(value);
  useEffect(() => {
    const t = setTimeout(() => setV(value), ms);
    return () => clearTimeout(t);
  }, [value, ms]);
  return v;
}

/** Search ideas that exist in this collection, typed out one after another in an empty search box. */
export const SEARCH_HINTS = ["navy blue", "brewery", "K-0100", "Christmas", "fishing", "Texas"];

/**
 * A placeholder that types and deletes each phrase in turn ("Try “Brewers”"). Stops while `active`
 * is false (the box has text), and shows a static hint for reduced motion.
 */
export function useTypewriter(phrases: string[], active: boolean, prefix = "Try ") {
  const reduced = typeof matchMedia === "function" && matchMedia("(prefers-reduced-motion: reduce)").matches;
  const [text, setText] = useState("");
  useEffect(() => {
    if (!active || reduced) return;
    let i = 0;
    let n = 0;
    let deleting = false;
    let t: number;
    const step = () => {
      const word = phrases[i % phrases.length];
      n += deleting ? -1 : 1;
      setText(word.slice(0, n));
      let delay = deleting ? 35 : 75;
      if (!deleting && n === word.length) {
        deleting = true;
        delay = 1600;
      } else if (deleting && n === 0) {
        deleting = false;
        i++;
        delay = 350;
      }
      t = window.setTimeout(step, delay);
    };
    t = window.setTimeout(step, 400);
    return () => clearTimeout(t);
  }, [active, reduced, phrases]);
  if (reduced) return `${prefix}“${phrases[0]}”, “${phrases[1]}” or “${phrases[2]}”`;
  return `${prefix}“${text}”`;
}
