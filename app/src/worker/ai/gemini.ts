// Google Gemini API: multimodal embeddings (gemini-embedding-2) and image descriptions (Flash-Lite).
// Plain REST with fetch; no SDK.

import type { Suggestion } from "../../shared/types";
import { AiError } from "../errors";
import { normalize } from "../vectors";
import { sanitizeMatch, sanitizeSuggestion } from "./suggestion";
import type { Describer, Embedder, Matcher, MatchResult, RecordOption } from "./types";

const API = "https://generativelanguage.googleapis.com/v1beta/models";
const TIMEOUT_MS = 25_000;

async function call(apiKey: string, model: string, method: string, body: unknown): Promise<any> {
  if (!apiKey) throw new AiError("GEMINI_API_KEY is not set", "unavailable");
  let res: Response;
  try {
    res = await fetch(`${API}/${model}:${method}`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-goog-api-key": apiKey },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
  } catch (e) {
    throw new AiError(`Gemini request failed: ${(e as Error).message}`, "failed", true);
  }
  if (!res.ok) {
    const text = (await res.text()).slice(0, 300);
    // 503 "high demand" happens for hours at a time on the free tier; treat it like a rate limit.
    const busy = res.status === 429 || res.status >= 500;
    throw new AiError(`Gemini ${model} ${res.status}: ${text}`, busy ? "rate_limited" : "failed", busy);
  }
  return res.json();
}

export function toBase64(bytes: Uint8Array): string {
  let bin = "";
  for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(bin);
}

const inline = (jpeg: Uint8Array) => ({ inlineData: { mimeType: "image/jpeg", data: toBase64(jpeg) } });

export class GeminiEmbedder implements Embedder {
  readonly modelId: string;
  constructor(
    private apiKey: string,
    private model: string,
    readonly dims: number,
  ) {
    this.modelId = `${model}@${dims}`;
  }

  async embedImage(jpeg: Uint8Array): Promise<Float32Array> {
    const body = { content: { parts: [inline(jpeg)] }, outputDimensionality: this.dims };
    const json = await call(this.apiKey, this.model, "embedContent", body);
    const values: number[] | undefined = json?.embedding?.values ?? json?.embeddings?.[0]?.values;
    if (!Array.isArray(values) || values.length !== this.dims) {
      throw new AiError(`Unexpected embedding response (got ${values?.length ?? "no"} dims, want ${this.dims})`);
    }
    // gemini-embedding-2 normalises truncated outputs, but normalising again is cheap and makes
    // dot product == cosine regardless of provider.
    return normalize(Float32Array.from(values));
  }
}

// The description style copies the collector's spreadsheet: what's printed first, design details
// after commas. The body colour is its own field.
const PROMPT = `You are cataloguing a koozie (foam, neoprene or fabric can/bottle cooler) for a collector's spreadsheet.
You get a photo of its front, and sometimes a second photo of its back.
Describe ONLY what is clearly visible. Never guess at text you cannot read.
Return JSON with these fields:
- description: one line in the collector's style. Start with the main printed name or text, then the notable
  design elements, separated by commas. Don't put the body colour here. Not a full sentence, don't say "koozie",
  at most about 25 words.
- color: the koozie's body colour, lowercase; several separated by "/". null if you can't tell.
  Examples of the collector's own entries (description | color):
    Chicago Cubs logo, Chicago Cubs text inside red rectangle | navy blue
    Harpoon Love Beer Love Life red text | yellow
    Santa face, present, bell | green/blue
    Milwaukee Bucks text with deer logo, 2021 Eastern Conference Champions | cream/green
    Life is better at the beach with seashell, starfish | orange
- visible_text: all legible printed text, verbatim, separated by " / ": the front's first, then the back's.
  null if none is legible.
- If there is a back photo and it shows a different design or text, end the description with a short
  ", back: ..." (e.g. ", back: phone number and website"). Leave it out if the back is blank or matches the front.
- size: "Standard Can" (regular 12 oz can), "Tall Can" (slim or tall 16-24 oz can), "Large Can", or
  "Standard Bottle" (bottle shape with a neck). null if you can't tell.
- base: "Collapsible" (soft foam or neoprene that folds flat), "Structured" (rigid foam that holds its shape),
  "Slap" (slap-bracelet wrap) or "Metal" (insulated metal). null if you can't tell.
If the photo does not show a koozie, describe what it shows and set the other fields to null.`;
const BACK_LABEL = "The second photo is the back of the same koozie.";

const SCHEMA = {
  type: "OBJECT",
  properties: {
    description: { type: "STRING" },
    color: { type: "STRING", nullable: true },
    visible_text: { type: "STRING", nullable: true },
    size: { type: "STRING", nullable: true, enum: ["Standard Can", "Tall Can", "Large Can", "Standard Bottle"] },
    base: { type: "STRING", nullable: true, enum: ["Collapsible", "Structured", "Slap", "Metal"] },
  },
  required: ["description"],
};

/**
 * Ask the first model in `models` for JSON; when it's overloaded or rate-limited, ask the next.
 * Returns the parsed JSON and the model that answered.
 */
async function generateJson(
  apiKey: string,
  models: string[],
  images: Uint8Array[],
  prompt: string,
  schema: unknown,
): Promise<{ raw: unknown; model: string }> {
  let last: unknown = new AiError("No describe model configured", "unavailable");
  for (const model of models) {
    try {
      return { raw: await generateOnce(apiKey, model, images, prompt, schema), model };
    } catch (e) {
      last = e;
      if (!(e instanceof AiError && e.retryable)) throw e;
      console.warn("gemini fallback:", (e as Error).message.slice(0, 120));
    }
  }
  throw last;
}

async function generateOnce(apiKey: string, model: string, images: Uint8Array[], prompt: string, schema: unknown): Promise<unknown> {
  const body = {
    contents: [{ role: "user", parts: [...images.map(inline), { text: prompt }] }],
    generationConfig: {
      responseMimeType: "application/json",
      responseSchema: schema,
      temperature: 0.2,
      maxOutputTokens: 2048,
    },
  };
  const json = await call(apiKey, model, "generateContent", body);
  const text: string = (json?.candidates?.[0]?.content?.parts ?? [])
    .filter((p: any) => typeof p.text === "string" && !p.thought)
    .map((p: any) => p.text)
    .join("");
  try {
    return JSON.parse(text);
  } catch {
    // Usually a one-off (cut-off or rambling output): worth trying the next model.
    throw new AiError("Model returned invalid JSON", "failed", true);
  }
}

export class GeminiDescriber implements Describer {
  readonly modelId: string;
  constructor(
    private apiKey: string,
    private models: string[],
  ) {
    this.modelId = models[0];
  }

  async describe(front: Uint8Array, back?: Uint8Array): Promise<Suggestion> {
    const images = back ? [front, back] : [front];
    const { raw, model } = await generateJson(this.apiKey, this.models, images, back ? `${PROMPT}\n${BACK_LABEL}` : PROMPT, SCHEMA);
    return sanitizeSuggestion(raw, model);
  }
}

// One call per photo with the whole list of unphotographed records: a few hundred short lines is
// well within Flash-Lite's context, and seeing every option avoids a separate retrieval step that
// could miss the right one.
const MATCH_PROMPT = `You are matching a photo of a koozie to a collector's written catalogue. If there is a second photo,
it is the back of the same koozie: use its text and design too.
Each catalogue line is: ID | description | size | base. The collector wrote the descriptions: printed text
and design first, the koozie's body colour in brackets.

Decide which ONE record this koozie is, judging by printed text, logos, artwork and colour. Some records are
near-identical (the same design in another colour or size); use colour and shape to choose between them.
If no record fits, use null. Do not force a match.

Return JSON:
- match: the chosen ID exactly as written (e.g. "K-0042"), or null
- confidence: "high" if the printed text or artwork clearly matches and no other record is near-identical,
  "medium" if it probably matches, "low" if it's a guess
- alternatives: up to 3 other plausible IDs, best first
- reason: why, in at most 15 words
- description, color, visible_text, size, base: how you would catalogue this koozie if it were new, in the collector's
  style (see the descriptions below for examples)

Catalogue:
`;

const MATCH_SCHEMA = {
  type: "OBJECT",
  properties: {
    match: { type: "STRING", nullable: true },
    confidence: { type: "STRING", enum: ["high", "medium", "low"] },
    alternatives: { type: "ARRAY", items: { type: "STRING" } },
    reason: { type: "STRING" },
    ...SCHEMA.properties,
  },
  required: ["confidence", "description"],
};

const line = (r: RecordOption) =>
  `${r.code} | ${r.description.replace(/\s+/g, " ").slice(0, 300)} | ${r.color ?? "-"} | ${r.size ?? "-"} | ${r.base ?? "-"}`;

export class GeminiMatcher implements Matcher {
  readonly modelId: string;
  constructor(
    private apiKey: string,
    private models: string[],
  ) {
    this.modelId = models[0];
  }

  async match(jpeg: Uint8Array, records: RecordOption[], opts: { back?: Uint8Array } = {}): Promise<MatchResult> {
    const images = opts.back ? [jpeg, opts.back] : [jpeg];
    const { raw, model } = await generateJson(this.apiKey, this.models, images, MATCH_PROMPT + records.map(line).join("\n"), MATCH_SCHEMA);
    return sanitizeMatch(raw, records, model);
  }
}

