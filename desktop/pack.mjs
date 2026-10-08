// 桌面端打包脚本：
// 1) npm 依赖收集器「空依赖快路径」补丁
// 2) 7za 压缩「Defender 锁文件重试」补丁
// 3) 程序化打包（输出英文临时目录，避免 NSIS 中文路径乱码）
// 4) 成功后把 exe 复制回 desktop/release/
import { readFileSync, writeFileSync, copyFileSync, mkdirSync, existsSync } from "node:fs";
import { resolve, basename } from "node:path";
import { tmpdir } from "node:os";

function patchNpmCollector() {
  const target = "node_modules/app-builder-lib/out/node-module-collector/nodeModulesCollector.js";
  const marker = "// [ww-patch] empty-deps fast path";
  let src = readFileSync(target, "utf8");
  if (src.includes(marker)) return;
  const anchor = "async getDependenciesTree(pm) {";
  if (!src.includes(anchor)) throw new Error("补丁锚点不存在: " + anchor);
  src = src.replace(anchor, anchor + "\n" + marker + "\ntry { const rootPkg = JSON.parse(require(\"fs\").readFileSync(require(\"path\").join(this.rootDir, \"package.json\"), \"utf8\")); if (!rootPkg.dependencies || Object.keys(rootPkg.dependencies).length === 0) { return { name: rootPkg.name, version: rootPkg.version, path: this.rootDir, dependencies: {} }; } } catch {}");
  writeFileSync(target, src);
  console.log("[patch] npm collector 空依赖快路径已注入");
}

function patch7za() {
  const target = "node_modules/app-builder-lib/out/targets/archive.js";
  const marker = "【本机补丁】";
  let s = readFileSync(target, "utf8");
  if (s.includes(marker)) return;
  const oldLines = [
    "        try {",
    "            await (0, builder_util_1.exec)(await (0, _7zip_1.getPath7za)(), args, { cwd: options.withoutDir ? dirToArchive : path.dirname(dirToArchive) }, builder_util_1.debug7z.enabled);",
    "        }",
    "        catch (e) {",
    "            if (e.code === \"ENOENT\" && !(await (0, builder_util_1.exists)(dirToArchive))) {",
    "                throw new Error(`Cannot create archive: \"${dirToArchive}\" doesn't exist`);",
    "            }",
    "            else {",
    "                throw e;",
    "            }",
    "        }",
  ].join("\n");
  if (!s.includes(oldLines)) { console.warn("[patch7za] 未找到目标代码块，跳过"); return; }
  const newLines = [
    "        // 【本机补丁】Windows Defender 实时扫描会短暂锁住刚拷贝的 DLL，导致 7za exit 1——等其扫完重试最多 8 次",
    "        let lastErr = null;",
    "        for (let attempt = 0; attempt < 8; attempt++) {",
    "            try {",
    "                await (0, builder_util_1.exec)(await (0, _7zip_1.getPath7za)(), args, { cwd: options.withoutDir ? dirToArchive : path.dirname(dirToArchive) }, builder_util_1.debug7z.enabled);",
    "                lastErr = null;",
    "                break;",
    "            }",
    "            catch (e) {",
    "                lastErr = e;",
    "                if (e.code === \"ENOENT\" && !(await (0, builder_util_1.exists)(dirToArchive))) {",
    "                    throw new Error(`Cannot create archive: \"${dirToArchive}\" doesn't exist`);",
    "                }",
    "                builder_util_1.log.warn({ attempt: attempt + 1, error: e.message }, \"7za failed (AV file lock?), waiting to retry\");",
    "                await new Promise((r) => setTimeout(r, 5000));",
    "                await (0, builder_util_1.unlinkIfExists)(outFile);",
    "            }",
    "        }",
    "        if (lastErr) {",
    "            throw lastErr;",
    "        }",
  ].join("\n");
  writeFileSync(target, s.replace(oldLines, newLines));
  console.log("[patch] 7za 重试补丁已注入");
}

patchNpmCollector();
patch7za();

const { build, Platform } = await import("electron-builder");
const pkg = JSON.parse(readFileSync(new URL("./package.json", import.meta.url), "utf8"));
const outDir = resolve(tmpdir(), "ww-release-" + (Date.now() % 100000));

// electronDist 条件注入：仅当本机存在已解压的 Electron 副本（desktop/electron-dist，
// 绕过 Defender 解压锁的本机加速手段，不入库）时才使用；CI/新克隆环境没有该目录，
// 不传 electronDist —— electron-builder 自动走官方下载通道（硬性要求：配置存在但目录缺失会直接报错）
const localElectronDist = resolve(process.cwd(), "electron-dist");
const hasLocalElectronDist = existsSync(resolve(localElectronDist, "electron.exe"));
console.log(hasLocalElectronDist
  ? "[pack] 检测到本机 electron-dist，走直拷快路径"
  : "[pack] 无本机 electron-dist，走官方下载通道");

try {
  const files = await build({
    targets: Platform.WINDOWS.createTarget(["nsis", "portable"]),
    projectDir: process.cwd(),
    config: {
      ...pkg.build,
      ...(hasLocalElectronDist ? { electronDist: localElectronDist } : {}),
      directories: { ...pkg.build.directories, output: outDir },
    },
  });
  mkdirSync("release", { recursive: true });
  for (const f of files) {
    if (f.endsWith(".exe")) {
      copyFileSync(f, resolve("release", basename(f)));
      console.log("copied:", basename(f));
    }
  }
  console.log("PACK OK");
} catch (err) {
  console.error("PACK FAIL:", err instanceof Error ? (err.stack ?? err.message) : err);
  process.exit(1);
}
