// ============================================================
// 胜率集群：分析师实时评估双方胜率（非阻塞、不排队）
// 触发时机：对局启动 / 每批事件落盘后 / 断点恢复续跑 / 终局（保底再评估一次）。
// 在飞去重：一次分析未结束时跳过新触发——只分析最新状态，绝不排队积压（保证及时性）。
// 失败静默：AI 调用失败/输出无法解析/越界一律跳过，不污染事件流、不阻塞对局循环。
// 版图拆分（2026-10-15 第二波）：自 service.ts 抽出；
// getCachedGuideText 依 createRecovery 先例依赖注入，杜绝与 service.ts 的运行时环引用。
// ============================================================

import type { GameEvent, RoleId } from "../../contracts/game";
import { BOARDS, ROLE_META, boardRulesText } from "../../contracts/game";
import { getLatestEvents } from "../queries/games";
import { getLatestWinRate, getWinRatesAfter, insertWinRate } from "../queries/winrates";
import type { Engine } from "./engine/api";
import { callAi } from "./ai/providers";
import { isThinkingModel } from "./ai/modelCaps";
import type { GameRuntime } from "./service";


/** 胜率输出解析：去围栏截取首个 { 到末个 }；good 必须落在 0-100，reasons 裁剪到 ≤6 条 ≤120 字 */
export function parseWinRateOutput(text: string): { good: number; reasons: string[]; causeLabel: string | null } | null {
  const cleaned = text.replace(/```(?:json)?/gi, "");
  const start = cleaned.indexOf("{");
  const end = cleaned.lastIndexOf("}");
  if (start < 0 || end <= start) return null;
  const jsonText = cleaned.slice(start, end + 1);
  let obj: unknown;
  try {
    obj = JSON.parse(jsonText);
  } catch {
    // 模型把原始控制字符直接写进字符串的高频失败形态：替换为空格再试一次
    try {
      obj = JSON.parse(jsonText.replace(/[\x00-\x1F]/g, " "));
    } catch {
      return null;
    }
  }
  if (!obj || typeof obj !== "object" || Array.isArray(obj)) return null;
  const o = obj as Record<string, unknown>;
  const good = typeof o.good === "number" ? Math.round(o.good) : NaN;
  if (!Number.isFinite(good) || good < 0 || good > 100) return null;
  const reasons = (Array.isArray(o.reasons) ? o.reasons : [])
    .filter((r): r is string => typeof r === "string" && r.trim().length > 0)
    .slice(0, 6)
    .map((r) => r.trim().slice(0, 120));
  // 胜率变化的直接缘由标签（格式：第N天/第N夜 · 人物（可选）· 具体事件）；缺失/非法回退 null
  const causeLabel =
    typeof o.causeLabel === "string" && o.causeLabel.trim().length >= 4
      ? o.causeLabel.trim().slice(0, 80)
      : null;
  return { good, reasons, causeLabel };
}


/** 上帝视角 prompt：引擎快照（身份全亮）+ 座位模型表 + 版型 + 用户选项 + 最近事件 + 经验指南。
 * 快照由调用方在「prompt 构建时刻」捕获传入：标签与内容同源（杜绝 AI 思考期间对局推进
 * 导致落库的 day/phase 与 prompt 内容不匹配） */
function buildWinRatePrompt(
  rt: GameRuntime,
  snap: ReturnType<Engine["getSnapshot"]>,
  events: GameEvent[],
  prevGood: number | null,
  guide: string,
  recentLabels: string[] = [],
): { system: string; user: string } {
  const board = BOARDS.find((b) => b.id === rt.boardId);
  const campLabel = (camp: string) => (camp === "wolf" ? "狼人" : camp === "god" ? "神" : "民");
  const playerLines = snap.players.map((p) => {
    const ai = rt.seatAIs.find((a) => a.seat === p.seat);
    const status = [p.alive ? "存活" : `已死亡（${p.deathInfo ?? "死因未知"}）`];
    if (p.sheriff) status.push("警长");
    // 技能存量与查验记录是引擎权威事实（女巫解药已用就是已用），分析师据此评估，杜绝编造
    return `${p.seat}号 ${ROLE_META[p.role]?.name ?? p.role}（${campLabel(p.camp)}阵营）${status.join("·")}，模型：${ai?.model ?? "未知"}${p.stock.length ? `，技能存量：${p.stock.join("、")}` : ""}${p.checks.length ? `，查验记录：${p.checks.join("，")}` : ""}`;
  });
  const eventLines = events.map(
    (e) =>
      `#${e.seq} 第${e.day}天 ${e.phase} [${e.type}] ${e.actorLabel ?? "系统"}《${e.title}》${e.content.slice(0, 200)}`,
  );
  const system = [
    "你是狼人杀对局的分析师，拥有上帝视角（知晓所有玩家真实身份与全部事件）。",
    "你的任务：基于当前对局的一切要素，实时评估「神民阵营」的胜率（0-100 的整数）。",
    "综合考量：人数与阵营比、轮次与游戏节奏、神职存活与技能存量（女巫解药/毒药、守卫守护等）、警徽归属、死亡链、发言与投票行为的可信度、各座位所用 AI 模型的强弱对阵营表现的影响等一切要素。",
    '严格只输出 JSON（不要输出任何其他文字）：{"good": 0-100的整数, "causeLabel": "胜率变化的直接缘由标签", "reasons": ["理由1", "理由2", ...]}',
    prevGood != null
      ? `你上一次评估的神民阵营胜率是 ${prevGood}%。reasons 只写「相比上次评估、导致胜率发生变化」的新原因（新的事件、新的信息、局势转折）——不要重复此前已经给出的理由；若你的判断与上次相同，reasons 返回空数组。`
      : "reasons 只写导致胜率判断的原因与依据（这是首次评估）。",
    "causeLabel：从最近事件中定位「导致本次胜率变化的直接缘由」——它不是当前时刻的事件，而是造成胜率变动的那个具体事件；格式为「第N天/第N夜 · 人物（可选）· 具体事件」，例如「第1夜 · 3号女巫 · 毒杀5号狼人」「第2天 · 放逐投票 · 5号出局」（无明确人物时省略人物段）。",
    recentLabels.length > 0
      ? `以下缘由标签已被最近记录占用：${recentLabels.map((l) => `「${l}」`).join("")}——同一事件只允许对应一次胜率变化，不得重复引用；若你的评估与其中某条缘由相同，说明与上次判断一致：good 必须等于上次值（该次评估不落库）。`
      : "每个胜率变化事件只能对应一次胜率变化：若与上次的直接缘由是同一事件，good 必须与上次相同。",
    "reasons 最多 6 条，每条不超过 120 字。",
    "数值方向必须与理由一致：若你写的理由主要利于狼人阵营，则神民胜率 good 必须比上次下降；主要利于神民则 good 必须上升——理由与数值矛盾会被视为无效评估。",
    "每条理由必须细化到具体的行为主体与动作——写明「几号玩家（角色名）做了什么、对局势产生什么影响」（例如「3号女巫昨夜毒杀了5号狼人，狼队人数优势被抹平」），不要只写「狼队夜刀成功」「白天出了个平安夜」这类不含主体的宏观概括。",
  ].join("\n");
  const userLines = [
    `版型：${board?.name ?? rt.boardId}（${rt.boardId}）`,
    // 官方规则全文（与注入玩家的规则文本同一事实源）：分析师不知「最后一狼不开枪」，
    // 曾把神民必胜局评成狼人 100%（2026-10-15 实锤）——胜率评估必须以官方规则为准绳
    `【本局官方规则】\n${board ? boardRulesText(board, rt.options.sheriffEnabled) : "以摘要为准"}`,
    `用户配置选项：${JSON.stringify(rt.options)}`,
    `当前进度：第${snap.day}天 · ${snap.phaseLabel}（${snap.phase}）；${snap.finished ? `对局已结束，${snap.winner === "wolf" ? "狼人阵营获胜" : snap.winner === "good" ? "神民阵营获胜" : "未分胜负"}` : "对局进行中"}`,
    "",
    "玩家（上帝视角，身份全亮）：",
    ...playerLines,
    "",
    "最近事件（按时间顺序）：",
    ...(eventLines.length > 0 ? eventLines : ["（暂无事件）"]),
  ];
  // 经验指南为空时不注入该小节；超长截断到 4000 字符，防止指南膨胀导致 prompt 爆 token
  const guideText = guide.trim().slice(0, 4000);
  if (guideText) {
    userLines.push(
      "",
      "经验指南（通用指南 + 本版型指南，分析师经验沉淀，供你评估时参考）：",
      guideText,
    );
  }
  const user = userLines.join("\n");
  return { system, user };
}


/** 胜率分析结果："stored"=落库 / "same"=胜率未变不落库 / "stale"=内容已过时丢弃（调用方立即重评） / "skip"=其余静默跳过 */
export type WinRateAnalysisResult = "stored" | "same" | "stale" | "skip";



/** 胜率集群工厂：注入指南缓存读取器，返回四个胜率函数（service.ts 顶层接线一次） */
export function createWinRate(deps: {
  getCachedGuideText: (userId: string | null, boardId: string) => Promise<string>;
}) {

  /** 执行一次胜率分析：AI 评估 → 解析校验 → 新鲜度守门 → 落库（入库后无需更新 rt，前端走轮询游标拉取）。
   * 标签与内容同源：落库的 day/phase/triggerLabel 全部锚定「prompt 构建时刻」的快照与事件，
   * 不再用 AI 返回时刻的状态（AI 思考 30-90s 期间对局可能已推进数步，旧写法标签严重滞后内容） */
  async function runWinRateAnalysis(gameId: string, rt: GameRuntime): Promise<WinRateAnalysisResult> {
    // 分析配置：优先分析师配置，缺省回落到 1 号座位的座位配置（分析师与玩家共用同一 agent）
    const base = rt.analystAi ?? (rt.seatAIs[0] ? {
      provider: rt.seatAIs[0].provider,
      baseUrl: rt.seatAIs[0].baseUrl,
      model: rt.seatAIs[0].model,
      apiKey: rt.seatAIs[0].apiKey,
    } : null);
    if (!base) return "skip";
    // 上一次评估：prompt 据此聚焦「导致胜率变化的新原因」（不重复旧理由）；
    // 胜率判断不变时本条不予落库（理由列表只呈现胜率实际发生变化的记录）
    const prev = await getLatestWinRate(gameId);
    // 最近已占用缘由标签（防同一事件重复对应胜率变化——prompt 警示 + 落库前去重双保险）
    const recentRows = prev ? await getWinRatesAfter(gameId, Math.max(0, prev.id - 3)) : [];
    const recentLabels = recentRows
      .map((r) => r.triggerLabel)
      .filter((l): l is string => typeof l === "string" && l.length > 0)
      .slice(-4);
    // 近乎即时：事件窗口收窄到最近 15 条（prompt 更小、评估更快），胜率依据集中在近期动态
    const events = await getLatestEvents(gameId, 15);
    // prompt 构建时刻的快照与事件游标：落库标签与内容同源 + 新鲜度守门基准
    const promptSnap = rt.engine.getSnapshot();
    const promptSeq = events.length > 0 ? events[events.length - 1].seq : 0;
    // 预演循环基准：本次评估锚定的状态游标与时刻
    rt.winRateLastEvalAt = Date.now();
    rt.winRateLastSeq = promptSeq;
    // 触发事件锚点：取本次 prompt 最近一条事件（如「4号狼人独立思考」「3号警上发言」，
    // 角色名与事件标题之间不加空格）；无事件（开局评估）为 null
    const triggerEvent = events.length > 0 ? events[events.length - 1] : null;
    const triggerLabel = triggerEvent
      ? triggerEvent.actor != null
        ? `${triggerEvent.actor}号${
            ROLE_META[
              promptSnap.players.find((p) => p.seat === triggerEvent.actor)?.role as RoleId
            ]?.name ?? ""
          }${triggerEvent.title}`
        : triggerEvent.title
      : null;
    // 经验指南注入（与玩家决策同一缓存机制：60s 缓存 + 超时/失败退回空，绝不阻塞分析）
    const guide = await deps.getCachedGuideText(rt.userId, rt.boardId);
    const { system, user } = buildWinRatePrompt(rt, promptSnap, events, prev?.goodPct ?? null, guide, recentLabels);
    // 单次上限：评估是即时性辅助功能，超时就放（dirty 追逐/守门外层兜底），绝不拖长战线；
    // 思考型模型（kimi-k3 等）思考链耗时长，60s 必然大面积超时 → 放宽到 120s
    const res = await callAi({ ...base, seat: 0 }, system, user, {
      maxRetries: 1,
      timeoutMs: isThinkingModel(base) ? 120_000 : 60_000,
    });
    if (!res.ok || !res.text) return "skip";
    const parsed = parseWinRateOutput(res.text);
    if (!parsed) return "skip"; // 输出无法解析/越界：静默跳过，不污染记录
    // 新鲜度策略（提速对局适配）：AI 思考期间对局又推进 ≠ 丢弃——该评估锚定的是
    // 「prompt 构建时刻」的状态（day/phase/triggerLabel/causeLabel 全部同源），作为
    // 该时刻的合法读数照常落库；新事件已由 dirty 标记驱动立即重评最新状态。
    // （旧策略 stale 即丢弃：提速后对局每分钟都有新事件，慢分析师被永久判过期 → 记录饿死）
    if (prev && parsed.good === prev.goodPct) return "same"; // 胜率未变：不落库、不显示
    // 同一事件只允许对应一次胜率变化：缘由标签与上一条记录相同（归一化比对）→ 按未变化处理
    const norm = (s: string | null | undefined) => (s ?? "").replace(/\s+/g, "");
    if (parsed.causeLabel && norm(parsed.causeLabel) === norm(prev?.triggerLabel)) return "same";
    // 锚点单调性：只接受「锚定游标比已落库记录更新」的评估——乱序/同状态的评估会造成
    // 阵营颜色与涨跌方向错乱、同一变动重复出现（提速后乱序窗口显著，必须单调落库）
    if (promptSeq <= rt.winRateLastStoredSeq) return "skip";
    // 开局尚未进入第1天（初始化态无任何实质进展）不落记录：面板维持 50/50 初始态，
    // 首个事件批（第1夜降临）落盘后的触发立即补上首次评估
    if (promptSnap.day < 1) return "skip";
    await insertWinRate({
      gameId,
      day: promptSnap.day,
      phase: promptSnap.phase,
      goodPct: parsed.good,
      wolfPct: 100 - parsed.good,
      reasons: parsed.reasons,
      // 标签=胜率变化的直接缘由（分析师从事件中定位；缺省回退系统锚定的触发事件）
      triggerLabel: parsed.causeLabel ?? triggerLabel,
    });
    rt.winRateLastStoredSeq = promptSeq;
    return "stored";
  }

  /** 胜率预演循环（「预判断」机制）：对局 running 期间每 ~3.5s 巡检一次——
   * 有新事件（seq 推进）立即评估；无新事件的空隙每 20s 也做一次预演（利用玩家思考的
   * 时间空隙提前完成当前状态评估，事件落地即可秒出结果）；暂停/终局自动停止，
   * control("start")/startPostGame 恢复时重新拉起。定时器 unref，绝不阻碍进程退出。 */
  function startWinRateLoop(gameId: string, rt: GameRuntime): void {
    if (!rt.winRateEnabled || rt.winRateLoopTimer) return;
    const tick = () => {
      rt.winRateLoopTimer = null;
      if (!rt.winRateEnabled || rt.status !== "running") return;
      const advanced = rt.seq !== rt.winRateLastSeq;
      const idleMs = Date.now() - rt.winRateLastEvalAt;
      if (!rt.winRateInFlight && (advanced || idleMs >= 20_000)) {
        maybeWinRateTick(gameId, rt); // 事件追逐 / 空隙预演
      }
      const t = setTimeout(tick, 3_500);
      (t as { unref?: () => void }).unref?.();
      rt.winRateLoopTimer = t;
    };
    const t = setTimeout(tick, 3_500);
    (t as { unref?: () => void }).unref?.();
    rt.winRateLoopTimer = t;
  }

  /** 触发一次胜率分析（非阻塞）：在飞则记脏标记（完成后立即用最新状态重评，近乎即时），
   * 终局时记保底标记（在飞完成后补一次） */
  function maybeWinRateTick(gameId: string, rt: GameRuntime): void {
    if (!rt.winRateEnabled) return;
    if (rt.status !== "running" && rt.status !== "finished") return;
    if (rt.winRateInFlight) {
      if (rt.status === "finished") rt.winRateFinalPending = true; // 终局保底：在飞完成后补终局评估
      else rt.winRateDirty = true; // 在飞期间又有新事件：完成后立即重评（追逐最新状态）
      return;
    }
    rt.winRateDirty = false; // 本次评估自最新状态起步
    rt.winRateInFlight = true;
    void runWinRateAnalysis(gameId, rt)
      .catch((): WinRateAnalysisResult => "skip") // 静默：AI/DB 失败绝不阻塞对局循环
      .then((result) => {
        rt.winRateInFlight = false;
        // 终局保底：在飞期间对局收官，补一次终局状态分析
        if (rt.winRateFinalPending) {
          rt.winRateFinalPending = false;
          maybeWinRateTick(gameId, rt);
        } else if (rt.winRateDirty || result === "stale") {
          // 在飞期间又有新事件（stale 为旧路径兼容，现已不判丢弃）：立即用最新状态重评
          maybeWinRateTick(gameId, rt);
        }
      });
  }

  return { runWinRateAnalysis, startWinRateLoop, maybeWinRateTick };
}
