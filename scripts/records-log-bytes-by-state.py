#!/usr/bin/env python3
"""Byte accounting for a Chronicle `records.log`, by state and operation.

Streams the log (never loads the store, never holds payloads) and prints:
bytes and record counts per record type, per state, per (state, operation),
and per UTC day with that day's heaviest states. Use it when a store's
`records.log` is larger than its content explains — it is how #148 (the
kv-unified presentation receipt written as a full O(messages) Set on every
accepted call, 92% of a 4.6 GB log) was found.

Record framing (chronicle 0.4.x, `records/log.rs`):
  REC\\0 | ver(1) | flags(1) | id(8) | seq(8) | branch(8) | ts_us(8)
  | type_len(2) | type | enc(1) | payload_len(4) | payload
  | caused_by_count(2) | ids*8 | linked_to_count(2) | ids*8 | crc32(4)
`state_update` payloads are MessagePack maps; only `state_id` and the
operation's variant name are read, from the first 400 bytes. A field the
sample cuts off is reported as `?`, never a crash.

Usage:
    python3 scripts/records-log-bytes-by-state.py <store-dir-or-records.log> [--top N]
"""
import collections
import datetime
import os
import struct
import sys


def mp_str(buf, i):
    """Decode a MessagePack string header at buf[i]; return (text, next_index).

    `buf` is a bounded sample of the payload, so a field may start or end past
    it; then the text is '?' (counted under that label) rather than an error.
    """
    if i < 0 or i >= len(buf):
        return '?', len(buf)
    t = buf[i]
    if 0xA0 <= t <= 0xBF:
        n, start = t & 0x1F, i + 1
    elif t == 0xD9 and i + 1 < len(buf):
        n, start = buf[i + 1], i + 2
    elif t == 0xDA and i + 2 < len(buf):
        n, start = int.from_bytes(buf[i + 1:i + 3], 'big'), i + 3
    else:
        return '?', i + 1
    if start + n > len(buf):
        return '?', len(buf)
    return buf[start:start + n].decode('utf-8', 'replace'), start + n


def state_and_op(head):
    """Pull `state_id` and the operation variant out of a state_update payload head."""
    sid, op = '?', '?'
    i = head.find(b'\xa8state_id')
    if i >= 0:
        sid, _ = mp_str(head, i + 9)
    j = head.find(b'\xa9operation')
    if j >= 0:
        j += 10
        if j < len(head) and head[j] == 0x81:  # fixmap(1): { Variant: payload }
            op, _ = mp_str(head, j + 1)
        else:  # unit variant encoded as a bare string (or cut off by the sample)
            op, _ = mp_str(head, j)
    return sid, op


def scan(path):
    size = os.path.getsize(path)
    by_type = collections.Counter(); by_type_n = collections.Counter()
    by_state = collections.Counter(); by_state_n = collections.Counter()
    by_state_op = collections.Counter(); by_state_op_n = collections.Counter()
    by_day = collections.Counter(); by_day_state = collections.Counter()
    largest = {}
    records = 0
    with open(path, 'rb') as f:
        def need(n):
            b = f.read(n)
            if len(b) != n:
                raise EOFError
            return b
        while f.tell() < size:
            start = f.tell()
            try:
                if need(4) != b'REC\0':
                    print(f'bad magic at {start}; stopping', file=sys.stderr)
                    break
                need(2)
                _rid, seq, _branch, ts = struct.unpack('<QQQq', need(32))
                tlen = struct.unpack('<H', need(2))[0]
                rtype = need(tlen).decode('utf-8', 'replace')
                need(1)
                plen = struct.unpack('<I', need(4))[0]
                head = need(min(plen, 400))
                if plen > 400:
                    f.seek(plen - 400, 1)
                cbc = struct.unpack('<H', need(2))[0]; need(8 * cbc)
                ltc = struct.unpack('<H', need(2))[0]; need(8 * ltc)
                need(4)
            except EOFError:
                print(f'truncated record at {start}; stopping', file=sys.stderr)
                break
            records += 1
            reclen = f.tell() - start
            day = datetime.datetime.fromtimestamp(ts / 1e6, datetime.timezone.utc).strftime('%Y-%m-%d')
            by_type[rtype] += reclen; by_type_n[rtype] += 1
            by_day[day] += reclen
            if rtype == 'state_update':
                sid, op = state_and_op(head)
                by_state[sid] += reclen; by_state_n[sid] += 1
                by_state_op[(sid, op)] += reclen; by_state_op_n[(sid, op)] += 1
                by_day_state[(day, sid)] += reclen
                if reclen > largest.get(sid, (0,))[0]:
                    largest[sid] = (reclen, op, seq, day)
            else:
                by_day_state[(day, f'<{rtype}>')] += reclen
    return dict(size=size, records=records, by_type=by_type, by_type_n=by_type_n,
                by_state=by_state, by_state_n=by_state_n, by_state_op=by_state_op,
                by_state_op_n=by_state_op_n, by_day=by_day, by_day_state=by_day_state,
                largest=largest)


def mb(b):
    return f'{b / 1e6:9.1f} MB'


def main(argv):
    if len(argv) < 2 or argv[1] in ('-h', '--help'):
        print(__doc__); return 2
    path = argv[1]
    if os.path.isdir(path):
        path = os.path.join(path, 'records.log')
    top = int(argv[argv.index('--top') + 1]) if '--top' in argv else 25
    r = scan(path)
    print(f'{path}: {r["records"]} records, {r["size"]} bytes')
    print('\n== by record type')
    for k, v in r['by_type'].most_common():
        print(f'{mb(v)}  n={r["by_type_n"][k]:8d}  {k}')
    print(f'\n== by state (top {top})')
    for k, v in r['by_state'].most_common(top):
        big = r['largest'][k]
        print(f'{mb(v)}  n={r["by_state_n"][k]:8d}  largest={big[0] / 1e6:7.2f} MB ({big[1]} seq {big[2]} {big[3]})  {k}')
    print(f'\n== by state and operation (top {top})')
    for k, v in r['by_state_op'].most_common(top):
        n = r['by_state_op_n'][k]
        print(f'{mb(v)}  n={n:8d}  avg={v / n / 1e3:8.1f} KB  {k[0]} / {k[1]}')
    print('\n== by UTC day (heaviest states)')
    for day in sorted(r['by_day']):
        heaviest = sorted(((v, s) for (d, s), v in r['by_day_state'].items() if d == day), reverse=True)[:4]
        print(f'{day} {mb(r["by_day"][day])}  ' + '  '.join(f'{s}={v / 1e6:.0f}MB' for v, s in heaviest))
    return 0


if __name__ == '__main__':
    sys.exit(main(sys.argv))
