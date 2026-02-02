import type { ContentBlock } from 'membrane';

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
