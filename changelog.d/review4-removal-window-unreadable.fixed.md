- A removal through the manager (`removeMessage`, `removeMessages`) tells
  the strategy the rows left (`onRetracted`, with `removed`) where the
  window index can't be read: every row removed, with the rows as they were
  before they went. Before, a `removeMessages` whose read of the window
  threw wrote no tombstones and told nothing, though its rows could be read
  from the slot, and a `removeMessage` whose index read threw told nothing,
  though its event names the row. The rows keep their ordinals until
  `retractAbsentRows` takes them out, which tells the strategy again.
