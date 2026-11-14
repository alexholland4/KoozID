// Shared by the contribute form and the emails.

export const QUANTITY_LABEL: Record<string, string> = {
  "1": "1 koozie",
  "2-5": "2–5 koozies",
  "6-10": "6–10 koozies",
  "10+": "More than 10",
};

export const fmtQuantity = (q: string | null) => (q ? (QUANTITY_LABEL[q] ?? q) : "");

/** Loose on purpose: catches typos like a missing @ or domain, not every RFC corner case. */
export const EMAIL_RE = /^[^\s@<>()",;:]+@[^\s@<>()",;:]+\.[a-z]{2,}$/i;
