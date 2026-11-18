import type { JsStore } from '@animalabs/chronicle';

export interface StoreBranchGeneration {
  name: string;
  generation: number;
}

const branchGenerations = new WeakMap<JsStore, StoreBranchGeneration>();

/** Observe direct/non-manager switches without advancing ordinary same-branch opens. */
export function observeStoreBranch(store: JsStore): StoreBranchGeneration {
  // One reconciliation read handles an ordinary nested switch/back. A host
  // hook that keeps changing the observation cannot be trusted indefinitely.
  for (let attempt = 0; attempt < 2; attempt++) {
    const previous = branchGenerations.get(store);
    const name = store.currentBranch().name;
    const reentered = branchGenerations.get(store);
    if (reentered !== previous && reentered) {
      if (reentered.name === name) return reentered;
      continue;
    }
    if (previous?.name === name) return previous;
    const current = { name, generation: (previous?.generation ?? -1) + 1 };
    branchGenerations.set(store, current);
    return current;
  }
  throw new Error('Store branch observation did not stabilize after reentry');
}
/** Record every ContextManager switch, including away-and-back and same-name calls. */
export function markStoreBranchSwitch(store: JsStore): StoreBranchGeneration {
  const previous = branchGenerations.get(store);
  const name = store.currentBranch().name;
  const reentered = branchGenerations.get(store);
  if (reentered !== previous && reentered) return reentered.name === name ? reentered : observeStoreBranch(store);
  const current = { name, generation: (previous?.generation ?? -1) + 1 };
  branchGenerations.set(store, current);
  return current;
}
