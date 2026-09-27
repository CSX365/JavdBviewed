/**
 * @file actorHiding.test.ts
 * @description 演员隐藏决策单测（09-26-display-settings-audit B1 止血 + B2 空库保护修复锁定）
 * @module features/listEnhancement/application
 */
import { describe, expect, it } from 'vitest';
import {
  decideActorHiding,
  type ActorHidingDecisionInput,
} from './actorHiding';
import type { ActorIndexRecord } from '../../../types';

const actor = (id: string, over: Partial<ActorIndexRecord> = {}): ActorIndexRecord => ({
  id,
  name: id,
  aliases: [],
  ...over,
});

const input = (over: Partial<ActorHidingDecisionInput> = {}): ActorHidingDecisionInput => ({
  hideByBlacklist: false,
  hideByNonFavorited: true,
  hideUnrecognized: false,
  domActorIds: new Set(),
  actors: [],
  actorIndexSize: 0,
  ...over,
});

describe('decideActorHiding B1 止血语义（未收藏 ≈ 匹配演员全部在黑名单）', () => {
  it('匹配演员全部在黑名单 → 按 ACTOR_NOT_FAVORITED 隐藏', () => {
    const d = decideActorHiding(input({
      actors: [actor('a1', { blacklisted: true }), actor('a2', { blacklisted: true })],
      actorIndexSize: 10,
    }));
    expect(d.reason).toBe('ACTOR_NOT_FAVORITED');
    expect(d.matchedNonFavorited).toBe(true);
  });

  it('存在任一非黑名单匹配演员 → 不隐藏（数据模型无收藏字段，非黑名单≈视为收藏）', () => {
    const d = decideActorHiding(input({
      actors: [actor('a1', { blacklisted: true }), actor('a2')],
      actorIndexSize: 10,
    }));
    expect(d.reason).toBeNull();
    expect(d.matchedNonFavorited).toBe(false);
  });

  it('DOM 有演员链接但本地无记录 → 按 ACTOR_NOT_FAVORITED 隐藏', () => {
    const d = decideActorHiding(input({ domActorIds: new Set(['a-x']) }));
    expect(d.reason).toBe('ACTOR_NOT_FAVORITED');
  });

  it('黑名单开关优先：全黑名单 + hideByBlacklist 开 → reason 取 ACTOR_BLACKLIST', () => {
    const d = decideActorHiding(input({
      hideByBlacklist: true,
      actors: [actor('a1', { blacklisted: true })],
      actorIndexSize: 10,
    }));
    expect(d.reason).toBe('ACTOR_BLACKLIST');
    expect(d.matchedBlack).toBe(true);
  });

  it('关闭 nonFavorited 开关时不参与该路径决策', () => {
    const d = decideActorHiding(input({
      hideByNonFavorited: false,
      actors: [actor('a1', { blacklisted: true })],
      actorIndexSize: 10,
    }));
    expect(d.reason).toBeNull();
    expect(d.hasAnyFavoritedActor).toBeNull();
  });
});

describe('decideActorHiding B2 空演员库保护（修复前 case3 绕过保护泄漏）', () => {
  it('空演员库 + 无任何演员信息 + nonFavorited 开 → 不隐藏（修复前会误判 ACTOR_NOT_FAVORITED）', () => {
    const d = decideActorHiding(input({
      hideUnrecognized: true,
      actorIndexSize: 0,
    }));
    expect(d.reason).toBeNull();
    expect(d.matchedNonFavorited).toBe(false);
  });

  it('非空库 + 无任何演员信息 + nonFavorited 开 + unrecognized 开 → 按 ACTOR_NOT_FAVORITED 隐藏', () => {
    const d = decideActorHiding(input({
      hideUnrecognized: true,
      actorIndexSize: 3,
    }));
    expect(d.reason).toBe('ACTOR_NOT_FAVORITED');
  });

  it('非空库 + 无任何演员信息 + nonFavorited 开 + unrecognized 关 → 不隐藏（「无匹配」不等于「全在黑名单」）', () => {
    const d = decideActorHiding(input({
      actorIndexSize: 3,
    }));
    expect(d.reason).toBeNull();
  });
});
