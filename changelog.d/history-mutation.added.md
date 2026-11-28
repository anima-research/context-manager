- **A host can change an agent's history through the manager, which checks
  the change and builds it on a branch of its own.**
  - `ContextManager.planHistoryMutation(manifest)` plans ops of three kinds.
    `edit_summary` edits a summary's text, `edit_message` edits a message,
    and `remove_messages` removes messages. Each op names the sha256 of the
    target that its caller read, which `describeMutationTarget` gives. The
    plan writes nothing. It returns each target with the sha256 of what it
    holds now and, for an edit, the content or text that the edit writes.
    It also returns the summaries that the mutation drops, the first row
    whose rendering may change (an estimate that errs early), whether a
    changed row lies inside the thinking-binding record, and a `planSha256`
    of all that it reports, its violations included, with each summary that
    it drops as the strategy holds it.
  - The plan refuses each of these, and says what to change:
    - a target that changed since its caller read it, a target named twice,
      or a target that isn't there;
    - an entry that carries another summary up a level (the error names that
      summary);
    - a summary that renders verbatim response blocks, unless the op sets
      `dropResponseContent`;
    - merged parents, unless `parentPolicy` says to leave or drop them;
    - a folded message, unless `foldedPolicy` says to drop what folds it,
      or, for an edit, to leave it; a removal from a presented window drops
      what folds it by default, as the window's removal does;
    - an empty summary text, malformed content, an edit of a shard, or the
      removal of part of a body;
    - a tool call split from its result, or a system change put between
      them;
    - a change to a message that keeps a thinking block;
    - a summary that one op edits and another op's policy drops;
    - an edit that the store's own tool-pair check would refuse after the
      batch's earlier ops;
    - the removal of every message;
    - an op of no known kind, or a field of the wrong type or value
      (`MALFORMED_OP`);
    - summaries in a strategy's memory, the manager's or a reader's, that
      differ from the ones the store holds, which another handle wrote
      since (`STALE_MEMORY`): that manager is initialized again first;
    - a strategy, the manager's or a reader's, that has no `historyMemory()`,
      since the plan can't see its summaries (`STRATEGY_UNSUPPORTED`).
      `PassthroughStrategy` and `WindowedPassthroughStrategy` themselves keep
      none. A strategy without summaries joins with a `historyMemory()` of
      empty lists.
  - An edited message takes a required `label` that names who changed it.
    The label goes first in the content, or after the message's leading
    tool results, unless a text block holds it already. The message's metadata records the edit (`historyMutation`),
    beside the metadata that it had. Each block that the edit changes loses
    the raw replay forms (`rawItem`, `rawXml`) that the old content held, so
    that a formatter sends the new text. A raw form that the old content
    didn't hold is the caller's, and stays.
  - `applyHistoryMutation(manifest, { targetBranch, expectedSourceBranch,
    expectedPlanSha256, by, strategy?, beforeSwitch?, readers?,
    ignoreNamespaces? })` makes the
    plan again and refuses a plan that drifted. It forks `targetBranch` from
    the head with every state. A manager on that branch makes the writes,
    with a fresh instance of the strategy
    (`ContextStrategy.cloneForScratch`, or `strategy`). After
    `beforeSwitch`, a fresh open reads the branch back. The rows must be the
    source's, with the plan's edits and removals. A presented window must
    hold the source window's rows, less the removed ones, each at its place.
    The summaries must be the source's, with the plan's summary edits and
    drops. Otherwise the apply refuses (`READBACK_MISMATCH`). New rows after the source's rows are allowed,
    such as a notice that `beforeSwitch` writes. The apply also refuses an
    anomaly that the source didn't have (`INVARIANT_BROKEN`). Where the
    build and the readback pass, it refuses a source that moved while the
    branch was built (`SOURCE_MOVED`): a record written to the source, the
    store on another branch, or the target branch replaced. Only then does
    it switch the store to the branch.
  - The preview and the apply refuse, before they write anything, a `by`
    whose `by` is blank or isn't a string, and a call made while the
    manager stores the shards of a sharded `addMessage`. The apply refuses
    the same for each reader. Ask again once the add returns.
  - A failure before that switch, or a process that stops, leaves the store
    where it was, and every manager on it with it. That is the source
    branch, unless something else moved the store meanwhile. A failure in
    the process also deletes the
    branch built. Where that deletion fails, the error (`BRANCH_LEFT`) names
    the branch. It says whether the branch is still there, or deleted with
    the deletion not saved yet. Where the work on the built branch threw,
    the error says so, that the branch is deleted, and that the source
    holds what it held. A process that stops leaves the branch, as a
    preview leaves its scratch branch (`preview-mutation/<uuid>`), and an
    apply can't build on that name until it is deleted. The switch can fail
    after the store has moved to the branch, such as where the store can't
    save the switch, or move the store to the branch and lose it to another
    selection. The mutation is then applied, and the error
    (`APPLIED_INIT_FAILED`) carries the receipt.
  - Nothing else should write the history while an apply runs. After it, the
    host re-initializes each other manager on the store, as after
    `switchBranch`.
  - The plan, the preview and the apply take `readers`: the other managers
    on the store that read the rows the mutation changes, such as another
    agent on the slot, or one that merges it. Each reader gets the rules of
    the manager's own window, by the op's `foldedPolicy` and the reader's
    own window mode. So its summaries over an edited or removed row can
    refuse the plan, and so can a tool pair split in its record or its
    window. The plan says what the mutation does to each reader
    (`readers`): the rows that its window holds or its summaries fold, the
    summaries that it drops, and where its window and its thinking record
    change. `planSha256` covers each reader's part. Before `beforeSwitch`,
    the apply reconciles every reader on the target branch: the removed rows
    leave its window, and the summaries that the plan drops for it go. It
    uses a fresh instance of the reader's strategy (`cloneForScratch`), or a
    `PassthroughStrategy` where that strategy keeps no summaries and has no
    `onRetracted`. A fresh open reads each reader back too. So a failure
    before the switch leaves every reader as it was. A reader is refused,
    thrown before anything is written, where it is the manager itself, is
    named twice, shares a strategy namespace with the manager or another
    reader, reads another store, or keeps summaries or has `onRetracted`
    with no usable `cloneForScratch`.
  - `compileMutationPreview(manifest, { by, budget?, injections?,
    selectOptions?, strategy?, readers?, ignoreNamespaces?, beforeCompile? })`
    builds the manager's part of the mutation the same way on a scratch
    branch, compiles there with `dryRun`, and deletes the branch.
    `beforeCompile` gets the scratch manager before the compile, so a caller
    can write there what it writes after an apply, for the compile to weigh. It plans the
    readers as the apply does, and reconciles none of them: the compile is
    the manager's. So a preview writes to the store, though the manager's
    branch doesn't move: its records stay in the store's log after the
    branch is deleted, and a preview that a crash stops leaves its
    `preview-mutation/<id>` branch, which `listBranches()` lists. The
    scratch strategy gets the live strategy's rendering frontier, as
    `derive` does, so that the live strategy's hot settings apply there too.
  - A mutation changes what agents read, not what the store holds: the
    source branch and the store's log keep the earlier text. So a
    redaction isn't an erasure.
  - The plan refuses where the store holds a namespace that isn't the
    manager's or a reader's, and whose autobiographical summaries or chunk
    records fold a row that the change edits or removes, or whose presented
    window holds one (`UNLISTED_READER`, naming it). It knows a namespace by
    those states, so a manager whose strategy keeps its summaries
    elsewhere is passed as a reader. A caller that means to leave a
    namespace as it is names it in `ignoreNamespaces`, which `planSha256`
    covers, and whose states the plan doesn't read.
  - `checkHistoryInvariants()` lists the anomalies of a history as it
    stands. These are malformed or empty content, a body that lacks shards,
    a tool call or result without its partner, a system change between a
    call and its result, and crossed summaries. It reads tool pairs in
    record order and in the order that a compile reads the window, with the
    view filter applied, and names a split once in each of the two where it
    stands.
  - Under `recallEnvelope: 'xml'`, the recall envelope of a summary gains
    `writtenBy` when the summary's text came from outside the strategy and
    names who wrote it (`external.by` isn't empty). Its carriers gain it
    too. The value escapes `&`, `<`, `>`, `"` and line breaks as character
    references. A summary stored with `external` before this change gains
    it as well. A compile that renders such a summary sends different bytes
    once, and so does a compression or merge request whose prompt holds it,
    so that request can miss its cached prefix once.
  - `editMessage` and `MessageStore.edit` take `{ mergeMetadata }`. The
    store's edit event still carries the content alone.
  - New exports: `HistoryMutationError`, and the types that an op, a plan,
    a receipt, an anomaly and a violation use (`HistoryMutationManifest`,
    `HistoryMutationOp`, the policies, `HistoryMutationPlan`,
    `PlannedTarget`, `PlannedReader`, `HistoryMutationReceipt`,
    `HistoryAnomaly`, `HistoryInvariantCode`, `MutationViolation`,
    `MutationViolationCode`, `MutationTargetDescription`, and
    `MessageEditStamp`, the shape of `metadata.historyMutation`); `messageContentSha256` and `textSha256`,
    the sha256s that an op names for a message and a summary;
    `HistoryMemorySource`, what a strategy implements for the plan to read
    its summaries; `HistoryMutationStrategy` (`historyMemory`,
    `editSummaryText` and `dropSummaries`) and its guard
    `isHistoryMutationStrategy`, what a strategy implements for its
    summaries to be changed; and
    `findUnpairedToolBlocks` with its `UnpairedToolBlock`.
