import { describe, expect, it } from "vitest";
import { createServer } from "node:http";
import { applyServerTimeouts } from "./serverTimeouts";

describe("applyServerTimeouts（长任务天花板解除）", () => {
  it("requestTimeout 从 Node 默认 300s 置 0——铸造/分析等长任务不被服务端掐断", () => {
    const srv = createServer();
    // Node ≥18 默认 300s 正是「铸造途中界面忽然消失」的根因
    expect(srv.requestTimeout).toBe(300_000);
    applyServerTimeouts(srv);
    expect(srv.requestTimeout).toBe(0);
    srv.close();
  });
});
