- Keep an image in a tool result as a blob, as the store keeps an image at the
  top of a message. It covers each image in a top-level `tool_result`'s
  content array, except an image whose source is a URL. The record holds a
  `blob_ref` in the image's place. The blob store holds the image's bytes one
  time, and each read with blobs resolved gives the image back in its place.
  The context log keeps these images as blobs too, and `blockAsStored`,
  `BlobManager.hasStorableMedia` and `estimateMediaSize` count them.
  - An image inside a tool result now comes back with its source alone. The
    store already gives back an image at the top of a message this way. The
    store writes the base64 again from the bytes. For a png, jpeg, gif or webp, it takes the media type from the bytes'
    signature, and for other bytes it takes the declared type. It keeps no
    other field, so it drops a `tokenEstimate` stamp and prices the image at
    1,600 tokens.
  - When the store can't keep an image inside a tool result, a write refuses
    it. The refusal names the image's place, such as
    `content[0].content[1].source.mediaType`. The store keeps these as they
    were given: a URL image, other media in a tool result's content array, and
    anything nested deeper.
  - `StoredContentBlock` has a new `tool_result` variant, `StoredToolResult`.
    Its content array can hold a `BlobReferenceBlock`, and the package exports
    both types. A `StoredToolResult` is not a membrane `ContentBlock` to the
    compiler.
  - Each such image is a file in the store's blob directory, so it is in the
    store's backups as well, and nothing removes a blob. A record from an
    earlier release holds the image inline, and it reads back as before.
    Nothing is migrated.
  - A release before this one reads a `blob_ref` inside a tool result and
    doesn't resolve it. A request made from that message can then lose the
    image silently, or fail. To go back to such a release, restore the copy
    of the store from before the update.
