// 桌面端打包脚本（替代 npm run app:dist）：
// 1) 给 electron-builder 的 npm 依赖收集器打「空依赖快路径」补丁（绕开 npm ls --json 输出污染）
// 2) 程序化打包 NSIS 安装版 + portable 便携版
import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

function patchNpmCollector() {
  const target = "node_modules/app-builder-lib/out/node-module-collector/nodeModulesCollector.js";
  const marker = "// [ww-patch] empty-deps fast path";
  let src = readFileSync(target, "utf8");
  if (src.includes(marker)) return;
  const anchor = "async getDependenciesTree(pm) {";
  if (!src.includes(anchor)) throw new Error(`补丁锚点不存在：${anchor}`);
  src = src.replace(anchor, `${anchor}
        ${marker}
        try {
            const rootPkg = JSON.parse(require("fs").readFileSync(require("path").join(this.rootDir, "package.json"), "utf8"));
            if (!rootPkg.dependencies || Object.keys(rootPkg.dependencies).length === 0) {
                return { name: rootPkg.name, version: rootPkg.version, path: this.rootDir, dependencies: {} };
            }
        } catch { /* 读不到则走原逻辑 */ }`);
  writeFileSync(target, src);
  console.log("[patch] npm collector 空依赖快路径已注入");
}
patchNpmCollector();

const { build, Platform } = await import("electron-builder");
const pkg = JSON.parse(readFileSync(new URL("./package.json", import.meta.url), "utf8"));

try {
  const result = await build({
    targets: Platform.WINDOWS.createTarget(["nsis", "portable"]),
    projectDir: process.cwd(),
    config: {
      ...pkg.build,
      electronDist: resolve(process.cwd(), pkg.build.electronDist ?? "electron-dist"),
    },
  });
  console.log("PACK OK:", result.join("\n"));
} catch (err) {
  console.error("PACK FAIL:", err instanceof Error ? (err.stack ?? err.message) : err);
  process.exit(1);
}
