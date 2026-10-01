/**
 * 大厅设置云同步 hook（登录态生效，未登录纯 localStorage 不触发任何网络请求）。
 *
 * 同步协议（SyncedSettings = { lobby?, analyst? }，结构由前端定义、服务端透传透存）：
 * 1. 登录态建立后拉取 auth.getSettings：
 *    - 云端有设置 → 通过 applySynced 应用到本地 state（调用方负责顺带写 localStorage）
 *    - 云端无设置 → 把本地当前配置 saveSettings 上传（首次上云）
 * 2. 之后本地设置每次变更，防抖约 1.5s 推送 saveSettings；
 *    拉取完成前绝不推送，防止本地默认值覆盖云端
 * 3. 内容未实际变化（与应用下来的云端快照一致）时不重复推送
 */
import { useEffect, useRef } from 'react'
import { trpc } from '@/providers/trpc'

/** 推送防抖时长（毫秒） */
const PUSH_DEBOUNCE_MS = 1500

export interface SettingsSyncOptions {
  /** 当前登录用户 id（未登录为 null，同步完全关闭） */
  userId: string | null
  /** 大厅工作配置快照（随 state 每次变更传入最新值） */
  lobby: unknown
  /** 分析师配置快照 */
  analyst: unknown
  /** 把云端设置应用到本地 state（仅应用非空部分；由调用方做字段校验） */
  applySynced: (synced: { lobby?: unknown; analyst?: unknown }) => void
}

export function useSettingsSync({ userId, lobby, analyst, applySynced }: SettingsSyncOptions): void {
  const client = trpc.useUtils().client

  // 拉取完成标志：完成前禁止推送（防止本地默认配置覆盖云端）
  const pulledRef = useRef(false)
  // 最近一次与云端一致的内容签名（拉取成功或推送成功后更新），用于跳过冗余推送
  const lastSyncedRef = useRef('')
  // 最新配置与回调走 ref：拉取流程不随配置变更重跑
  const stateRef = useRef({ lobby, analyst })
  const applyRef = useRef(applySynced)
  useEffect(() => {
    stateRef.current = { lobby, analyst }
    applyRef.current = applySynced
  })

  // 登录态建立 / 切换账户：拉取云端设置（或首登上传本地）
  useEffect(() => {
    pulledRef.current = false
    lastSyncedRef.current = ''
    if (!userId) return
    let cancelled = false
    client.auth.getSettings
      .query()
      .then(async (settings) => {
        if (cancelled) return
        const synced = (settings ?? null) as { lobby?: unknown; analyst?: unknown } | null
        if (synced && (synced.lobby != null || synced.analyst != null)) {
          // 云端有设置 → 应用到本地（state 变更后由大厅既有逻辑自动写 localStorage）
          applyRef.current({ lobby: synced.lobby ?? undefined, analyst: synced.analyst ?? undefined })
          // 应用后的合并结果即为最新一致态：云端字段覆盖、本地字段保留
          lastSyncedRef.current = JSON.stringify({
            lobby: synced.lobby ?? stateRef.current.lobby,
            analyst: synced.analyst ?? stateRef.current.analyst,
          })
        } else {
          // 云端无设置 → 本地当前配置首次上云
          const payload = { lobby: stateRef.current.lobby, analyst: stateRef.current.analyst }
          lastSyncedRef.current = JSON.stringify(payload)
          await client.auth.saveSettings.mutate({ settings: payload }).catch(() => {
            // 上传失败不阻断使用，下次变更推送时会重试
            lastSyncedRef.current = ''
          })
        }
        if (!cancelled) pulledRef.current = true
      })
      .catch(() => {
        // 拉取失败（网络/会话失效）：保持本地模式，不推送
      })
    return () => {
      cancelled = true
    }
  }, [client, userId])

  // 本地设置变更：防抖推送（内容未变跳过）
  useEffect(() => {
    if (!userId || !pulledRef.current) return
    const payload = { lobby, analyst }
    const json = JSON.stringify(payload)
    if (json === lastSyncedRef.current) return
    const timer = window.setTimeout(() => {
      if (!pulledRef.current) return
      lastSyncedRef.current = json
      client.auth.saveSettings.mutate({ settings: payload }).catch(() => {
        // 推送失败（如会话过期）：清空签名，后续变更可重试
        lastSyncedRef.current = ''
      })
    }, PUSH_DEBOUNCE_MS)
    return () => window.clearTimeout(timer)
  }, [client, userId, lobby, analyst])
}
