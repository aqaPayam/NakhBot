import { crc32, inflateRawSync } from 'node:zlib';
function denied(): never {
  throw new Error('Release archive ZIP is invalid.');
}
/** No extraction. Fixed JSON members only; bounded central directory and inflation. */
export function releaseZipReports(
  input: Uint8Array,
  expected: readonly string[],
): ReadonlyMap<string, unknown> {
  const zip = Buffer.from(input);
  if (zip.length < 22 || zip.length > 16777216) denied();
  let end = -1;
  for (let i = zip.length - 22; i >= Math.max(0, zip.length - 65557); i--)
    if (zip.readUInt32LE(i) === 0x06054b50) {
      end = i;
      break;
    }
  if (
    end < 0 ||
    zip.readUInt16LE(end + 4) !== 0 ||
    zip.readUInt16LE(end + 6) !== 0 ||
    end + 22 + zip.readUInt16LE(end + 20) !== zip.length
  )
    denied();
  const count = zip.readUInt16LE(end + 10),
    size = zip.readUInt32LE(end + 12),
    offset = zip.readUInt32LE(end + 16);
  if (
    count !== expected.length ||
    count !== zip.readUInt16LE(end + 8) ||
    count > 10 ||
    offset + size !== end
  )
    denied();
  const reports = new Map<string, unknown>();
  let cursor = offset,
    total = 0;
  for (let i = 0; i < count; i++) {
    if (cursor + 46 > end || zip.readUInt32LE(cursor) !== 0x02014b50) denied();
    const flags = zip.readUInt16LE(cursor + 8),
      method = zip.readUInt16LE(cursor + 10),
      crc = zip.readUInt32LE(cursor + 16),
      compressed = zip.readUInt32LE(cursor + 20),
      uncompressed = zip.readUInt32LE(cursor + 24);
    const length = zip.readUInt16LE(cursor + 28),
      extra = zip.readUInt16LE(cursor + 30),
      comment = zip.readUInt16LE(cursor + 32),
      local = zip.readUInt32LE(cursor + 42);
    if (
      (flags & ~0x808) !== 0 ||
      ![0, 8].includes(method) ||
      zip.readUInt16LE(cursor + 34) !== 0 ||
      cursor + 46 + length + extra + comment > end ||
      local + 30 > offset ||
      zip.readUInt32LE(local) !== 0x04034b50
    )
      denied();
    const name = zip.subarray(cursor + 46, cursor + 46 + length).toString('utf8');
    if (
      !expected.includes(name) ||
      reports.has(name) ||
      zip.readUInt16LE(local + 6) !== flags ||
      zip.readUInt16LE(local + 8) !== method ||
      zip.readUInt16LE(local + 26) !== length ||
      zip.subarray(local + 30, local + 30 + length).toString('utf8') !== name
    )
      denied();
    const start = local + 30 + length + zip.readUInt16LE(local + 28);
    total += uncompressed;
    if (
      start + compressed > offset ||
      uncompressed < 1 ||
      uncompressed > 4194304 ||
      total > 8388608
    )
      denied();
    const body =
      method === 0
        ? zip.subarray(start, start + compressed)
        : inflateRawSync(zip.subarray(start, start + compressed), { maxOutputLength: 4194304 });
    if (body.length !== uncompressed || crc32(body) !== crc) denied();
    try {
      reports.set(name, JSON.parse(body.toString('utf8')) as unknown);
    } catch {
      denied();
    }
    cursor += 46 + length + extra + comment;
  }
  if (cursor !== end || expected.some((n) => !reports.has(n))) denied();
  return reports;
}
