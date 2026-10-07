// 后端构建脚本：用 esbuild JS API（banner 作为对象属性），避免命令行引号在 Windows cmd 下被破坏
import { build } from "esbuild";
try {
  await build({
    entryPoints: ["api/boot.ts"],
    platform: "node",
    bundle: true,
    format: "esm",
    outdir: "dist",
    banner: { js: "import { createRequire } from 'module';const require = createRequire(import.meta.url);" },
  });
  console.log("backend build done");
} catch (e) {
  console.error("backend build failed:", e.message);
  process.exit(1);
}
