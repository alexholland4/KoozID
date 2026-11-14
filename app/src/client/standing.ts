// Fun facts for guests that are computed in the browser from the public stats.

import type { Insights, NameCount } from "../shared/types";
import { pub } from "./api";

// Several components want the same stats on one page view; fetch them once.
let insights: Promise<Insights> | null = null;
export function sharedInsights(): Promise<Insights> {
  insights ??= pub.insights().catch((e) => {
    insights = null;
    throw e;
  });
  return insights;
}

export interface Standing {
  rank: number;
  count: number;
  /** 1, 3, 5 or 10 for the notable ones; null otherwise. */
  tier: 1 | 3 | 5 | 10 | null;
  /** "contributor" for gifts, "source" for shops and finds. */
  noun: "contributor" | "source";
}

/** The leaderboard name for a source: its group's name if it's been combined with others. */
export function contributorOf(ins: Pick<Insights, "groups">, name: string): string {
  const n = name.toLowerCase();
  return ins.groups.find((g) => g.source.toLowerCase() === n)?.contributor ?? name;
}

/** Does a leaderboard row match a search, by its own name or any source combined into it? */
export function matchesSource(ins: Pick<Insights, "groups">, row: NameCount, q: string): boolean {
  if (row.name.toLowerCase().includes(q)) return true;
  const name = row.name.toLowerCase();
  return ins.groups.some((g) => g.contributor.toLowerCase() === name && g.source.toLowerCase().includes(q));
}

/** Rank among all sources (groups combined) by koozie count; ties share a rank. */
export function standing(ins: Pick<Insights, "sources" | "groups">, source: string): Standing | null {
  const sources = ins.sources;
  const name = contributorOf(ins, source);
  const me = sources.find((s) => s.name.toLowerCase() === name.toLowerCase());
  if (!me) return null;
  const rank = 1 + sources.filter((s) => s.count > me.count).length;
  const tier = rank === 1 ? 1 : rank <= 3 ? 3 : rank <= 5 ? 5 : rank <= 10 ? 10 : null;
  return { rank, count: me.count, tier, noun: /^(purchased|bought|found|won)\b/i.test(name) ? "source" : "contributor" };
}

export function standingLabel(s: Standing): string | null {
  if (!s.tier) return null;
  return s.tier === 1 ? `The #1 ${s.noun}` : `A top ${s.tier} ${s.noun} (#${s.rank})`;
}

/** "Lately about 2 a day. At this pace, 4,000 arrives around March 2029." */
export function paceLine(total: number, goal: number | null, last90: number): string | null {
  if (!goal) return null;
  if (total >= goal) return "Goal reached!";
  if (!last90) return null;
  const perDay = last90 / 90;
  const eta = new Date(Date.now() + ((goal - total) / perDay) * 86_400_000);
  const rate =
    perDay >= 1.5 ? `about ${Math.round(perDay)} a day` : perDay * 7 >= 1.5 ? `about ${Math.round(perDay * 7)} a week` : `one every ${Math.round(1 / perDay)} days`;
  const when = eta.toLocaleDateString(undefined, { month: "long", year: "numeric" });
  return `Lately ${rate}. At this pace, ${goal.toLocaleString()} arrives around ${when}.`;
}
