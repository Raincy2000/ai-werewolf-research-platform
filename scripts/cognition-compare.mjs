#!/usr/bin/env node
// 开发环境专用：比较两份 { events, decisions } JSON 快照；不连接数据库、不调用模型、不进入客户端。
import { readFileSync } from "node:fs";
import path from "node:path";
import { buildSync } from "esbuild";

const [beforePath, afterPath] = process.argv.slice(2);
if (!beforePath || !afterPath) {
  console.error("用法：npm run cognition:compare -- <before.json> <after.json>");
  process.exit(2);
}

const bundled = buildSync({
  entryPoints: [path.resolve("api/game/cognition-audit.ts")],
  bundle: true,
  platform: "node",
  format: "esm",
  target: "node20",
  write: false,
  logLevel: "silent",
});
const code = bundled.outputFiles[0].text;
const moduleUrl = `data:text/javascript;base64,${Buffer.from(code).toString("base64")}`;
const { buildCognitionAudit, compareCognitionAudits } = await import(moduleUrl);

function load(file) {
  const value = JSON.parse(readFileSync(path.resolve(file), "utf8"));
  if (!value || !Array.isArray(value.events) || !Array.isArray(value.decisions ?? [])) {
    throw new Error(`${file} 必须是 { events: [], decisions?: [] } 快照`);
  }
  return buildCognitionAudit(value.events, value.decisions ?? []);
}

const before = load(beforePath);
const after = load(afterPath);
process.stdout.write(JSON.stringify({ before, after, diff: compareCognitionAudits(before, after) }, null, 2));
