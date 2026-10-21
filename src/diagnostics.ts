/**
 * Diagnostics on stderr that name the namespace whose work they report (#239).
 *
 * One process can host several managers on one store, each with its own
 * namespace (agent-framework gives each agent `agents/<name>`), and their
 * lines interleave on stderr. A line about one namespace's work ends its
 * message's first line with ` ns=<namespace>`, after its own fields, so a
 * grep for its prefix still matches and a reader can keep one namespace's
 * lines. Values logged after the message, such as an error, print after the
 * suffix, as console prints them. A line about what no one namespace owns,
 * such as the store's own records or a message slot the managers share, is
 * logged as it is, through `console`, which is a Diagnostics too.
 *
 * As with console, a message followed by arguments is a format string, so a
 * value put into it that may hold a '%' is doubled first.
 */
export interface Diagnostics {
  error(message: string, ...rest: unknown[]): void;
  warn(message: string, ...rest: unknown[]): void;
}

/** `message` with ` ns=<namespace>` at the end of its first line. */
export function withNamespace(message: string, namespace: string): string {
  const end = message.indexOf('\n');
  return end === -1
    ? `${message} ns=${namespace}`
    : `${message.slice(0, end)} ns=${namespace}${message.slice(end)}`;
}

/**
 * Diagnostics for one namespace's work. The namespace is read as each line
 * is logged, since a strategy learns its own at initialize, and so is
 * `console`, so a test's mock of console.error or console.warn sees the line.
 * Before it has one (a strategy no manager has initialized), a line names
 * none. The suffix ends the message's first line, as withNamespace places it,
 * and arguments after the message, such as an error, print after it, as
 * console prints them.
 */
export function namespaceDiagnostics(namespace: () => string): Diagnostics {
  const named = (message: string, rest: unknown[]) => {
    const name = namespace();
    if (!name) return message;
    // Console reads the message as a format string when arguments follow it,
    // so a '%' in the name is doubled to print as itself.
    return withNamespace(message, rest.length > 0 ? name.replaceAll('%', '%%') : name);
  };
  return {
    error: (message, ...rest) => console.error(named(message, rest), ...rest),
    warn: (message, ...rest) => console.warn(named(message, rest), ...rest),
  };
}
