// The emails the contribute flow sends, as plain text plus a matching dark HTML version.
// Everything a visitor typed is escaped; links are absolute to the site that served the request.

import type { Contribution } from "../shared/types";
import { fmtQuantity } from "../shared/contribute";
import type { Mail } from "./mail";

export interface ThankedItem {
  id: number;
  code: string;
  description: string;
  thumb_photo_id: string | null;
}

const esc = (s: string) => s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);
const firstName = (name: string) => name.trim().split(/\s+/)[0];

/** "John S." for "John Smith": enough to recognise yourself, little enough to share. */
export function creditName(name: string): string {
  const parts = name.trim().split(/\s+/);
  return parts.length > 1 ? `${parts[0]} ${parts[parts.length - 1][0].toUpperCase()}.` : parts[0];
}

const FONT = "-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif";
const C = { bg: "#0f0f10", card: "#19191b", line: "#2a2a2d", text: "#ededed", text2: "#a1a1a6", muted: "#85858b", accent: "#ef6a43" };

/** The shared frame: dark page, centred column, footer tagline. */
function shell(preheader: string, inner: string): string {
  return `<!DOCTYPE html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="color-scheme" content="dark"><meta name="supported-color-schemes" content="dark"></head>
<body style="margin:0;padding:0;background:${C.bg};">
<div style="display:none;max-height:0;overflow:hidden;">${esc(preheader)}</div>
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:${C.bg};"><tr><td align="center" style="padding:32px 16px;">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:520px;font-family:${FONT};color:${C.text};">
${inner}
<tr><td style="padding:32px 0 0;text-align:center;font-size:13px;line-height:18px;color:${C.muted};">One Koozie at a Time. One World Record in the Making.</td></tr>
</table></td></tr></table></body></html>`;
}

const para = (html: string) => `<tr><td style="padding:0 4px 14px;font-size:16px;line-height:24px;color:${C.text};">${html}</td></tr>`;
const button = (href: string, label: string) =>
  `<tr><td style="padding:10px 4px 0;"><a href="${esc(href)}" style="display:block;background:${C.text};color:${C.bg};text-align:center;text-decoration:none;font-size:16px;font-weight:600;line-height:22px;padding:13px 16px;border-radius:999px;">${esc(label)}</a></td></tr>`;

/** From Tools: proves the provider, the sending domain and the From address all work. */
export function testEmail(to: string, base: string): Mail {
  const subject = "KoozID test email";
  const text = `Email from KoozID is working. Approvals, thank-yous and new-offer notices will now be sent automatically.

${base}`;
  const html = shell(
    subject,
    `<tr><td style="padding:0 4px 16px;font-size:22px;line-height:28px;font-weight:600;">Email is working ✅</td></tr>
${para("Approvals, thank-yous and new-offer notices from KoozID will now be sent automatically.")}
${button(base, "Open KoozID")}`,
  );
  return { to, subject, text, html };
}

/** To the collector: someone wants to send (or has gifted) a koozie. */
export function offerNotice(c: Contribution, base: string): Mail {
  const link = `${base}/requests`;
  const qty = c.quantity ? ` (${fmtQuantity(c.quantity)})` : "";
  const checked = c.checked === "new" ? " Their photo check said it's not in the collection yet." : c.checked === "maybe" ? " Their photo check found possible lookalikes." : "";
  const text =
    c.kind === "gift"
      ? `${c.name} (${c.email}) is gifting a koozie from your wish list.\n\nWhen it arrives and you've cataloged it, send them a thank-you:\n${link}`
      : `${c.name} (${c.email}) wants to mail you a koozie${qty}.${checked}\n\nApprove it to email them your mailing address:\n${link}`;
  const subject = c.kind === "gift" ? `${c.name} is gifting a koozie` : `New koozie offer from ${c.name}`;
  const html = shell(
    subject,
    `<tr><td style="padding:0 4px 16px;font-size:22px;line-height:28px;font-weight:600;">${esc(subject)}</td></tr>
${para(esc(text.split("\n\n")[0]))}
${button(link, c.kind === "gift" ? "Open requests" : "Review the request")}`,
  );
  return { to: "", subject, text, html };
}

/** To the visitor, once approved: where to mail it. */
export function approvalEmail(c: Contribution, address: string, base: string): Mail {
  const hi = firstName(c.name);
  const subject = "Koozie Mailing Instructions";
  const text = `Hi ${hi},

Thanks for offering to send a koozie to the world record collection! Here's where to mail it:

${address}

Tuck a note in with your name (${c.name}) so you get the credit. Once it arrives and is cataloged, we'll email you a link to it.

Thank you for being part of the journey!

${base}`;
  const html = shell(
    subject,
    `<tr><td style="padding:0 4px 8px;text-align:center;font-size:26px;line-height:32px;font-weight:600;">You're approved! 📦</td></tr>
<tr><td style="padding:0 4px 24px;text-align:center;font-size:15px;line-height:22px;color:${C.text2};">Here's where to mail your koozie.</td></tr>
${para(`Hi ${esc(hi)},`)}
${para("Thanks for offering to send a koozie to the world record collection! Mail it to:")}
<tr><td style="padding:4px 4px 18px;"><div style="background:${C.card};border:1px solid ${C.line};border-radius:16px;padding:18px 20px;font-size:17px;line-height:26px;white-space:pre-line;">${esc(address)}</div></td></tr>
${para(`Tuck a note in with your name (<strong>${esc(c.name)}</strong>) so you get the credit. Once it arrives and is cataloged, we'll email you a link to it.`)}
${para("Thank you for being part of the journey!")}
${button(base, "Visit the collection")}`,
  );
  return { to: c.email, subject, text, html };
}

/** To the visitor, once their koozie(s) are cataloged: the "You're part of the journey" email. */
export function thanksEmail(c: Contribution, items: ThankedItem[], counts: { total: number; goal: number | null }, base: string): Mail {
  const hi = firstName(c.name);
  const one = items.length === 1;
  const subject = one ? "Your Koozie Is Officially Part of the Collection! 🎉" : "Your Koozies Are Officially Part of the Collection! 🎉";
  const goal = counts.goal ? `${counts.goal.toLocaleString("en-US")} unique koozies` : null;
  const lines = items.map((it) => `${it.code}${it.description ? `: ${it.description}` : ""}\n${base}/items/${it.id}`).join("\n\n");
  const text = `Hi ${hi},

Your ${one ? "koozie has" : `${items.length} koozies have`} arrived, been cataloged, and ${one ? "is" : "are"} now officially part of the Koozie World Record collection!

${lines}

${goal ? `Your contribution is helping us work toward our goal of collecting ${goal}. The collection is at ${counts.total.toLocaleString("en-US")} so far. ` : ""}Thank you for being part of the journey.

One Koozie at a Time. One World Record in the Making.`;

  const card = (it: ThankedItem) => {
    const href = `${base}/items/${it.id}`;
    const pic = it.thumb_photo_id
      ? `<img src="${esc(`${base}/pub/photos/${it.thumb_photo_id}/thumb`)}" width="88" height="88" alt="" style="display:block;width:88px;height:88px;object-fit:cover;border-radius:12px;background:#fff;">`
      : `<div style="width:88px;height:88px;border-radius:12px;background:#232325;"></div>`;
    const desc = it.description.length > 70 ? `${it.description.slice(0, 68).trimEnd()}…` : it.description;
    return `<tr><td style="padding:0 0 10px;"><a href="${esc(href)}" style="text-decoration:none;color:${C.text};">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0"><tr>
<td width="88" valign="top" style="padding:0 16px 0 0;">${pic}</td>
<td valign="middle">
<div style="font-size:11px;line-height:16px;letter-spacing:.06em;text-transform:uppercase;color:${C.muted};">Your contribution</div>
<div style="font-family:ui-monospace,'SF Mono',Menlo,Consolas,monospace;font-size:24px;line-height:30px;font-weight:600;color:${C.text};">${esc(it.code)}</div>
${desc ? `<div style="font-size:15px;line-height:20px;font-weight:600;color:${C.text};">${esc(desc)}</div>` : ""}
<div style="font-size:13px;line-height:18px;color:${C.text2};">Contributed by ${esc(creditName(c.name))}</div>
</td></tr></table></a></td></tr>`;
  };

  const html = shell(
    subject,
    `<tr><td style="padding:0 4px 4px;text-align:center;font-size:28px;line-height:34px;">🎉</td></tr>
<tr><td style="padding:0 4px 8px;text-align:center;font-size:26px;line-height:32px;font-weight:600;">You're Part of the Journey!</td></tr>
<tr><td style="padding:0 4px 24px;text-align:center;font-size:15px;line-height:22px;color:${C.text2};">Your ${one ? "koozie has" : "koozies have"} officially joined the world record collection.</td></tr>
<tr><td style="padding:0 0 22px;"><table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:${C.card};border:1px solid ${C.line};border-radius:18px;">
<tr><td style="padding:18px 18px 8px;"><table role="presentation" width="100%" cellpadding="0" cellspacing="0">${items.map(card).join("")}</table></td></tr>
${
  goal
    ? `<tr><td style="padding:0 18px;"><div style="border-top:1px solid ${C.line};"></div></td></tr>
<tr><td style="padding:14px 18px 16px;"><table role="presentation" width="100%" cellpadding="0" cellspacing="0"><tr>
<td style="font-size:14px;line-height:20px;color:${C.text2};">Record attempt goal</td>
<td align="right" style="font-size:16px;line-height:20px;font-weight:600;color:${C.text};">${esc(counts.goal!.toLocaleString("en-US"))} koozies</td></tr></table></td></tr>`
    : ""
}
</table></td></tr>
${para(`Hey ${esc(hi)},`)}
${para(`Your ${one ? "koozie has" : `${items.length} koozies have`} arrived, been cataloged, and ${one ? "is" : "are"} now officially part of the Koozie World Record collection!`)}
${goal ? para(`Your contribution is helping us work toward our goal of collecting ${esc(goal)}. Thank you for being part of the journey.`) : para("Thank you for being part of the journey.")}
${one ? button(`${base}/items/${items[0].id}`, "View Your Koozie ↗") : button(base, "Visit the Collection ↗")}`,
  );
  return { to: c.email, subject, text, html };
}
