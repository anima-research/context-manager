- **Hosts that write content they didn't build,** such as a channel's
  messages: `addMessage`, `editMessage`, `MessageStore.append` and `edit`,
  `ContextLog.append`, `edit` and `replaceAll`, and `blockAsStored` for its
  one block, now refuse content that doesn't match `ContentBlock` where its
  readers read it, and store nothing of it. Before, such content was stored,
  and a reader written against `ContentBlock` could throw on it from then
  on, except inline media the store couldn't keep, whose write threw. What's
  refused: content that isn't an array; a block that isn't an object, is an
  array, or has no string `type`; a text or thinking block whose `text` or
  `thinking` isn't a string; a `tool_result` whose content is neither a
  string nor an array of such blocks, at any depth; an image, document,
  audio or video block whose `source` isn't an object, such as MCP's form of
  an image or audio, which carries `data` and `mimeType` on the block (a
  write takes it as `source: { type: 'base64', data, mediaType }`, as
  agent-framework converts it); inline media the store can't keep as a blob,
  where its own write threw an error naming neither the block nor the field:
  a document, audio or video block, or an image other than a URL one, in the
  content itself, not inside a `tool_result`, whose `source.data` the
  store's read of base64 can't take, which only data that isn't a string can
  be, or that has no media type, neither a declared `source.mediaType` nor,
  for an image, a png, jpeg, gif or webp signature in its data (data outside
  membrane's string type, such as a `Buffer`, is read for this as the store
  reads it, a copy the store's write then makes again); a generated image
  whose `data` or `mimeType` isn't a string; a `tool_use` whose `input` is
  given, isn't an object and has no JSON form, such as a `bigint`, unless
  the block already carries a string `unparseableInput`, which is kept; and
  a `blob_ref`, which only the store writes. A host that copies messages
  from one store to another copies them as read with blobs resolved, the
  default: a read with `resolveBlobs: false` gives `blob_ref`s. The refusal
  is a `MalformedContentError`. Its message names each place by its path,
  such as `Message refused: content[1] is a string, not a content block.`,
  and its `places` lists them. `malformedContentPlaces(content)` lists the
  same places without throwing, for content as JSON gives it nested no
  deeper than the call stack allows, so a host can check content before it
  writes or queues it, and drop a write this refuses rather than requeue it.
  `addMessage` refuses such a message before anything else happens: no
  compression hold expires or is placed, and the strategy's ingress chunking
  never reads it. A shard of a strategy's chunking that doesn't match is
  refused before any shard is stored, with an error naming the shard, though
  by then expired holds have been released, as at any add; and
  `ContextLog.replaceAll` refuses an entry holding such content before it
  clears the log.
