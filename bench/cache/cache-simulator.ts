/**
 * Cache-hit simulator.
 *
 * Models Anthropic's prompt cache as a pure structural function of the
 * request prefix: each `cache_control` ephemeral marker writes a cache
 * entry at that prefix length; a later request gets a hit at the longest
 * stored prefix that matches its own prefix exactly.
 *
 * The cache stores entries from PRIOR requests' markers, not the current
 * request's. The current request's markers determine where new entries
 * are written THIS turn (and so what subsequent requests can hit).
 *
 * Simplifications relative to the real cache:
 *  - 5-minute TTL is assumed not to expire across the bench (we run all
 *    turns back-to-back).
 *  - Per Anthropic docs the live cache keeps up to N marker positions; we
 *    keep all prior markers (overestimate) unless cacheRetention is set.
 *  - Token estimates use the 4 chars/token rule.
 */

export interface PrefixUnit {
  /** Canonical equality key. Cache_control fields are stripped. */
  canonical: string;
  tokens: number;
  /** Role label, kept only for debugging — not part of equality. */
  role: string;
}

export interface RequestPrefix {
  units: PrefixUnit[];
  /** Indices into `units` where a cache_control ephemeral marker lives. */
  breakpoints: number[];
  totalTokens: number;
}

export interface CacheReport {
  requestTokens: number;
  /** Tokens served from cache (up to the highest matching breakpoint). */
  cacheHitTokens: number;
  /** Tokens written to cache at new breakpoint positions this turn. */
  cacheWriteTokens: number;
  /** Tokens charged at full input price (past the last breakpoint). */
  freshTokens: number;
  /** Highest current-request breakpoint that matched the prior prefix. */
  hitBreakpoint: number | null;
  /** First diverging unit index (or -1 if prefixes are identical). */
  divergeAt: number;
}

function estimateBlockTokens(block: unknown): number {
  if (typeof block === 'string') return Math.ceil(block.length / 4);
  if (block && typeof block === 'object') {
    const b = block as { type?: string; text?: string };
    if (b.type === 'text' && typeof b.text === 'string') {
      return Math.ceil(b.text.length / 4);
    }
    return Math.ceil(JSON.stringify(block).length / 4);
  }
  return 0;
}

function stripCacheControl(block: unknown): unknown {
  if (!block || typeof block !== 'object') return block;
  const { cache_control: _drop, ...rest } = block as Record<string, unknown>;
  return rest;
}

/**
 * Flatten a raw provider request into a linear sequence of cache-relevant
 * units. Order matches what Anthropic's cache lookup sees: system → tools →
 * messages, each broken into individual content blocks.
 */
export function linearizeRequest(rawReq: unknown): RequestPrefix {
  const units: PrefixUnit[] = [];
  const breakpoints: number[] = [];
  const req = rawReq as {
    system?: unknown;
    tools?: unknown[];
    messages?: Array<{ role: string; content: unknown }>;
  };

  const push = (canonical: string, tokens: number, role: string, hasBp: boolean) => {
    units.push({ canonical, tokens, role });
    if (hasBp) breakpoints.push(units.length - 1);
  };

  // System: string or array of blocks
  if (req.system) {
    const sysBlocks = Array.isArray(req.system)
      ? req.system
      : [{ type: 'text', text: req.system as string }];
    for (const block of sysBlocks) {
      const hasBp = !!(block as { cache_control?: unknown }).cache_control;
      push(
        'SYS:' + JSON.stringify(stripCacheControl(block)),
        estimateBlockTokens(block),
        'system',
        hasBp,
      );
    }
  }

  // Tools (cacheable prefix segment when promptCaching is on)
  if (Array.isArray(req.tools)) {
    for (const tool of req.tools) {
      const hasBp = !!(tool as { cache_control?: unknown }).cache_control;
      push(
        'TOOL:' + JSON.stringify(stripCacheControl(tool)),
        estimateBlockTokens(tool),
        'tool',
        hasBp,
      );
    }
  }

  // Messages: explode each into per-block units
  for (const msg of req.messages || []) {
    const content = Array.isArray(msg.content)
      ? msg.content
      : [{ type: 'text', text: msg.content }];
    for (const block of content) {
      const hasBp = !!(block as { cache_control?: unknown }).cache_control;
      push(
        `${msg.role}:` + JSON.stringify(stripCacheControl(block)),
        estimateBlockTokens(block),
        msg.role,
        hasBp,
      );
    }
  }

  const totalTokens = units.reduce((s, u) => s + u.tokens, 0);
  return { units, breakpoints, totalTokens };
}

function sumTokens(units: PrefixUnit[], lo: number, hi: number): number {
  // hi exclusive
  let s = 0;
  for (let i = lo; i < hi; i++) s += units[i].tokens;
  return s;
}

/**
 * Persistent cache state across multiple requests. The cache stores one
 * entry per breakpoint per request (deduplicated). A request can hit at
 * any prior marker position whose prefix matches the current request
 * unit-for-unit.
 */
export interface CacheEntry {
  canonical: string[];
  units: number;
  tokens: number;
}

export class CacheState {
  private entries: CacheEntry[] = [];
  private readonly retention: number;

  constructor(opts: { retention?: number } = {}) {
    // Default keeps a generous history — bench is short. Set retention=4
    // to roughly approximate the per-request marker budget that bounds
    // how much state Anthropic keeps live.
    this.retention = opts.retention ?? 1024;
  }

  longestMatch(currUnits: PrefixUnit[]): CacheEntry | null {
    let best: CacheEntry | null = null;
    for (const entry of this.entries) {
      if (entry.units > currUnits.length) continue;
      let matches = true;
      for (let i = 0; i < entry.units; i++) {
        if (entry.canonical[i] !== currUnits[i].canonical) {
          matches = false;
          break;
        }
      }
      if (matches && (!best || entry.units > best.units)) {
        best = entry;
      }
    }
    return best;
  }

  ingest(req: RequestPrefix): void {
    for (const bp of req.breakpoints) {
      const units = bp + 1;
      const canonical = req.units.slice(0, units).map((u) => u.canonical);
      const isDup = this.entries.some(
        (e) =>
          e.units === units &&
          e.canonical.every((c, i) => c === canonical[i]),
      );
      if (isDup) continue;
      this.entries.push({
        canonical,
        units,
        tokens: sumTokens(req.units, 0, units),
      });
    }
    while (this.entries.length > this.retention) {
      this.entries.shift();
    }
  }

  size(): number {
    return this.entries.length;
  }
}

/**
 * Score one request against the cache. Caller is responsible for invoking
 * `cache.ingest(curr)` AFTER recording the report — so the new markers
 * become available to subsequent turns.
 *
 * Definitions:
 *  - hit:   tokens covered by the longest cached prefix that matches curr
 *  - write: tokens from end-of-hit to end-of-last-marker (newly cached this turn)
 *  - fresh: tokens past the last marker (full input price)
 */
export function simulateCacheHit(
  cache: CacheState,
  curr: RequestPrefix,
): CacheReport {
  const lastBp =
    curr.breakpoints.length > 0
      ? curr.breakpoints[curr.breakpoints.length - 1]
      : -1;

  const match = cache.longestMatch(curr.units);
  const hitEnd = match ? match.units : 0;
  const hitTokens = match ? match.tokens : 0;

  let writeTokens = 0;
  if (lastBp + 1 > hitEnd) {
    writeTokens = sumTokens(curr.units, hitEnd, lastBp + 1);
  }

  const freshTokens = curr.totalTokens - hitTokens - writeTokens;

  return {
    requestTokens: curr.totalTokens,
    cacheHitTokens: hitTokens,
    cacheWriteTokens: writeTokens,
    freshTokens,
    hitBreakpoint: lastBp >= 0 ? lastBp : null,
    divergeAt: hitEnd,
  };
}
