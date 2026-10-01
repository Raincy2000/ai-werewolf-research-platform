import { describe, expect, it } from "vitest";
import {
  ackCast,
  castCheckpoint,
  castControl,
  getActiveCast,
  getCastProgress,
  makeCharsReporter,
  note,
  runWithCastProgress,
  stage,
  startCastJob,
  withLane,
} from "./progress";

const tick = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe("铸造进度登记处", () => {
  it("成功路径：阶段/细节透出，结束后 done=true", async () => {
    const r = await runWithCastProgress("t-ok", async () => {
      stage("① 搜集人物研究档案");
      note("已生成 100 字");
      return "ok";
    });
    expect(r).toBe("ok");
    const p = getCastProgress("t-ok");
    expect(p).not.toBeNull();
    expect(p!.label).toBe("① 搜集人物研究档案");
    expect(p!.detail).toBe("已生成 100 字");
    expect(p!.done).toBe(true);
    expect(p!.error).toBeNull();
  });

  it("失败路径：错误原样抛出，条目 done=true 且留住 error", async () => {
    await expect(
      runWithCastProgress("t-fail", async () => {
        stage("③ 整合量化人格参数卡");
        throw new Error("boom");
      }),
    ).rejects.toThrow("boom");
    const p = getCastProgress("t-fail");
    expect(p!.done).toBe(true);
    expect(p!.error).toBe("boom");
    expect(p!.label).toBe("③ 整合量化人格参数卡");
  });

  it("并行 lane 细节分行合并；stage 切换清空细节", async () => {
    await runWithCastProgress("t-lane", async () => {
      stage("② 分段深读人格（4 专题并行）");
      await Promise.all([
        withLane("核心", async () => note("已生成 10 字")),
        withLane("冲突", async () => note("已生成 20 字")),
      ]);
      const mid = getCastProgress("t-lane");
      expect(mid!.detail).toContain("核心 已生成 10 字");
      expect(mid!.detail).toContain("冲突 已生成 20 字");
      expect(mid!.detail).toContain("；");
      stage("② 合并四段解读成稿");
      expect(getCastProgress("t-lane")!.detail).toBe("");
      note("已生成 99 字");
      expect(getCastProgress("t-lane")!.detail).toBe("已生成 99 字"); // main lane 原文
    });
  });

  it("无 castId 直接执行；无上下文时 stage/note 静默空转", async () => {
    const r = await runWithCastProgress(undefined, async () => "bare");
    expect(r).toBe("bare");
    expect(() => {
      stage("x");
      note("y");
    }).not.toThrow();
    expect(getCastProgress("不存在")).toBeNull();
  });

  it("makeCharsReporter 节流：首次必报、小增量抑制、大增量再报", async () => {
    await runWithCastProgress("t-throttle", async () => {
      stage("① 搜集");
      const report = makeCharsReporter("联网检索 第 1 轮");
      report(50); // 首次必报
      expect(getCastProgress("t-throttle")!.detail).toBe("联网检索 第 1 轮 · 已生成 50 字");
      report(120); // +70 < 200 且 <400ms → 抑制
      expect(getCastProgress("t-throttle")!.detail).toBe("联网检索 第 1 轮 · 已生成 50 字");
      report(300); // +250 ≥ 200 → 再报
      expect(getCastProgress("t-throttle")!.detail).toBe("联网检索 第 1 轮 · 已生成 300 字");
    });
  });

  it("两个 castId 互不串扰（并发任务隔离）", async () => {
    await Promise.all([
      runWithCastProgress("t-a", async () => {
        stage("A 阶段");
        await new Promise((r) => setTimeout(r, 10));
      }),
      runWithCastProgress("t-b", async () => {
        stage("B 阶段");
      }),
    ]);
    expect(getCastProgress("t-a")!.label).toBe("A 阶段");
    expect(getCastProgress("t-b")!.label).toBe("B 阶段");
  });

  it("startCastJob 异步执行：完成落 result、失败落 error；getActiveCast 进行中优先、按用户隔离；ackCast 后不再恢复", async () => {
    // 完成任务（含进度埋点，验证 ALS 上下文在异步任务里生效）
    startCastJob("job-1", 7, "甲", async () => {
      stage("① 搜集中");
      await new Promise((r) => setTimeout(r, 30));
      return { draft: { name: "甲" } };
    });
    const running = getActiveCast(7);
    expect(running).not.toBeNull();
    expect(running!.done).toBe(false);
    await new Promise((r) => setTimeout(r, 80));
    const p1 = getCastProgress("job-1", 7);
    expect(p1!.done).toBe(true);
    expect(p1!.error).toBeNull();
    expect(p1!.label).toBe("① 搜集中");
    expect((p1!.result as { draft: { name: string } }).draft.name).toBe("甲");

    // 失败任务
    startCastJob("job-2", 7, "乙", async () => {
      throw new Error("崩了");
    });
    await new Promise((r) => setTimeout(r, 60));
    expect(getCastProgress("job-2", 7)!.error).toBe("崩了");

    // 无进行中 → 找回最近完成的（后启动的 job-2）；其它用户隔离
    expect(getActiveCast(7)!.castId).toBe("job-2");
    expect(getActiveCast(8)).toBeNull();
    expect(getCastProgress("job-1", 8)).toBeNull();

    // 确认取走后不再恢复
    ackCast("job-2");
    expect(getActiveCast(7)!.castId).toBe("job-1");
    ackCast("job-1");
    expect(getActiveCast(7)).toBeNull();
  });

  it("暂停挂起与继续：任务链在检查点挂起，resume 后继续推进（含姓名透出）", async () => {
    const steps: string[] = [];
    let go = false;
    startCastJob("job-pause", 9, "五条悟", async () => {
      steps.push("a");
      await castCheckpoint(); // C1：未暂停，直接过
      while (!go) await tick(5); // 等外部先按下暂停
      steps.push("b");
      await castCheckpoint(); // C2：已暂停 → 挂起
      steps.push("c");
      return "done";
    });
    await tick(30);
    expect(steps).toEqual(["a"]);
    expect(getActiveCast(9)!.name).toBe("五条悟");

    expect(castControl("job-pause", 9, "pause")).toBe(true);
    expect(getCastProgress("job-pause", 9)!.paused).toBe(true);
    expect(castControl("job-pause", 9, "pause")).toBe(false); // 重复暂停幂等拒绝

    go = true; // fn 推进到 C2 → 挂起
    await tick(60);
    expect(steps).toEqual(["a", "b"]); // c 未执行（挂起中）

    expect(castControl("job-pause", 9, "resume")).toBe(true);
    await tick(500); // 挂起轮询间隔 300ms，留余量
    expect(steps).toEqual(["a", "b", "c"]);
    const p = getCastProgress("job-pause", 9)!;
    expect(p.done).toBe(true);
    expect(p.paused).toBe(false);
    ackCast("job-pause");
  });

  it("终止：任务链在检查点中断，条目直接删除（取消并删除整个流程）", async () => {
    const steps: string[] = [];
    startCastJob("job-cancel", 10, "艾伦", async () => {
      steps.push("a");
      for (;;) {
        await castCheckpoint(); // 终止时此处抛 CastCancelledError
        await tick(5);
        steps.push("loop");
      }
    });
    await tick(30);
    expect(steps[0]).toBe("a");
    expect(castControl("job-cancel", 10, "cancel")).toBe(true);
    await tick(80);
    expect(getCastProgress("job-cancel", 10)).toBeNull(); // 条目已删
    expect(getActiveCast(10)).toBeNull();
    expect(steps.length).toBeLessThan(20); // 任务链已中断（不再空转）
  });

  it("控制无效操作：条目不存在/越权/已结束均拒绝", async () => {
    expect(castControl("不存在", 9, "pause")).toBe(false);
    startCastJob("job-gone", 11, "张雪峰", async () => "done");
    await tick(30);
    expect(castControl("job-gone", 11, "pause")).toBe(false); // 已 done 不可暂停
    expect(castControl("job-gone", 999, "cancel")).toBe(false); // 越权不可终止
    expect(castControl("job-gone", 11, "cancel")).toBe(true); // 本人终止已 done 条目=丢弃草稿
    expect(getCastProgress("job-gone", 11)).toBeNull();
  });
});
