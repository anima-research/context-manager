import type { JsStore } from '@animalabs/chronicle';

export interface StoreBranchGeneration {
  name: string;
  generation: number;
}

const branchGenerations = new WeakMap<JsStore, StoreBranchGeneration>();

/** Observe direct/non-manager switches without advancing ordinary same-branch opens. */
export function observeStoreBranch(store: JsStore): StoreBranchGeneration {
  const name = store.currentBranch().name;
  const previous = branchGenerations.get(store);
  if (previous?.name === name) return previous;
  const current = { name, generation: (previous?.generation ?? -1) + 1 };
  branchGenerations.set(store, current);
  return current;
}
/** Record every ContextManager switch, including away-and-back and same-name calls. */
export function markStoreBranchSwitch(store: JsStore): StoreBranchGeneration {
  const previous = branchGenerations.get(store);
  const current = {
    name: store.currentBranch().name,
    generation: (previous?.generation ?? -1) + 1,
  };
  branchGenerations.set(store, current);
  return current;
}
