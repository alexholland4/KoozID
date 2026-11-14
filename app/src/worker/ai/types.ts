import type { MatchConfidence, Suggestion } from "../../shared/types";

/** Turns a photo into a unit-length vector. Implementations must be deterministic per model. */
export interface Embedder {
  /** Stored alongside each vector so a provider/model/dimension change can be detected. */
  readonly modelId: string;
  readonly dims: number;
  embedImage(jpeg: Uint8Array): Promise<Float32Array>;
}

/** Suggests a description and attributes for a photo. Optional: failures never block saving. */
export interface Describer {
  readonly modelId: string;
  /** `back`, when given, is read too (its printed text goes into visible_text). */
  describe(front: Uint8Array, back?: Uint8Array): Promise<Suggestion>;
}

/** One catalogue record offered to the matcher. */
export interface RecordOption {
  id: number;
  code: string;
  description: string;
  color: string | null;
  size: string | null;
  base: string | null;
}

export interface MatchResult {
  /** Chosen record, or null if none fits. Always one of the offered ids. */
  itemId: number | null;
  confidence: MatchConfidence;
  alternatives: number[];
  reason: string;
  /** A description in case it's a new koozie after all. */
  suggestion: Suggestion;
}

/** Picks which written catalogue record a photo shows (bulk photo import). */
export interface Matcher {
  readonly modelId: string;
  /** `hint` is the photo's original file name (only the offline mock uses it); `back` is the koozie's back. */
  match(jpeg: Uint8Array, records: RecordOption[], opts?: { hint?: string; back?: Uint8Array }): Promise<MatchResult>;
}
