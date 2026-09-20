- Tool-prose hoist: an inserted call's id is now `<original id>_<argument index
  within that call>` instead of counting across the whole request, so a hoisted
  call renders identically after earlier hoisted calls leave the window.
