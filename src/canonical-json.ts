/**
 * JSON with each object's keys in one order whatever order they were set in
 * (sorted, though integer-like keys come first, ascending, as in any object),
 * and each array's items in their own order, so two values that differ only
 * in the order their keys were set give the same text. An object a store
 * written by chronicle 0.5.0 keeps comes back with its keys sorted, one
 * written by 0.6.0 (chronicle #67) in the order they were written, and one
 * built in code in the order it was built in; this gives the same text for
 * all three.
 */
export function canonicalJson(value: unknown): string {
  return JSON.stringify(value, (_key, inner: unknown) => {
    if (inner === null || typeof inner !== 'object' || Array.isArray(inner)) return inner;
    return Object.fromEntries(Object.keys(inner).sort().map((key) => [key, (inner as Record<string, unknown>)[key]]));
  });
}
