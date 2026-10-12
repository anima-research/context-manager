/**
 * Bodies: one ingestion of a message, stored whole or as shards.
 *
 * A shard group's id names its content (the chunker hashes the text), so
 * every ingestion of the same text carries the same id: a document posted
 * twice, or a write an interruption cut short followed by its retry. Each
 * ingestion writes its shards 0..n-1, after whatever came before, so in
 * store order a message continues the body before it only when it carries
 * the same group id at a higher shard index; an index that doesn't rise
 * starts the next body.
 *
 * The rule is read pairwise, so it holds wherever a sequence is cut: a
 * render region that begins mid-body (the head and recent windows end where
 * their tokens run out), a slice of entries, or a view that hides a body's
 * first shards. Sequences are read in store order; nothing reorders a
 * body's shards. Every reader that asks which messages make up a body asks
 * it here, rather than matching the group id.
 */

/** The fields that place a stored message in a body. */
export interface BodyShard {
  bodyGroupId?: string | undefined;
  shardIndex?: number | undefined;
}

type At = (i: number) => BodyShard | null | undefined;

/** Whether `next`, right after `prev` in store order, is a later shard of the same body. */
export function continuesBody(prev: BodyShard | null | undefined, next: BodyShard | null | undefined): boolean {
  return (
    !!prev?.bodyGroupId &&
    prev.bodyGroupId === next?.bodyGroupId &&
    (next.shardIndex ?? 0) > (prev.shardIndex ?? 0)
  );
}

/**
 * The first position of the body holding `index`, read backward from it
 * through `at` (a store's point lookups, or an array's). A message outside
 * any group is a body of its own.
 */
export function bodyStart(at: At, index: number): number {
  let start = index;
  while (start > 0 && continuesBody(at(start - 1), at(start))) start--;
  return start;
}

/**
 * The last position (inclusive) of the body holding `index`, read forward
 * from it in a sequence of `length`: the scan stops at `length`, so a
 * caller that can use nothing past some point passes that point.
 */
export function bodyEnd(length: number, at: At, index: number): number {
  let end = index;
  while (end + 1 < length && continuesBody(at(end), at(end + 1))) end++;
  return end;
}

/**
 * The first and last positions (inclusive) of the body holding `index`.
 * A reader that needs only one edge asks `bodyStart` or `bodyEnd`.
 */
export function bodyBounds(length: number, at: At, index: number): { from: number; to: number } {
  return { from: bodyStart(at, index), to: bodyEnd(length, at, index) };
}

/** The body holding `messages[index]`, as positions in `messages`. */
export function bodyBoundsIn(messages: readonly (BodyShard | null | undefined)[], index: number): { from: number; to: number } {
  return bodyBounds(messages.length, (i) => messages[i], index);
}
