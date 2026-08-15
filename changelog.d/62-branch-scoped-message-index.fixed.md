- Rebuild the message ID-to-index lookup after a Chronicle branch switch, so
  message mutations and `branchAt(messageId)` cannot use slot positions cached
  from a differently shaped sibling branch.
