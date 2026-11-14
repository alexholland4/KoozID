import { createApp, createDeps } from "./app";
import { dailyMaintenance } from "./catalog";
import { getConfig, type Env } from "./env";
import { createPublicApp } from "./public";

const app = createApp();
const pub = createPublicApp();

export default {
  fetch(req, env, ctx) {
    const path = new URL(req.url).pathname;
    if (path.startsWith("/pub/")) return pub.fetch(req, env, ctx);
    // Cloudflare Access guards /signin, so reaching it means the sign-in succeeded.
    if (path === "/signin") return Response.redirect(new URL("/", req.url).toString(), 302);
    return app.fetch(req, env, ctx);
  },

  // Daily (see "triggers" in wrangler.jsonc): erase expired trash and abandoned scans with their photos.
  async scheduled(_event, env, ctx) {
    const d = createDeps(env, getConfig(env), {}, (p) => ctx.waitUntil(p));
    console.log("daily maintenance", await dailyMaintenance(d));
  },
} satisfies ExportedHandler<Env>;
