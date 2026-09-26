/**
 * @file viewedPatchListIdsCloudQueue.test.ts
 * @description viewedPatchListIds / viewedBulkPatchListIds 云同步待发队列入队口径
 * 09-27-local-lists-backup-scope 批 1：成员关系变化必须入队，no-op 与回写路径不入队
 */
import { afterEach, describe, expect, it, vi } from 'vitest';

type VideoLike = { id: string; title: string; status: string; listIds?: string[]; createdAt: number; updatedAt: number };

function setupMockDb(existing: VideoLike[]) {
  const storeMap = new Map(existing.map((r) => [r.id, r]));
  const viewedStore = {
    get: vi.fn(async (id: string) => storeMap.get(id)),
    put: vi.fn(async (rec: VideoLike) => { storeMap.set(rec.id, rec); }),
  };
  const tagStore = { delete: vi.fn(async () => undefined), put: vi.fn(async () => undefined) };
  const listStore = { delete: vi.fn(async () => undefined), put: vi.fn(async () => undefined) };
  const tx = {
    objectStore: vi.fn((name: string) => {
      if (name === 'viewedRecords') return viewedStore;
      if (name === 'viewedByTag') return tagStore;
      return listStore;
    }),
    done: Promise.resolve(),
  };
  return { tx, viewedStore };
}

function mockCloud(fns: {
  enqueueVideoChange: ReturnType<typeof vi.fn>;
  enqueueVideoChanges: ReturnType<typeof vi.fn>;
  scheduleEnqueue: ReturnType<typeof vi.fn>;
}) {
  vi.doMock('../../apps/extension/src/features/cloudSync/enqueueLocalChange', () => ({
    ...fns,
  }));
}

function mockDb(tx: unknown) {
  vi.doMock('../../apps/extension/src/platform/storage/indexedDbConnection', () => ({
    initDB: vi.fn(async () => ({
      transaction: vi.fn(() => tx),
      getAllKeys: vi.fn(async () => []),
    })),
  }));
}

async function loadModule() {
  const mod = await import('../../apps/extension/src/platform/storage/indexedDb');
  return mod as unknown as {
    viewedPatchListIds: (videoId: string, listId: string, action: 'add' | 'remove', options?: { skipCloudEnqueue?: boolean }) => Promise<{ changed: boolean; record?: VideoLike }>;
    viewedBulkPatchListIds: (videoIds: string[] | 'all', listId: string, action: 'add' | 'remove', options?: { skipCloudEnqueue?: boolean }) => Promise<{ successCount: number; failCount: number }>;
  };
}

describe('viewedPatchListIds cloud pending queue', () => {
  afterEach(() => {
    vi.resetModules();
    vi.doUnmock('../../apps/extension/src/platform/storage/indexedDbConnection');
    vi.doUnmock('../../apps/extension/src/features/cloudSync/enqueueLocalChange');
  });

  it('add 成员关系变化：入队一次，payload 含新 listIds', async () => {
    const { tx } = setupMockDb([{ id: 'V1', title: 'T', status: 'viewed', createdAt: 1, updatedAt: 2 }]);
    const enqueueVideoChange = vi.fn(async () => undefined);
    const enqueueVideoChanges = vi.fn(async () => undefined);
    const scheduleEnqueue = vi.fn((task: () => Promise<void>) => { void task().catch(() => undefined); });
    mockDb(tx);
    mockCloud({ enqueueVideoChange, enqueueVideoChanges, scheduleEnqueue });

    const { viewedPatchListIds } = await loadModule();
    const result = await viewedPatchListIds('V1', 'L1', 'add');

    expect(result.changed).toBe(true);
    expect(scheduleEnqueue).toHaveBeenCalledTimes(1);
    expect(enqueueVideoChange).toHaveBeenCalledTimes(1);
    expect(enqueueVideoChange).toHaveBeenCalledWith(expect.objectContaining({ id: 'V1', listIds: ['L1'] }));
  });

  it('幂等 no-op（add 已存在的 listId）：不入队', async () => {
    const { tx } = setupMockDb([{ id: 'V1', title: 'T', status: 'viewed', listIds: ['L1'], createdAt: 1, updatedAt: 2 }]);
    const enqueueVideoChange = vi.fn(async () => undefined);
    const enqueueVideoChanges = vi.fn(async () => undefined);
    const scheduleEnqueue = vi.fn((task: () => Promise<void>) => { void task().catch(() => undefined); });
    mockDb(tx);
    mockCloud({ enqueueVideoChange, enqueueVideoChanges, scheduleEnqueue });

    const { viewedPatchListIds } = await loadModule();
    const result = await viewedPatchListIds('V1', 'L1', 'add');

    expect(result.changed).toBe(false);
    expect(scheduleEnqueue).not.toHaveBeenCalled();
    expect(enqueueVideoChange).not.toHaveBeenCalled();
  });

  it('remove 不存在的 listId（no-op）：不入队', async () => {
    const { tx } = setupMockDb([{ id: 'V1', title: 'T', status: 'viewed', listIds: ['L2'], createdAt: 1, updatedAt: 2 }]);
    const enqueueVideoChange = vi.fn(async () => undefined);
    const enqueueVideoChanges = vi.fn(async () => undefined);
    const scheduleEnqueue = vi.fn((task: () => Promise<void>) => { void task().catch(() => undefined); });
    mockDb(tx);
    mockCloud({ enqueueVideoChange, enqueueVideoChanges, scheduleEnqueue });

    const { viewedPatchListIds } = await loadModule();
    const result = await viewedPatchListIds('V1', 'L1', 'remove');

    expect(result.changed).toBe(false);
    expect(scheduleEnqueue).not.toHaveBeenCalled();
    expect(enqueueVideoChange).not.toHaveBeenCalled();
  });

  it('remove 实际成员关系变化：入队一次，payload 为移除后 listIds', async () => {
    const { tx } = setupMockDb([{ id: 'V1', title: 'T', status: 'viewed', listIds: ['L1', 'L2'], createdAt: 1, updatedAt: 2 }]);
    const enqueueVideoChange = vi.fn(async () => undefined);
    const enqueueVideoChanges = vi.fn(async () => undefined);
    const scheduleEnqueue = vi.fn((task: () => Promise<void>) => { void task().catch(() => undefined); });
    mockDb(tx);
    mockCloud({ enqueueVideoChange, enqueueVideoChanges, scheduleEnqueue });

    const { viewedPatchListIds } = await loadModule();
    const result = await viewedPatchListIds('V1', 'L1', 'remove');

    expect(result.changed).toBe(true);
    expect(enqueueVideoChange).toHaveBeenCalledTimes(1);
    expect(enqueueVideoChange).toHaveBeenCalledWith(expect.objectContaining({ id: 'V1', listIds: ['L2'] }));
  });

  it('记录不存在：changed=false 且不入队', async () => {
    const { tx } = setupMockDb([]);
    const enqueueVideoChange = vi.fn(async () => undefined);
    const enqueueVideoChanges = vi.fn(async () => undefined);
    const scheduleEnqueue = vi.fn((task: () => Promise<void>) => { void task().catch(() => undefined); });
    mockDb(tx);
    mockCloud({ enqueueVideoChange, enqueueVideoChanges, scheduleEnqueue });

    const { viewedPatchListIds } = await loadModule();
    const result = await viewedPatchListIds('MISSING', 'L1', 'add');

    expect(result).toEqual({ changed: false });
    expect(scheduleEnqueue).not.toHaveBeenCalled();
  });

  it('skipCloudEnqueue（回写路径）：本地仍更新，不入队', async () => {
    const { tx } = setupMockDb([{ id: 'V1', title: 'T', status: 'viewed', createdAt: 1, updatedAt: 2 }]);
    const enqueueVideoChange = vi.fn(async () => undefined);
    const enqueueVideoChanges = vi.fn(async () => undefined);
    const scheduleEnqueue = vi.fn((task: () => Promise<void>) => { void task().catch(() => undefined); });
    mockDb(tx);
    mockCloud({ enqueueVideoChange, enqueueVideoChanges, scheduleEnqueue });

    const { viewedPatchListIds } = await loadModule();
    const result = await viewedPatchListIds('V1', 'L1', 'add', { skipCloudEnqueue: true });

    expect(result.changed).toBe(true);
    expect(scheduleEnqueue).not.toHaveBeenCalled();
    expect(enqueueVideoChange).not.toHaveBeenCalled();
  });
});

describe('viewedBulkPatchListIds cloud pending queue', () => {
  afterEach(() => {
    vi.resetModules();
    vi.doUnmock('../../apps/extension/src/platform/storage/indexedDbConnection');
    vi.doUnmock('../../apps/extension/src/features/cloudSync/enqueueLocalChange');
  });

  it('混合批量：仅变化记录合并为一次 enqueueVideoChanges，单条版不逐条入队', async () => {
    const { tx } = setupMockDb([
      { id: 'V1', title: 'A', status: 'viewed', createdAt: 1, updatedAt: 2 },
      { id: 'V2', title: 'B', status: 'viewed', listIds: ['L1'], createdAt: 1, updatedAt: 2 },
      { id: 'V3', title: 'C', status: 'viewed', createdAt: 1, updatedAt: 2 },
    ]);
    const enqueueVideoChange = vi.fn(async () => undefined);
    const enqueueVideoChanges = vi.fn(async () => undefined);
    const scheduleEnqueue = vi.fn((task: () => Promise<void>) => { void task().catch(() => undefined); });
    mockDb(tx);
    mockCloud({ enqueueVideoChange, enqueueVideoChanges, scheduleEnqueue });

    const { viewedBulkPatchListIds } = await loadModule();
    const result = await viewedBulkPatchListIds(['V1', 'V2', 'V3', 'MISSING'], 'L1', 'add');

    expect(result).toEqual({ successCount: 4, failCount: 0 });
    expect(enqueueVideoChange).not.toHaveBeenCalled();
    expect(scheduleEnqueue).toHaveBeenCalledTimes(1);
    expect(enqueueVideoChanges).toHaveBeenCalledTimes(1);
    const batch = enqueueVideoChanges.mock.calls[0][0] as VideoLike[];
    expect(batch.map((r) => r.id).sort()).toEqual(['V1', 'V3']);
    expect(batch).toEqual(
      expect.arrayContaining(batch.map((r) => expect.objectContaining({ listIds: ['L1'] }))),
    );
  });

  it('批量全 no-op：不入队', async () => {
    const { tx } = setupMockDb([
      { id: 'V1', title: 'A', status: 'viewed', listIds: ['L1'], createdAt: 1, updatedAt: 2 },
      { id: 'V2', title: 'B', status: 'viewed', listIds: ['L1'], createdAt: 1, updatedAt: 2 },
    ]);
    const enqueueVideoChange = vi.fn(async () => undefined);
    const enqueueVideoChanges = vi.fn(async () => undefined);
    const scheduleEnqueue = vi.fn((task: () => Promise<void>) => { void task().catch(() => undefined); });
    mockDb(tx);
    mockCloud({ enqueueVideoChange, enqueueVideoChanges, scheduleEnqueue });

    const { viewedBulkPatchListIds } = await loadModule();
    const result = await viewedBulkPatchListIds(['V1', 'V2'], 'L1', 'add');

    expect(result).toEqual({ successCount: 2, failCount: 0 });
    expect(scheduleEnqueue).not.toHaveBeenCalled();
  });

  it('批量 skipCloudEnqueue（回写路径）：不入队', async () => {
    const { tx } = setupMockDb([{ id: 'V1', title: 'A', status: 'viewed', createdAt: 1, updatedAt: 2 }]);
    const enqueueVideoChange = vi.fn(async () => undefined);
    const enqueueVideoChanges = vi.fn(async () => undefined);
    const scheduleEnqueue = vi.fn((task: () => Promise<void>) => { void task().catch(() => undefined); });
    mockDb(tx);
    mockCloud({ enqueueVideoChange, enqueueVideoChanges, scheduleEnqueue });

    const { viewedBulkPatchListIds } = await loadModule();
    const result = await viewedBulkPatchListIds(['V1'], 'L1', 'add', { skipCloudEnqueue: true });

    expect(result).toEqual({ successCount: 1, failCount: 0 });
    expect(scheduleEnqueue).not.toHaveBeenCalled();
  });
});
