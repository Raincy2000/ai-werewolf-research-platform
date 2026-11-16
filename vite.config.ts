import devServer from "@hono/vite-dev-server"
import path from "path"
const __dirname = import.meta.dirname
import react from "@vitejs/plugin-react"
import { defineConfig } from "vite"
import { inspectAttr } from 'plugin-inspect-react-code'

// https://vite.dev/config/
// 架构约定：后端并入平台托管的 vite 进程内（@hono/vite-dev-server 运行 api/boot.ts）——
// vite 由平台自动保活，其后端随之前端同生共死，彻底摆脱「独立 node 进程被环境周期性
// 收割导致接口全挂」的问题（历史：bash 守护/supervisord 均被 SIGTERM 收割）。
// 对局引擎在 vite 重启/重载时经决策日志断点恢复续跑（已有机制），单引擎无抢班风险。
export default defineConfig({
  plugins: [
    // 源码开发仅 /api/* 进 hono；首页、SPA 路由、Vite 内部资产与前端源码全部交给 Vite。
    // 由 Vite 完整执行 transformIndexHtml，注入 /@vite/client 与 React preamble，
    // 避免应用 SPA 回退把 JS 模块返回成 HTML，或首页缺少 React 预加载脚本导致空白。
    devServer({
      entry: "api/boot.ts",
      exclude: [/^\/(?!api\/).*$/],
    }),
    // dev 模式同样解除 Node http server 的 300s requestTimeout（铸魂师铸造/分析等长任务）
    {
      name: "no-request-timeout",
      configureServer(s) {
        const srv = s.httpServer as unknown as import("node:http").Server | null;
        if (srv) srv.requestTimeout = 0;
      },
    },
    inspectAttr(), react()],
  server: {
    port: 3000,
    watch: {
      // 打包产物/本地数据库/构建输出不监听——否则 Windows 下目录监视句柄会
      // 阻止 electron-builder 重命名 release/win-unpacked.tmp（EPERM 拒绝访问）
      ignored: ["**/release/**", "**/tools/**", "**/dist/**", "**/tmp/**", "**/node_modules/**"],
    },
  },
  resolve: {
    alias: {
      "@": path.resolve(__dirname, "./src"),
      "@contracts": path.resolve(__dirname, "./contracts"),
      "@db": path.resolve(__dirname, "./db"),
      "db": path.resolve(__dirname, "./db"),
    },
  },
  envDir: path.resolve(__dirname),
  build: {
    outDir: path.resolve(__dirname, "dist/public"),
    emptyOutDir: true,
    rollupOptions: {
      output: {
        // 框架/图标库拆为独立长效缓存 chunk：业务代码迭代时 vendor 指纹不变，二次访问免下载
        manualChunks(id: string) {
          if (id.includes("node_modules")) {
            if (id.includes("lucide-react")) return "icons";
            if (id.includes("react") || id.includes("scheduler")) return "vendor";
          }
        },
      },
    },
  },
});
