/**
 * A real, minimal MaxMind DB: one search-tree node whose two records both point at a single map,
 * so every IPv4 address answers with `data`. Enough for the real reader to open and look up,
 * which a stand-in byte string is not.
 */

function encodeSize(type: number, size: number): Buffer {
  // Every value here is short: sizes under 29 fit the control byte.
  if (size >= 29) throw new Error('mmdb helper: value too long');
  return type <= 7 ? Buffer.from([(type << 5) | size]) : Buffer.from([size, type - 7]);
}

function encodeUint(type: number, value: number | bigint): Buffer {
  let hex = BigInt(value).toString(16);
  if (hex === '0') hex = '';
  if (hex.length % 2) hex = `0${hex}`;
  const bytes = Buffer.from(hex, 'hex');
  return Buffer.concat([encodeSize(type, bytes.length), bytes]);
}

type Value = string | number | { [key: string]: Value } | Value[] | { uint64: bigint };

function encode(value: Value): Buffer {
  if (typeof value === 'string') {
    const bytes = Buffer.from(value, 'utf-8');
    return Buffer.concat([encodeSize(2, bytes.length), bytes]);
  }
  if (typeof value === 'number') return encodeUint(6, value);
  if (Array.isArray(value)) {
    return Buffer.concat([encodeSize(11, value.length), ...value.map(encode)]);
  }
  if ('uint64' in value && typeof value.uint64 === 'bigint') return encodeUint(9, value.uint64);
  const entries = Object.entries(value as Record<string, Value>);
  return Buffer.concat([
    encodeSize(7, entries.length),
    ...entries.flatMap(([key, entry]) => [encode(key), encode(entry)]),
  ]);
}

const METADATA_MARKER = Buffer.concat([
  Buffer.from([0xab, 0xcd, 0xef]),
  Buffer.from('MaxMind.com'),
]);

export function buildMmdb(options: {
  databaseType: string;
  buildEpoch?: Date;
  data?: Record<string, Value>;
}): Uint8Array<ArrayBuffer> {
  const nodeCount = 1;
  // A record past the node count points into the data section, 16 bytes after the tree.
  const pointer = nodeCount + 16;
  const record = Buffer.from([(pointer >> 16) & 0xff, (pointer >> 8) & 0xff, pointer & 0xff]);
  const tree = Buffer.concat([record, record]);
  const data = encode(options.data ?? { country: { iso_code: 'DE' } });
  const epoch = BigInt(Math.floor((options.buildEpoch ?? new Date('2026-10-01')).getTime() / 1000));
  const metadata = encode({
    binary_format_major_version: 2,
    binary_format_minor_version: 0,
    build_epoch: { uint64: epoch },
    database_type: options.databaseType,
    description: { en: 'test' },
    ip_version: 4,
    languages: ['en'],
    node_count: nodeCount,
    record_size: 24,
  });
  return Uint8Array.from(Buffer.concat([tree, Buffer.alloc(16), data, METADATA_MARKER, metadata]));
}
