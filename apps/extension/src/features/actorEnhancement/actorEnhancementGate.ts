/**
 * 演员页增强功能的统一启用判断（单一事实来源）。
 *
 * 背景：设置里同一开关存在双写字段——
 * - `userExperience.enableActorEnhancement`（新设置表单的 userExperience 节，
 *   见 enhancementSettingsModel.ts 的 buildSettingsFromForm 写入）
 * - `actorEnhancement.enabled`（旧内容脚本直接读取的 actorEnhancement 节，
 *   同一表单保存时也会双写）
 *
 * 历史问题：bootstrap 的两处门控各读一个字段（preregister 读
 * `ux.enableActorEnhancement !== false`、add 读 `ae.enabled !== false`），
 * 老 profile 中 ux 字段显式为 false 而 ae.enabled 缺失时，UI 显示"关"
 * 但内容脚本实际仍"开"，两者分叉。
 *
 * 统一优先级与设置表单的读取映射保持一致
 * （enhancementSettingsModel.ts 中 form.enableActorEnhancement 的推导）：
 * `ux.enableActorEnhancement` 显式存在时以其为准，否则回退
 * `actorEnhancement.enabled !== false`（默认开）。
 */
export interface ActorEnhancementGateSettings {
    userExperience?: { enableActorEnhancement?: boolean } | null;
    actorEnhancement?: { enabled?: boolean } | null;
}

/** 判断演员页增强是否启用（与设置表单显示的开关状态一致）。 */
export function isActorEnhancementEnabled(settings: ActorEnhancementGateSettings): boolean {
    const ux = settings.userExperience?.enableActorEnhancement;
    if (ux !== undefined) {
        return ux === true;
    }
    return settings.actorEnhancement?.enabled !== false;
}
