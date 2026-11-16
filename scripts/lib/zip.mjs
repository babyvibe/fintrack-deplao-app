/**
 * Create / read back ZIP files without external libraries, in the format Deplao can extract
 * (src/services/plugins/zip.ts): deflate or stored, UTF-8 flag, no ZIP64, no symlinks,
 * safe names (no "..", ":", Windows device names, trailing dot / space).
 */
import zlib from 'node:zlib';

/** = Deplao's DEFAULT_ZIP_LIMITS (src/services/plugins/zip.ts). */
export const LIMITS = { maxZipBytes: 50 * 1024 * 1024, maxTotalBytes: 200 * 1024 * 1024, maxEntries: 5000, maxEntryBytes: 100 * 1024 * 1024 };
/** Fixed DOS time / date (00:00 1980-01-01): reproducible packages, and unzip tools don't report a broken date. */
const DOS_TIME = 0;
const DOS_DATE = 0x21;

const SIG_LOC = 0x04034b50;
const SIG_CEN = 0x02014b50;
const SIG_EOCD = 0x06054b50;
const WINDOWS_RESERVED = /^(con|prn|aux|nul|com\d|lpt\d)(\..*)?$/i;

let table = null;
export function crc32(buf) {
  if (!table) {
    table = new Uint32Array(256);
    for (let n = 0; n < 256; n++) {
      let c = n;
      for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      table[n] = c >>> 0;
    }
  }
  let crc = 0xffffffff;
  for (let i = 0; i < buf.length; i++) crc = table[(crc ^ buf[i]) & 0xff] ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

/** Throw if Deplao could not extract an entry with this name. */
export function assertSafeName(name) {
  if (!name || name.includes('\0') || name.includes('\\')) throw new Error(`Invalid file name: ${name}`);
  if (name.startsWith('/') || /^[a-zA-Z]:/.test(name)) throw new Error(`Absolute path: ${name}`);
  for (const seg of name.replace(/\/$/, '').split('/')) {
    if (!seg || seg === '.' || seg === '..') throw new Error(`Invalid path: ${name}`);
    if (seg.includes(':')) throw new Error(`":" in name: ${name}`);
    if (WINDOWS_RESERVED.test(seg) || /[. ]$/.test(seg)) throw new Error(`Name not allowed on Windows: ${name}`);
  }
}

/** files: [{ name: 'a/b.js', data: Buffer }] → zip Buffer. */
export function createZip(files) {
  if (files.length > LIMITS.maxEntries) throw new Error(`Too many files (${files.length} > ${LIMITS.maxEntries})`);
  const seen = new Set();
  const locals = [];
  const centrals = [];
  let offset = 0;
  let total = 0;
  for (const f of files) {
    assertSafeName(f.name);
    const key = f.name.toLowerCase();
    if (seen.has(key)) throw new Error(`Duplicate name (case-insensitive): ${f.name}`);
    seen.add(key);
    const name = Buffer.from(f.name, 'utf8');
    const raw = Buffer.isBuffer(f.data) ? f.data : Buffer.from(String(f.data), 'utf8');
    if (raw.length > LIMITS.maxEntryBytes) throw new Error(`File over ${LIMITS.maxEntryBytes / 1048576} MB: ${f.name}`);
    total += raw.length;
    if (total > LIMITS.maxTotalBytes) throw new Error(`Extracted size over ${LIMITS.maxTotalBytes / 1048576} MB`);
    const deflated = zlib.deflateRawSync(raw, { level: 9 });
    const useDeflate = deflated.length < raw.length;
    const body = useDeflate ? deflated : raw;
    const crc = crc32(raw);

    const local = Buffer.alloc(30);
    local.writeUInt32LE(SIG_LOC, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(0x800, 6);
    local.writeUInt16LE(useDeflate ? 8 : 0, 8);
    local.writeUInt16LE(DOS_TIME, 10);
    local.writeUInt16LE(DOS_DATE, 12);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(body.length, 18);
    local.writeUInt32LE(raw.length, 22);
    local.writeUInt16LE(name.length, 26);
    local.writeUInt16LE(0, 28);
    locals.push(local, name, body);

    const central = Buffer.alloc(46);
    central.writeUInt32LE(SIG_CEN, 0);
    central.writeUInt16LE(20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(0x800, 8);
    central.writeUInt16LE(useDeflate ? 8 : 0, 10);
    central.writeUInt16LE(DOS_TIME, 12);
    central.writeUInt16LE(DOS_DATE, 14);
    central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(body.length, 20);
    central.writeUInt32LE(raw.length, 24);
    central.writeUInt16LE(name.length, 28);
    central.writeUInt32LE(offset, 42);
    centrals.push(central, name);
    offset += local.length + name.length + body.length;
  }
  const cd = Buffer.concat(centrals);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(SIG_EOCD, 0);
  eocd.writeUInt16LE(files.length, 8);
  eocd.writeUInt16LE(files.length, 10);
  eocd.writeUInt32LE(cd.length, 12);
  eocd.writeUInt32LE(offset, 16);
  const out = Buffer.concat([...locals, cd, eocd]);
  if (out.length > LIMITS.maxZipBytes) throw new Error(`Zip package is ${Math.round(out.length / 1048576)} MB, over Deplao's 50 MB limit`);
  return out;
}

/** Read back the whole zip (checks CRC and sizes) → [{ name, data }]. */
export function readZip(buf) {
  let eocd = -1;
  for (let i = buf.length - 22; i >= Math.max(0, buf.length - 65557); i--) {
    if (buf.readUInt32LE(i) === SIG_EOCD) { eocd = i; break; }
  }
  if (eocd < 0) throw new Error('Not a zip file');
  const total = buf.readUInt16LE(eocd + 10);
  let p = buf.readUInt32LE(eocd + 16);
  const out = [];
  for (let i = 0; i < total; i++) {
    if (buf.readUInt32LE(p) !== SIG_CEN) throw new Error('Corrupt central directory');
    const method = buf.readUInt16LE(p + 10);
    const crc = buf.readUInt32LE(p + 16);
    const csize = buf.readUInt32LE(p + 20);
    const size = buf.readUInt32LE(p + 24);
    const nameLen = buf.readUInt16LE(p + 28);
    const extraLen = buf.readUInt16LE(p + 30);
    const commentLen = buf.readUInt16LE(p + 32);
    const off = buf.readUInt32LE(p + 42);
    const name = buf.subarray(p + 46, p + 46 + nameLen).toString('utf8');
    p += 46 + nameLen + extraLen + commentLen;
    if (buf.readUInt32LE(off) !== SIG_LOC) throw new Error(`Corrupt local header: ${name}`);
    const start = off + 30 + buf.readUInt16LE(off + 26) + buf.readUInt16LE(off + 28);
    const data = buf.subarray(start, start + csize);
    const raw = method === 8 ? zlib.inflateRawSync(data, { maxOutputLength: Math.max(1, size) }) : Buffer.from(data);
    if (raw.length !== size || crc32(raw) !== crc) throw new Error(`CRC / size mismatch: ${name}`);
    out.push({ name, data: raw });
  }
  return out;
}
