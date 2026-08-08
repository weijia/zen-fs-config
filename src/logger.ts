/**
 * zen-fs-config — Logger (powered by @richard432/localstorage-logger)
 *
 * 每个模块对应一个 localStorage key `debug:zen-fs-config:<prefix>`。
 * key 不存在时自动创建并设为 '1'（默认开启）。
 * 在浏览器控制台中控制：
 *   localStorage.setItem('debug:zen-fs-config:config-repo', '0')  // 关闭
 *   localStorage.setItem('debug:zen-fs-config:config-repo', '1')  // 开启
 */

import { createLogger as createLoggerBase } from '@richard432/localstorage-logger';

const MODULE_PREFIX = 'zen-fs-config';

/**
 * Create a prefixed logger.
 * Returns a single-argument function (backward compatible with existing callers).
 */
export function createLogger(prefix: string): (...args: unknown[]) => void {
  const logger = createLoggerBase(`${MODULE_PREFIX}:${prefix}`);
  return (...args: unknown[]) => logger.log(...args);
}
