- A `tool_use` whose `input` isn't an object, as membrane 0.5.87's adapters
  can give it, is now stored with `input: {}`, and `unparseableInput`, where
  membrane keeps arguments whose JSON didn't parse, keeps the value as JSON.
  One with no `input` at all is stored with `{}` and no marker, and a string
  marker the block already carries is kept. A block that shares a raw replay
  form (`rawXml`, `rawItem`) with a mended one gives the form up, as after
  any edit, so a write stores what a read of the same content gives. Before,
  such a block was stored as given. Reads mend it the same way in a store
  written before. They also mend a signed thinking block whose `thinking`
  isn't a string, which keeps its signature with `thinking: ''`, as membrane
  gives a signature-only block; media in MCP's form, with its `data` and
  `mimeType` on the block and no `source`, which reads with them as its
  base64 source, as agent-framework converts MCP's media; and a
  `tool_result` whose content is a lone block or a number, which reads as an
  array of that block, when the read keeps the block, or as the number's
  text.
