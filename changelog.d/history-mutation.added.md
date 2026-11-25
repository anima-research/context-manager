- **A host can change an agent's history through the manager, which checks
  the change and builds it on a branch of its own.**
  - `ContextManager.planHistoryMutation(manifest)` plans ops of three kinds.
    `edit_summary` edits a summary's text, `edit_message` edits a message,
    and `remove_messages` removes messages. Each op names the sha256 of the
    target that its caller read, which `describeMutationTarget` gives. The
    plan writes nothing. It returns each target before and after, the
    summaries that the mutation drops, the first row whose rendering
    changes, whether a changed row lies inside the thinking-binding record,
    and a `planSha256`.
  - The plan refuses each of these, and says what to change:
    - a target that changed since its caller read it, a target named twice,
      or a target that isn't there;
    - an entry that carries another summary up a level (the error names that
      summary);
    - a summary that renders verbatim response blocks, unless the op sets
      `dropResponseContent`;
    - merged parents, unless `parentPolicy` says to leave or drop them;
    - a folded message, unless `foldedPolicy` says to drop or leave what
      folds it;
    - an empty summary text, malformed content, an edit of a shard, or the
      removal of part of a body;
    - a tool call split from its result, or a system change put between
      them;
    - a change to a message that keeps a thinking block;
    - a summary that one op edits and another op's policy drops;
    - an edit that the store's own tool-pair check would refuse after the
      batch's earlier ops;
    - the removal of every message.
  - An edited message takes a required `label` that names who changed it.
    The label goes first in the content, unless a text block holds it
    already. The message's metadata records the edit (`historyMutation`),
    beside the metadata that it had. The edit drops the raw replay forms
    (`rawItem`, `rawXml`) of each block that it changes, so that a formatter
    sends the new text.
  - `applyHistoryMutation(manifest, { targetBranch, expectedSourceBranch,
    expectedPlanSha256, by, strategy?, beforeSwitch?, readers? })` makes the
    plan again and refuses a plan that drifted. It forks `targetBranch` from
    the head with every state. A manager on that branch makes the writes,
    with a fresh instance of the strategy
    (`ContextStrategy.cloneForScratch`, or `strategy`). After
    `beforeSwitch`, a fresh open reads the branch back. The rows must be the
    source's, with the plan's edits and removals. The summaries must be the
    source's, without the plan's drops. Otherwise the apply refuses
    (`READBACK_MISMATCH`). New rows after the source's rows are allowed,
    such as a notice that `beforeSwitch` writes. The apply also refuses an
    anomaly that the source didn't have (`INVARIANT_BROKEN`). It refuses a
    source that moved while the branch was built (`SOURCE_MOVED`): a record
    written to the source, the store on another branch, or the target branch
    replaced. Only then does it switch the store to the branch.
  - A failure before that switch, or a process that stops, leaves the store
    where it was, and every manager on it with it. That is the source
    branch, unless something else moved the store meanwhile, which refuses
    the apply (`SOURCE_MOVED`). A failure in the process also deletes the
    branch built. Where that deletion fails, the error (`BRANCH_LEFT`) names
    the branch. It says whether the branch is still there, or deleted with
    the deletion not saved yet. A process that stops leaves the branch, as a
    preview leaves its scratch branch (`preview-mutation/<uuid>`), and an
    apply can't build on that name until it is deleted. The switch can fail
    after the store has moved to the branch, or move the store to the branch
    and lose it to another selection. The mutation is then applied, and the
    error (`APPLIED_INIT_FAILED`) carries the receipt.
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
    (`readers`), and `planSha256` covers it. Before `beforeSwitch`, the
    apply reconciles each reader on the target branch with a fresh instance
    of the reader's strategy: the removed rows leave its window, and the
    summaries that the plan drops for it go. A fresh open reads each reader
    back too. So a failure before the switch leaves every reader as it was.
  - `compileMutationPreview(manifest, { by, budget?, injections?,
    selectOptions?, strategy?, readers? })` builds the mutation the same way
    on a scratch branch, compiles there with `dryRun`, and deletes the
    branch. So a preview writes to the store, though the manager's branch
    doesn't move. The scratch strategy gets the live strategy's rendering
    frontier, as `derive` does, so that the live strategy's hot settings
    apply there too.
  - `checkHistoryInvariants()` lists the anomalies of a history as it
    stands. These are malformed or empty content, a body that lacks shards,
    a tool call or result without its partner, a system change between a
    call and its result, and crossed summaries. It reads tool pairs in
    record order and in the window's order.
  - Under `recallEnvelope: 'xml'`, the recall envelope of a summary gains
    `editedBy` when the summary's text came from outside the strategy
    (`external`). Its carriers gain it too. The value escapes `&`, `<`, `>`,
    `"` and line breaks as character references. A summary stored with
    `external` before this change gains it as well. A compile that renders
    such a summary sends different bytes once.
  - `editMessage` and `MessageStore.edit` take `{ mergeMetadata }`.
    `findUnpairedToolBlocks` is exported. `src/history-mutation.ts` holds
    the types and `HistoryMutationError`. Among the types,
    `MessageEditStamp` is the shape of `metadata.historyMutation`.
