/**
 * Content that matches `ContentBlock` where its readers read it. Content is
 * an array, every block in it an object, not an array, whose `type` is a
 * string, and the field that carries a block's content has its type:
 *   - a `text` block's `text` and a `thinking` block's `thinking` are strings;
 *   - a `tool_use`'s `input` is an object, not null and not an array;
 *   - a `tool_result`'s `content` is a string, or an array of such blocks,
 *     at any depth;
 *   - an `image`, `document`, `audio` or `video` block's `source` is an
 *     object, and a `generated_image`'s `data` and `mimeType` are strings.
 * A write also refuses inline media the store can't keep as a blob, by the
 * store's own rules (stored-media.ts): data its read of base64 can't take,
 * which only data that isn't a string can be, since any string reads as
 * base64, or no media type, neither a declared one nor, for an image, one
 * its data's signature names. The store keeps a block of the content as a
 * blob, not media inside a `tool_result`, which it keeps as given.
 * Nothing else is checked: not ids, names or signatures, which a provider may
 * still refuse a block without, and nothing else of a media source, such as
 * a URL image's URL, which the formatters and the providers read. A block of
 * a type none of these names passes as it is, since membrane adds types:
 * whether a provider can take one is the provider's to say. One type is the
 * store's own: a `blob_ref`, which the store writes in place of inline media.
 * A write can't give one, and a read takes one whose `ref` is an object with
 * a string `hash` and an `originalType` of image, document, audio or video,
 * which is what a read turns the blob back into.
 *
 * Every reader of stored content, from the token estimators to compression
 * and the formatters, is written against `ContentBlock`, and a reader that
 * meets content that doesn't match it can throw. A stored message holding a
 * block that isn't an object, or a `blob_ref` without a `ref` or whose
 * `originalType` isn't image, document, audio or video, made every compile
 * throw under the passthrough and windowed strategies, after a reopen too,
 * and made opening the store throw under the autobiographical one, until
 * someone edited the store by hand. Under the autobiographical strategy,
 * whose token estimate reads the field's length, opening a store holding a
 * text or thinking block missing its text or thinking threw too.
 *
 * So a write mends what released providers produce, and refuses the rest
 * ({@link contentForWrite}). A read leaves out or mends what doesn't match
 * ({@link wellFormedContent}), for a store written before the refusal, which
 * keeps the content as written. The mend both share is a `tool_use` whose
 * `input` isn't an object, as membrane 0.5.87's adapters can give it: `input`
 * becomes `{}`, and `unparseableInput`, where membrane keeps arguments whose
 * JSON didn't parse, keeps the value as JSON (mendedToolUse). A read also
 * mends media in MCP's form, which carries its `data` and `mimeType` on the
 * block and has no `source`: they become its base64 source, as
 * agent-framework converts it (mendedMedia). A write refuses that form,
 * naming where it is, since it isn't a `ContentBlock`.
 *
 * Content is walked with index loops throughout: a hole in an array reads as
 * undefined, so it is named and refused like any other. (A stored record has
 * no holes, since JSON writes a hole as null.) The walks recurse once per
 * `tool_result` level, so content nested deeper than the call stack allows
 * throws a RangeError instead of being named. Content that contains itself,
 * through a `tool_result`'s content, always does, and JSON can't produce it.
 */

import type { ContentBlock } from '@animalabs/membrane';
import type { StoredContentBlock } from './types/index.js';
import { releaseEditedRawForms } from './raw-forms.js';
import { unstorableSource } from './stored-media.js';

/** A write, which mends only a `tool_use`'s input and refuses the rest, or a read of stored content. */
type Side = 'write' | 'read';

/** An object that isn't an array: what a block, a `tool_use`'s `input` and a media `source` must be. */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** What a value is, for the line that names it: "null", "undefined", "an array", "a string", "an object". */
function kindOf(value: unknown): string {
  if (value === null || value === undefined) return String(value);
  if (Array.isArray(value)) return 'an array';
  const type = typeof value;
  return `${/^[aeiou]/.test(type) ? 'an' : 'a'} ${type}`;
}

/** The block types whose `source` carries their media. */
const MEDIA_TYPES: ReadonlySet<string> = new Set(['image', 'document', 'audio', 'video']);

/** Whether a block matches where its readers read it, without allocating: each side's common case. */
function wellFormed(block: unknown, side: Side): boolean {
  if (!isRecord(block)) return false;
  const type = block.type;
  if (typeof type !== 'string') return false;
  switch (type) {
    case 'text':
      return typeof block.text === 'string';
    case 'thinking':
      return typeof block.thinking === 'string';
    case 'tool_use':
      return isRecord(block.input);
    case 'tool_result': {
      const inner = block.content;
      if (typeof inner === 'string') return true;
      if (!Array.isArray(inner)) return false;
      for (let i = 0; i < inner.length; i++) if (!wellFormed(inner[i], side)) return false;
      return true;
    }
    case 'generated_image':
      return typeof block.data === 'string' && typeof block.mimeType === 'string';
    case 'blob_ref':
      return (
        side === 'read' &&
        isRecord(block.ref) &&
        typeof block.ref.hash === 'string' &&
        MEDIA_TYPES.has(block.ref.originalType as string)
      );
    default:
      return MEDIA_TYPES.has(type) ? isRecord(block.source) : true;
  }
}

/** Whether inline media in `block`, a block of the content, is media the store can't keep as a blob (unstorableSource). */
function storeRefuses(block: unknown): boolean {
  return (
    isRecord(block) &&
    MEDIA_TYPES.has(block.type as string) &&
    isRecord(block.source) &&
    unstorableSource(block as unknown as ContentBlock) !== null
  );
}

function allWellFormed(content: readonly unknown[], side: Side): boolean {
  for (let i = 0; i < content.length; i++) {
    if (!wellFormed(content[i], side) || (side === 'write' && storeRefuses(content[i]))) return false;
  }
  return true;
}

/**
 * A `tool_use` whose `input` isn't an object, mended so that it can't pass
 * for the model's arguments: `input` is `{}`, and `unparseableInput`, where
 * membrane keeps arguments whose JSON didn't parse, keeps the value as JSON.
 * No value at all is a call with no arguments, and isn't marked. A string
 * marker the block already carries is kept. Undefined for a value with no
 * JSON form (a bigint, a function, an array that contains itself), which a
 * write then refuses by name.
 */
function mendedToolUse(block: Record<string, unknown>): ContentBlock | undefined {
  const value = block.input;
  if (value === undefined || typeof block.unparseableInput === 'string') {
    return { ...block, input: {} } as unknown as ContentBlock;
  }
  let kept: string | undefined;
  try {
    kept = JSON.stringify(value);
  } catch {
    kept = undefined;
  }
  if (kept === undefined) return undefined;
  return { ...block, input: {}, unparseableInput: kept } as unknown as ContentBlock;
}

/**
 * Media in MCP's form, an image, document, audio or video block with no
 * `source` object whose `data` and `mimeType` are strings, mended to
 * `ContentBlock`'s form: they become its base64 source, as agent-framework
 * converts MCP's media, and the block keeps its other fields. Undefined for
 * media without the data or media type to make a source.
 */
function mendedMedia(block: Record<string, unknown>): ContentBlock | undefined {
  const { data, mimeType, ...rest } = block;
  if (typeof data !== 'string' || typeof mimeType !== 'string') return undefined;
  return { ...rest, source: { type: 'base64', data, mediaType: mimeType } } as unknown as ContentBlock;
}

/**
 * Each place in `block` that doesn't match on `side`, as a phrase naming its
 * path from `at` ("content[2] is a string, not a content block",
 * "content[0].content is null, not a string or an array of content blocks"),
 * added to `places` in content order. On a write, a `tool_use` input it
 * mends isn't a place.
 */
function placesIn(block: unknown, at: string, places: string[], side: Side): void {
  if (!isRecord(block)) {
    places.push(`${at} is ${kindOf(block)}, not a content block`);
    return;
  }
  const type = block.type;
  if (typeof type !== 'string') {
    places.push(`${at}.type is ${kindOf(type)}, not a string`);
    return;
  }
  switch (type) {
    case 'text':
      if (typeof block.text !== 'string') places.push(`${at}.text is ${kindOf(block.text)}, not a string`);
      return;
    case 'thinking':
      if (typeof block.thinking !== 'string') places.push(`${at}.thinking is ${kindOf(block.thinking)}, not a string`);
      return;
    case 'tool_use':
      if (isRecord(block.input)) return;
      if (side === 'write' && mendedToolUse(block)) return;
      places.push(`${at}.input is ${kindOf(block.input)}, not an object`);
      return;
    case 'tool_result': {
      const inner = block.content;
      if (typeof inner === 'string') return;
      if (!Array.isArray(inner)) {
        places.push(`${at}.content is ${kindOf(inner)}, not a string or an array of content blocks`);
        return;
      }
      for (let i = 0; i < inner.length; i++) placesIn(inner[i], `${at}.content[${i}]`, places, side);
      return;
    }
    case 'generated_image':
      if (typeof block.data !== 'string') places.push(`${at}.data is ${kindOf(block.data)}, not a string`);
      if (typeof block.mimeType !== 'string') places.push(`${at}.mimeType is ${kindOf(block.mimeType)}, not a string`);
      return;
    case 'blob_ref':
      if (side === 'write') {
        places.push(`${at} is a blob_ref, which only the store writes (a read with blobs resolved, the default, gives the block to write)`);
      } else if (!isRecord(block.ref) || typeof block.ref.hash !== 'string') {
        places.push(`${at}.ref is ${isRecord(block.ref) ? 'an object without a string hash' : kindOf(block.ref)}, not a blob reference`);
      } else if (!MEDIA_TYPES.has(block.ref.originalType as string)) {
        const originalType = block.ref.originalType;
        places.push(
          `${at}.ref.originalType is ${typeof originalType === 'string' ? JSON.stringify(originalType) : kindOf(originalType)}, ` +
            'not image, document, audio or video',
        );
      }
      return;
    default:
      if (MEDIA_TYPES.has(type) && !isRecord(block.source)) places.push(`${at}.source is ${kindOf(block.source)}, not an object`);
  }
}

/** The places of inline media in `block`, a block of the content, that the store can't keep, as phrases from `at`. */
function storePlacesIn(block: unknown, at: string, places: string[]): void {
  if (!storeRefuses(block)) return;
  const { type, source } = block as { type: string; source: Record<string, unknown> };
  const unstorable = unstorableSource(block as unknown as ContentBlock)!;
  if (unstorable.data) places.push(`${at}.source.data is ${kindOf(source.data)}, not base64 data`);
  if (unstorable.mediaType) {
    places.push(
      `${at}.source.mediaType is ${kindOf(source.mediaType)}, not a string` +
        (type === 'image' && !unstorable.data ? ", and the image's data has no png, jpeg, gif or webp signature" : ''),
    );
  }
}

function malformedPlaces(content: readonly unknown[], side: Side, at = 'content'): string[] {
  const places: string[] = [];
  for (let i = 0; i < content.length; i++) {
    placesIn(content[i], `${at}[${i}]`, places, side);
    if (side === 'write') storePlacesIn(content[i], `${at}[${i}]`, places);
  }
  return places;
}

/** The place naming content that isn't an array. */
function notAnArray(content: unknown): string {
  return `content is ${kindOf(content)}, not an array of content blocks`;
}

/**
 * Where `content` doesn't match `ContentBlock`, as this boundary refuses it
 * on write: one phrase per place, naming its path ("content[2] is a string,
 * not a content block"), in content order, or the one place "content is
 * null, not an array of content blocks". A `tool_use` whose input isn't an
 * object is a place only when a write can't mend it (contentForWrite): when
 * the input has no JSON form. Non-throwing for content nested no deeper
 * than the call stack allows, which content that contains itself never is
 * (JSON can't produce it), for a host that checks content before it queues
 * it.
 */
export function malformedContentPlaces(content: unknown): string[] {
  if (!Array.isArray(content)) return [notAnArray(content)];
  return allWellFormed(content, 'write') ? [] : malformedPlaces(content, 'write');
}

/** A write refused because its content doesn't match `ContentBlock`; `places` is malformedContentPlaces' answer for it. */
export class MalformedContentError extends Error {
  readonly places: readonly string[];

  constructor(what: string, places: readonly string[]) {
    super(`${what}: ${places.join('; ')}.`);
    this.name = 'MalformedContentError';
    this.places = places;
  }
}

/**
 * Content as a write stores it. Content that matches is returned as it is.
 * A `tool_use` whose input isn't an object is mended (mendedToolUse), at any
 * depth, and every block that shares a raw replay form with one mended gives
 * that form up (raw-forms.ts), as a read's mend does, so a write stores what
 * a read of the unmended content would give. Anything else that doesn't
 * match is refused before anything of it is stored, with a
 * MalformedContentError whose `places` are malformedContentPlaces'. `what`
 * opens its message ("Message refused", "Edit of m-12 refused").
 */
export function contentForWrite(content: ContentBlock[], what: string): ContentBlock[] {
  if (!Array.isArray(content)) throw new MalformedContentError(what, [notAnArray(content)]);
  if (allWellFormed(content, 'write')) return content;
  const places = malformedContentPlaces(content);
  if (places.length > 0) throw new MalformedContentError(what, places);
  return transformed(content, 'write');
}

/** As contentForWrite, for one block, whose places are named from `block`. */
export function blockForWrite(block: ContentBlock, what: string): ContentBlock {
  if (wellFormed(block, 'write') && !storeRefuses(block)) return block;
  const places: string[] = [];
  placesIn(block, 'block', places, 'write');
  storePlacesIn(block, 'block', places);
  if (places.length > 0) throw new MalformedContentError(what, places);
  return transformed([block], 'write')[0]!;
}

/**
 * One level of content as `side` gives it (writeBlock, readBlock). Every
 * block that shares a raw replay form with a block changed or left out gives
 * that form up, as after any edit (raw-forms.ts), since replaying it would
 * carry what was left out. A `tool_result`'s content goes through here too,
 * so each level is reconciled on its own, and a block mended inside a
 * `tool_result` gives up its form like one at the top.
 */
function transformed(content: readonly unknown[], side: Side): ContentBlock[] {
  const before: ContentBlock[] = [];
  const after: ContentBlock[] = [];
  for (let i = 0; i < content.length; i++) {
    const block = content[i];
    // A value that isn't an object, or is an array, carries no raw form. A
    // read leaves it out, and a write has refused it already.
    if (!isRecord(block)) continue;
    before.push(block as unknown as ContentBlock);
    const out = side === 'write' ? writeBlock(block) : readBlock(block);
    if (out) after.push(out);
  }
  return releaseEditedRawForms(before, after);
}

/** A block as a write stores it, once nothing in it is refused: the block itself, or with its `tool_use` inputs mended. */
function writeBlock(block: Record<string, unknown>): ContentBlock {
  if (wellFormed(block, 'write')) return block as unknown as ContentBlock;
  if (block.type === 'tool_use') return mendedToolUse(block)!;
  if (block.type === 'tool_result' && Array.isArray(block.content)) {
    return { ...block, content: transformed(block.content, 'write') } as unknown as ContentBlock;
  }
  return block as unknown as ContentBlock;
}

/**
 * A block as a read gives it: the block itself when it matches. Otherwise a
 * `tool_use` is mended (mendedToolUse, or `{}` alone), a signed thinking
 * block keeps its signature with `thinking: ''`, as membrane gives a
 * signature-only block, media in MCP's form gets its base64 source
 * (mendedMedia), and a `tool_result` keeps its content blocks that match, so
 * that the pair they make survives: its content as a read gives an array of
 * them, a lone block as an array of that block when the read keeps it, and a
 * number as its text; anything else is an empty array. Anything else is left
 * out (undefined): a value that isn't an object, an array, a block without a
 * string `type`, a text block without its string, unsigned thinking without
 * its string, media without a source or the data and media type to make
 * one, a generated image without its data or media type, and a `blob_ref`
 * that doesn't reference a blob or whose `originalType` isn't image,
 * document, audio or video.
 */
function readBlock(block: Record<string, unknown>): ContentBlock | undefined {
  if (wellFormed(block, 'read')) return block as unknown as ContentBlock;
  switch (block.type) {
    case 'tool_use':
      return mendedToolUse(block) ?? ({ ...block, input: {} } as unknown as ContentBlock);
    case 'thinking':
      return typeof block.signature === 'string' ? ({ ...block, thinking: '' } as unknown as ContentBlock) : undefined;
    case 'image':
    case 'document':
    case 'audio':
    case 'video':
      return mendedMedia(block);
    case 'tool_result': {
      const inner = block.content;
      const content = Array.isArray(inner)
        ? transformed(inner, 'read')
        : isRecord(inner)
          ? transformed([inner], 'read')
          : typeof inner === 'number'
            ? String(inner)
            : [];
      return { ...block, content } as unknown as ContentBlock;
    }
    default:
      return undefined;
  }
}

/**
 * Stored content as a read gives it: what doesn't match is left out or
 * mended (readBlock), at any depth, and the store keeps the content as
 * written. Content that isn't an array reads as empty. Content that matches
 * is returned as it is. The first read of a
 * record logs one line naming where it doesn't match, once per instance.
 * `logged` keys it by `where` and those places, so a record that comes to
 * have another's label, such as a context entry at an index that a
 * replacement or another branch gives another entry, logs its own line
 * unless the same places are wrong in it. `where` names the record
 * ("message m-12", "context entry 3").
 */
export function wellFormedContent(
  content: StoredContentBlock[],
  where: string,
  logged: Set<string>,
): StoredContentBlock[] {
  const array = Array.isArray(content);
  if (array && allWellFormed(content, 'read')) return content;
  const places = array ? malformedPlaces(content, 'read').join('; ') : notAnArray(content);
  const key = `${where}\u0000${places}`;
  if (!logged.has(key)) {
    logged.add(key);
    console.error(
      `[context-manager] ${where}: reads leave out or mend what doesn't match ContentBlock (${places}); ` +
        'the store keeps it as written',
    );
  }
  return array ? (transformed(content, 'read') as StoredContentBlock[]) : [];
}
