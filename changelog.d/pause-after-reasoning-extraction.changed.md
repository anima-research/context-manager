- **Compression no longer sends its next request right after one was refused
  as `reasoning_extraction`.** A chunk whose request is refused has a ladder
  of other requests to try, and a refused merge has further attempts. These
  used to follow within seconds, so one chunk could draw seven refusals in
  twenty. Now the refusal is recorded as before and the lane pauses as it
  does after a transient failure (5 s, doubling to 10 minutes). On a later
  tick the ladder goes on from the request after the refused one, and the
  merge makes its next attempt. Such a refusal no longer ends the lane's
  pause, so the backoff grows while these refusals are all that comes back;
  any other answer ends it. The ladder's requests, their order and their
  count are unchanged, and so is every other refusal category. A host that
  reports a failed tick sees the wait as one, with the same text each time.
