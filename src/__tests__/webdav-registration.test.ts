import { describe, it, expect } from 'vitest';
import {
  hasBackend,
  listBackends,
  getBackendMetadata,
  createBackend,
} from '../backend-registry';

/**
 * WebDAV 核心预注册（FR6）
 *
 * `zen-fs-webdav` 是可选 peer 依赖：未安装时 `type: 'WebDAV'` 依然应当被
 * 注册（开箱即用），只有在真正 `createBackend()` 时才给出清晰的安装提示。
 */
describe('WebDAV core pre-registration', () => {
  it('FR6.1: WebDAV is registered out of the box', () => {
    expect(hasBackend('WebDAV')).toBe(true);
    expect(listBackends()).toContain('WebDAV');
  });

  it('FR6.3: WebDAV metadata is available for dynamic UI forms', () => {
    const meta = getBackendMetadata('WebDAV');
    expect(meta).toBeDefined();
    expect(meta?.type).toBe('WebDAV');
    const keys = (meta?.fields ?? []).map(f => f.key);
    expect(keys).toContain('baseUrl');
    expect(keys).toContain('username');
    expect(keys).toContain('password');
    expect(keys).toContain('token');
    // baseUrl 必填
    expect(meta?.fields.find(f => f.key === 'baseUrl')?.required).toBe(true);
    // 默认选项齐备，UI 表单可直接初始化
    expect(meta?.defaultOptions).toMatchObject({ baseUrl: '', username: '', password: '', token: '' });
  });

  it('FR6.3b: accountFields / identityFields are declared', () => {
    const meta = getBackendMetadata('WebDAV');
    expect(meta?.accountFields ?? []).toEqual(expect.arrayContaining(['username', 'password', 'token']));
    // identity = endpoint：同一 URL 视为同一副本
    expect(meta?.identityFields).toEqual(['baseUrl']);
  });

  it('FR6.4: missing zen-fs-webdav package yields a clear install hint', async () => {
    // 本测试环境下 zen-fs-webdav 未安装，createBackend 应当抛出可操作的错误信息
    await expect(
      createBackend({ type: 'WebDAV', options: { baseUrl: 'https://dav.example.com/' } }),
    ).rejects.toThrow(/zen-fs-webdav/);
  });

  it('FR6.4b: other backends remain unaffected', () => {
    expect(hasBackend('InMemory')).toBe(true);
    expect(hasBackend('IndexedDB')).toBe(true);
    expect(hasBackend('GitHub')).toBe(true);
    expect(hasBackend('Gitee')).toBe(true);
    expect(hasBackend('RemoteStorage')).toBe(true);
  });
});
