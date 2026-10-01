/**
 * 未登录态的本地 API 存档库（localStorage 持久化）。
 *
 * 与云端存档库（trpc.preset.*）字段对齐（ApiPreset），但 id 使用递减负数，
 * 与后端自增正数 id 永不冲突；登录后若云端为空会把本地存档逐条上传，
 * 上传成功的条目随即从本地移除（apiKey 由后端 AES-GCM 加密落库）。
 *
 * 纯函数实现：存储对象可注入（测试友好），默认取 globalThis.localStorage。
 */
import type { ApiPreset, ApiPresetInput } from '@contracts/game'

/** 本地存档库存储 key */
export const PRESETS_STORAGE_KEY = 'aiwerewolf.presets.v1'

/** 最小存储接口（localStorage 的可注入替身） */
export interface StorageLike {
  getItem(key: string): string | null
  setItem(key: string, value: string): void
  removeItem(key: string): void
}

function storageOf(custom?: StorageLike): StorageLike | null {
  if (custom) return custom
  try {
    return typeof localStorage === 'undefined' ? null : localStorage
  } catch {
    return null
  }
}

/** 逐字段校验并收窄为 ApiPreset（坏数据直接丢弃，避免污染 UI） */
function sanitizePreset(raw: unknown): ApiPreset | null {
  if (!raw || typeof raw !== 'object') return null
  const p = raw as Partial<ApiPreset>
  if (typeof p.id !== 'number' || !Number.isFinite(p.id)) return null
  if (typeof p.name !== 'string' || !p.name) return null
  if (typeof p.provider !== 'string') return null
  return {
    id: p.id,
    name: p.name,
    provider: p.provider as ApiPreset['provider'],
    baseUrl: typeof p.baseUrl === 'string' ? p.baseUrl : '',
    model: typeof p.model === 'string' ? p.model : '',
    apiKey: typeof p.apiKey === 'string' ? p.apiKey : '',
    updatedAt: typeof p.updatedAt === 'string' ? p.updatedAt : new Date(0).toISOString(),
  }
}

/** 读取本地存档库（不存在/损坏返回空数组） */
export function loadLocalPresets(storage?: StorageLike): ApiPreset[] {
  const store = storageOf(storage)
  if (!store) return []
  try {
    const raw = store.getItem(PRESETS_STORAGE_KEY)
    if (!raw) return []
    const parsed = JSON.parse(raw) as unknown
    if (!Array.isArray(parsed)) return []
    return parsed.map(sanitizePreset).filter((p): p is ApiPreset => p !== null)
  } catch {
    return []
  }
}

/** 覆盖写本地存档库（空数组时移除 key，保持存储干净） */
export function saveLocalPresets(presets: ApiPreset[], storage?: StorageLike): void {
  const store = storageOf(storage)
  if (!store) return
  try {
    if (presets.length === 0) store.removeItem(PRESETS_STORAGE_KEY)
    else store.setItem(PRESETS_STORAGE_KEY, JSON.stringify(presets))
  } catch {
    // 隐私模式等写入失败场景直接忽略
  }
}

/** 某账户的云端存档镜像 key（按用户隔离，同一浏览器多账户互不串号） */
function mirrorKey(userId: string): string {
  return `${PRESETS_STORAGE_KEY}.mirror.${userId}`
}

/**
 * 读取指定账户的云端存档镜像（登录态云端加载失败时的兜底副本）。
 * 教训（2026-08-02 存档丢失事故）：云端必须是唯一权威，但浏览器要留一份
 * 按账户隔离的镜像，防止服务端单点故障再次造成不可恢复的丢失。
 */
export function loadMirrorPresets(userId: string, storage?: StorageLike): ApiPreset[] {
  const store = storageOf(storage)
  if (!store) return []
  try {
    const raw = store.getItem(mirrorKey(userId))
    if (!raw) return []
    const parsed = JSON.parse(raw) as unknown
    if (!Array.isArray(parsed)) return []
    return parsed.map(sanitizePreset).filter((p): p is ApiPreset => p !== null)
  } catch {
    return []
  }
}

/** 覆盖写指定账户的云端存档镜像（空数组时移除 key） */
export function saveMirrorPresets(userId: string, presets: ApiPreset[], storage?: StorageLike): void {
  const store = storageOf(storage)
  if (!store) return
  try {
    if (presets.length === 0) store.removeItem(mirrorKey(userId))
    else store.setItem(mirrorKey(userId), JSON.stringify(presets))
  } catch {
    // 写入失败忽略
  }
}

/** 生成本地 id：递减负数（-1、-2…），与后端自增正数 id 隔离 */
function nextLocalId(presets: ApiPreset[]): number {
  return presets.reduce((min, p) => Math.min(min, p.id), 0) - 1
}

/** 本地新建存档（返回带本地 id 与更新时间的完整记录，新存档排最前） */
export function createLocalPreset(input: ApiPresetInput, storage?: StorageLike): ApiPreset {
  const presets = loadLocalPresets(storage)
  const created: ApiPreset = {
    id: nextLocalId(presets),
    name: input.name,
    provider: input.provider,
    baseUrl: input.baseUrl,
    model: input.model,
    apiKey: input.apiKey,
    updatedAt: new Date().toISOString(),
  }
  saveLocalPresets([created, ...presets], storage)
  return created
}

/** 本地更新存档（不存在返回 null） */
export function updateLocalPreset(
  id: number,
  patch: Partial<ApiPresetInput>,
  storage?: StorageLike,
): ApiPreset | null {
  const presets = loadLocalPresets(storage)
  const index = presets.findIndex((p) => p.id === id)
  if (index < 0) return null
  const updated: ApiPreset = {
    ...presets[index],
    ...patch,
    id, // id 不可被 patch 覆盖
    updatedAt: new Date().toISOString(),
  }
  const next = [...presets]
  next[index] = updated
  saveLocalPresets(next, storage)
  return updated
}

/** 本地批量删除存档（返回删除后的完整列表） */
export function deleteLocalPresets(ids: ReadonlySet<number>, storage?: StorageLike): ApiPreset[] {
  const next = loadLocalPresets(storage).filter((p) => !ids.has(p.id))
  saveLocalPresets(next, storage)
  return next
}
