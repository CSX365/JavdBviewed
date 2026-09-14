/**
 * Emby 源删除永久墓碑（tombstone parity：与桌面端 ④、Cloud 1.2.3 服务端同契约）。
 *
 * 契约：
 * - `settings.emby.deletedServerIds: string[]` 为永久墓碑；云端对 settings value
 *   按 union 合并（base ∪ incoming），旧设备省略该字段也不会丢墓碑；
 * - 保存侧：diff prev/next mediaServers，把消失的 server id 记入墓碑；
 *   剪掉当前仍存活的 id（同 id 重加视为复活，墓碑解除）；
 * - 导入侧：按 local∪remote 墓碑过滤 incoming mediaServers，防止已删源复活，
 *   union 墓碑保留在本地 blob；
 * - 扩展重加源总是生成新 id（createMediaServerId），已删源的 id 永不复用。
 */

type AnyRecord = Record<string, unknown>;

function asRecord(value: unknown): AnyRecord | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  return value as AnyRecord;
}

/** 归一化 server id：任意类型转 string + trim，空值返回 ''。 */
function normalizedServerId(server: unknown): string {
  const record = asRecord(server);
  if (!record) return '';
  return String(record.id ?? '').trim();
}

/** 合并若干 id 数组：trim + 去空 + 去重（保序）。非数组候选跳过。 */
export function unionServerIds(...lists: unknown[]): string[] {
  const seen = new Set<string>();
  const merged: string[] = [];
  for (const list of lists) {
    if (!Array.isArray(list)) continue;
    for (const item of list) {
      const id = String(item ?? '').trim();
      if (!id || seen.has(id)) continue;
      seen.add(id);
      merged.push(id);
    }
  }
  return merged;
}

/** 读 emby 对象上的 deletedServerIds（畸形输入一律返回空数组）。 */
export function readEmbyDeletedServerIds(emby: unknown): string[] {
  const record = asRecord(emby);
  if (!record) return [];
  return unionServerIds(record.deletedServerIds);
}

/** 读 emby 对象上 mediaServers 的 id 列表（无 id 条目跳过）。 */
function readEmbyServerIds(emby: unknown): string[] {
  const record = asRecord(emby);
  if (!record) return [];
  const servers = record.mediaServers;
  if (!Array.isArray(servers)) return [];
  const seen = new Set<string>();
  const ids: string[] = [];
  for (const server of servers) {
    const id = normalizedServerId(server);
    if (!id || seen.has(id)) continue;
    seen.add(id);
    ids.push(id);
  }
  return ids;
}

/**
 * 保存侧：diff prev/next mediaServers，把消失的 server id 记为永久墓碑。
 *
 * - tombstones = (prev.deletedServerIds ∪ prev.mediaServers ids) \ next 存活 ids；
 * - 原地更新 nextSettings（非空写 `deletedServerIds`，空则删键）；
 * - next 无 emby 对象时创建并承载墓碑（prev 有 tombstone/源记录才有必要）；
 * - prev 无 emby（或无源记录、无墓碑）时为 no-op。
 *
 * @returns 同一个 nextSettings 对象
 */
export function applyEmbyDeletedServerTombstones(
  prevSettings: unknown,
  nextSettings: AnyRecord,
): AnyRecord {
  const prevEmby = asRecord(asRecord(prevSettings)?.emby);
  if (!prevEmby) return nextSettings;

  const prevTombstones = readEmbyDeletedServerIds(prevEmby);
  const prevServerIds = readEmbyServerIds(prevEmby);
  if (prevTombstones.length === 0 && prevServerIds.length === 0) return nextSettings;

  const nextEmby = asRecord(nextSettings.emby) ?? {};
  nextSettings.emby = nextEmby;

  const liveIds = new Set(readEmbyServerIds(nextEmby));
  const tombstones = unionServerIds(prevTombstones, prevServerIds).filter(
    (id) => !liveIds.has(id),
  );
  if (tombstones.length > 0) {
    nextEmby.deletedServerIds = tombstones;
  } else {
    delete nextEmby.deletedServerIds;
  }
  return nextSettings;
}

/**
 * 导入侧：按 local∪remote 墓碑过滤 incoming（remote）mediaServers，防已删源复活。
 *
 * - remote 整体或 emby 非对象时原样返回（维持既有整替语义）；
 * - 结果 emby 携带 union 墓碑（非空才写键），保证本地 blob 不丢墓碑；
 * - 无 id 的 server 条目保留（不参与墓碑匹配）；
 * - 纯函数：不改 local/remote 输入，返回新对象。
 */
export function filterEmbyImportedMediaServers(
  localSettings: unknown,
  remoteSettings: unknown,
): unknown {
  const remoteRoot = asRecord(remoteSettings);
  if (!remoteRoot) return remoteSettings;
  const remoteEmby = asRecord(remoteRoot.emby);
  if (!remoteEmby) return remoteSettings;

  const localEmby = asRecord(asRecord(localSettings)?.emby);
  const tombstones = unionServerIds(
    readEmbyDeletedServerIds(localEmby),
    readEmbyDeletedServerIds(remoteEmby),
  );

  const servers = remoteEmby.mediaServers;
  const filteredServers = Array.isArray(servers)
    ? servers.filter((server) => {
        const id = normalizedServerId(server);
        return !id || !tombstones.includes(id);
      })
    : servers;

  const nextEmby: AnyRecord = { ...remoteEmby };
  nextEmby.mediaServers = filteredServers;
  if (tombstones.length > 0) {
    nextEmby.deletedServerIds = tombstones;
  } else {
    delete nextEmby.deletedServerIds;
  }
  return { ...remoteRoot, emby: nextEmby };
}
