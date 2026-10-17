- A store holding content that doesn't match `ContentBlock` where its
  readers read it no longer wedges its agent. Such content is content that
  isn't an array; a block that isn't an object, is an array, or has no
  string `type`; a text block whose `text`, or a thinking block whose
  `thinking`, isn't a string; a `tool_use` whose `input` isn't an object; a
  `tool_result` whose content is neither a string nor an array of such
  blocks, at any depth; an image, document, audio or video block whose
  `source` isn't an object; a generated image whose `data` or `mimeType`
  isn't a string; or a `blob_ref` whose `ref` has no string `hash`, or whose
  `originalType` isn't image, document, audio or video. Readers written
  against `ContentBlock` throw on it. A store holding a block that isn't an
  object, or a `blob_ref` without its `ref` or with any other
  `originalType`, threw on every compile under the passthrough and windowed
  strategies, after a reopen too. Under the autobiographical strategy,
  opening such a store threw, and so did opening one holding a text or
  thinking block without its `text` or `thinking`. Membrane 0.5.87 throws
  while building a request that carries an image block without a `source` at
  the top level, or inside a `tool_result` in xml tool mode. In native tool
  mode, it replaces such an image inside a `tool_result` with a note that
  its media type "undefined" isn't accepted, so the model loses it. Its
  native formatter throws on audio without a `source` at the top level too.
  Reads (`MessageStore`'s messages and `ContextLog`'s entries) now leave
  such content out, or mend it so that it matches, before anything reads it,
  blob resolution included, and log one line per message or context entry
  naming each place, once per `MessageStore` or `ContextLog`. An entry that
  comes to have another's index gets a line of its own unless the same
  places are wrong in it. A `tool_use` is mended as a write now mends it. A
  `tool_result` keeps its block with the blocks of its content that match,
  or with an empty array in place of content that is neither a string, an
  array, a lone block nor a number, so the pair they make survives. A
  message whose content isn't an array, or all of whose blocks are left out,
  reads with empty content. The store keeps the content as written, and
  `editMessage` can replace it. In the message's content, and in each
  `tool_result`'s content within it, a block that shares a raw replay form
  (`rawXml`, `rawItem`) with a block a read changes or leaves out gives that
  form up, as after any edit.
