import { describe, it, expect } from 'vitest';
import { summarizeIdentity } from '../group-identity.js';

/**
 * 身份摘要要能被拿去核对：实例 ID 必须给完整 UUID。
 * 截成前 8 位会让「两个不同实例」看起来像同一个。
 */
describe('summarizeIdentity', () => {
  const instanceId = 'c5b50d9d-0174-4599-ba20-239d32375de2';

  it('实例 ID 输出完整 UUID', () => {
    const text = summarizeIdentity({ kind: 'data', id: 'remote-storage', instanceId });
    expect(text).toContain(instanceId);
    expect(text).toContain('kind=data');
    expect(text).toContain('id=remote-storage');
    expect(text.endsWith('…')).toBe(false);
  });

  it('多个不同实例 ID 的摘要彼此可区分', () => {
    const a = summarizeIdentity({ kind: 'data', id: 'remote-storage', instanceId });
    const b = summarizeIdentity({ kind: 'data', id: 'remote-storage', instanceId: 'd25103f3-cdd4-401c-8bba-aaf3aaa99318' });
    expect(a).not.toBe(b);
  });

  it('没有描述符 / 没有实例 ID 时如实说明', () => {
    expect(summarizeIdentity(null)).toBe('（无描述符）');
    expect(summarizeIdentity({ kind: 'config', id: 'config' })).toContain('实例 ID=（无）');
  });
});
