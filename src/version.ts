/**
 * zen-fs-config — Sidecar Version File Management
 *
 * Each config file has a companion .version file for version-based change
 * detection and conflict resolution.
 *
 * Config file:  /app-a/db.json
 * Version file: /app-a/.db.json.version
 */

import type { VersionMeta } from './types';
import type { SyncableFS } from 'zen-fs-sync';

// ---------------------------------------------------------------------------
// Version File Path
// ---------------------------------------------------------------------------

/**
 * Compute the sidecar version file path from a config file path.
 *
 * /app-a/db.json        → /app-a/.db.json.version
 * /shared/flags.json    → /shared/.flags.json.version
 * /nodes/s1/env.json    → /nodes/s1/.env.json.version
 *
 * Returns null for files that are already version sidecars (.version files),
 * to prevent creating version-of-version files (e.g. ..db.json.version.version).
 */
export function versionPathFor(configFilePath: string): string | null {
  const lastSlash = configFilePath.lastIndexOf('/');
  const dir = lastSlash >= 0 ? configFilePath.slice(0, lastSlash) : '';
  const fileName = lastSlash >= 0 ? configFilePath.slice(lastSlash + 1) : configFilePath;

  // Don't create version files for version files
  if (fileName.endsWith('.version')) {
    return null;
  }

  // Avoid double dot: if fileName already starts with '.', don't add another
  const versionFileName = fileName.startsWith('.') ? `${fileName}.version` : `.${fileName}.version`;
  return dir ? `${dir}/${versionFileName}` : versionFileName;
}

// ---------------------------------------------------------------------------
// Hash Computation
// ---------------------------------------------------------------------------

/**
 * Pure-JS SHA-256 fallback (no dependencies, works in non-secure contexts).
 * Used when crypto.subtle (Web Crypto) and Node.js crypto are both unavailable.
 * Returns the 32-byte digest as a Uint8Array.
 */
function sha256PureJS(data: Uint8Array): Uint8Array {
  const K = new Uint32Array([
    0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
    0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
    0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
    0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
    0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
    0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
    0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
    0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
  ]);

  const H = new Uint32Array([
    0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a,
    0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19,
  ]);

  const len = data.length;
  const bitLen = len * 8;
  // Padding: append 0x80, then zeros, then 64-bit length
  const padLen = ((len + 8) >> 6 << 6) + 64;
  const buf = new Uint8Array(padLen);
  buf.set(data);
  buf[len] = 0x80;
  // 64-bit big-endian length (only low 32 bits for typical sizes)
  const dv = new DataView(buf.buffer);
  dv.setUint32(padLen - 4, bitLen >>> 0, false);
  dv.setUint32(padLen - 8, Math.floor(bitLen / 0x100000000) >>> 0, false);

  const W = new Uint32Array(64);
  for (let i = 0; i < padLen; i += 64) {
    for (let t = 0; t < 16; t++) {
      W[t] = dv.getUint32(i + t * 4, false);
    }
    for (let t = 16; t < 64; t++) {
      const s0 = ((W[t - 15] >>> 7) | (W[t - 15] << 25)) ^ ((W[t - 15] >>> 18) | (W[t - 15] << 14)) ^ (W[t - 15] >>> 3);
      const s1 = ((W[t - 2] >>> 17) | (W[t - 2] << 15)) ^ ((W[t - 2] >>> 19) | (W[t - 2] << 13)) ^ (W[t - 2] >>> 10);
      W[t] = (W[t - 16] + s0 + W[t - 7] + s1) >>> 0;
    }
    let a = H[0], b = H[1], c = H[2], d = H[3], e = H[4], f = H[5], g = H[6], h = H[7];
    for (let t = 0; t < 64; t++) {
      const S1 = ((e >>> 6) | (e << 26)) ^ ((e >>> 11) | (e << 21)) ^ ((e >>> 25) | (e << 7));
      const ch = (e & f) ^ (~e & g);
      const temp1 = (h + S1 + ch + K[t] + W[t]) >>> 0;
      const S0 = ((a >>> 2) | (a << 30)) ^ ((a >>> 13) | (a << 19)) ^ ((a >>> 22) | (a << 10));
      const maj = (a & b) ^ (a & c) ^ (b & c);
      const temp2 = (S0 + maj) >>> 0;
      h = g; g = f; f = e; e = (d + temp1) >>> 0;
      d = c; c = b; b = a; a = (temp1 + temp2) >>> 0;
    }
    H[0] = (H[0] + a) >>> 0; H[1] = (H[1] + b) >>> 0; H[2] = (H[2] + c) >>> 0; H[3] = (H[3] + d) >>> 0;
    H[4] = (H[4] + e) >>> 0; H[5] = (H[5] + f) >>> 0; H[6] = (H[6] + g) >>> 0; H[7] = (H[7] + h) >>> 0;
  }

  const out = new Uint8Array(32);
  const outDv = new DataView(out.buffer);
  for (let i = 0; i < 8; i++) outDv.setUint32(i * 4, H[i], false);
  return out;
}

/**
 * Compute SHA-256 hash of a Uint8Array.
 * Returns "sha256:" prefix + hex digest.
 *
 * Priority:
 *   1. Web Crypto (crypto.subtle) — secure contexts (HTTPS, localhost)
 *   2. Node.js crypto — server-side
 *   3. Pure-JS fallback — non-secure browser contexts (HTTP, some WebViews)
 */
export async function sha256(data: Uint8Array): Promise<string> {
  const buffer: ArrayBuffer = data.byteLength === data.buffer.byteLength
    ? (data.buffer as ArrayBuffer)
    : data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength) as ArrayBuffer;

  // 1. Web Crypto (preferred — native, fast, secure context)
  const webCrypto = (globalThis as any).crypto;
  if (webCrypto && typeof webCrypto.subtle?.digest === 'function') {
    const hashBuffer = await webCrypto.subtle.digest('SHA-256', buffer);
    const hashArray = Array.from(new Uint8Array(hashBuffer));
    const hex = hashArray.map((b) => b.toString(16).padStart(2, '0')).join('');
    return `sha256:${hex}`;
  }

  // 2. Node.js fallback — hidden from bundler static analysis via new Function()
  if (typeof (globalThis as any).window === 'undefined') {
    const nodeCrypto = await (new Function("return import('node:crypto')")());
    const hash = nodeCrypto.createHash('sha256').update(Buffer.from(buffer)).digest('hex');
    return `sha256:${hash}`;
  }

  // 3. Pure-JS fallback — works everywhere, including non-secure browser contexts
  const digest = sha256PureJS(data);
  const hex = Array.from(digest).map((b) => b.toString(16).padStart(2, '0')).join('');
  return `sha256:${hex}`;
}

// ---------------------------------------------------------------------------
// Version File Read / Write
// ---------------------------------------------------------------------------

/**
 * Read and parse a version file. Returns null if it doesn't exist or is invalid.
 */
export async function readVersion(
  fs: SyncableFS,
  versionFilePath: string,
): Promise<VersionMeta | null> {
  try {
    const content = await fs.readFile(versionFilePath, 'utf-8');
    const parsed = JSON.parse(content as string);
    if (typeof parsed.version === 'number' && typeof parsed.hash === 'string') {
      return parsed as VersionMeta;
    }
    return null;
  } catch {
    return null;
  }
}

/**
 * Write a version file.
 */
export async function writeVersion(
  fs: SyncableFS,
  versionFilePath: string,
  meta: VersionMeta,
): Promise<void> {
  const content = JSON.stringify(meta, null, 2);
  await fs.writeFile(versionFilePath, new TextEncoder().encode(content));
}

/**
 * Increment version for a config file write.
 */
export async function incrementVersion(
  fs: SyncableFS,
  configFilePath: string,
  newContent: Uint8Array,
  author: string,
): Promise<VersionMeta> {
  const vPath = versionPathFor(configFilePath);
  const prev = vPath ? await readVersion(fs, vPath) : null;
  const hash = await sha256(newContent);

  return {
    version: (prev?.version ?? 0) + 1,
    hash,
    author,
    timestamp: Date.now(),
  };
}

// ---------------------------------------------------------------------------
// Crash Recovery
// ---------------------------------------------------------------------------

/**
 * Verify that the version file's hash matches the actual file content.
 * If mismatch, auto-increment version and return updated meta.
 * If version file doesn't exist, return null.
 */
export async function verifyOrRepairVersion(
  fs: SyncableFS,
  configFilePath: string,
  author: string,
): Promise<VersionMeta | null> {
  const vPath = versionPathFor(configFilePath);
  if (!vPath) return null;
  const existing = await readVersion(fs, vPath);
  if (!existing) return null;

  try {
    // Use the Buffer overload (no encoding) to get raw bytes
    const content: any = await fs.readFile(configFilePath);
    let data: Uint8Array;
    if (typeof content === 'string') {
      data = new TextEncoder().encode(content);
    } else if (content instanceof Uint8Array) {
      data = content;
    } else if (typeof Buffer !== 'undefined' && Buffer.isBuffer(content)) {
      data = new Uint8Array(content.buffer, content.byteOffset, content.byteLength);
    } else {
      data = new Uint8Array(content);
    }
    const actualHash = await sha256(data);

    if (actualHash === existing.hash) {
      return existing;
    }

    // Hash mismatch — crash recovery: auto-increment
    const repaired: VersionMeta = {
      version: existing.version + 1,
      hash: actualHash,
      author,
      timestamp: Date.now(),
    };
    await writeVersion(fs, vPath, repaired);
    return repaired;
  } catch {
    return null;
  }
}