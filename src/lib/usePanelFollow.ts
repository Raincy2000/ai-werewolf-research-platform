/**
 * 滚动面板「吸底跟随」共享机制（对局记录 / 技能权衡等滚动栏通用）：
 * - 面板处于最新状态（内容吸底 / 选中最新时段）时，新内容到达自动保持最新
 * - 用户上翻或切到旧时段后，不再自动调整——直到用户自行滚回底端 / 切回最新时段
 * - 程序化滚动通过 suppressRef 屏蔽，不会被误判为用户上翻
 */

import { useEffect, useRef } from 'react'

/** 距底部多少 px 以内视为「吸底」 */
const STICK_THRESHOLD_PX = 48

export function usePanelFollow(
  getViewport: () => HTMLElement | null,
  /** 监听重挂信号：内容从无到有等 viewport 更换时传入变化值，滚动监听随之重挂 */
  reattachKey: unknown = 0,
) {
  /** 用户是否处于「吸底」状态（未上翻） */
  const stickRef = useRef(true)
  /** 是否跟随最新时段 */
  const followLatestRef = useRef(true)
  /** 程序化滚动屏蔽标记 */
  const suppressRef = useRef(false)

  // 监听用户滚动：仅更新吸底状态（程序化滚动除外）
  useEffect(() => {
    const viewport = getViewport()
    if (!viewport) return
    const onScroll = () => {
      if (suppressRef.current) return
      stickRef.current =
        viewport.scrollHeight - viewport.scrollTop - viewport.clientHeight < STICK_THRESHOLD_PX
    }
    viewport.addEventListener('scroll', onScroll, { passive: true })
    return () => viewport.removeEventListener('scroll', onScroll)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [reattachKey])

  /** 程序化吸底（不触发吸底状态重判） */
  const scrollToBottom = () => {
    const viewport = getViewport()
    if (!viewport) return
    suppressRef.current = true
    viewport.scrollTop = viewport.scrollHeight
    setTimeout(() => {
      suppressRef.current = false
    }, 50)
  }

  return { stickRef, followLatestRef, scrollToBottom }
}
