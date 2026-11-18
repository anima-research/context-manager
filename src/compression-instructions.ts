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
  | 'unable to inspect settings' | 'expected enumerable string keys' | 'expected nonempty object' | 'malformed braces' | 'unsupported placeholder' | 'context must appear once' | 'participant required';
class ValidationError extends TypeError {}

// Only diagnostic names are echoed, bounded and JSON-escaped; never bodies
// or participant values. Non-string presets report their type, not payload.
function spelling(value: unknown): string {
  return typeof value === 'string'
    ? JSON.stringify(value.slice(0, 64) + (value.length > 64 ? '…' : '')).replace(/\u2028/g, '\\u2028').replace(/\u2029/g, '\\u2029')
    : `<${value === null ? 'null' : typeof value}>`;
}
function invalid(path: Path, reason: Reason, detail = ''): never {
  throw new ValidationError(`Invalid compressionInstructions configuration: ${path}: ${reason}${detail}`);
}
function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    && (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null);
}

function checkKeys(value: object, path: Path): void {
  if (Reflect.ownKeys(value).some(key => typeof key !== 'string'
    || !Object.prototype.propertyIsEnumerable.call(value, key))) {
    invalid(path, 'expected enumerable string keys');
  }
}

// Optional settings must be explicitly supplied, never inherited from a prototype.
function own<T extends object, K extends keyof T>(value: T | undefined, key: K): T[K] | undefined {
  return value !== undefined && Object.hasOwn(value, key) ? value[key] : undefined;
}

/** Validate before constructing a strategy (also usable by a recipe loader).
 * Strict within this object, including unselected slots. No template bodies in errors.
 */
export function validateCompressionInstructions(value: unknown): asserts value is CompressionInstructions | undefined {
  try {
    validateSettings(value);
  } catch (error) {
    if (error instanceof ValidationError) throw error;
    invalid('configuration', 'unable to inspect settings');
  }
}

function validateSettings(value: unknown): asserts value is CompressionInstructions | undefined {
  if (value === undefined) return;
  if (!record(value)) invalid('configuration', 'expected object');
  checkKeys(value, 'configuration');
  const keys = ['preset', 'participant', 'templates'];
  const unknown = Object.keys(value).find(key => !keys.includes(key));
  if (unknown !== undefined) invalid('configuration', 'unknown key', ` ${spelling(unknown)}; supported: ${keys.join(', ')}`);
  const preset = own(value, 'preset');
  const participant = own(value, 'participant');
  const templates = own(value, 'templates');
  if (preset !== undefined && (typeof preset !== 'string' || !presets.includes(preset))) invalid('preset', 'unsupported preset', ` ${spelling(preset)}; supported: ${presets.join(', ')}`);
  if (participant !== undefined && (typeof participant !== 'string' || !participant.trim())) invalid('participant', 'expected nonblank string');
  let needsParticipant = false;
  if (templates !== undefined) {
    if (!record(templates)) invalid('templates', 'expected nonempty object');
    checkKeys(templates, 'templates');
    if (Object.keys(templates).length === 0) invalid('templates', 'expected nonempty object');
    for (const [slot, template] of Object.entries(templates)) {
      if (!Object.hasOwn(placeholders, slot)) invalid('templates', 'unknown key', ` ${spelling(slot)}; supported: ${Object.keys(placeholders).join(', ')}`);
      const path: Path = `templates.${slot as Slot}`;
      if (typeof template !== 'string' || !template.trim()) invalid(path, 'expected nonblank string');
      const names: string[] = [];
      const remainder = template.replace(/\{([a-zA-Z][a-zA-Z0-9_]*)\}/g, (_, name: string) => {
        names.push(name);
        return '';
      });
      if (/[{}]/.test(remainder)) invalid(path, 'malformed braces');
      const supported = placeholders[slot as Slot] as readonly string[];
      const unknown = names.find(name => !supported.includes(name));
      if (unknown !== undefined) invalid(path, 'unsupported placeholder', ` ${spelling(unknown)}; supported: ${supported.map(name => `{${name}}`).join(', ')}`);
      if (slot === 'transition' && names.filter(name => name === 'context').length !== 1) invalid(path, 'context must appear once');
      needsParticipant ||= names.includes('participant');
    }
  }
  if (needsParticipant && participant === undefined) invalid('participant', 'participant required');
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
  const all = { ...values, participant: own(config, 'participant') } as CompressionInstructionValues[K];
  const templates = own(config, 'templates');
  const template = templates && Object.hasOwn(templates, slot) ? templates[slot] : undefined;
  if (template !== undefined) return substitute(template, all);
  return undefined;
}
