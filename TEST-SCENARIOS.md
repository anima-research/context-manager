# Context Manager Test Scenarios

Complex flows and edge cases that need testing beyond basic operations.

## Edit Propagation Edge Cases

1. **Cascading edits** - Edit a message that's referenced by multiple context entries with different source relations. Does `copy` propagate while `derived` doesn't?

2. **Edit during compression** - What if a message is edited while the autobiographical strategy is mid-compression on a chunk containing that message?

3. **Remove message that's mid-compression** - Similar: chunk is being compressed, source message gets deleted

4. **Edit propagation with blob content** - Edit a message containing an image. Does the blob get properly updated/dereferenced?

## Autobiographical Strategy

5. **Chunk boundary stability** - Add messages, let it chunk. Add more messages. Do the old chunk boundaries stay stable, or do they shift and invalidate cached compressions?

6. **Compression failure recovery** - LLM call fails mid-compression. Is state consistent? Can we retry?

7. **Chunk key collision** - Two different message sequences that happen to produce the same chunk key (unlikely but possible with our simple ID-based key)

8. **Reopen after partial compression** - Close store mid-compression, reopen. Is the chunk marked compressed or not?

9. **Token estimation drift** - Chunk is sized at 3k tokens, but actual LLM tokenizer counts it as 4k. Does the budget math still work?

## Branching

10. **Branch with pending compression** - Create branch while autobiographical has chunks queued. Does each branch get independent compression state?

11. **Edit on branch, check main** - Edit message on branch, switch to main. Is main's context log unaffected?

12. **Merge scenarios** - (Not implemented, but worth thinking about) What happens if you want to merge branches?

## Blob Storage

13. **Blob deduplication** - Add same image twice in different messages. Should only store once. Then delete one message - blob should remain.

14. **Blob reference after message delete** - Delete message with blob, but context log has a `derived` entry that referenced it (and wasn't deleted). Can we still resolve the blob?

15. **Large blob handling** - Multi-MB images/documents. Memory pressure during extraction/resolution.

## Concurrency (if ever multi-threaded)

16. **Concurrent addMessage calls** - Two messages added "simultaneously". Are IDs unique? Is ordering deterministic?

17. **Compile during tick** - `compile()` called while `tick()` is running compression. Race on chunk state?

## State Consistency

18. **Index rebuild correctness** - After multiple add/edit/remove operations, is the `idToIndex` map accurate?

19. **Source-to-index mapping after removals** - ContextLog's `sourceToIndices` after removing entries. Are the indices still valid?

20. **Historical state access** - `getMessageAt(id, oldSequence)` after the message was edited. Do we get the old content?

## Integration

21. **Round-trip through compile** - Add messages → compile → use result with Membrane → add response → compile again. Does the conversation stay coherent?

22. **Tool use/result pairing** - `tool_use` and `tool_result` blocks must stay paired. Does compression preserve this relationship?

---

## Priority Testing

Highest risk areas to prioritize:

1. **Edit propagation with mixed source relations** (#1)
2. **Chunk boundary stability on message add** (#5)
3. **State after failed compression** (#6)
4. **Blob lifecycle with deletes** (#13, #14)
5. **Index consistency after remove operations** (#18, #19)

## Current Test Coverage

- Basic CRUD operations ✓
- Passthrough strategy compilation ✓
- Token budget enforcement ✓
- Readiness reporting ✓
- Branching basics ✓
- Autobiographical initialization ✓
- Persistence ✓ (close() method added)
- Edit propagation with mixed source relations (#1) ✓
- Chunk boundary stability on message add (#5) ✓
- State after failed compression (#6) ✓
- Blob lifecycle with deletes (#13, #14) ✓
- Index consistency after remove operations (#18, #19) ✓
- Configurable compression prompts ✓

