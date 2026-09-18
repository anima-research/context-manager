import type { ContentBlock } from '@animalabs/membrane';

/**
 * Unique identifier for a message in the store.
 * Corresponds to Chronicle record ID.
 */
export type MessageId = string;

/**
 * Sequence number within a branch.
 */
export type Sequence = number;

/**
 * Branch identifier.
 */
export type BranchId = string;

/**
 * Metadata attached to a stored message.
 */
export interface MessageMetadata {
  /** Application-defined tags */
  tags?: string[];
  /** Original source ID (e.g., from external system) */
  sourceId?: string;
  /** Custom key-value pairs */
  [key: string]: unknown;
}

/**
 * A message stored in the message store.
 * This is the source of truth for all conversation history.
 */
export interface StoredMessage {
  /** Unique message identifier */
  id: MessageId;
  /** Sequence number within current branch */
  sequence: Sequence;
  /** Participant name: "User", "Claude", "Alice", etc. */
  participant: string;
  /** Message content blocks (uses Membrane types) */
  content: ContentBlock[];
  /** Optional metadata */
  metadata?: MessageMetadata;
  /** When the message was stored */
  timestamp: Date;
  /** IDs of messages that caused this one (from Chronicle causation) */
  causedBy?: MessageId[];

  /**
   * If this message is a shard of a larger logical message (chunked at
   * ingestion because it exceeded `chunkThreshold`), this is the stable
   * group id shared with sibling shards. Shards with the same id are
   * concatenated into one API message at render time. Null/undefined
   * for messages that fit in a single chunk. See
   * `docs/adaptive-resolution-design.md` §3.6.
   */
  bodyGroupId?: string;

  /**
   * The shard's order within its bodyGroup, starting at 0. Only meaningful
   * when `bodyGroupId` is set. Used to reassemble shards into byte-faithful
   * order at render time.
   */
  shardIndex?: number;

  /**
   * Current display resolution for this chunk:
   *  - 0  = render raw content
   *  - k>0 = render the L_k summary that covers this chunk
   *
   * Set by the picker (or the agent in V2). Default 0. See
   * `docs/adaptive-resolution-design.md` §3.3.
   */
  currentResolution?: number;

  /**
   * If true, the picker must not change `currentResolution` for this chunk.
   * Set by `lockChunk()` (programmatic API) or, in V2, by the agent's
   * `unfold` tool. Default false.
   */
  lockedByAgent?: boolean;
}

/**
 * Reference to a blob stored in Chronicle.
 * Used internally to avoid duplicating media content.
 */
export interface BlobReference {
  /** SHA-256 hash of the blob content */
  hash: string;
  /** MIME type of the content */
  mediaType: string;
  /** Original content block type */
  originalType: 'image' | 'document' | 'audio' | 'video';
}

/**
 * Content block with blob references instead of inline data.
 * Used for storage efficiency.
 *
 * - Media with base64 data is replaced with blob_ref
 * - URL-based images pass through unchanged
 * - All other content types pass through unchanged
 */
export type StoredContentBlock =
  | Exclude<ContentBlock, { type: 'document' | 'audio' | 'video' }>
  | { type: 'blob_ref'; ref: BlobReference };

/**
 * Internal representation of a stored message with blob references.
 */
export interface StoredMessageInternal {
  id: MessageId;
  sequence: Sequence;
  participant: string;
  content: StoredContentBlock[];
  metadata?: MessageMetadata;
  timestamp: number; // Unix timestamp for storage
  causedBy?: MessageId[];

  /** See StoredMessage.bodyGroupId */
  bodyGroupId?: string;
  /** See StoredMessage.shardIndex */
  shardIndex?: number;
  /** See StoredMessage.currentResolution */
  currentResolution?: number;
  /** See StoredMessage.lockedByAgent */
  lockedByAgent?: boolean;
}

/**
 * Query filter for message lookup.
 * All fields are optional - omitted fields match everything.
 */
export interface MessageQuery {
  /**
   * Filter by external source (e.g., 'discord', 'slack').
   * Matches messages where metadata.external.source === source.
   */
  source?: string;

  /**
   * Filter by specific external IDs.
   * Matches messages where metadata.external.id is in this list.
   */
  externalIds?: string[];

  /**
   * Filter by participant name.
   */
  participant?: string;

  /**
   * Filter by metadata fields.
   * Supports dot notation for nested fields (e.g., 'external.channelId').
   * Values are compared with strict equality.
   */
  metadata?: Record<string, unknown>;

  /**
   * Maximum number of messages to return.
   * If not specified, returns all matching messages.
   */
  limit?: number;

  /**
   * Return messages in reverse order (newest first).
   * Default: false (oldest first).
   */
  reverse?: boolean;
}

/**
 * Result of a message query.
 */
export interface MessageQueryResult {
  /** Matching messages */
  messages: StoredMessage[];
  /** Total count of matching messages (may be more than returned if limited) */
  totalCount: number;
}

/**
 * Options for a native chronicle-indexed timestamp-range query (see
 * MessageStore.queryByTime / ContextManager.queryMessagesByTime). Backed by
 * `queryStateIndexRange` against the `/timestamp` field index —
 * O(log n + k) ordinal lookup, not a full-store scan.
 */
export interface TimeRangeQueryOptions {
  /** Inclusive lower bound, Unix ms. Omit for open-ended. */
  fromMs?: number;
  /** Inclusive upper bound, Unix ms. Omit for open-ended. */
  toMs?: number;
  limit?: number;
  offset?: number;
  /** Return newest-first when true. Default false (oldest first). */
  reverse?: boolean;
}

/**
 * Options for a native chronicle-indexed channel-equality query (see
 * MessageStore.queryByChannel / ContextManager.queryMessagesByChannel).
 * Backed by `queryStateIndexEq` against the `/metadata/external/channelId`
 * field index.
 */
export interface ChannelQueryOptions {
  limit?: number;
  offset?: number;
}

/**
 * Options for a combined time-range + channel query (see
 * MessageStore.queryByTimeAndChannel / ContextManager.queryMessagesByTimeAndChannel).
 * When both a range and a channel are given, the two native ordinal sets
 * are intersected before limit/offset is applied (see the method's own
 * comment for why that ordering is the only correct one).
 */
export interface TimeAndChannelQueryOptions {
  fromMs?: number;
  toMs?: number;
  channelId?: string;
  limit?: number;
  offset?: number;
}

/**
 * Result of an index-backed message query (time/channel/both). Distinct
 * from MessageQueryResult (whose `totalCount` is the size of a full-scan
 * filter match) only in name, to keep the two query families visually
 * distinguishable at call sites.
 */
export interface IndexedMessageQueryResult {
  messages: StoredMessage[];
  /** Total matching ordinals before limit/offset was applied. */
  matchedCount: number;
}

/** One channel's message count, from MessageStore.getChannelCounts /
 *  ContextManager.getChannelMessageCounts. Native — O(index size), no
 *  content decoding. */
export interface ChannelCount {
  channelId: string;
  messages: number;
}

/** Per-channel token-estimate breakdown, one entry of
 *  ChannelTokenStats.byChannel. */
export interface ChannelTokenBreakdown {
  channelId: string;
  messages: number;
  tokensEstimate: number;
}

/**
 * Result of MessageStore.getChannelTokenStats /
 * ContextManager.getChannelTokenStats. Unlike getChannelCounts, this
 * requires decoding message content (token estimation isn't stored in
 * chronicle) — see MessageStore.tokenStatsCache for the amortizing cache.
 */
export interface ChannelTokenStats {
  totalMessages: number;
  totalTokensEstimate: number;
  byChannel: ChannelTokenBreakdown[];
}

/** Options for MessageStore.getChannelTokenStats / ContextManager.getChannelTokenStats. */
export interface ChannelTokenStatsOptions {
  fromMs?: number;
  toMs?: number;
}
