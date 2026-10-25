/**
 * The live-image window's limits, kept within the image ceilings.
 *
 * A strategy's live window keeps the images it counts (every image, nested
 * and generated ones included; see `AutobiographicalConfig.maxLiveImages`)
 * newest-first up to a count (`maxLiveImages`) and a byte budget
 * (`maxLiveImageBytes`). The image ceilings (`imageCeiling`,
 * `imageByteCeiling`) bound those limits: an unlimited (0) limit means "up to
 * the ceiling", and a limit above the ceiling keeps the ceiling's worth. They
 * bound what the window counts and what a compression prompt carries, not a
 * whole request: an image inside an opaque provider item isn't counted, nor
 * is anything a caller injects at compile time or appends to a compiled
 * request. A caller that wants a request within the ceilings counts that
 * request's images itself and compares them with the strategy's
 * `imageCeilings()`.
 */

/**
 * The provider refuses a request carrying more than 600 images and documents
 * together ("too many images and documents: 601 + 0 > 600", measured
 * 2026-10-13 and again on 2026-10-19). 500 leaves room for what the ceilings
 * don't count: documents, images inside opaque provider items, and images a
 * caller injects or appends.
 */
export const DEFAULT_IMAGE_CEILING = 500;

/**
 * membrane's byte cap is 28 MiB of serialized messages unless
 * `MEMBRANE_MAX_REQUEST_BYTES` says otherwise (membrane 0.5.87, 0.6.0 and 0.7.1,
 * the version this package's lockfile installs).
 * It checks a request when it builds it through `transformRequest`, which a
 * call's first request and each native tool-loop round go through; an
 * XML-mode continuation round doesn't, and of the provider adapters only the
 * Anthropic adapter checks again, on every request it sends. Over the cap,
 * `transformRequest` refuses the request before sending it
 * (`assertWithinByteBudget`), unless the request sets `shedOversizeImages`,
 * as this package's compression requests do. Then it replaces images,
 * oldest first, until the request fits or no image is left, and passes it
 * on either way; the Anthropic adapter's own check, which never sheds,
 * refuses one still over the cap. The shed works on the messages the
 * formatter built, and replaces only membrane's `image` blocks, top-level or
 * in a `tool_result`: a request that sets `shedOversizeImages` and is built
 * by membrane's `openai-responses` formatter, whose images are
 * `input_image` parts, has none shed and isn't checked against the cap
 * there, and that adapter doesn't check it again. 24 MiB of base64 images leaves 4 MiB of that
 * default cap for everything else the messages carry: their text, their
 * JSON, and any documents or other media.
 */
export const DEFAULT_IMAGE_BYTE_CEILING = 24 * 1024 * 1024;

/** A strategy's image limits as its window applies them. Each figure is a
 *  count of the images the window counts or a sum of their inline base64
 *  bytes, and 0 is no limit. `target` is what the window keeps, already
 *  within `ceiling` (`maxLiveImages` and `maxLiveImageBytes`, clamped);
 *  `ceiling` is `imageCeiling` and `imageByteCeiling`. */
export interface ResolvedImageLimits {
  target: { images: number; bytes: number };
  ceiling: { images: number; bytes: number };
}

/** A window limit as the window reads it: a whole number of 1 or more, or 0
 *  for none. Any value that isn't a positive finite number (0, a negative,
 *  NaN, Infinity) is none, as the window's own checks (`limit > 0 && kept >=
 *  limit`) already read it. A fraction is floored, to at least 1, so the
 *  limit reported is the limit kept. */
function asLimit(value: number): number {
  return Number.isFinite(value) && value > 0 ? Math.max(1, Math.floor(value)) : 0;
}

/** Whether a configured ceiling is one the window can read: 0 (none), or a
 *  finite number above 0. */
function wellFormedCeiling(value: number): boolean {
  return value === 0 || (Number.isFinite(value) && value > 0);
}

/** A ceiling as configured: 0 is none, a finite number above 0 is floored to
 *  at least 1, and any other value (a negative, NaN, Infinity) takes the
 *  default, so a malformed config doesn't remove the bound (the warning names
 *  it). */
function asCeiling(value: number, fallback: number): number {
  return wellFormedCeiling(value) ? asLimit(value) : fallback;
}

/**
 * `target` kept within `ceiling`, where 0 means no limit for either: an
 * unlimited target becomes the ceiling, and no ceiling leaves the target as
 * it is. A target that isn't a positive finite number counts as unlimited,
 * as the window's own checks already treat it. `ceiling` is one
 * resolveLiveImageLimits gives.
 */
export function clampToCeiling(target: number, ceiling: number): number {
  const c = asLimit(ceiling);
  const t = asLimit(target);
  if (c === 0) return t;
  return t === 0 ? c : Math.min(t, c);
}

/** The window's configured limits, the defaults applied where unset. */
export interface ConfiguredImageLimits {
  maxLiveImages: number;
  maxLiveImageBytes: number;
  imageCeiling: number;
  imageByteCeiling: number;
}

/** The limits a strategy's window applies, and the ceilings above them. */
export function resolveLiveImageLimits(configured: ConfiguredImageLimits): ResolvedImageLimits {
  const ceiling = {
    images: asCeiling(configured.imageCeiling, DEFAULT_IMAGE_CEILING),
    bytes: asCeiling(configured.imageByteCeiling, DEFAULT_IMAGE_BYTE_CEILING),
  };
  return {
    target: {
      images: clampToCeiling(configured.maxLiveImages, ceiling.images),
      bytes: clampToCeiling(configured.maxLiveImageBytes, ceiling.bytes),
    },
    ceiling,
  };
}

const MiB = 1024 * 1024;

/** A byte figure as the strategies' lines give it: in MiB when it's a whole
 *  number of them, and in bytes otherwise, so two figures that differ never
 *  read alike. */
function showBytes(n: number): string {
  return n % MiB === 0 ? `${n / MiB} MiB` : `${n} bytes`;
}

/**
 * The " (default)" a line puts after a setting whose value is a default: one
 * the host didn't give (`defaulted`), or a ceiling it gave malformed, which
 * takes its default (see asCeiling).
 */
function defaultMark(
  name: string,
  configured: ConfiguredImageLimits,
  defaulted: ReadonlySet<string>,
): string {
  const malformedCeiling = (name === 'imageCeiling' || name === 'imageByteCeiling') &&
    !wellFormedCeiling(configured[name]);
  return defaulted.has(name) || malformedCeiling ? ' (default)' : '';
}

/**
 * Which of the window's limits a ceiling sets: a limit the host gave as none
 * (0, or anything that isn't a positive finite number) or above its ceiling,
 * where that ceiling is itself a limit. The window then keeps the ceiling's
 * worth. (With no ceiling the window keeps the limit as given, so the two
 * never match there.)
 */
export function ceilingSetLimits(configured: ConfiguredImageLimits): { images: boolean; bytes: boolean } {
  const { target, ceiling } = resolveLiveImageLimits(configured);
  return {
    images: target.images === ceiling.images && asLimit(configured.maxLiveImages) !== ceiling.images,
    bytes: target.bytes === ceiling.bytes && asLimit(configured.maxLiveImageBytes) !== ceiling.bytes,
  };
}

/**
 * The line a strategy says once for each ceiling, at the first render a
 * select returns where images are shown as placeholders and a limit that
 * ceiling sets (ceilingSetLimits) was over: at an image the render
 * replaces, or, under the memory strategy's `imageStripHysteresisRatio`, at
 * the start of a trim anywhere in the rule's replay. It says which ceiling,
 * at what value, and the window limit of 0 or above it that the ceiling
 * holds, so an operator who set no limit sees where one now applies.
 */
export function ceilingBoundLine(
  strategy: string,
  kind: 'images' | 'bytes',
  configured: ConfiguredImageLimits,
  defaulted: ReadonlySet<string>,
): string {
  const ceiling = resolveLiveImageLimits(configured).ceiling;
  const [ceilingName, limitName, value, show] = kind === 'images'
    ? ['imageCeiling', 'maxLiveImages', configured.maxLiveImages, String] as const
    : ['imageByteCeiling', 'maxLiveImageBytes', configured.maxLiveImageBytes, showBytes] as const;
  const limit = asLimit(value) === 0 ? `${value} (no limit)` : show(asLimit(value));
  const mark = (name: string) => defaultMark(name, configured, defaulted);
  return `[${strategy}] ${ceilingName} ${show(ceiling[kind])}${mark(ceilingName)} ` +
    `holds ${limitName} ${limit}${mark(limitName)} to it, so some images are now shown as placeholders`;
}

/**
 * The warning a strategy gives once, when it initializes, or null when there
 * is nothing to say: a ceiling configured as something other than 0 or a
 * finite number above it, which takes the default, and a limit (not 0) above
 * its ceiling, which is kept at the ceiling. `maxCompressionImageBytes`, when
 * given, is the compression prompt's byte budget, held to the byte ceiling
 * too. `defaulted` names the settings the host didn't give, which the line
 * marks "(default)", so a host isn't told about a setting as if they had
 * made it. A byte figure reads in MiB when it's a whole number of them.
 */
export function liveImageLimitsWarning(
  strategy: string,
  configured: ConfiguredImageLimits & { maxCompressionImageBytes?: number },
  defaulted: ReadonlySet<string>,
): string | null {
  const said: string[] = [];
  const ceiling = resolveLiveImageLimits(configured).ceiling;
  const count = (n: number) => String(n);
  const bytes = showBytes;
  const setting = (name: string, shown: string) => `${name} ${shown}${defaultMark(name, configured, defaulted)}`;
  if (!wellFormedCeiling(configured.imageCeiling)) {
    said.push(`imageCeiling ${configured.imageCeiling} isn't 0 or a finite number above it, so the default ${count(ceiling.images)} applies`);
  }
  if (!wellFormedCeiling(configured.imageByteCeiling)) {
    said.push(`imageByteCeiling ${configured.imageByteCeiling} isn't 0 or a finite number above it, so the default ${bytes(ceiling.bytes)} applies`);
  }
  const above = (
    name: string, value: number | undefined, ceilingName: string, limit: number, keeps: string, show: (n: number) => string,
  ) => {
    const v = value === undefined ? 0 : asLimit(value);
    if (limit > 0 && v > limit) {
      said.push(`${setting(name, show(v))} is above ${setting(ceilingName, show(limit))}, so ${keeps} at most ${show(limit)}`);
    }
  };
  above('maxLiveImages', configured.maxLiveImages, 'imageCeiling', ceiling.images, 'the live window keeps', count);
  above('maxLiveImageBytes', configured.maxLiveImageBytes, 'imageByteCeiling', ceiling.bytes, 'the live window keeps', bytes);
  above('maxCompressionImageBytes', configured.maxCompressionImageBytes, 'imageByteCeiling', ceiling.bytes, 'a compression prompt keeps', bytes);
  return said.length === 0 ? null : `[${strategy}] ${said.join('; ')}`;
}
