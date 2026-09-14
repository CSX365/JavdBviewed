import { describe, expect, it } from 'vitest';
import {
  applyEmbyDeletedServerTombstones,
  filterEmbyImportedMediaServers,
  readEmbyDeletedServerIds,
  unionServerIds,
} from './embyDeletedServers';

const server = (id: string | null, name = `s-${id}`) =>
  id === null ? { name } : { id, name, url: `http://x/${id}`, enabled: true };

describe('unionServerIds', () => {
  it('trims, drops empty and dedupes while preserving order', () => {
    expect(unionServerIds([' a ', 'b', 'a', '', '  '])).toEqual(['a', 'b']);
    expect(unionServerIds(['a'], ['b', 'a'], null, 'nope', ['c'], undefined)).toEqual(['a', 'b', 'c']);
    expect(unionServerIds()).toEqual([]);
  });

  it('coerces non-string scalars via String() like the desktop reference', () => {
    expect(unionServerIds([1, '1', 2])).toEqual(['1', '2']);
  });
});

describe('readEmbyDeletedServerIds', () => {
  it('returns [] for malformed inputs', () => {
    expect(readEmbyDeletedServerIds(null)).toEqual([]);
    expect(readEmbyDeletedServerIds(undefined)).toEqual([]);
    expect(readEmbyDeletedServerIds('x')).toEqual([]);
    expect(readEmbyDeletedServerIds([])).toEqual([]);
    expect(readEmbyDeletedServerIds({})).toEqual([]);
    expect(readEmbyDeletedServerIds({ deletedServerIds: 'nope' })).toEqual([]);
  });

  it('filters non-strings and trims', () => {
    expect(readEmbyDeletedServerIds({ deletedServerIds: [' a', null, 7, '', 'b', 'a'] })).toEqual([
      'a',
      '7',
      'b',
    ]);
  });
});

describe('applyEmbyDeletedServerTombstones (save side)', () => {
  it('records ids that disappeared from mediaServers as tombstones', () => {
    const prev = { emby: { mediaServers: [server('a'), server('b'), server('c')] } };
    const next = { emby: { mediaServers: [server('b')] } };
    applyEmbyDeletedServerTombstones(prev, next);
    expect(next.emby.deletedServerIds).toEqual(['a', 'c']);
  });

  it('preserves previously tombstoned ids via union', () => {
    const prev = { emby: { mediaServers: [server('a')], deletedServerIds: ['z', 'q'] } };
    const next = { emby: { mediaServers: [] } };
    applyEmbyDeletedServerTombstones(prev, next);
    expect(next.emby.deletedServerIds).toEqual(['z', 'q', 'a']);
  });

  it('prunes tombstoned ids that are alive again (same id re-added)', () => {
    const prev = { emby: { mediaServers: [server('a')], deletedServerIds: ['a', 'gone'] } };
    const next = { emby: { mediaServers: [server('a')] } };
    applyEmbyDeletedServerTombstones(prev, next);
    expect(next.emby.deletedServerIds).toEqual(['gone']);
  });

  it('drops the tombstone key when everything is alive and no tombstones exist', () => {
    const prev = { emby: { mediaServers: [server('a')], deletedServerIds: ['a'] } };
    const next = { emby: { mediaServers: [server('a')], deletedServerIds: ['a'] } };
    applyEmbyDeletedServerTombstones(prev, next);
    expect('deletedServerIds' in (next.emby as object)).toBe(false);
  });

  it('is idempotent when the same object is saved twice', () => {
    const settings = { emby: { mediaServers: [server('a')], deletedServerIds: ['x'] } };
    applyEmbyDeletedServerTombstones(settings, settings);
    applyEmbyDeletedServerTombstones(settings, settings);
    expect(settings.emby.deletedServerIds).toEqual(['x']);
  });

  it('creates the emby object on next when missing but prev has records', () => {
    const prev = { emby: { mediaServers: [server('a')], deletedServerIds: ['z'] } };
    const next: Record<string, unknown> = { display: {} };
    applyEmbyDeletedServerTombstones(prev, next);
    expect(next.emby).toEqual({ deletedServerIds: ['z', 'a'] });
  });

  it('normalizes whitespace-only id differences (same id with padding stays alive)', () => {
    const prev = { emby: { mediaServers: [server('a')] } };
    const next = { emby: { mediaServers: [{ id: '  a ', name: 'a' }] } };
    applyEmbyDeletedServerTombstones(prev, next);
    expect('deletedServerIds' in (next.emby as object)).toBe(false);
  });

  it('no-ops when prev has no emby or emby has no records', () => {
    const next1: Record<string, unknown> = { emby: { mediaServers: [] } };
    expect(applyEmbyDeletedServerTombstones(null, next1)).toBe(next1);
    expect(applyEmbyDeletedServerTombstones({}, next1)).toBe(next1);

    const next2: Record<string, unknown> = { emby: { mediaServers: [server('b')] } };
    const prevEmpty = { emby: { mediaServers: [], deletedServerIds: [] } };
    applyEmbyDeletedServerTombstones(prevEmpty, next2);
    expect(next2.emby).toEqual({ mediaServers: [server('b')] });
  });

  it('tolerates malformed prev/next inputs without throwing', () => {
    const next: Record<string, unknown> = { emby: 'broken' };
    expect(() => applyEmbyDeletedServerTombstones('garbage', next)).not.toThrow();
    const next2: Record<string, unknown> = { emby: { mediaServers: 'nope' } };
    expect(() => applyEmbyDeletedServerTombstones({ emby: { mediaServers: null } }, next2)).not.toThrow();
  });
});

describe('filterEmbyImportedMediaServers (import side)', () => {
  it('returns remote as-is when remote (or its emby) is not an object', () => {
    const remoteNull: unknown = null;
    expect(filterEmbyImportedMediaServers({ emby: {} }, remoteNull)).toBe(remoteNull);
    const remoteNoEmbyRoot = { display: {} };
    expect(filterEmbyImportedMediaServers({}, remoteNoEmbyRoot)).toBe(remoteNoEmbyRoot);
    const remoteNoEmby = { emby: null, other: 1 };
    expect(filterEmbyImportedMediaServers({}, remoteNoEmby)).toBe(remoteNoEmby);
  });

  it('filters servers whose id is tombstoned locally (remote has no tombstone key)', () => {
    const local = { emby: { deletedServerIds: ['dead'] } };
    const remote = { emby: { mediaServers: [server('dead'), server('alive')] } };
    const result = filterEmbyImportedMediaServers(local, remote) as any;
    expect(result.emby.mediaServers.map((s: any) => s.id)).toEqual(['alive']);
    expect(result.emby.deletedServerIds).toEqual(['dead']);
  });

  it('filters servers tombstoned on remote and keeps the union', () => {
    const local = { emby: { deletedServerIds: ['local-dead'] } };
    const remote = {
      emby: { deletedServerIds: ['remote-dead'], mediaServers: [server('remote-dead'), server('local-dead'), server('ok')] },
    };
    const result = filterEmbyImportedMediaServers(local, remote) as any;
    expect(result.emby.mediaServers.map((s: any) => s.id)).toEqual(['ok']);
    expect(result.emby.deletedServerIds).toEqual(['local-dead', 'remote-dead']);
  });

  it('keeps servers without id (legacy anonymous entries)', () => {
    const local = { emby: { deletedServerIds: ['dead'] } };
    const remote = { emby: { mediaServers: [server(null), server('dead'), server('ok')] } };
    const result = filterEmbyImportedMediaServers(local, remote) as any;
    expect(result.emby.mediaServers).toHaveLength(2);
    expect(result.emby.mediaServers[0].id).toBeUndefined();
  });

  it('does not write the tombstone key when the union is empty', () => {
    const remote = { emby: { mediaServers: [server('a')] } };
    const result = filterEmbyImportedMediaServers({}, remote) as any;
    expect(result.emby.mediaServers.map((s: any) => s.id)).toEqual(['a']);
    expect('deletedServerIds' in result.emby).toBe(false);
  });

  it('preserves other remote settings and emby fields, and does not mutate inputs', () => {
    const local = { emby: { deletedServerIds: ['dead'] } };
    const remote = {
      display: { theme: 'dark' },
      emby: { recognitionEnabled: true, mediaServers: [server('dead'), server('ok')] },
    };
    const snapshot = JSON.stringify(remote);
    const result = filterEmbyImportedMediaServers(local, remote) as any;
    expect(result).not.toBe(remote);
    expect(result.display).toEqual({ theme: 'dark' });
    expect(result.emby.recognitionEnabled).toBe(true);
    expect(result.emby.mediaServers.map((s: any) => s.id)).toEqual(['ok']);
    expect(JSON.stringify(remote)).toBe(snapshot);
  });
});
