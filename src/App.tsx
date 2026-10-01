import { Suspense, lazy } from 'react'
import { BrowserRouter, Routes, Route } from 'react-router'
import Layout from '@/components/Layout'
// 大厅是落地页：静态引入，去掉首屏关键路径上的一级串行懒加载往返（首进更快）
import Home from '@/pages/Home'

// 路由级代码分割：对局观察室/指南页按需加载（非首屏）
const GameRoom = lazy(() => import('@/pages/GameRoom'))
const Guide = lazy(() => import('@/pages/Guide'))
const Library = lazy(() => import('@/pages/Library'))
const Personas = lazy(() => import('@/pages/Personas'))
const History = lazy(() => import('@/pages/History'))
const NotFound = lazy(() => import('@/pages/NotFound'))

export default function App() {
  return (
    <BrowserRouter>
      <Layout>
        <Suspense fallback={null}>
          <Routes>
            <Route path="/" element={<Home />} />
            <Route path="/game/:id" element={<GameRoom />} />
            <Route path="/guide" element={<Guide />} />
            <Route path="/library" element={<Library />} />
            <Route path="/personas" element={<Personas />} />
            <Route path="/history" element={<History />} />
            <Route path="*" element={<NotFound />} />
          </Routes>
        </Suspense>
      </Layout>
    </BrowserRouter>
  )
}
