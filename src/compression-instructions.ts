/** JSON-only customization of the base autobiographical instruction hooks. */
export interface CompressionInstructions {
  /** Omitted and `default` retain the existing wording. */
  preset?: 'default';
  /** Trusted actor name; required only by a custom {participant} placeholder. */
  participant?: string;
  /** Each supplied slot replaces only that phase's built-in wording. */
  templates?: CompressionInstructionTemplates;
}

export interface CompressionInstructionTemplates {
  opening?: string;
  chunk?: string;
  witnessedChunk?: string;
  readingChunk?: string;
  merge?: string;
  witnessedMerge?: string;
  readingMerge?: string;
  /** Must include {context} exactly once. Inserted context is data, not a template. */
  transition?: string;
}

type Actor = { participant?: string };
type ChunkValues = Actor & { targetTokens: number };
type MergeValues = ChunkValues & { sourceLevelShown: number; targetLevel: number };
/** The only values available to each slot; numbers come from request construction. */
export interface CompressionInstructionValues {
  opening: Actor;
  chunk: ChunkValues;
  witnessedChunk: ChunkValues;
  readingChunk: ChunkValues & { totalTokens: number };
  merge: MergeValues;
  witnessedMerge: MergeValues;
  readingMerge: MergeValues & { totalTokens: number };
  transition: ChunkValues & { context: string };
}

type Slot = keyof CompressionInstructionValues;
const placeholders: { [K in Slot]: readonly (keyof CompressionInstructionValues[K])[] } = {
  opening: ['participant'],
  chunk: ['participant', 'targetTokens'],
  witnessedChunk: ['participant', 'targetTokens'],
  readingChunk: ['participant', 'targetTokens', 'totalTokens'],
  merge: ['participant', 'targetTokens', 'sourceLevelShown', 'targetLevel'],
  witnessedMerge: ['participant', 'targetTokens', 'sourceLevelShown', 'targetLevel'],
  readingMerge: ['participant', 'targetTokens', 'sourceLevelShown', 'targetLevel', 'totalTokens'],
  transition: ['participant', 'targetTokens', 'context'],
};

// Internal allowlist: maintainers can add built-in names and rendering here.
// `default` deliberately delegates to the existing phase formatters.
const presets: readonly string[] = ['default'];

type Path = 'configuration' | 'preset' | 'participant' | 'templates' | `templates.${Slot}`;
type Reason = 'expected object' | 'unknown key' | 'unsupported preset' | 'expected nonblank string'
  | 'expected nonempty object' | 'malformed braces' | 'unsupported placeholder' | 'context must appear once' | 'participant required';
function invalid(path: Path, reason: Reason): never {
  // Do not echo template text, participant names, unknown keys or payloads.
  throw new TypeError(`Invalid compressionInstructions configuration: ${path}: ${reason}`);
}
function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    && (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null);
}

/** Validate before constructing a strategy (also usable by a recipe loader).
 * Strict within this object, including unselected slots. No values in errors.
 */
export function validateCompressionInstructions(value: unknown): asserts value is CompressionInstructions | undefined {
  if (value === undefined) return;
  if (!record(value)) invalid('configuration', 'expected object');
  if (Object.keys(value).some(k => !['preset', 'participant', 'templates'].includes(k))) invalid('configuration', 'unknown key');
  if (value.preset !== undefined && (typeof value.preset !== 'string' || !presets.includes(value.preset))) invalid('preset', 'unsupported preset');
  if (value.participant !== undefined && (typeof value.participant !== 'string' || !value.participant.trim())) invalid('participant', 'expected nonblank string');
  let needsParticipant = false;
  if (value.templates !== undefined) {
    if (!record(value.templates) || Object.keys(value.templates).length === 0) invalid('templates', 'expected nonempty object');
    for (const [slot, template] of Object.entries(value.templates)) {
      if (!Object.hasOwn(placeholders, slot)) invalid('templates', 'unknown key');
      const path: Path = `templates.${slot as Slot}`;
      if (typeof template !== 'string' || !template.trim()) invalid(path, 'expected nonblank string');
      const names: string[] = [];
      const remainder = template.replace(/\{([a-zA-Z]+)\}/g, (_, name: string) => {
        names.push(name);
        return '';
      });
      if (/[{}]/.test(remainder)) invalid(path, 'malformed braces');
      if (names.some(name => !(placeholders[slot as Slot] as readonly string[]).includes(name))) invalid(path, 'unsupported placeholder');
      if (slot === 'transition' && names.filter(name => name === 'context').length !== 1) invalid(path, 'context must appear once');
      needsParticipant ||= names.includes('participant');
    }
  }
  if (needsParticipant && value.participant === undefined) invalid('participant', 'participant required');
}

/** One substitution pass over trusted template text, never over inserted data. */
function substitute<K extends Slot>(template: string, values: CompressionInstructionValues[K]): string {
  return template.replace(/\{([a-zA-Z]+)\}/g, (_, name: string) => String(values[name as keyof typeof values]));
}

/** Undefined means use the existing formatter, without changing its bytes. */
export function compressionInstruction<K extends Slot>(
  config: CompressionInstructions | undefined,
  slot: K,
  values: Omit<CompressionInstructionValues[K], 'participant'>,
): string | undefined {
  const all = { ...values, participant: config?.participant } as CompressionInstructionValues[K];
  const templates = config?.templates;
  const template = templates && Object.hasOwn(templates, slot) ? templates[slot] : undefined;
  if (template !== undefined) return substitute(template, all);
  return undefined;
}
