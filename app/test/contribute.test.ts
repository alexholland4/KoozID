import { createExecutionContext, waitOnExecutionContext } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import { creditName } from "../src/worker/emails";
import type { Env } from "../src/worker/env";
import type { Mail, Mailer } from "../src/worker/mail";
import { createPublicApp } from "../src/worker/public";
import { emptyFields, makeClient } from "./helpers";

/** Records what would have been emailed. */
function outbox(): Mailer & { sent: Mail[] } {
  const sent: Mail[] = [];
  return { enabled: true, sent, send: async (m) => void sent.push(m) };
}

function pubClient(mailer?: Mailer, extraEnv: Partial<Env> = {}) {
  const app = createPublicApp(mailer ? { mailer: () => mailer } : {});
  return async (body: unknown, headers: Record<string, string> = { "x-koozid": "1" }) => {
    const ctx = createExecutionContext();
    const res = await app.fetch(
      new Request("http://localhost/pub/offers", { method: "POST", body: JSON.stringify(body), headers: { "content-type": "application/json", ...headers } }),
      { ...(env as unknown as Env), ...extraEnv },
      ctx,
    );
    await waitOnExecutionContext(ctx);
    return { status: res.status, body: (await res.json()) as any };
  };
}

async function makeItem(api: ReturnType<typeof makeClient>, seed: number, description: string, source: string | null = null) {
  const scan = (await api.scan(seed)).body.scan_id;
  return (await api.json("POST", "/items", { ...emptyFields, description, acquired_from: source, scan_id: scan, side: "front", status: "active" })).body;
}

describe("koozie offers", () => {
  it("send: offer -> collector notified -> approve emails the private address -> thank-you names the koozie", async () => {
    const mail = outbox();
    const offer = pubClient(mail, { NOTIFY_EMAILS: "bobby@example.com" } as Partial<Env>);
    const api = makeClient({ mailer: () => mail });

    expect((await offer({ name: "John Smith", email: "john@example.com" }, {})).status).toBe(403);
    expect((await offer({ name: "", email: "john@example.com" })).status).toBe(400);
    expect((await offer({ name: "John", email: "not-an-email" })).status).toBe(400);
    expect((await offer({ name: "John", email: "john@example.com", quantity: "lots" })).status).toBe(400);

    const res = await offer({ name: "  John   Smith ", email: "John@Example.com", quantity: "2-5", checked: "new" });
    expect(res).toMatchObject({ status: 201, body: { kind: "send", status: "new" } });
    expect(mail.sent.map((m) => m.to)).toEqual(["bobby@example.com"]);
    expect(mail.sent[0].text).toContain("John Smith (john@example.com) wants to mail you a koozie (2–5 koozies)");

    // Tapping again updates the open request instead of adding one, and doesn't notify again.
    await offer({ name: "John Smith", email: "john@example.com", quantity: "6-10" });
    expect(mail.sent).toHaveLength(1);

    const list = (await api.json("GET", "/admin/offers?status=new")).body;
    const mine = list.offers.filter((o: any) => o.email === "john@example.com");
    expect(mine).toHaveLength(1);
    expect(mine[0]).toMatchObject({ name: "John Smith", quantity: "6-10", checked: "new", status: "new" });
    expect(list.email_enabled).toBe(true);

    // No address yet: approving says so instead of emailing nothing.
    await api.json("PUT", "/admin/contribute", { mailing_address: null });
    expect((await api.json("POST", `/admin/offers/${mine[0].id}/approve`)).status).toBe(400);
    await api.json("PUT", "/admin/contribute", { mailing_address: "Bobby\n1 Koozie Ln\nSpringfield" });

    const approved = (await api.json("POST", `/admin/offers/${mine[0].id}/approve`)).body;
    expect(approved.contribution.status).toBe("approved");
    expect(approved.email).toMatchObject({ sent: true, draft: { to: "john@example.com" } });
    expect(mail.sent.at(-1)!.text).toContain("1 Koozie Ln");
    expect(mail.sent.at(-1)!.html).toContain("1 Koozie Ln");

    // Only counted koozies can be named in a thank-you.
    const item = await makeItem(api, 9101, "Wisconsin <Koozie>");
    expect((await api.json("POST", `/admin/offers/${mine[0].id}/thank`, { item_ids: [] })).status).toBe(400);
    expect((await api.json("POST", `/admin/offers/${mine[0].id}/thank`, { item_ids: [999999] })).status).toBe(400);
    const thanked = (await api.json("POST", `/admin/offers/${mine[0].id}/thank`, { item_ids: [item.id] })).body;
    expect(thanked.contribution).toMatchObject({ status: "thanked", item_ids: [item.id] });
    const thanks = mail.sent.at(-1)!;
    expect(thanks.subject).toContain("Officially Part of the Collection");
    expect(thanks.text).toContain(`http://localhost/items/${item.id}`);
    expect(thanks.html).toContain("Contributed by John S.");
    expect(thanks.html).toContain("Wisconsin &lt;Koozie&gt;"); // escaped
    expect(thanks.html).toContain(`/pub/photos/${item.photos[0].id}/thumb`);

    expect((await api.json("GET", "/admin/offers?status=done")).body.offers.some((o: any) => o.id === mine[0].id)).toBe(true);
  });

  it("without email connected, every email comes back as a draft and nothing breaks", async () => {
    const offer = pubClient();
    const api = makeClient();
    await offer({ name: "Ann Lee", email: "ann@example.com" });
    const id = (await api.json("GET", "/admin/offers?status=new")).body.offers.find((o: any) => o.email === "ann@example.com").id;
    await api.json("PUT", "/admin/contribute", { mailing_address: "Bobby\n1 Koozie Ln" });
    const r = (await api.json("POST", `/admin/offers/${id}/approve`)).body;
    expect(r.contribution.status).toBe("approved");
    expect(r.email.sent).toBe(false);
    expect(r.email.draft).toMatchObject({ to: "ann@example.com", subject: "Koozie Mailing Instructions" });
    expect(r.email.draft.text).toContain("1 Koozie Ln");
    expect((await api.json("GET", "/admin/contribute")).body.email_enabled).toBe(false);
  });

  it("gifts skip approval; declines can be undone; bots filling the hidden field are ignored", async () => {
    const offer = pubClient();
    const api = makeClient();
    expect((await offer({ kind: "gift", name: "Gift Giver", email: "gift@example.com" })).body).toMatchObject({ kind: "gift", status: "approved" });
    expect((await api.json("GET", "/admin/offers?status=approved")).body.offers.some((o: any) => o.email === "gift@example.com")).toBe(true);

    await offer({ name: "Bot", email: "bot@example.com", website: "http://spam" });
    expect((await api.json("GET", "/admin/offers?status=new")).body.offers.some((o: any) => o.email === "bot@example.com")).toBe(false);

    await offer({ name: "Maybe Later", email: "later@example.com" });
    const id = (await api.json("GET", "/admin/offers?status=new")).body.offers.find((o: any) => o.email === "later@example.com").id;
    expect((await api.json("POST", `/admin/offers/${id}/decline`)).body.contribution.status).toBe("declined");
    expect((await api.json("POST", `/admin/offers/${id}/thank`, { item_ids: [1] })).status).toBe(400);
    expect((await api.json("POST", `/admin/offers/${id}/reopen`)).body.contribution.status).toBe("new");
  });

  it("caps offers per day", async () => {
    const offer = pubClient(undefined, { PUBLIC_OFFER_DAILY_LIMIT: "0" } as Partial<Env>);
    expect((await offer({ name: "Late", email: "late@example.com" })).status).toBe(429);
  });

  it("credits people by first name and last initial", () => {
    expect(creditName("John Smith")).toBe("John S.");
    expect(creditName(" mary ann  van der berg ")).toBe("mary B.");
    expect(creditName("Cher")).toBe("Cher");
  });
});

describe("leaderboard groups", () => {
  it("counts combined sources as one contributor, keeps each koozie's source, and filters by the group", async () => {
    const api = makeClient();
    const a = await makeItem(api, 9201, "Group A", "Gift from Ana Grouptest");
    await makeItem(api, 9202, "Group B", "Gift from the Grouptest family");
    await makeItem(api, 9203, "Group C", "Gift from the Grouptest family");

    const sources = (await api.json("GET", "/admin/sources")).body.sources;
    expect(sources.find((s: any) => s.name === "Gift from the Grouptest family")).toMatchObject({ count: 2, contributor: null });

    expect((await api.json("PUT", "/admin/source-groups", { contributor: "", sources: ["x"] })).status).toBe(400);
    const grouped = await api.json("PUT", "/admin/source-groups", { contributor: "The Grouptest family", sources: ["Gift from Ana Grouptest", "Gift from the Grouptest family"] });
    expect(grouped.body.sources.find((s: any) => s.name === "Gift from Ana Grouptest").contributor).toBe("The Grouptest family");

    const ins = (await (await createPublicApp().fetch(new Request("http://localhost/pub/insights"), env as unknown as Env, createExecutionContext())).json()) as any;
    expect(ins.sources.find((s: any) => s.name === "The Grouptest family")).toMatchObject({ count: 3 });
    expect(ins.sources.some((s: any) => s.name === "Gift from Ana Grouptest")).toBe(false);
    expect(ins.groups).toContainEqual({ source: "Gift from Ana Grouptest", contributor: "The Grouptest family" });

    // The group name filters to every member; an exact source still filters to itself.
    expect((await api.json("GET", `/items?source=${encodeURIComponent("the grouptest family")}`)).body.total).toBe(3);
    expect((await api.json("GET", `/items?source=${encodeURIComponent("Gift from Ana Grouptest")}`)).body.total).toBe(1);
    expect((await api.json("GET", `/items/${a.id}`)).body.acquired_from).toBe("Gift from Ana Grouptest");

    // Rename, then take one out.
    await api.json("PUT", "/admin/source-groups", { contributor: "Grouptests", sources: ["Gift from Ana Grouptest", "Gift from the Grouptest family"], previous: "The Grouptest family" });
    const after = (await api.json("DELETE", "/admin/source-groups", { sources: ["Gift from Ana Grouptest"] })).body.sources;
    expect(after.find((s: any) => s.name === "Gift from Ana Grouptest").contributor).toBeNull();
    expect(after.find((s: any) => s.name === "Gift from the Grouptest family").contributor).toBe("Grouptests");
  });
});

describe("test email", () => {
  it("sends to whoever is signed in, and reports the provider's error", async () => {
    const mail = outbox();
    const api = makeClient({ mailer: () => mail }, { DEV_USER_EMAIL: "bobby@example.com" } as Partial<Env>);
    expect((await api.json("POST", "/admin/email-test")).body).toEqual({ sent: true, to: "bobby@example.com" });
    expect(mail.sent[0]).toMatchObject({ to: "bobby@example.com", subject: "KoozID test email" });

    const failing = makeClient({ mailer: () => ({ enabled: true, send: async () => Promise.reject(new Error("Email provider answered 403: domain is not verified")) }) }, { DEV_USER_EMAIL: "bobby@example.com" } as Partial<Env>);
    expect((await failing.json("POST", "/admin/email-test")).body).toMatchObject({ sent: false, error: expect.stringContaining("not verified") });

    expect((await makeClient().json("POST", "/admin/email-test")).body).toMatchObject({ sent: false });
  });
});
