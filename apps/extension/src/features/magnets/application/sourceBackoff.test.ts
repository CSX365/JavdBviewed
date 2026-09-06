import { describe, expect, it } from 'vitest';

import {
  MAGNET_SOURCE_BACKOFF_MS,
  describeMagnetSourceBackoff,
  filterMagnetSourcesByBackoff,
  recordMagnetSourceFailure,
  recordMagnetSourceSuccess,
  shouldSkipMagnetSource,
  type MagnetSourceBackoffState,
} from './sourceBackoff';

const NOW = 1_750_000_000_000;

describe('sourceBackoff', () => {
  it('records failures with a 15 minute retry window and normalized errors', () => {
    const state: MagnetSourceBackoffState = {};
    const entry = recordMagnetSourceFailure(state, 'sukebei', new Error('boom'), NOW);
    expect(entry).toEqual({ failedAt: NOW, retryAt: NOW + MAGNET_SOURCE_BACKOFF_MS, error: 'boom' });
    expect(shouldSkipMagnetSource(state, 'sukebei', NOW + 1)).toBe(true);
    expect(shouldSkipMagnetSource(state, 'sukebei', NOW + MAGNET_SOURCE_BACKOFF_MS)).toBe(false);
    expect(shouldSkipMagnetSource(state, 'btdig', NOW)).toBe(false);
  });

  it('records string errors as-is and drops undefined errors', () => {
    const state: MagnetSourceBackoffState = {};
    expect(recordMagnetSourceFailure(state, 'btdig', 'network down', NOW).error).toBe('network down');
    expect(recordMagnetSourceFailure(state, 'btsow', undefined, NOW).error).toBeUndefined();
  });

  it('clears the entry on success', () => {
    const state: MagnetSourceBackoffState = {};
    recordMagnetSourceFailure(state, 'sukebei', 'boom', NOW);
    recordMagnetSourceSuccess(state, 'sukebei');
    expect(state).toEqual({});
  });

  it('filters runnable sources while manual runs bypass backoff', () => {
    const state: MagnetSourceBackoffState = {};
    recordMagnetSourceFailure(state, 'sukebei', 'boom', NOW);

    const sources = [{ key: 'sukebei' as const }, { key: 'btdig' as const }];
    const filtered = filterMagnetSourcesByBackoff(sources, state, { now: NOW });
    expect(filtered.runnable).toEqual([{ key: 'btdig' }]);
    expect(filtered.skipped).toHaveLength(1);
    expect(filtered.skipped[0].source).toEqual({ key: 'sukebei' });

    const manual = filterMagnetSourcesByBackoff(sources, state, { manual: true });
    expect(manual.runnable).toEqual(sources);
    expect(manual.skipped).toEqual([]);
  });

  it('describes remaining backoff in whole minutes with a one minute floor', () => {
    const state: MagnetSourceBackoffState = {};
    const entry = recordMagnetSourceFailure(state, 'sukebei', 'boom', NOW);
    expect(describeMagnetSourceBackoff(entry, NOW)).toBe('来源暂时退避，约 15 分钟后重试');
    expect(describeMagnetSourceBackoff(entry, entry.retryAt)).toBe('来源暂时退避，约 1 分钟后重试');
  });
});
