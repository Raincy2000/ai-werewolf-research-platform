/**
 * 主题判定（浅色纸面为应用根主题；对局页夜间用 .dark 类）。
 * Canvas 手绘无法直接用 CSS 变量，颜色分支需要知道当前主题。
 */
import { useEffect, useState } from 'react'
import { hasDarkClass } from '@/lib/relationGraph'

function detect(): boolean {
  if (typeof document === 'undefined') return false
  return hasDarkClass(document.documentElement.className)
}

export function useIsDarkTheme(): boolean {
  const [isDark, setIsDark] = useState<boolean>(detect)

  useEffect(() => {
    if (typeof document === 'undefined' || typeof MutationObserver === 'undefined') return
    const el = document.documentElement
    const update = () => setIsDark(hasDarkClass(el.className))
    update()
    const mo = new MutationObserver(update)
    mo.observe(el, { attributes: true, attributeFilter: ['class'] })
    return () => mo.disconnect()
  }, [])

  return isDark
}
