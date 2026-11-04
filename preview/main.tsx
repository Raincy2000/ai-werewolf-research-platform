import { createRoot } from 'react-dom/client'
import { useState } from 'react'
import '@/index.css'
import { RelationGraphBar } from '@/components/persona/RelationGraphBar'
import { Button } from '@/components/ui/button'
import { setMockGraphFixture } from './mockGameApi'
import type { MockGraphFixture } from './mockData'

const FIXTURES: Array<{ key: MockGraphFixture; label: string; hint: string }> = [
  { key: 'normal', label: '常规图', hint: '7 人 + 跨世界线；点线看双向视角、报告、手录、补完' },
  { key: 'empty', label: '空关系网', hint: '验证空库入口：「关系补完」按钮仍在' },
  { key: 'dangling', label: '悬空边 + 自环', hint: '左下列出库外角色；自环画小圆环' },
  { key: 'large', label: '大图', hint: '36 人 / ~110 条边，验证绘制与命中不卡' },
]

/**
 * 关系网预览（无后端手工验证）：
 *   npx vite --config preview/vite.preview.config.ts
 * 或构建：npx vite build --config preview/vite.preview.config.ts
 */
function App() {
  const [fixture, setFixture] = useState<MockGraphFixture>('normal')
  const [dark, setDark] = useState(false)
  const [version, setVersion] = useState(0)

  const pick = (next: MockGraphFixture) => {
    setMockGraphFixture(next)
    setFixture(next)
    // 重新挂载：让图重新拉取（模拟切换研究库）
    setVersion((v) => v + 1)
  }

  const toggleDark = () => {
    const next = !dark
    setDark(next)
    document.documentElement.classList.toggle('dark', next)
  }

  return (
    <div className="min-h-screen bg-background p-6 text-foreground">
      <div className="mx-auto max-w-6xl space-y-3">
        <div className="flex flex-wrap items-center gap-2">
          <h1 className="text-sm font-semibold">人格关系网 · 预览</h1>
          {FIXTURES.map((f) => (
            <Button
              key={f.key}
              size="sm"
              variant={fixture === f.key ? 'default' : 'outline'}
              onClick={() => pick(f.key)}
            >
              {f.label}
            </Button>
          ))}
          <Button size="sm" variant="outline" className="ml-auto" onClick={toggleDark}>
            {dark ? '切到浅色' : '切到深色'}
          </Button>
        </div>
        <p className="text-xs text-muted-foreground">
          {FIXTURES.find((f) => f.key === fixture)?.hint}
        </p>
        <RelationGraphBar key={fixture + ':' + version} defaultOpen />
      </div>
    </div>
  )
}

createRoot(document.getElementById('root')!).render(<App />)
