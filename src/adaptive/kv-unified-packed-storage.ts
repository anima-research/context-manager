import type { FrontierTraceSource } from './kv-unified-terminal.js';

export interface PackedEmission {
  readonly kind: 'raw' | 'recall';
  readonly key: string;
  readonly tokens: number;
  readonly sequence: number;
}

const TRACE_SHIFT = 18;
const TRACE_SIZE = 1 << TRACE_SHIFT;
const TRACE_MASK = TRACE_SIZE - 1;
const EMPTY_EMISSIONS: readonly PackedEmission[] = Object.freeze([]);

export const LABEL_STRIDE = 16;
export enum LabelField {
  Tokens, Extension, Continuity, Fidelity,
  Intact, CachedUnits, Matched, CachedTokens,
  TokenError, ContinuityError, FidelityError, CacheError,
  Trace, PendingAction,
}

/** Immutable trace nodes use two integers. Pages avoid copying a growing
 * arena; rejected labels do not allocate a trace node until it is needed. */
export class PackedTraceArena {
  private parents: Uint32Array[] = [];
  private actions: Uint32Array[] = [];
  private definitions: Array<{ ids: readonly string[]; level: number }> = [{ ids: [], level: 0 }];
  private length = 0;

  action(ids: readonly string[], level: number): number {
    this.definitions.push({ ids, level });
    return this.definitions.length - 1;
  }

  append(parent: number, action: number): number {
    if (action === 0) return parent;
    const id = ++this.length;
    if (id > 0xffffffff) throw new Error('kv-unified trace index exhausted');
    const page = id >>> TRACE_SHIFT;
    while (this.parents.length <= page) {
      this.parents.push(new Uint32Array(TRACE_SIZE));
      this.actions.push(new Uint32Array(TRACE_SIZE));
    }
    this.parents[page][id & TRACE_MASK] = parent;
    this.actions[page][id & TRACE_MASK] = action;
    return id;
  }

  reference(id: number): FrontierTraceSource {
    const arena = this;
    return {
      forEachAssignment(visit) {
        for (let cursor = id; cursor !== 0;) {
          const page = cursor >>> TRACE_SHIFT;
          const offset = cursor & TRACE_MASK;
          const action = arena.definitions[arena.actions[page][offset]];
          visit(action.ids, action.level);
          cursor = arena.parents[page][offset];
        }
      },
    };
  }

  get nodes(): number { return this.length; }
}

/** Owned labels are integer handles into reusable packed numeric records. A batch
 * owns its handles: transforms may update them, pruning frees discarded ones,
 * and branching explicitly clones. Trace nodes remain immutable. */
export class PackedLabels {
  private capacity = 1024;
  private length = 0;
  private free = 0;
  private freeNext = new Uint32Array(this.capacity);
  readonly traces = new PackedTraceArena();

  // One contiguous record permits native copyWithin for branching. Integer
  // handles are uint32-sized and exactly representable in binary64.
  data = new Float64Array(this.capacity * LABEL_STRIDE);
  pending: Array<readonly PackedEmission[]> = [];

  private grow(): void {
    const capacity = this.capacity * 2;
    if (capacity > 0x7fffffff) throw new Error('kv-unified label index exhausted');
    const data = new Float64Array(capacity * LABEL_STRIDE); data.set(this.data); this.data = data;
    const free = new Uint32Array(capacity); free.set(this.freeNext); this.freeNext = free;
    this.capacity = capacity;
  }

  allocate(): number {
    if (this.free) {
      const id = this.free; this.free = this.freeNext[id]; return id;
    }
    const id = ++this.length;
    if (id >= this.capacity) this.grow();
    return id;
  }

  initial(cacheRelevant: boolean, externalIds: readonly string[]): number {
    const id = this.allocate();
    const at = id * LABEL_STRIDE;
    this.data.fill(0, at, at + LABEL_STRIDE);
    this.data[at + LabelField.Intact] = cacheRelevant ? 1 : 0;
    this.pending[id] = EMPTY_EMISSIONS;
    if (externalIds.length) this.data[at + LabelField.PendingAction] = this.traces.action(externalIds, 0);
    return id;
  }

  clone(source: number): number {
    this.finishTrace(source);
    const id = this.allocate();
    this.data.copyWithin(id * LABEL_STRIDE, source * LABEL_STRIDE, (source + 1) * LABEL_STRIDE);
    this.pending[id] = this.pending[source];
    return id;
  }

  release(id: number): void {
    this.pending[id] = EMPTY_EMISSIONS;
    this.freeNext[id] = this.free; this.free = id;
  }

  finishTrace(id: number): number {
    const at = id * LABEL_STRIDE;
    if (this.data[at + LabelField.PendingAction]) {
      this.data[at + LabelField.Trace] = this.traces.append(this.data[at + LabelField.Trace], this.data[at + LabelField.PendingAction]);
      this.data[at + LabelField.PendingAction] = 0;
    }
    return this.data[at + LabelField.Trace];
  }

  assign(id: number, action: number, fidelity: number, continuity: number): void {
    if (!action) return;
    this.finishTrace(id);
    const at = id * LABEL_STRIDE;
    this.data[at + LabelField.PendingAction] = action;
    this.data[at + LabelField.Fidelity] += fidelity;
    this.data[at + LabelField.Continuity] += continuity;
  }

  get slots(): number { return this.length; }
}

/** Reusable grouping metadata. Large/non-numeric key spaces use a Map only
 * for key-to-group lookup; member chains and extrema remain packed. */
export class PackedBuckets {
  private epoch = 0;
  private readonly epochs: Uint32Array;
  private readonly slots: Uint32Array;
  private readonly sparse = new Map<string | number, number>();
  count = 0;
  head = new Int32Array(1024);
  next = new Int32Array(1024);
  fidelity = new Uint32Array(1024);
  continuity = new Uint32Array(1024);
  tokens = new Uint32Array(1024);
  extension = new Uint32Array(1024);
  size = new Uint32Array(1024);

  constructor(denseSlots: number) {
    // This only selects the representation, never the number of retained
    // labels or the solver's stopping condition.
    const dense = Number.isSafeInteger(denseSlots) && denseSlots > 0 && denseSlots <= 4_000_000 ? denseSlots : 0;
    this.epochs = new Uint32Array(dense);
    this.slots = new Uint32Array(dense);
  }

  begin(labels: number): void {
    this.count = 0;
    this.sparse.clear();
    this.epoch = (this.epoch + 1) >>> 0;
    if (this.epoch === 0) { this.epochs.fill(0); this.epoch = 1; }
    if (labels > this.next.length) this.next = new Int32Array(Math.max(labels, this.next.length * 2));
  }

  group(key: string | number): number {
    const dense = typeof key === 'number' && Number.isInteger(key) && key >= 0 && key < this.epochs.length;
    if (dense && this.epochs[key] === this.epoch) return this.slots[key];
    if (!dense) {
      const found = this.sparse.get(key);
      if (found !== undefined) return found;
    }
    const group = this.count++;
    if (group >= this.head.length) {
      const length = this.head.length * 2;
      const head = new Int32Array(length); head.set(this.head); this.head = head;
      for (const key of ['fidelity', 'continuity', 'tokens', 'extension', 'size'] as const) {
        const copy = new Uint32Array(length); copy.set(this[key]); this[key] = copy;
      }
    }
    this.head[group] = -1; this.size[group] = 0;
    this.fidelity[group] = this.continuity[group] = this.tokens[group] = this.extension[group] = 0;
    if (dense) { this.epochs[key] = this.epoch; this.slots[key] = group; }
    else this.sparse.set(key, group);
    return group;
  }
}
