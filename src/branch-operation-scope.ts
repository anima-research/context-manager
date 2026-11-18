import { AsyncLocalStorage } from 'node:async_hooks';

/** Internal control-flow error: obsolete work must not touch a replacement load. */
export class StaleBranchOperationError extends Error {
  constructor() {
    super('AutobiographicalStrategy refused stale branch-scoped continuation; earlier writes may have completed; inspect the original branch and dispatch fresh intended work through ContextManager, not the obsolete continuation');
    this.name = 'StaleBranchOperationError';
  }
}

/** Internal manager boundary; a forwarding strategy Proxy preserves this slot. */
const strategyOperationBoundary = Symbol('strategy operation boundary');
type Boundary = <T>(key: PropertyKey, work: () => T) => T;

// A forwarding Proxy can schedule work even while resolving the internal
// boundary symbol. Its continuation inherits this holder, which the resolved
// boundary fills exactly once, before any ordinary strategy member is read.
// Synchronous protected work during unresolved protocol lookup fails closed.
interface BoundaryResolution {
  resolving: boolean;
  failed: boolean;
  invalidated: Set<object>;
  parent?: BoundaryResolution;
  origin?: { owner: object; context: object; displaced: object | undefined };
}
const boundaryResolution = new AsyncLocalStorage<BoundaryResolution>();

/** Resolve ALL strategy member checks, methods and arguments in this boundary. */
export function callStrategy<S extends object, T>(strategy: S, key: PropertyKey, work: (strategy: S) => T): T {
  let parent = boundaryResolution.getStore();
  while (parent && !parent.resolving) parent = parent.parent;
  return boundaryResolution.run({ resolving: true, failed: false, invalidated: new Set(), parent }, () => {
    const resolution = boundaryResolution.getStore()!;
    const boundary = (strategy as { [strategyOperationBoundary]?: Boundary })[strategyOperationBoundary];
    resolution.resolving = false;
    return boundary ? boundary(key, () => work(strategy)) : work(strategy);
  });
}

/**
 * One origin per library invocation and its context-preserving continuations.
 * This is not a host callback sandbox: event/abort dispatch uses the dispatching
 * context, not the registration context; host schedulers can replace context.
 * Storage is per instance: calling another strategy starts its own operation. Lifecycle entrypoints deliberately start independent trees.
 *
 * The manager boundary is authoritative, independent of the strategy's method
 * representation. Prototype wrappers additionally scope direct calls to existing
 * prototype entrypoints; they cannot scope arbitrary external instance-function
 * calls. Library writers always check the invocation's origin, not a fresh load.
 */
export class BranchOperationScope<Identity extends object> {
  private readonly isolateFields: Array<() => void> = [];
  // Entry itself supersedes earlier work, even if an override awaits before
  // super and has not advanced the strategy's load generation yet.
  private lifecycleEpoch = 0;
  private readonly storage = new AsyncLocalStorage<Readonly<{
    // Only the synchronous lifecycle setup may replace this binding. Keeping
    // the holder lets an override's post-super continuation retain that load,
    // rather than the previously loaded identity (or an unfenced null scope).
    binding: { identity: Readonly<Identity> | null; generation: number };
    lifecycle: boolean;
    epoch: number;
    boundary?: { key: PropertyKey; claimed: boolean };
  }>>();

  constructor(
    private readonly capture: () => Readonly<Identity> | null,
    private readonly current: (identity: Readonly<Identity>) => boolean,
    private readonly generation: () => number,
  ) {}

  private context(): ReturnType<typeof this.storage.getStore> {
    const resolution = boundaryResolution.getStore();
    if (resolution?.resolving || resolution?.failed) throw new StaleBranchOperationError();
    const own = this.storage.getStore();
    let pending = resolution;
    while (pending && pending.origin?.owner !== this) pending = pending.parent;
    const origin = pending?.origin;
    // Symbol-trap work may inherit the old caller's instance storage. Use the
    // resolved invocation instead, but do not replace a genuinely nested scope.
    if (origin?.owner === this && (!own || own === origin.displaced)) {
      return origin.context as NonNullable<typeof own>;
    }
    return own;
  }

  get identity(): Readonly<Identity> | null | undefined { return this.context()?.binding.identity; }

  run<T>(identity: Readonly<Identity> | null, work: () => T, lifecycle = false,
    boundary?: { key: PropertyKey; claimed: boolean }): T {
    return this.storage.run(Object.freeze({
      binding: { identity, generation: this.generation() }, lifecycle, epoch: this.lifecycleEpoch, boundary,
    }), work);
  }

  private advanceEpoch(): void {
    this.lifecycleEpoch++;
    // A boundary-symbol trap may synchronously reenter the manager before
    // forwarding the symbol. Such a lookup cannot adopt the replacement load.
    for (let pending = boundaryResolution.getStore(); pending; pending = pending.parent) {
      if (pending.resolving) pending.invalidated.add(this);
    }
  }

  /** A manager call is a new origin even when made reentrantly by old work. */
  private invoke<T>(key: PropertyKey, work: () => T): T {
    const resolution = boundaryResolution.getStore();
    if (resolution?.invalidated.has(this)) {
      resolution.failed = true;
      throw new StaleBranchOperationError();
    }
    const displaced = this.storage.getStore();
    return this.storage.exit(() => {
      const lifecycle = key === 'initialize' || key === 'detach';
      if (lifecycle) this.advanceEpoch();
      const identity = this.capture();
      return this.run(identity ? Object.freeze({ ...identity }) : null, () => {
        if (resolution) resolution.origin = { owner: this, context: this.storage.getStore()!, displaced };
        return work();
      }, lifecycle, { key, claimed: false });
    });
  }

  /** Library-owned dispatch only: preserve its origin when another load cancels it.
   * Arbitrary host listeners/schedulers are not intercepted or rebound. */
  bind<T extends (...args: any[]) => any>(callback: T): T {
    return AsyncLocalStorage.bind(callback);
  }

  /** Snapshot before looking up a writer, which itself may invoke a host hook. */
  writerGuard(): () => void {
    const scope = this.context();
    const identity = scope?.binding.identity;
    const generation = scope?.binding.generation;
    return () => {
      this.assertCurrent();
      if (!scope || this.context() !== scope ||
        scope.binding.identity !== identity || scope.binding.generation !== generation) {
        throw new StaleBranchOperationError();
      }
    };
  }

  /** Advance only the calling lifecycle, BEFORE abort listeners can reenter. */
  advanceLifecycle(generation: number): void {
    this.bindLifecycle(null, generation);
  }

  /** Bind the outer override as well as the base initializer's inner work. */
  bindLifecycle(identity: Readonly<Identity> | null, generation = this.generation()): void {
    this.assertCurrent();
    const scope = this.context();
    if (!scope?.lifecycle) throw new Error('Branch lifecycle setup requires its own scope');
    scope.binding.identity = identity;
    scope.binding.generation = generation;
  }

  assertCurrent(): void {
    if (!this.isCurrent()) throw new StaleBranchOperationError();
  }

  /** Cheap, non-reentrant epoch/generation check, also used by currency probes. */
  isBindingCurrent(): boolean {
    const scope = this.context();
    return !scope || (scope.epoch === this.lifecycleEpoch && scope.binding.generation === this.generation());
  }

  private assertBindingCurrent(): void {
    if (!this.isBindingCurrent()) throw new StaleBranchOperationError();
  }

  isCurrent(): boolean {
    const scope = this.context();
    return this.isBindingCurrent() && (!scope?.binding.identity || this.current(scope.binding.identity)) &&
      this.isBindingCurrent();
  }

  /** Detach collection shells before initialization clears/reloads them. */
  isolateMirrors(): void {
    this.assertCurrent();
    for (const isolate of this.isolateFields) isolate();
  }

  install(target: object, sharedFields: ReadonlySet<string>, objectMirrors: ReadonlySet<string>,
    discardedMirrors: ReadonlySet<string> = new Set()): void {
    const scope = this;
    Object.defineProperty(target, strategyOperationBoundary, {
      // Forwarders may bind functions returned by their get trap. A frozen
      // data slot would require the trap to return this exact function.
      configurable: true,
      value: <T>(key: PropertyKey, work: () => T) => scope.invoke(key, work),
    });
    const seen = new Set<PropertyKey>(['constructor']);
    for (let prototype = Object.getPrototypeOf(target); prototype !== Object.prototype; prototype = Object.getPrototypeOf(prototype)) {
      for (const key of Reflect.ownKeys(prototype)) {
        if (seen.has(key)) continue;
        seen.add(key);
        const descriptor = Object.getOwnPropertyDescriptor(prototype, key)!;
        if (typeof descriptor.value !== 'function') continue;
        const method = descriptor.value;
        const wrapped = function (this: object, ...args: unknown[]) {
          const work = () => Reflect.apply(method, this, args);
          // Consume only the manager's forwarded entry. This also works when
          // a Proxy awaits before forwarding to an installed prototype method.
          // The boundary's binding then remains the lifecycle override's binding.
          const entry = scope.context()?.boundary;
          if (entry?.key === key && !entry.claimed) {
            entry.claimed = true;
            scope.assertCurrent();
            return work();
          }
          if (key === 'initialize' || key === 'detach') {
            // A reentrant lifecycle is independent of its caller, but its
            // entire override still has an origin, including before super.
            return scope.storage.exit(() => {
              scope.advanceEpoch();
              const identity = scope.capture();
              return scope.run(identity ? Object.freeze({ ...identity }) : null, work, true);
            });
          }
          if (scope.context()) return work();
          const identity = scope.capture();
          return scope.run(identity ? Object.freeze({ ...identity }) : null, work);
        };
        Object.defineProperties(wrapped, {
          name: { value: method.name, configurable: true },
          length: { value: method.length, configurable: true },
        });
        Object.defineProperty(target, key, { ...descriptor, value: wrapped });
      }
    }

    // Protect loaded mirrors as well as durable writes. Otherwise a reentrant
    // read could assign its old result into B before the next writer's guard.
    // Previously captured A collections remain A's; fetching a B collection
    // or assigning a field from an obsolete scope fails before touching B.
    // No store reads here: generation/binding comparisons cannot themselves
    // invoke a host hook. Lifecycle controls and process-wide config are shared.
    for (const key of Object.keys(target)) {
      if (sharedFields.has(key) && key !== 'store' && key !== 'ns') continue;
      const descriptor = Object.getOwnPropertyDescriptor(target, key)!;
      if (!('value' in descriptor) || !descriptor.writable || typeof descriptor.value === 'function') continue;
      let value = descriptor.value;
      this.isolateFields.push(() => {
        // Caches immediately reset by initialization need a new shell, not a
        // history-sized copy. Old operations retain their previously captured shell.
        if (discardedMirrors.has(key)) {
          value = Array.isArray(value) ? [] : new Map();
        } else if (value instanceof Map) value = new Map(value);
        else if (value instanceof Set) value = new Set(value);
        else if (value instanceof WeakMap) value = new WeakMap();
        else if (value instanceof WeakSet) value = new WeakSet();
        else if (Array.isArray(value)) value = value.slice();
        else if (objectMirrors.has(key) && value) value = { ...value };
      });
      Object.defineProperty(target, key, {
        configurable: descriptor.configurable,
        enumerable: descriptor.enumerable,
        get() { if (key !== 'store' && key !== 'ns') scope.assertBindingCurrent(); return value; },
        set(next) { scope.assertBindingCurrent(); value = next; },
      });
    }
  }
}
