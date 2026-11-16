import { existsSync, readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const rootPackage = JSON.parse(readFileSync(new URL("../../package.json", import.meta.url), "utf8")) as { scripts: Record<string, string> };
const desktopPackage = JSON.parse(readFileSync(new URL("../../desktop/package.json", import.meta.url), "utf8")) as { scripts: Record<string, string> };
const main = readFileSync(new URL("../../desktop/main.mjs", import.meta.url), "utf8");

describe("本地源码开发工作流", () => {
  it("提供一键 Electron 源码启动，不产生安装包", () => {
    expect(rootPackage.scripts["dev:desktop"]).toBe("npm --prefix desktop run dev:source");
    expect(desktopPackage.scripts["dev:source"]).toBe("node dev-source.mjs");
    expect(existsSync(new URL("../../desktop/dev-source.mjs", import.meta.url))).toBe(true);
  });

  it("启动器用系统 Node 启动 Vite，Electron 只连接其地址并复用当前数据库", () => {
    const launcher = readFileSync(new URL("../../desktop/dev-source.mjs", import.meta.url), "utf8");
    expect(launcher).toContain("const viteCommand = process.execPath");
    expect(launcher).toContain("spawn(viteCommand");
    expect(launcher).toContain("WW_DEV_URL");
    expect(launcher).toContain('SQLITE_PATH: path.join(userData, "werewolf.db")');
    expect(main).toContain("process.env.WW_DEV_URL");
    expect(main).not.toContain("startSourceServerOnce");
    expect(main).not.toContain('server = fork(vitePath');
  });

  it("开发启动器保持前台进程，不驻留、不脱离当前终端", () => {
    const launcher = readFileSync(new URL("../../desktop/dev-source.mjs", import.meta.url), "utf8");
    expect(launcher).toContain("stdio: \"inherit\"");
    expect(launcher).not.toContain("detached: true");
    expect(launcher).not.toContain("nohup");
    expect(launcher).not.toContain("Start-Process");
  });

  it("npm Electron 缺失时回退到项目已有的 electron-dist", () => {
    const launcher = readFileSync(new URL("../../desktop/dev-source.mjs", import.meta.url), "utf8");
    expect(launcher).toContain('path.resolve(import.meta.dirname, "electron-dist", "electron.exe")');
    expect(launcher).toContain("existsSync(npmElectron)");
    expect(launcher).toContain("existsSync(localElectron)");
  });

  it("窗口进程不继承宿主的 ELECTRON_RUN_AS_NODE", () => {
    const launcher = readFileSync(new URL("../../desktop/dev-source.mjs", import.meta.url), "utf8");
    expect(launcher).toContain("delete env.ELECTRON_RUN_AS_NODE");
    expect(launcher).toContain("env,");
  });

  it("Vite 复用当前 Node 进程并显式保留 Node 语义", () => {
    const launcher = readFileSync(new URL("../../desktop/dev-source.mjs", import.meta.url), "utf8");
    expect(launcher).toContain("const viteCommand = process.execPath");
    expect(launcher).toContain('ELECTRON_RUN_AS_NODE: "1"');
  });

  it("健康检查不会被单个悬挂请求永久阻塞，并允许冷启动完成", () => {
    const launcher = readFileSync(new URL("../../desktop/dev-source.mjs", import.meta.url), "utf8");
    expect(launcher).toContain("AbortSignal.timeout(10_000)");
    expect(launcher).toContain("const deadline = Date.now() + 300_000");
  });

  it("源码开发时 Vite 处理全部非 API 请求，以完整注入 React 预加载脚本", () => {
    const viteConfig = readFileSync(new URL("../../vite.config.ts", import.meta.url), "utf8");
    expect(viteConfig).toContain("exclude: [/^\\/(?!api\\/).*$/]");
  });
});
