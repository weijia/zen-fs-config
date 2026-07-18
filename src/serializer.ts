/**
 * zen-fs-config — Config Serializers
 *
 * Handles serialization/deserialization between JS values and file bytes.
 * The default serializer handles .json, .txt, and unknown extensions.
 * Users can provide a custom ConfigSerializer via ConfigRepoOptions.
 */

import type { ConfigSerializer } from './types';

// ---------------------------------------------------------------------------
// Default JSON Serializer
// ---------------------------------------------------------------------------

const JSON_SERIALIZER: ConfigSerializer = {
  serialize(data: unknown): Uint8Array {
    return new TextEncoder().encode(JSON.stringify(data, null, 2));
  },
  deserialize(raw: Uint8Array): unknown {
    return JSON.parse(new TextDecoder().decode(raw));
  },
  canHandle(path: string): boolean {
    return path.endsWith('.json');
  },
};

// ---------------------------------------------------------------------------
// Plain Text Serializer
// ---------------------------------------------------------------------------

const TEXT_SERIALIZER: ConfigSerializer = {
  serialize(data: unknown): Uint8Array {
    return new TextEncoder().encode(String(data));
  },
  deserialize(raw: Uint8Array): unknown {
    return new TextDecoder().decode(raw);
  },
  canHandle(path: string): boolean {
    const ext = getExtension(path);
    return ext === '' || ext === '.txt' || ext === '.md' || ext === '.log';
  },
};

// ---------------------------------------------------------------------------
// Serializer Chain
// ---------------------------------------------------------------------------

const DEFAULT_SERIALIZERS: ConfigSerializer[] = [JSON_SERIALIZER, TEXT_SERIALIZER];

/**
 * Extended serializer that also accepts an optional path hint for routing.
 * The core ConfigSerializer interface only takes `data`, but internally
 * we use the path to pick the right serializer.
 */
interface PathAwareSerializer extends ConfigSerializer {
  serialize(data: unknown, path?: string): Uint8Array;
  deserialize(raw: Uint8Array, path?: string): unknown;
}

/**
 * Create a serializer chain from a user-provided serializer + defaults.
 * The first serializer whose `canHandle()` returns true wins.
 */
export function createSerializerChain(custom?: ConfigSerializer): PathAwareSerializer {
  const chain = custom ? [custom, ...DEFAULT_SERIALIZERS] : [...DEFAULT_SERIALIZERS];

  return {
    serialize(data: unknown, path?: string): Uint8Array {
      if (path) {
        for (const s of chain) {
          if (s.canHandle(path)) return s.serialize(data);
        }
      }
      return JSON_SERIALIZER.serialize(data);
    },
    deserialize(raw: Uint8Array, path?: string): unknown {
      if (path) {
        for (const s of chain) {
          if (s.canHandle(path)) return s.deserialize(raw, path);
        }
      }
      return JSON_SERIALIZER.deserialize(raw, path ?? '');
    },
    canHandle(path: string): boolean {
      return chain.some((s) => s.canHandle(path));
    },
  };
}

/** Re-export PathAwareSerializer type for internal use. */
export type { PathAwareSerializer };

// ---------------------------------------------------------------------------
// Path → File Path Mapping
// ---------------------------------------------------------------------------

/**
 * Map a config key to a file path.
 *
 * - `/db/host` → `/db/host.json` (append .json if no extension)
 * - `/readme.md` → `/readme.md` (preserve existing extension)
 */
export function configKeyToFilePath(configPath: string): string {
  const ext = getExtension(configPath);
  if (ext !== '') return configPath;
  return configPath.endsWith('/') ? configPath : `${configPath}.json`;
}

/**
 * Extract the file extension (including the dot), or empty string.
 */
export function getExtension(path: string): string {
  const lastSlash = path.lastIndexOf('/');
  const lastDot = path.lastIndexOf('.');
  if (lastDot > lastSlash && lastDot < path.length - 1) {
    return path.slice(lastDot);
  }
  return '';
}