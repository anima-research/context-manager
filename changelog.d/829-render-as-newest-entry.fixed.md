- 0.23.1's `renderAsNewest` entry said the adaptive middle sends a sharded
  body's text alone, uncut, and that a body across the middle and a window
  goes out in more than one entry. The compile now sends such a body in one
  entry, as the render gives it. A sharded body still goes out in more than
  one entry only across a reset head window's end: one that leaves no call
  waiting for a later result, and a reply that makes a call, in a store
  whose chunks begin partway through it, until the next reset.
