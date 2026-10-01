/**
 * 警徽图标（替代原王冠）：盾牌 + 五角星的经典警徽造型。
 * 视觉风格与 lucide-react 完全一致：24×24 viewBox、fill=none、
 * stroke=currentColor、strokeWidth=2、圆角线帽/线接——可像 lucide 图标一样
 * 用 className 控制尺寸与颜色（text-god 等）。
 */

import type { SVGProps } from 'react'

export function SheriffBadge({ className, ...props }: SVGProps<SVGSVGElement>) {
  return (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={2}
      strokeLinecap="round"
      strokeLinejoin="round"
      className={className}
      {...props}
    >
      {/* 盾牌外廓（与 lucide Shield 同路径） */}
      <path d="M20 13c0 5-3.5 7.5-7.66 8.95a1 1 0 0 1-.67-.01C7.5 20.5 4 18 4 13V6a1 1 0 0 1 1-1c2 0 4.5-1.2 6.24-2.72a1.17 1.17 0 0 1 1.52 0C14.51 3.81 17 5 19 5a1 1 0 0 1 1 1z" />
      {/* 中心五角星（警徽之星） */}
      <path d="m12 8.4 1.12 2.27 2.5.36-1.81 1.77.43 2.5-2.24-1.18-2.24 1.18.43-2.5-1.81-1.77 2.5-.36z" />
    </svg>
  )
}
