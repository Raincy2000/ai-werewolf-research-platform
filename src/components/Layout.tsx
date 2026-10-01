import type { ReactNode } from 'react'
import Navbar from '@/components/Navbar'
import Footer from '@/components/Footer'

/**
 * 全局布局：顶部 sticky 导航 + 内容区 + 页脚。
 * 使用 children 模式（App.tsx 中 Layout 包裹 <Routes>）。
 */
export default function Layout({ children }: { children: ReactNode }) {
  return (
    <div className="flex min-h-[100dvh] flex-col overflow-x-hidden bg-background text-foreground">
      <Navbar />
      <main className="flex-1">{children}</main>
      <Footer />
    </div>
  )
}
