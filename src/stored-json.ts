/**
 * The JSON bytes a state write stores (`editStateItem`, `setState`).
 *
 * JSON.stringify writes a lone UTF-16 surrogate half as the escape `\udXXX`.
 * The native store keeps those bytes, and then can't parse them back:
 * serde_json refuses a lone half in an escape. It replays every record of a
 * state whenever it rebuilds that state, so one such write leaves the whole
 * state unreadable, and a store whose messages hold one can't be opened.
 *
 * So each such escape in the text JSON.stringify wrote becomes `\ufffd`, and
 * the store reads U+FFFD there, as it stores for a lone half in a string that
 * its JSON object writes take (`appendToStateJson`, through napi's conversion
 * to UTF-8). JSON.stringify writes a surrogate pair as its characters and only
 * a lone half as an escape, so every such escape is a lone half, in a string
 * or a key. It also writes each backslash in a string as `\\`, so it's the
 * backslashes directly before the `u` that tell an escape from text. When
 * they're odd in number, the last of them begins the escape, and the ones
 * before it are escaped backslashes. When they're even, they're all escaped
 * backslashes, and the `u` and the hex after it are text, left as they are.
 *
 * A key isn't as an object write stores it: that write drops a key holding a
 * lone half, where here the key keeps U+FFFD. Two keys of one object that
 * differ only in a lone half (`k\uD800`, `k\uDC00`, `k\uFFFD`) come out the
 * same, and the store keeps the last of them.
 */

/**
 * `\u` and a surrogate half's hex, with an odd number of backslashes directly
 * before the `u`: an even run of escaped backslashes (group 1, written back),
 * then the escape's own. The lookbehind starts a match at a run's first
 * backslash.
 */
const LONE_HALF_ESCAPE = /(?<!\\)((?:\\\\)*)\\u[dD][89a-fA-F][0-9a-fA-F]{2}/g;

export function storedJson(value: unknown): Buffer {
  return Buffer.from(JSON.stringify(value).replace(LONE_HALF_ESCAPE, '$1\\ufffd'));
}
