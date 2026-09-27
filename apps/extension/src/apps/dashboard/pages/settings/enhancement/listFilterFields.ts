/**
 * @file listFilterFields.ts
 * @description 列表过滤开关字段元数据（id 稳定锚点 + 文案）
 * @module apps/dashboard/pages/settings/enhancement
 *
 * 2026-09-27 IA 裁决：原「显示设置」页整页迁入功能增强 · 列表页增强（ListTab）。
 * 键命名空间不变（display 与 listEnhancement 两个命名空间），存量用户零回填；
 * 字段 id 同时是设置搜索锚点与 DOM 控件 id，与 legacy 入口保持同一套 id。
 */
import type { EnhancementSettingsFormState } from './enhancementSettingsModel';

type ListFilterField = {
  key: keyof EnhancementSettingsFormState;
  id: string;
  label: string;
  description?: string;
};

/** 番号过滤（display.*，默认全 false） */
export const DISPLAY_FILTER_FIELDS: ListFilterField[] = [
  { key: 'hideViewed', id: 'hideViewed', label: '隐藏已标记"看过"的影片' },
  { key: 'hideBrowsed', id: 'hideBrowsed', label: '隐藏已浏览详情页的影片' },
  { key: 'hideVR', id: 'hideVR', label: '隐藏所有VR影片' },
  { key: 'hideWant', id: 'hideWant', label: '隐藏想看的影片' },
];

/** 演员过滤（列表，listEnhancement.*，默认全 false；空演员库保护） */
export const ACTOR_LIST_FILTER_FIELDS: ListFilterField[] = [
  {
    key: 'hideBlacklistedActorsInList',
    id: 'hideBlacklistedActorsInList',
    label: '隐藏含黑名单演员的作品',
  },
  {
    key: 'hideNonFavoritedActorsInList',
    id: 'hideNonFavoritedActorsInList',
    label: '隐藏匹配演员全在黑名单中的作品',
    description: '同时隐藏列表页有演员信息但本地无演员记录的作品。本地演员库暂不区分收藏/未收藏',
  },
  {
    key: 'hideUnrecognizedActorsInList',
    id: 'hideUnrecognizedActorsInList',
    label: '隐藏无法识别演员的作品',
    description: '仅在本地演员库可用时生效；本地演员库为空时不隐藏。默认关闭',
  },
];
