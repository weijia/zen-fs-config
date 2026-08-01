/**
 * zen-fs-config — Logger
 *
 * Simple prefixed logger factory. In production, logs are gated by
 * the ZEN_FS_CONFIG_DEBUG environment variable / localStorage flag.
 */

const isDebug = (() => {
  if (typeof process !== 'undefined' && process.env?.ZEN_FS_CONFIG_DEBUG) {
    return true;
  }
  if (typeof localStorage !== 'undefined') {
    try {
      return localStorage.getItem('ZEN_FS_CONFIG_DEBUG') === '1';
    } catch {
      return false;
    }
  }
  return false;
})();

/**
 * Create a prefixed logger.
 * When debug mode is off, log calls are no-ops to avoid console noise.
 */
export function createLogger(prefix: string): (...args: unknown[]) => void {
  if (!isDebug) {
    return () => {};
  }
  return (...args: unknown[]) => {
    console.log(`[${prefix}]`, ...args);
  };
}
