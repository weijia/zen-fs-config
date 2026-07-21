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
 */
export function versionPathFor(configFilePath: string): string {
  const lastSlash = configFilePath.lastIndexOf('/');
  const dir = lastSlash >= 0 ? configFilePath.slice(0, lastSlash) : '';
  const fileName = lastSlash >= 0 ? configFilePath.slice(lastSlash + 1) : configFilePath;
  const versionFileName = `.${fileName}.version`;
  return dir ? `${dir}/${versionFileName}` : versionFileName;
}

// ---------------------------------------------------------------------------
// Hash Computation
// ---------------------------------------------------------------------------

/**
 * Compute SHA-256 hash of a Uint8Array.
 * Returns "sha256:" prefix + hex digest.
 */
export async function sha256(data: Uint8Array): Promise<string> {
  const buffer: ArrayBuffer = data.byteLength === data.buffer.byteLength
    ? (data.buffer as ArrayBuffer)
    : data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength) as ArrayBuffer;

  if (typeof crypto !== 'undefined' && typeof crypto.subtle?.digest === 'function') {
    const hashBuffer = await crypto.subtle.digest('SHA-256', buffer);
    const hashArray = Array.from(new Uint8Array(hashBuffer));
    const hex = hashArray.map((b) => b.toString(16).padStart(2, '0')).join('');
    return `sha256:${hex}`;
  }
  // Node.js fallback — hidden from bundler static analysis via new Function()
  if (typeof (globalThis as any).window === 'undefined') {
    const nodeCrypto = await (new Function("return import('node:crypto')")());
    const hash = nodeCrypto.createHash('sha256').update(Buffer.from(buffer)).digest('hex');
    return `sha256:${hash}`;
  }
  throw new Error('SHA-256 not available: neither Web Crypto nor Node.js crypto module found');
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
  const prev = await readVersion(fs, vPath);
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
    } else if (Buffer.isBuffer(content)) {
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