import type { ContentBlock } from '@animalabs/membrane';
import type { RequestOverhead, SelectOptions } from './types/strategy.js';
import type { StoredMessage } from './types/index.js';
import { OverBudgetError } from './adaptive/picker.js';

export function requestOverheadContent(overhead: RequestOverhead): ContentBlock[] {
  const content: ContentBlock[] = [];
  if (overhead.system) content.push({ type: 'text', text: overhead.system });
  if (overhead.tools && overhead.tools.length > 0) content.push({ type: 'text', text: JSON.stringify(overhead.tools) });
  for (const message of overhead.messages ?? []) content.push(...message);
  return content;
}

export function refuseUnreadableRequestLimit(opts: Pick<SelectOptions, 'requestLimitTokens' | 'requestOverhead'> | undefined): void {
  const limit: unknown = opts?.requestLimitTokens;
  if (limit === undefined) return;
  if (typeof limit !== 'number' || !Number.isFinite(limit) || limit <= 0) {
    throw new TypeError(`requestLimitTokens must be a positive finite number of tokens; it is ${String(limit)}`);
  }
  if (!opts?.requestOverhead) {
    throw new TypeError('requestLimitTokens needs requestOverhead, the system prompt and tools the request sends beside the window');
  }
}

export type RequestBesidesWindow = { limit: number; reserve: number; overhead: number; injected: number };

export function noRoomUnderRequestLimit(parts: RequestBesidesWindow & { allowance: number; pricedAt?: string }): OverBudgetError {
  const besides = parts.reserve + parts.overhead + parts.injected;
  const error = new OverBudgetError({
    budget: parts.limit,
    actual: besides,
    stage: 'Request limit',
    diagnostics: {
      headTokens: 0, tailTokens: 0, middleTokens: 0, middleChunkCount: 0, deepestLevel: 0, deepestLevelKind: 'unplanned',
      requestLimitTokens: parts.limit, requestAllowanceTokens: parts.allowance, requestLimitBound: true,
    },
  });
  error.message = `The request limit of ${parts.limit} tokens leaves the window no room: the reply's reserve of ` +
    `${parts.reserve}, the request overhead of ${parts.overhead} and the message injections of ${parts.injected}` +
    `${parts.pricedAt === undefined ? '' : ` (those two priced at ${parts.pricedAt})`} come to ${besides}`;
  return error;
}

export function overRequestLimit(parts: RequestBesidesWindow & { window: number }): OverBudgetError {
  const total = parts.window + parts.reserve + parts.overhead + parts.injected;
  const error = new OverBudgetError({
    budget: parts.limit,
    actual: total,
    stage: 'Request limit',
    diagnostics: {
      headTokens: 0, tailTokens: 0, middleTokens: parts.window, middleChunkCount: 0, deepestLevel: 0, deepestLevelKind: 'unplanned',
      requestLimitTokens: parts.limit, requestAllowanceTokens: parts.limit - parts.reserve - parts.overhead - parts.injected,
      requestLimitBound: true,
    },
  });
  error.message = `The compiled request would hold ${total} tokens, over its limit of ${parts.limit}: the window ` +
    `${parts.window}, the message injections ${parts.injected}, the request overhead ${parts.overhead} and the ` +
    `reply's reserve ${parts.reserve}`;
  return error;
}

export function roomUnderRequestLimit(
  store: { estimateTokens(message: StoredMessage): number },
  reserve: number,
  room: number,
  opts: SelectOptions | undefined,
): number {
  const limit = opts?.requestLimitTokens;
  if (limit === undefined || !opts?.requestOverhead) return room;
  const price = (content: ContentBlock[]) => (content.length > 0 ? store.estimateTokens({ content } as unknown as StoredMessage) : 0);
  const overhead = price(requestOverheadContent(opts.requestOverhead));
  const injected = (opts.messageInjections ?? []).reduce((n, content) => n + price([...content]), 0);
  const allowance = Math.floor(limit - reserve - overhead - injected);
  if (allowance <= 0) throw noRoomUnderRequestLimit({ limit, reserve, overhead, injected, allowance });
  return Math.min(room, allowance);
}
