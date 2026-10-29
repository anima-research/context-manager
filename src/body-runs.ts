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

import type { ContentBlock } from '@animalabs/membrane';

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

/** One part of a body to join: a shard, or a render that already joins a run
 *  of its shards, with the first shard's `continuesBlock`. */
export interface BodyPart<Block extends { type: string } = ContentBlock> {
  content: readonly Block[];
  continuesBlock?: boolean | undefined;
}

/**
 * A body's blocks, from consecutive parts of it in store order: its shards,
 * or renders that each join a run of them. This is how every raw render of a
 * body joins it, so a body reads the same wherever its shards render.
 *
 * A body written with each block in place declares `continuesBlock` on every
 * shard after the first, and comes back as given: the parts' blocks in order,
 * with a part's first text block joined to the previous part's last where the
 * seam between them split that block, so the text blocks keep the boundaries
 * they were given with too. A block a seam cut comes back as plain text, as
 * ingress stored its pieces.
 *
 * A body written before then holds its text joined into one block, cut
 * across its shards, and its other blocks on its first shard after that
 * shard's text. Joined as stored, its thinking and its calls would come
 * after its first slice of text, and where those blocks sat wasn't kept, so
 * it is joined as it always was: every other block first, then the text as
 * one block. A single part is its own content, as before.
 */
export function joinBodyContent<Block extends { type: string }>(parts: readonly BodyPart<Block>[]): Block[] {
  if (parts.length === 1) return [...parts[0]!.content];
  if (parts.slice(1).some((part) => part.continuesBlock === undefined)) {
    const others: Block[] = [];
    const text: string[] = [];
    for (const part of parts) {
      for (const block of part.content) {
        if (block.type === 'text') text.push((block as unknown as { text: string }).text);
        else others.push(block);
      }
    }
    return [...others, { type: 'text', text: text.join('') } as unknown as Block];
  }
  const out: Block[] = [];
  for (const [k, part] of parts.entries()) {
    const first = part.content[0];
    const last = out.at(-1);
    if (k > 0 && part.continuesBlock && first?.type === 'text' && last?.type === 'text') {
      out[out.length - 1] = {
        ...last,
        text: (last as unknown as { text: string }).text + (first as unknown as { text: string }).text,
      } as Block;
      out.push(...part.content.slice(1));
    } else {
      out.push(...part.content);
    }
  }
  return out;
}
