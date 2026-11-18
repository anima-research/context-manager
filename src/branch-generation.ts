import type { JsStore } from '@animalabs/chronicle';

export interface StoreBranchGeneration {
  name: string;
  generation: number;
}

const branchGenerations = new WeakMap<JsStore, StoreBranchGeneration>();

/** Observe direct/non-manager switches without advancing ordinary same-branch opens. */
export function observeStoreBranch(store: JsStore): StoreBranchGeneration {
  const previous = branchGenerations.get(store);
  const name = store.currentBranch().name;
  // A currentBranch hook can initialize another load and observe its branch.
  // Never overwrite that newer observation with the outer read's old result.
  const reentered = branchGenerations.get(store);
  if (reentered !== previous && reentered) {
    // A mismatch may be the outer read's old snapshot OR a real switch back
    // after the nested observation. Reobserve rather than assuming either.
    return reentered.name === name ? reentered : observeStoreBranch(store);
  }
  if (previous?.name === name) return previous;
  const current = { name, generation: (previous?.generation ?? -1) + 1 };
  branchGenerations.set(store, current);
  return current;
}
/** Record every ContextManager switch, including away-and-back and same-name calls. */
export function markStoreBranchSwitch(store: JsStore): StoreBranchGeneration {
  const previous = branchGenerations.get(store);
  const name = store.currentBranch().name;
  const reentered = branchGenerations.get(store);
  if (reentered !== previous && reentered) return reentered;
  const current = { name, generation: (previous?.generation ?? -1) + 1 };
  branchGenerations.set(store, current);
  return current;
}
