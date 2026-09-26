/**
 * @file actorHiding.ts
 * @description actorHiding
 * @module features/listEnhancement
 */
import type { ActorIndexRecord } from '../../../types';

export type ActorHidingReason = 'ACTOR_BLACKLIST' | 'ACTOR_NOT_FAVORITED' | 'ACTOR_UNRECOGNIZED';

export interface ActorHidingDecisionInput {
  hideByBlacklist: boolean;
  hideByNonFavorited: boolean;
  hideUnrecognized: boolean;
  domActorIds: Set<string>;
  actors: ActorIndexRecord[];
  actorIndexSize: number;
}

export interface ActorHidingDecision {
  reason: ActorHidingReason | null;
  matchedBlack: boolean;
  matchedNonFavorited: boolean;
  matchedUnrecognized: boolean;
  hasAnyFavoritedActor: boolean | null;
}

export function decideActorHiding(input: ActorHidingDecisionInput): ActorHidingDecision {
  const matchedBlack = input.hideByBlacklist && input.actors.some(actor => !!actor.blacklisted);
  const matchedNonFavorited = input.hideByNonFavorited
    ? isNonFavoritedMatch(input)
    : false;
  // 仅当「无任何本地演员记录且 DOM 无演员信息、但演员库非空」时视为未识别；
  // 空演员库（新装/未导入）时不隐藏，避免整列被藏。
  const matchedUnrecognized =
    input.hideUnrecognized &&
    input.actors.length === 0 &&
    input.domActorIds.size === 0 &&
    input.actorIndexSize > 0;

  return {
    reason: matchedBlack
      ? 'ACTOR_BLACKLIST'
      : matchedNonFavorited
        ? 'ACTOR_NOT_FAVORITED'
        : matchedUnrecognized
          ? 'ACTOR_UNRECOGNIZED'
          : null,
    matchedBlack,
    matchedNonFavorited,
    matchedUnrecognized,
    hasAnyFavoritedActor: input.hideByNonFavorited && input.actors.length > 0
      ? hasAnyFavoritedActor(input.actors)
      : null,
  };
}

function isNonFavoritedMatch(input: ActorHidingDecisionInput): boolean {
  if (input.domActorIds.size > 0 && input.actors.length === 0) {
    return true;
  }

  if (input.actors.length > 0) {
    return !hasAnyFavoritedActor(input.actors);
  }

  // 无任何演员信息时并入「未识别」语义：须同时满足 hideUnrecognized 且演员库非空
  //（空演员库保护，2026-09-27 真机审计 B2 修复：原实现绕过空库保护）。
  return input.hideUnrecognized && input.actorIndexSize > 0;
}

function hasAnyFavoritedActor(actors: ActorIndexRecord[]): boolean {
  // 数据模型限制（09-26-display-settings-audit B1 止血）：
  // ActorIndexRecord 只有 blacklisted 字段，没有收藏状态字段，
  // 因此「未收藏」语义当前等价于「匹配演员全部处于黑名单」。
  // 收藏/订阅不再参与决策（treatSubscribedAsFavorited 为死代码，已删除）；
  // 真正的「未收藏」实现（引入收藏数据模型或并入黑名单）待产品决策。
  return actors.some(actor => !actor.blacklisted);
}
