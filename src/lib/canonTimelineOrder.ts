/**
 * 现实层事件时间线排序（2026-10-22 详情页拖动排序）
 *
 * 规则：
 * - 一旦用户拖动过（任一行有 sortOrder），按 sortOrder 升序（null 排最后）；
 * - 否则按「时代」时间：年-月-日（季节→3/6/9/12 月；年末/之后→13 月；无年份排最后）；
 * - 倒序由调用方翻转。
 */

export interface CanonOrderable {
  id: number
  era: string
  sortOrder?: number | null
}

/** 时代字符串 → 可比较键 */
export function eraSortKey(era: string): string {
  const s = String(era || '')
  const y = s.match(/(\d{4})/)
  if (!y) return '9999-99-99'
  const mo = s.match(/(\d{1,2})\s*月/)
  const dd = s.match(/(\d{1,2})\s*日/)
  const isLate = /(末|底|后|之后|以后)\s*$/.test(s.trim())
  let month = mo ? Number(mo[1]) : 0
  if (!month) {
    if (/春/.test(s)) month = 3
    else if (/夏/.test(s)) month = 6
    else if (/秋/.test(s)) month = 9
    else if (/冬/.test(s)) month = 12
  }
  if (isLate) month = month > 0 ? month + 1 : 13
  const pad = (n: number) => String(n).padStart(2, '0')
  return y[1] + '-' + pad(month) + '-' + pad(dd && !isLate ? Number(dd[1]) : 0)
}

export function orderCanonItems<T extends CanonOrderable>(items: T[], desc: boolean): T[] {
  const manual = items.some((x) => x.sortOrder != null)
  const sorted = [...items].sort((a, b) => {
    if (manual) {
      const av = a.sortOrder ?? Number.MAX_SAFE_INTEGER
      const bv = b.sortOrder ?? Number.MAX_SAFE_INTEGER
      if (av !== bv) return av - bv
    }
    return eraSortKey(a.era).localeCompare(eraSortKey(b.era)) || a.id - b.id
  })
  return desc ? sorted.reverse() : sorted
}
