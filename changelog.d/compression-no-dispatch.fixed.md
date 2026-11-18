- Restore observability for L1 operations ending before dispatch: logging now
  emits a distinct `compression:no-dispatch` outcome with a bounded reason and
  no request payload, rather than representing an unsent request as sent.
- Surgery provider-error sanitization supports getter-only error prototypes
  such as DOMException without losing cancellation classification.
- Zero-recall surgery rejects raw recall markers split across text blocks;
  drain recipes ignore inherited or non-enumerable compression instructions.
- Recall-curve expansion preserves raw Context Manager blocks collapsed into
  constructed header messages. Recall totals recover on a later valid request,
  and stripped-carrier pricing includes the actual replayed text preamble.
- Warn without exposing payloads when L1 receipt preparation fails.
