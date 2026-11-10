import { describe, it, expect, vi, beforeEach } from 'vitest';

/**
 * connect() 的创建护栏：
 * - 描述符存在但读取失败时，禁止 createAppDataGroup(id, []) 兜底；
 * - 读取描述符本身抛错时，禁止创建，也不触发任何写操作；
 * - 描述符确实为空时，connect() 也不创建（创建是用户显式动作）。
 */
const mocks = vi.hoisted(() => {
  const createAppDataGroup = vi.fn();
  const getAppDataGroup = vi.fn();
  const listAppDataGroups = vi.fn();
  return {
    createAppDataGroup,
    getAppDataGroup,
    listAppDataGroups,
    repo: {
      appId: 'guard-app',
      nodeId: 'guard-node',
      createAppDataGroup,
      getAppDataGroup,
      listAppDataGroups,
    },
  };
});

vi.mock('../config-repo', () => ({
  createConfigRepo: vi.fn(async () => mocks.repo),
}));

import { connect } from '../connect';

describe('connect() — 数据组创建护栏', () => {
  beforeEach(() => {
    mocks.createAppDataGroup.mockReset();
    mocks.getAppDataGroup.mockReset();
    mocks.listAppDataGroups.mockReset();
  });

  it('描述符存在但加载失败时，不得创建空组，也不得覆盖描述符', async () => {
    mocks.listAppDataGroups.mockResolvedValue([
      {
        id: 'default',
        groupType: 'data-sync',
        backends: [{ id: 'gitee-mvy0056x', type: 'Gitee', options: {} }],
      },
    ]);
    mocks.getAppDataGroup.mockRejectedValue(
      new Error('Failed to create local primary for data group "default"'),
    );

    const result = await connect('guard-app-1', { nodeId: 'guard-node' });

    expect(mocks.createAppDataGroup).not.toHaveBeenCalled();
    expect(result.dataGroup).toBeUndefined();
    expect(result.appDataGroups).toEqual([]);
    expect(result.repo).toBe(mocks.repo);
  });

  it('读取描述符抛错时，connect 直接失败，不创建也不写入', async () => {
    mocks.listAppDataGroups.mockRejectedValue(new Error('descriptor read failed'));

    await expect(connect('guard-app-2', { nodeId: 'guard-node' })).rejects.toThrow(
      /descriptor read failed/,
    );
    expect(mocks.createAppDataGroup).not.toHaveBeenCalled();
    expect(mocks.getAppDataGroup).not.toHaveBeenCalled();
  });

  it('描述符为空时，connect 也不创建空组（创建需用户显式动作）', async () => {
    mocks.listAppDataGroups.mockResolvedValue([]);

    const result = await connect('guard-app-3', { nodeId: 'guard-node' });

    expect(mocks.createAppDataGroup).not.toHaveBeenCalled();
    expect(result.dataGroup).toBeUndefined();
  });
});
