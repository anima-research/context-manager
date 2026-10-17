- `acceptRound` refuses a compile whose branch its store doesn't know, live or
  recorded in the manager's namespace, as it already refused one of another
  namespace. Another store's compile in the same namespace used to land as a
  receipt for a branch that store never had, announced to its listeners. A
  compile of a branch deleted before any of its compiles was accepted is
  refused the same way; a deleted branch with readable records still takes
  one.
- `listFoldReceipts` stops where a receipt's link leaves its namespace or
  branch, and its `note` says so, instead of listing the other branch's
  receipts as this one's. An acceptance no longer announces another branch's
  receipt that such a link names.
- `acceptRound` refuses a layout whose members aren't in ascending order,
  whose units' counts aren't positive whole numbers adding up to its members,
  or that doesn't have one id for each member, as a layout changed after
  `compile()` returned it can be, instead of writing
  a record that later fails to rebuild and starts its branch again from a
  baseline. A change that keeps that shape can't be told from the layout
  `compile()` returned, and is recorded as written.
- The fold journal keeps its own copy of each layout and branch it accepts,
  and a compile's `journalMark` and the branch `listFoldReceipts` returns are
  copies. So changing a compile's provenance after accepting it no longer
  changes the layout the journal diffs the next acceptance against, the
  branch it lists receipts under, or where it looks for an earlier
  acceptance.
