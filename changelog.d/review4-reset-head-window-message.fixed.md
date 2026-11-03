- `resetHeadWindow`'s rejection for a failed presentation of its transition
  says whether the window holds the transition: stored and presented, where
  the presentation landed before it threw; stored; or stored and maybe
  presented, where the window can't be read. Its message begins
  `ContextManager.resetHeadWindow's presentation of its transition failed:`,
  where it began `ContextManager.resetHeadWindow couldn't present its
  transition:` and said the transition was only stored.
