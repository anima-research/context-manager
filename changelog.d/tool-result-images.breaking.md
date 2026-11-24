- **Host operators:** copy each store before you update. You need that copy to
  go back to an earlier release. This release stores an image inside a tool
  result as a blob, and an earlier release can't read it back. An earlier
  release can then drop the image from a request without a warning, or the
  request can fail. To go back, restore the copy from before the update. A
  restore also loses what the store recorded after the update. A host that
  stays on this release or a later one needs no action, and a record from an
  earlier release reads back as before.
- **Hosts that read with `resolveBlobs: false`:** such a read now returns a
  `blob_ref` for an image in a tool result. Before, it came back inline. A
  default read still gives the image itself, and an image at the top of a
  message comes back as before.
- **TypeScript consumers:** `StoredContentBlock` has a new `tool_result`
  variant, `StoredToolResult`. Its content array can hold a
  `BlobReferenceBlock`, and the package exports both types. The compiler
  doesn't accept a `StoredToolResult` as membrane's `ContentBlock`.
- Keep an image in a tool result as a blob, as the store keeps an image at the
  top of a message. This applies to each image in the content array of a
  top-level `tool_result`. An image whose source is a URL stays as it is. The
  record holds a `blob_ref` in the image's place. The blob store holds the
  image's bytes one time, and each read with blobs resolved gives the image
  back in its place. The context log keeps these images as blobs too, and
  `blockAsStored`, `BlobManager.hasStorableMedia` and `estimateMediaSize`
  count them.
  - An image inside a tool result now comes back with its source alone. The
    store already gives back an image at the top of a message this way. The
    store writes the base64 again from the bytes. For a png, jpeg, gif or
    webp, it takes the media type from the bytes' signature, and for other
    bytes it takes the declared type. It keeps no other field, so it drops a
    `tokenEstimate` stamp and prices the image at 1,600 tokens.
  - A write now refuses an image in a tool result if the store can't keep it.
    Before this release, a write checked only the image's form. The refusal
    names the image's place, such as `content[0].content[1].source.mediaType`.
    The store keeps these as they were given: a URL image, other media in a
    tool result's content array, and anything nested deeper.
  - Each such image is a file in the store's blob directory, so it is in the
    store's backups as well, and nothing removes a blob. Nothing is migrated.
