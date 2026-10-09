- `blockAsStored(block)` gives a content block as the message store hands it
  back once stored: what `getMessage`, `getAllMessages` and
  `getMessageWindow` return for it with blobs resolved, live and after
  reopening. It needs no store and does no I/O, so a host can hash a body as
  the store will keep it before writing it. Inline media comes back as its
  source alone, its base64 rewritten from the decoded bytes and an image
  relabeled by its bytes' signature (png, jpeg, gif, webp); every other block
  comes back as given. The store's own write and read are built from the same
  helpers, so the two can't disagree. The store's serialization (undefined
  fields dropped, strings written as UTF-8) is outside it.
