import { createRoot } from 'react-dom/client'
import './index.css'
import App from './App.tsx'
import { TRPCProvider } from './providers/trpc'
import { AuthProvider } from './providers/auth'

// 部署/重构建后，用户已打开的旧页面里的懒加载 chunk 哈希会失效（404）——
// 捕获 vite:preloadError 自动整页刷新一次拿新 index.html，根治「点击后一直加载」。
// 用 sessionStorage 标记防刷新死循环（极端情况：新构建本身缺失该 chunk）。
window.addEventListener('vite:preloadError', () => {
  const KEY = 'chunk-reload-at'
  const last = Number(sessionStorage.getItem(KEY) || 0)
  if (Date.now() - last > 10_000) {
    sessionStorage.setItem(KEY, String(Date.now()))
    window.location.reload()
  }
})

// 注意：不使用 <React.StrictMode>（react-dev.md：会导致副作用执行两次）
createRoot(document.getElementById('root')!).render(
  <TRPCProvider>
    <AuthProvider>
      <App />
    </AuthProvider>
  </TRPCProvider>
)
