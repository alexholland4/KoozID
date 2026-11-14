// Outgoing email. Off ("none") until a provider is connected: every email is then returned to the
// collector as a draft he can open in his own mail app, so nothing in the contribute flow depends
// on email being set up. Connecting one is configuration only (see docs/DEPLOYMENT.md, "Email").

import type { EmailDraft, EmailOutcome } from "../shared/types";
import type { Config } from "./env";

export interface Mail extends EmailDraft {
  html?: string;
}

export interface Mailer {
  readonly enabled: boolean;
  send(mail: Mail): Promise<void>;
}

class NoMailer implements Mailer {
  readonly enabled = false;
  async send(): Promise<void> {
    throw new Error("Email isn't connected yet");
  }
}

/** Resend (resend.com): one HTTPS call; the sending domain is verified with DNS records on Cloudflare. */
class ResendMailer implements Mailer {
  readonly enabled = true;
  constructor(
    private key: string,
    private from: string,
    private replyTo: string,
  ) {}

  async send(mail: Mail): Promise<void> {
    const res = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: { authorization: `Bearer ${this.key}`, "content-type": "application/json" },
      body: JSON.stringify({
        from: this.from,
        to: [mail.to],
        subject: mail.subject,
        text: mail.text,
        ...(mail.html ? { html: mail.html } : {}),
        ...(this.replyTo ? { reply_to: this.replyTo } : {}),
      }),
    });
    if (!res.ok) {
      const body = await res.text().catch(() => "");
      throw new Error(`Email provider answered ${res.status}${body ? `: ${body.slice(0, 200)}` : ""}`);
    }
  }
}

export function createMailer(cfg: Config): Mailer {
  return cfg.emailProvider === "resend" ? new ResendMailer(cfg.resendApiKey, cfg.emailFrom, cfg.emailReplyTo) : new NoMailer();
}

/** Send, or hand the email back as a draft. Never throws: a failed email mustn't undo the action that sent it. */
export async function deliver(mailer: Mailer, mail: Mail): Promise<EmailOutcome> {
  const draft = { to: mail.to, subject: mail.subject, text: mail.text };
  if (!mailer.enabled) return { sent: false, draft };
  try {
    await mailer.send(mail);
    return { sent: true, draft };
  } catch (e) {
    console.warn("email failed", (e as Error).message);
    return { sent: false, error: "The email didn't go through. You can send it yourself instead.", draft };
  }
}
