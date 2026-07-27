/**
 * Compression profiles for the bench's mock summarizer.
 *
 * A `CompressionProfile` is what a real LLM-driven summarizer is replaced
 * with: it takes the chunk text the strategy wants to compress and emits
 * a deterministic shorter string. The bench cares about the *length* of
 * the output (it determines how much the head zone shifts) and the
 * *content uniqueness* (it determines whether the cache prefix breaks).
 * Quality of the summary is irrelevant — nothing reads it.
 *
 * The compress() output is deterministic in (input, seed) so re-running
 * a bench produces identical request shapes.
 */

export interface CompressionProfile {
  readonly name: string;
  /** Target output token count for a given input token count. */
  outputTokens(inputTokens: number): number;
  /**
   * Emit a deterministic string roughly `outputTokens(input)` tokens long.
   * `seed` may be omitted; if provided, varies the output for the same
   * input across runs (used for sensitivity analysis).
   */
  compress(input: string, seed?: number): string;
}

function fnv1a(s: string, seed = 0): number {
  let h = (seed ^ 0x811c9dc5) >>> 0;
  for (let i = 0; i < s.length; i++) {
    h = (h ^ s.charCodeAt(i)) >>> 0;
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h;
}

function tokensToChars(tokens: number): number {
  return tokens * 4;
}

function approxTokenCount(text: string): number {
  return Math.ceil(text.length / 4);
}

/**
 * Build a body of approximately `targetTokens` tokens that is stable
 * under input — same input always produces the same body — but differs
 * across inputs so the cache treats it as new content.
 */
function buildBody(input: string, targetTokens: number, seed: number): string {
  const fingerprint = fnv1a(input, seed).toString(16).padStart(8, '0');
  const targetChars = tokensToChars(Math.max(1, targetTokens));
  const block = `[summary:${fingerprint}] `;
  let out = block;
  while (out.length < targetChars) {
    out += block;
  }
  return out.slice(0, targetChars);
}

/**
 * Fixed-ratio profile. outputTokens = ceil(inputTokens * ratio).
 * Quickest default — pick the ratio you've observed empirically.
 */
export function constantRatio(ratio: number, name?: string): CompressionProfile {
  return {
    name: name ?? `constant-${ratio}`,
    outputTokens(inputTokens) {
      return Math.max(1, Math.ceil(inputTokens * ratio));
    },
    compress(input, seed = 0) {
      const inTok = approxTokenCount(input);
      const outTok = this.outputTokens(inTok);
      return buildBody(input, outTok, seed);
    },
  };
}

/**
 * Bucketed profile. Plug a table of `{ inputTokensUpTo, outputTokens }` rows
 * (observed from real summarizations). Inputs are bucketed by the smallest
 * matching `inputTokensUpTo`; outputs interpolate linearly between bucket
 * endpoints.
 *
 * Useful when observed data shows a non-linear relationship (e.g. small
 * chunks compress less aggressively than large ones, or there's a floor
 * around 200 tokens).
 */
export interface CompressionBucket {
  inputTokensUpTo: number;
  outputTokens: number;
}

export function bucketed(
  buckets: CompressionBucket[],
  name = 'bucketed',
): CompressionProfile {
  const sorted = [...buckets].sort(
    (a, b) => a.inputTokensUpTo - b.inputTokensUpTo,
  );
  if (sorted.length === 0) {
    throw new Error('bucketed: at least one bucket required');
  }
  return {
    name,
    outputTokens(inputTokens) {
      for (let i = 0; i < sorted.length; i++) {
        if (inputTokens <= sorted[i].inputTokensUpTo) {
          if (i === 0) return Math.max(1, sorted[0].outputTokens);
          // Linear interpolation between (i-1) and i
          const lo = sorted[i - 1];
          const hi = sorted[i];
          const span = hi.inputTokensUpTo - lo.inputTokensUpTo;
          const pos = inputTokens - lo.inputTokensUpTo;
          const ratio = span > 0 ? pos / span : 0;
          return Math.max(
            1,
            Math.round(lo.outputTokens + ratio * (hi.outputTokens - lo.outputTokens)),
          );
        }
      }
      return Math.max(1, sorted[sorted.length - 1].outputTokens);
    },
    compress(input, seed = 0) {
      const inTok = approxTokenCount(input);
      const outTok = this.outputTokens(inTok);
      return buildBody(input, outTok, seed);
    },
  };
}

/**
 * Empirical profile. Pass a list of `{ inputTokens, outputTokens }`
 * observations and the profile picks the nearest neighbor on every call.
 *
 * Suited for raw data from observed compression logs
 * (CONTEXT_MANAGER_COMPRESSION_LOG produces this shape directly).
 */
export interface CompressionSample {
  inputTokens: number;
  outputTokens: number;
}

export function empirical(
  samples: CompressionSample[],
  name = 'empirical',
): CompressionProfile {
  if (samples.length === 0) {
    throw new Error('empirical: at least one sample required');
  }
  const sorted = [...samples].sort((a, b) => a.inputTokens - b.inputTokens);
  return {
    name: `${name}(n=${samples.length})`,
    outputTokens(inputTokens) {
      // Binary search nearest neighbor by inputTokens
      let lo = 0,
        hi = sorted.length - 1;
      while (lo < hi) {
        const mid = (lo + hi) >> 1;
        if (sorted[mid].inputTokens < inputTokens) lo = mid + 1;
        else hi = mid;
      }
      const cand = [sorted[Math.max(0, lo - 1)], sorted[lo]];
      const nearest = cand.reduce((best, s) =>
        Math.abs(s.inputTokens - inputTokens) <
        Math.abs(best.inputTokens - inputTokens)
          ? s
          : best,
      );
      return Math.max(1, nearest.outputTokens);
    },
    compress(input, seed = 0) {
      const inTok = approxTokenCount(input);
      const outTok = this.outputTokens(inTok);
      return buildBody(input, outTok, seed);
    },
  };
}
