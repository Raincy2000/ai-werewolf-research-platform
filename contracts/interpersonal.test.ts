// 人际网算法层单元测试（P1 验收）：纯函数、零 I/O
// 2026-10-22 P0-11 审计修复回归：cap 优先、信任留疤、分层融合、称呼硬禁止、
// 二阶认知乘积、事件显著性表 + 计数饱和、校正白名单/nextId。
import { describe, expect, it } from "vitest";
import {
  NICKNAME_LAYER_RANK,
  addressAsymmetry,
  applyCorrection,
  applyTrust,
  boundaryRecklessness,
  canUseNickname,
  checkRelationDelta,
  chooseAddress,
  computeDeltaCaps,
  deriveMetrics,
  diffRelations,
  EVENT_SALIENCE_WEIGHTS,
  eventSalience,
  eventStats,
  familiarEnough,
  familiarityScore,
  familiarityThreshold,
  isAddressCandidateAllowed,
  isDisclosureUpgrade,
  isNicknameAware,
  linkCorrection,
  mergeLayers,
  nicknameBreadth,
  rankHierarchy,
  sanitizeCorrectionPatch,
  scoreAddressCandidate,
  stepDownLayer,
  trustCeiling,
  type AddressContext,
  type Nickname,
  type RelationRow,
  RELATION_FORMS, RELATION_KINDS, RELATION_KIND_TO_FORM, MECHANISM_VERSION,
  granularityScore, scoreToGranularity, visibilityOf, canAssertDimension,
  biasRisk, perceptionAccuracy,
} from "./interpersonal";

const nk = (over: Partial<Nickname>): Nickname => ({
  text: "某称呼", layer: "public", awareness: "all", usage: "all",
  ...over,
});

const rel = (over: Partial<RelationRow>): RelationRow => ({
  fromPersonaId: 1, toPersonaId: 2, layer: "vale", form: "CS", kind: "unspecified",
  positivity: 0, negativity: 0, trust: 50, status: "active",
  ...over,
});

describe("§17 昵称层：亲密度与使用权", () => {
  it("familiarityScore：closeness 直通 / positivity+trust 组合", () => {
    expect(familiarityScore({ closeness: 70 })).toBe(70);
    expect(familiarityScore({ positivity: 80, trust: 65 })).toBe(65);
    expect(familiarityScore(null)).toBe(0);
  });

  it("familiarityScore 输入域 clamp：越界值不污染口径", () => {
    expect(familiarityScore({ closeness: 150, positivity: 200, trust: 250 })).toBe(100);
    expect(familiarityScore({ closeness: -20 })).toBe(0);
    expect(familiarityScore({ positivity: NaN, trust: 65 })).toBe(0);
  });

  it("公开层：人人可用", () => {
    const n = nk({ layer: "public" });
    expect(canUseNickname(n, 99, 1)).toBe(true);
  });

  it("★ 亲密层：认知公开，但使用权受限（未达门槛不可用）", () => {
    const n = nk({ layer: "intimate", usage: "threshold", threshold: 60 });
    expect(isNicknameAware(n, 99, 1)).toBe(true); // 知道它存在
    expect(canUseNickname(n, 99, 1, { closeness: 30 })).toBe(false); // 没资格叫
    expect(canUseNickname(n, 99, 1, { closeness: 70 })).toBe(true); // 够近才能叫
  });

  it("★ 亲密层：越界使用（allowReckless）—— 允许但需记录（§17.4）", () => {
    const n = nk({ layer: "intimate", usage: "threshold", threshold: 60 });
    expect(canUseNickname(n, 99, 1, { closeness: 10 }, { allowReckless: true })).toBe(true);
  });

  it("★ 口径统一（P0-11）：familiarEnough 与 threshold 判定一致", () => {
    const n = nk({ layer: "intimate", usage: "threshold", threshold: 60 });
    // 探针 (61,61)：旧实现 score=61≥60 可用，但 familiarEnough=false → 现在必须一致为 false
    const probe = { positivity: 61, trust: 61 };
    expect(familiarEnough(probe)).toBe(false);
    expect(canUseNickname(n, 99, 1, probe)).toBe(false);
    // 达标组合（positivity≥70 且 trust≥60）两套口径都应为 true
    const qualified = { positivity: 80, trust: 65 };
    expect(familiarEnough(qualified)).toBe(true);
    expect(canUseNickname(n, 99, 1, qualified)).toBe(true);
  });

  it("threshold 缺省时按 NICKNAME_LAYER_DEFAULTS 分层回落（不再硬编码 60）", () => {
    const priv = nk({ layer: "private", usage: "threshold" }); // 无 threshold → 该层默认 80
    expect(familiarityThreshold(priv)).toBe(80);
    expect(canUseNickname(priv, 99, 1, { closeness: 70 })).toBe(false); // 70 < 80
    expect(canUseNickname(priv, 99, 1, { closeness: 85 })).toBe(true);
    const pub = nk({ layer: "public", usage: "threshold" }); // 该层默认 0 = 不设门槛
    expect(familiarityThreshold(pub)).toBe(0);
    expect(canUseNickname(pub, 99, 1)).toBe(true);
    const secret = nk({ layer: "secret", usage: "self" });
    expect(familiarityThreshold(secret)).toBe(100);
  });

  it("私人层：非允许者连**认知**都没有", () => {
    const n = nk({ layer: "private", awareness: "private", usage: "specific", allowedIds: [7] });
    expect(isNicknameAware(n, 99, 1)).toBe(false);
    expect(canUseNickname(n, 99, 1)).toBe(false);
    expect(isNicknameAware(n, 7, 1)).toBe(true);
    expect(canUseNickname(n, 7, 1)).toBe(true);
  });

  it("隐秘层：他人永不可用；本人始终可用", () => {
    const n = nk({ layer: "secret", awareness: "self", usage: "self" });
    expect(canUseNickname(n, 99, 1)).toBe(false);
    expect(canUseNickname(n, 1, 1)).toBe(true);
  });

  it("共有人（Petronio）：泄漏后可见（§20.4）", () => {
    const n = nk({ layer: "secret", awareness: "self", usage: "self", coOwners: [7] });
    expect(isNicknameAware(n, 7, 1)).toBe(true);
    expect(canUseNickname(n, 7, 1)).toBe(false); // 可见但仍不可用
  });

  it("披露广度（社会渗透理论 breadth）", () => {
    const b = nicknameBreadth([
      nk({ layer: "public" }), nk({ layer: "public" }),
      nk({ layer: "intimate" }), nk({ layer: "secret" }),
    ]);
    expect(b).toEqual({ public: 2, intimate: 1, private: 0, secret: 1 });
  });

  it("称呼不对称（Brown & Gilman）：层差即权力/亲密度差", () => {
    expect(addressAsymmetry(nk({ layer: "intimate" }), nk({ layer: "public" }))).toBe(1);
    expect(addressAsymmetry(nk({ layer: "public" }), nk({ layer: "public" }))).toBe(0);
  });

  it("越界倾向由特质推导", () => {
    const reckless = boundaryRecklessness({ narcissism: 90, machiavellianism: 90, agreeableness: 20 });
    const gentle = boundaryRecklessness({ narcissism: 20, machiavellianism: 20, agreeableness: 90 });
    expect(reckless).toBeGreaterThan(gentle);
  });
});

describe("§21 称呼的语境选择（核心：不是默认最高层）", () => {
  const eligible = [
    nk({ text: "艾伦", layer: "intimate", usage: "threshold", threshold: 60 }),
    nk({ text: "艾伦·耶格尔", layer: "public", usage: "all" }),
  ];

  it("★ 私下 + 亲近 → 用亲密层", () => {
    const got = chooseAddress({ eligible, setting: "private", intent: "affiliate" });
    expect(got?.text).toBe("艾伦");
  });

  it("★ 生气（负价+高唤醒）→ **主动降级**到全名", () => {
    const got = chooseAddress({
      eligible, setting: "private", intent: "warn",
      emotion: { valence: -0.8, arousal: 0.9 },
    });
    expect(got?.text).toBe("艾伦·耶格尔");
  });

  it("★ 正式场合 → 降级（不宜用亲密称呼）", () => {
    const got = chooseAddress({ eligible, setting: "formal" });
    expect(got?.text).toBe("艾伦·耶格尔");
  });

  it("公开场合 + publicUse=false 的称呼被硬禁止", () => {
    const hidden = nk({ text: "小名", layer: "intimate", usage: "threshold", threshold: 10, publicUse: false });
    const got = chooseAddress({ eligible: [hidden, nk({ text: "全名" })], setting: "public" });
    expect(got?.text).toBe("全名");
  });

  it("★ 硬禁止不是扣分（P0-11）：候选只剩 publicUse=false 时返回 null", () => {
    const hidden = nk({ text: "小名", layer: "intimate", usage: "threshold", threshold: 10, publicUse: false });
    expect(chooseAddress({ eligible: [hidden], setting: "public" })).toBeNull();
  });

  it("★ protectOther 时蔑称被硬禁止；若无替代候选返回 null", () => {
    const slur = nk({ text: "废物", layer: "public", tone: "derogatory" });
    expect(chooseAddress({ eligible: [slur], setting: "private", faceNeed: "protectOther" })).toBeNull();
    const got = chooseAddress({
      eligible: [slur, nk({ text: "艾伦", layer: "public" })],
      setting: "private", faceNeed: "protectOther",
    });
    expect(got?.text).toBe("艾伦");
  });

  it("硬禁止只对公开场合生效：私下仍可用 publicUse=false 的称呼", () => {
    const hidden = nk({ text: "小名", layer: "intimate", usage: "threshold", threshold: 10, publicUse: false });
    expect(chooseAddress({ eligible: [hidden], setting: "private" })?.text).toBe("小名");
    expect(isAddressCandidateAllowed(hidden, { setting: "public" })).toBe(false);
    expect(isAddressCandidateAllowed(hidden, { setting: "formal" })).toBe(true);
  });

  it("无可用称呼时返回 null", () => {
    expect(chooseAddress({ eligible: [], setting: "private" })).toBeNull();
  });

  it("评分函数可直接断言：警告意图压低高层得分", () => {
    const hi = nk({ text: "昵称", layer: "private", usage: "specific" });
    const lo = nk({ text: "全名", layer: "public" });
    const ctx: AddressContext = { eligible: [], setting: "private", intent: "warn" };
    expect(scoreAddressCandidate(lo, ctx)).toBeGreaterThan(scoreAddressCandidate(hi, ctx));
  });
});

describe("§17.5 层级迁移工具", () => {
  it("stepDownLayer 逐层内收，底为 public", () => {
    expect(stepDownLayer("secret")).toBe("private");
    expect(stepDownLayer("private")).toBe("intimate");
    expect(stepDownLayer("public")).toBe("public");
  });
  it("isDisclosureUpgrade：向外披露为 true", () => {
    expect(isDisclosureUpgrade("secret", "public")).toBe(true);
    expect(isDisclosureUpgrade("public", "secret")).toBe(false);
  });
  it("层级序单调", () => {
    expect(NICKNAME_LAYER_RANK.public).toBeLessThan(NICKNAME_LAYER_RANK.secret);
  });
});

describe("§12.2 双维情感与指标", () => {
  it("★ 爱恨可并存：ambivalence = min，involvement = max", () => {
    const m = deriveMetrics(rel({ positivity: 100, negativity: 95 }));
    expect(m.involvement).toBe(100);
    expect(m.ambivalence).toBe(95); // 三笠↔艾伦
    expect(m.netAffect).toBe(5);
  });
  it("中性关系矛盾度为 0", () => {
    expect(deriveMetrics(rel({ positivity: 0, negativity: 0 })).ambivalence).toBe(0);
  });
});

describe("§5.2 两层融合：只有双维情感取 max（P0-11）", () => {
  it("★ canon 的爱不被 vale 的恨抹掉（双向保留）", () => {
    const canon = [rel({ layer: "canon", kind: "beloved", positivity: 100, negativity: 10 })];
    const vale = [rel({ layer: "vale", kind: "beloved", positivity: 20, negativity: 95 })];
    const merged = mergeLayers(canon, vale);
    expect(merged).toHaveLength(1);
    expect(merged[0]!.positivity).toBe(100); // 爱保留
    expect(merged[0]!.negativity).toBe(95); // 恨保留
    expect(deriveMetrics(merged[0]!).ambivalence).toBe(95);
  });

  it("★ trust 不取 max：canon trust=90 + vale trust=20 仍为 90（旧实现会抬到 90 但来源混乱）", () => {
    const merged = mergeLayers(
      [rel({ layer: "canon", kind: "beloved", trust: 90, positivity: 10 })],
      [rel({ layer: "vale", kind: "beloved", trust: 20, positivity: 30 })],
    );
    expect(merged[0]!.trust).toBe(90);
    expect(merged[0]!.positivity).toBe(30); // 只有双维取 max
  });

  it("closeness/dependence/reciprocity/commitment 保留 canon 值，不被 vale 抬高", () => {
    const merged = mergeLayers(
      [rel({ layer: "canon", kind: "comrade", closeness: 80, dependence: 70, reciprocity: 60, commitment: 90 })],
      [rel({ layer: "vale", kind: "comrade", closeness: 10, dependence: 20, reciprocity: 30, commitment: 40 })],
    );
    expect(merged[0]!.closeness).toBe(80);
    expect(merged[0]!.dependence).toBe(70);
    expect(merged[0]!.reciprocity).toBe(60);
    expect(merged[0]!.commitment).toBe(90);
  });

  it("融合行输出 sources 且 layer 保持既有值 canon（向后兼容读模型）", () => {
    const merged = mergeLayers(
      [rel({ layer: "canon", kind: "beloved" })],
      [rel({ layer: "vale", kind: "beloved" })],
    );
    expect(merged[0]!.layer).toBe("canon");
    expect(merged[0]!.sources).toEqual(["canon", "vale"]);
  });

  it("单层行也标注来源：canon-only / vale-only", () => {
    const canonOnly = mergeLayers([rel({ layer: "canon", kind: "kin" })], []);
    expect(canonOnly[0]!.sources).toEqual(["canon"]);
    const valeOnly = mergeLayers([], [rel({ layer: "vale", kind: "rival" })]);
    expect(valeOnly[0]!.sources).toEqual(["vale"]);
    expect(valeOnly[0]!.layer).toBe("vale");
  });

  it("★ canon 的 kind 永不被删除（vale 独有 kind 只增）", () => {
    const canon = [rel({ layer: "canon", kind: "kin" })];
    const vale = [rel({ layer: "vale", kind: "rival" })];
    const merged = mergeLayers(canon, vale);
    expect(merged.map((r) => r.kind).sort()).toEqual(["kin", "rival"]);
  });
});

describe("依恋层级排序（C7）：按观察者分组", () => {
  it("按卷入度降序，同分按 id 稳定", () => {
    const rows = [
      rel({ id: 1, positivity: 10 }),
      rel({ id: 2, negativity: 90 }),
      rel({ id: 3, positivity: 40 }),
    ];
    const ranked = rankHierarchy(rows);
    expect(ranked[0]!.id).toBe(2);
    expect(ranked.map((r) => r.rank)).toEqual([1, 2, 3]);
  });

  it("★ 分组排名（P0-11）：每个观察者的 rank 各自从 1 开始，不再跨人混排", () => {
    const rows = [
      rel({ id: 1, fromPersonaId: 1, positivity: 10 }),
      rel({ id: 2, fromPersonaId: 2, negativity: 90 }),
      rel({ id: 3, fromPersonaId: 1, negativity: 80 }),
      rel({ id: 4, fromPersonaId: 2, positivity: 5 }),
    ];
    const ranked = rankHierarchy(rows);
    expect(ranked.map((r) => r.id)).toEqual([3, 1, 2, 4]);
    expect(ranked.map((r) => r.rank)).toEqual([1, 2, 1, 2]);
  });

  it("observerId 过滤：只返回该观察者的层级", () => {
    const rows = [
      rel({ id: 1, fromPersonaId: 1 }),
      rel({ id: 2, fromPersonaId: 2, positivity: 90 }),
    ];
    const ranked = rankHierarchy(rows, 2);
    expect(ranked.map((r) => r.id)).toEqual([2]);
    expect(ranked[0]!.rank).toBe(1);
  });
});

describe("§12.5 显著性调节的幅度上限", () => {
  it("显著性越高允许幅度越大，且有界", () => {
    const low = computeDeltaCaps("positivity", 0.2);
    const high = computeDeltaCaps("positivity", 3.0);
    expect(high.cap).toBeGreaterThan(low.cap);
    expect(computeDeltaCaps("positivity", 99).cap).toBe(computeDeltaCaps("positivity", 3).cap);
    expect(computeDeltaCaps("positivity", NaN).cap).toBe(computeDeltaCaps("positivity", 0.2).cap);
  });
});

describe("§13.3 增量校验：三态判定（cap 优先于 tolerance）", () => {
  it("无事件 → undeterminable（宁可漏检不可误改）", () => {
    const r = checkRelationDelta({ param: "positivity", layer: "vale", actualDelta: 50, events: [], salience: 1 });
    expect(r.verdict).toBe("undeterminable");
  });

  it("与事件推导一致 → consistent", () => {
    const r = checkRelationDelta({
      param: "positivity", layer: "vale", actualDelta: 10, salience: 1,
      events: [{ kind: "joint_win", eventId: 1, weight: 10 }],
    });
    expect(r.verdict).toBe("consistent");
  });

  it("★ 超出显著性上限 → anomalous 并给出建议值", () => {
    const r = checkRelationDelta({
      param: "positivity", layer: "vale", actualDelta: 90, salience: 0.2,
      events: [{ kind: "vote_for", eventId: 1, weight: 2 }],
    });
    expect(r.verdict).toBe("anomalous");
    expect(r.suggestedDelta).toBe(2);
  });

  it("★ 先判 cap 再判 tolerance（审计探针）：Δ=17、cap=2 → anomalous 而不是 consistent", () => {
    const r = checkRelationDelta({
      param: "positivity", layer: "vale", actualDelta: 17, salience: 0.2,
      events: [{ kind: "vote_for", eventId: 1, weight: 2 }],
    });
    expect(r.verdict).toBe("anomalous");
  });

  it("|expected|>cap（事件本身超出上限）→ undeterminable", () => {
    const r = checkRelationDelta({
      param: "positivity", layer: "vale", actualDelta: 5, salience: 0.2,
      events: [{ kind: "betrayal", eventId: 1, weight: 40 }],
    });
    expect(r.verdict).toBe("undeterminable");
  });

  it("方向相反 → anomalous", () => {
    const r = checkRelationDelta({
      param: "trust", layer: "vale", actualDelta: 20, salience: 1,
      events: [{ kind: "betrayal", eventId: 1, weight: -20 }],
    });
    expect(r.verdict).toBe("anomalous");
  });

  it("★ suggestedDelta = clamp100(before+expected)-before（相对当前值折算）", () => {
    const up = checkRelationDelta({
      param: "trust", layer: "canon", before: 95, actualDelta: 30, salience: 1,
      events: [{ kind: "joint_win", eventId: 1, weight: 10 }],
    });
    expect(up.verdict).toBe("anomalous");
    expect(up.suggestedDelta).toBe(5); // clamp100(95+10)=100 → 100-95
    const down = checkRelationDelta({
      param: "positivity", layer: "vale", before: 5, actualDelta: -30, salience: 1,
      events: [{ kind: "vote_against", eventId: 2, weight: -10 }],
    });
    expect(down.verdict).toBe("anomalous");
    expect(down.suggestedDelta).toBe(-5); // clamp100(5-10)=0 → 0-5
  });

  it("★ §13.3 第 7 步 trust 留疤：after 超过 100-10×violationCount → anomalous", () => {
    const r = checkRelationDelta({
      param: "trust", layer: "canon", before: 88, after: 96, violationCount: 1,
      actualDelta: 8, salience: 1,
      events: [{ kind: "same_camp", eventId: 1, weight: 50 }],
    });
    expect(r.verdict).toBe("anomalous");
    expect(r.reason).toContain("留疤");
  });

  it("同一 eventId 重复出现只计一次（证据去重）", () => {
    const r = checkRelationDelta({
      param: "closeness", layer: "vale", actualDelta: 5, salience: 1,
      events: [
        { kind: "joint_win", eventId: 7, weight: 5 },
        { kind: "joint_win", eventId: 7, weight: 5 },
      ],
    });
    expect(r.verdict).toBe("consistent"); // expected 去重后 = 5，与 Δ 一致
    expect(r.evidence).toHaveLength(1);
  });
});

describe("补完 diff：keep / correct / fill", () => {
  it("三态正确（原本正确的不改）", () => {
    const items = diffRelations(
      { positivity: 50, trust: 60 },
      { positivity: 50, trust: 80, closeness: 30 },
    );
    const byParam = Object.fromEntries(items.map((i) => [i.param, i.action]));
    expect(byParam.positivity).toBe("keep");
    expect(byParam.trust).toBe("correct");
    expect(byParam.closeness).toBe("fill");
  });
});

describe("§13.5 校正执行：不删除原行 + 白名单 + nextId", () => {
  it("原行标 superseded，新行 active 且无 id", () => {
    const row = rel({ id: 9, positivity: 10 });
    const { superseded, next } = applyCorrection(row, { positivity: 30 });
    expect(superseded.status).toBe("superseded");
    expect(superseded.id).toBe(9);
    expect(next.status).toBe("active");
    expect(next.id).toBeUndefined();
    expect(next.positivity).toBe(30);
  });

  it("★ patch 白名单：id/fromPersonaId/toPersonaId/layer/status/supersededBy 一律忽略", () => {
    const row = rel({ id: 9, positivity: 10, trust: 50 });
    const patch = {
      positivity: 30,
      id: 999,
      fromPersonaId: 5,
      toPersonaId: 7,
      layer: "canon",
      status: "superseded",
      supersededBy: 3,
      evilField: 1,
    } as unknown as Partial<RelationRow>;
    const { superseded, next } = applyCorrection(row, patch);
    expect(next.positivity).toBe(30);
    expect(next.id).toBeUndefined(); // id 不能被 patch 覆盖
    expect(next.fromPersonaId).toBe(1);
    expect(next.toPersonaId).toBe(2);
    expect(next.layer).toBe("vale");
    expect(next.status).toBe("active");
    expect(superseded.id).toBe(9);
    expect(superseded.status).toBe("superseded");
    expect(superseded.supersededBy).toBeNull(); // 不再自指
  });

  it("★ 数值 clamp：positivity 999→100、powerBalance -300→-100、trust -5→0", () => {
    const row = rel({ id: 1, positivity: 10, trust: 50 });
    const { next } = applyCorrection(row, { positivity: 999, powerBalance: -300, trust: -5 });
    expect(next.positivity).toBe(100);
    expect(next.powerBalance).toBe(-100);
    expect(next.trust).toBe(0);
  });

  it("kind/form 清洗：kind 接受受控词表值，非法 form 被忽略，NaN 数值忽略", () => {
    const row = rel({ id: 1, kind: "unspecified", form: "CS", trust: 50 });
    const ok = applyCorrection(row, { kind: "rival", form: "EM" });
    expect(ok.next.kind).toBe("rival");
    expect(ok.next.form).toBe("EM");
    const bad = applyCorrection(row, { kind: "", form: "ZZ" as never, trust: NaN, positivity: Infinity });
    expect(bad.next.kind).toBe("unspecified"); // 空 kind 忽略
    expect(bad.next.form).toBe("CS"); // 非法 form 忽略
    expect(bad.next.trust).toBe(50); // NaN 不落库
    expect(bad.next.positivity).toBe(0); // Infinity 不落库（保留原值）
  });

  it("★ 返回 nextId（P1-8）：supersededBy 指向新行而非自己", () => {
    const row = rel({ id: 9 });
    const result = applyCorrection(row, { positivity: 30 }, 42);
    expect(result.nextId).toBe(42);
    expect(result.next.id).toBe(42);
    expect(result.superseded.supersededBy).toBe(42);
    expect(result.superseded.supersededBy).not.toBe(row.id); // 不再自指
  });

  it("linkCorrection：写收口插入后回填新行 id（纯函数不触碰 DB）", () => {
    const row = rel({ id: 9 });
    const plan = applyCorrection(row, { positivity: 30 });
    expect(plan.nextId).toBeNull();
    const linked = linkCorrection(plan, 77);
    expect(linked.nextId).toBe(77);
    expect(linked.next.id).toBe(77);
    expect(linked.superseded.supersededBy).toBe(77);
    // 不变式：原 plan 不被就地修改
    expect(plan.next.id).toBeUndefined();
    expect(plan.superseded.supersededBy).toBeNull();
  });

  it("sanitizeCorrectionPatch 可直接断言：只保留白名单字段", () => {
    const clean = sanitizeCorrectionPatch({
      trust: 120,
      powerBalance: 500,
      kind: "nemesis",
      form: "CS",
      id: 3,
      layer: "canon",
    } as unknown as Partial<RelationRow>);
    expect(clean).toEqual({ trust: 100, powerBalance: 100, kind: "nemesis", form: "CS" });
  });
});

describe("§17.4 山谷事件统计（零 AI）", () => {
  it("统计各交互类型", () => {
    const s = eventStats([
      { kind: "same_camp", eventId: 1 },
      { kind: "vote_against", eventId: 2 },
      { kind: "killed_by", eventId: 3 },
      { kind: "betrayal", eventId: 4 },
    ]);
    expect(s.sameCamp).toBe(1);
    expect(s.votesAgainst).toBe(1);
    expect(s.killedBy).toBe(1);
    expect(s.betrayal).toBe(1);
  });

  it("★ killed / killed_by 保留频次（P0-11：旧实现布尔化丢次数）", () => {
    const s = eventStats([
      { kind: "killed", eventId: 1 },
      { kind: "killed", eventId: 2 },
      { kind: "killed_by", eventId: 3 },
    ]);
    expect(s.killedThem).toBe(2);
    expect(s.killedBy).toBe(1);
  });

  it("eventId 去重：同一事件重复出现只计一次", () => {
    const s = eventStats([
      { kind: "vote_against", eventId: 9 },
      { kind: "vote_against", eventId: 9 },
      { kind: "opposed_camp", eventId: 10 },
    ]);
    expect(s.votesAgainst).toBe(1);
    expect(s.opposedCamp).toBe(1);
  });

  it("★ 显著性档位表（§12.5）：亲手终结 3.0 / 背叛 2.5 / 关键局出局 1.5 / 同阵营 0.5", () => {
    const sal = (kind: Parameters<typeof eventStats>[0][number]["kind"]) =>
      eventSalience(eventStats([{ kind, eventId: 1 }]));
    expect(sal("killed")).toBe(3.0); // 亲手终结（kin_slayer）——审计要求可达 3.0
    expect(sal("betrayal")).toBeCloseTo(2.5, 10);
    expect(sal("killed_by")).toBeCloseTo(1.5, 10);
    expect(sal("same_camp")).toBeCloseTo(0.5, 10);
    expect(sal("vote_against")).toBeCloseTo(1.0, 10);
  });

  it("opposed_camp / skill_targeted / joint_win / joint_loss 全部纳入显著性", () => {
    const base = eventSalience(eventStats([]));
    expect(base).toBe(0.2);
    for (const kind of ["opposed_camp", "skill_targeted", "joint_win", "joint_loss"] as const) {
      expect(EVENT_SALIENCE_WEIGHTS[kind]).toBeGreaterThan(0);
      expect(eventSalience(eventStats([{ kind, eventId: 1 }]))).toBeGreaterThan(base);
    }
  });

  it("计数饱和：重复事件提高显著性但有上限，总体封顶 3.0", () => {
    const once = eventSalience(eventStats([{ kind: "vote_against", eventId: 1 }]));
    const twice = eventSalience(eventStats([
      { kind: "vote_against", eventId: 1 },
      { kind: "vote_against", eventId: 2 },
    ]));
    const saturated = eventSalience(eventStats(
      Array.from({ length: 100 }, (_, i) => ({ kind: "vote_against" as const, eventId: i })),
    ));
    expect(twice).toBeGreaterThan(once);
    expect(saturated).toBeGreaterThan(twice);
    expect(saturated).toBeLessThanOrEqual(1.5);
    // 各类事件叠加仍不超上限
    const everything = eventSalience(eventStats([
      { kind: "killed", eventId: 1 }, { kind: "betrayal", eventId: 2 },
      { kind: "killed_by", eventId: 3 }, { kind: "vote_against", eventId: 4 },
      { kind: "same_camp", eventId: 5 }, { kind: "opposed_camp", eventId: 6 },
      { kind: "skill_targeted", eventId: 7 }, { kind: "joint_win", eventId: 8 },
      { kind: "joint_loss", eventId: 9 },
    ]));
    expect(everything).toBe(3.0);
  });

  it("事件显著性随严重度上升且封顶 3.0", () => {
    const mild = eventSalience(eventStats([{ kind: "same_camp", eventId: 1 }]));
    const harsh = eventSalience(eventStats([{ kind: "betrayal", eventId: 1 }]));
    expect(harsh).toBeGreaterThan(mild);
    expect(harsh).toBeLessThanOrEqual(3.0);
  });
});

describe("§12.6 信任留疤", () => {
  it("背叛次数永久压低信任上限", () => {
    expect(trustCeiling(0)).toBe(100);
    expect(trustCeiling(1)).toBe(90);
    expect(trustCeiling(3)).toBe(70);
    expect(trustCeiling(NaN)).toBe(100); // P0-11：非数字计数按 0 处理，不再返回 NaN
  });

  it("★ 背叛后即使修复也回不到原值", () => {
    expect(applyTrust(50, 100, 1)).toBe(90); // 想升到 100，被上限压到 90
    expect(applyTrust(50, -20, 0)).toBe(30); // 下降不受上限影响
  });

  it("★ 正增量不允许把已高于上限的值往下拉（审计探针 applyTrust(95,+1,1)=95）", () => {
    expect(applyTrust(95, 1, 1)).toBe(95);
    expect(applyTrust(95, -1, 1)).toBe(94); // 下降正常生效
    expect(applyTrust(NaN, 5, 0)).toBe(5); // 旧值坏值按 0
  });
});

describe("§24 二阶关系认知（乘积模型）", () => {
  it("粒度评分：来源权重主导（canon > observed > rumor > inferred）", () => {
    const base = { distanceToActor: 0.5, faculty: 0.5, structuralPosition: 0.5, targetKnowledge: 0.5 };
    const a = granularityScore({ ...base, source: "canon" });
    const b = granularityScore({ ...base, source: "observed" });
    const c = granularityScore({ ...base, source: "rumor" });
    const d = granularityScore({ ...base, source: "inferred" });
    expect(a).toBeGreaterThan(b);
    expect(b).toBeGreaterThan(c);
    expect(c).toBeGreaterThan(d);
  });

  it("★ faculty=0 归零（P0-11：旧实现仍得 0.3，注释与实现不符）", () => {
    const score = granularityScore({
      source: "canon", distanceToActor: 0, faculty: 0,
      structuralPosition: 1, targetKnowledge: 1,
    });
    expect(score).toBe(0);
    expect(scoreToGranularity(score)).toBe("L0");
  });

  it("输入域 clamp：faculty 超界等价于 1，负值等价于 0", () => {
    const hi = granularityScore({ source: "canon", distanceToActor: 0, faculty: 2, structuralPosition: 0, targetKnowledge: 0 });
    const one = granularityScore({ source: "canon", distanceToActor: 0, faculty: 1, structuralPosition: 0, targetKnowledge: 0 });
    expect(hi).toBe(one);
    const neg = granularityScore({ source: "canon", distanceToActor: 1, faculty: -3, structuralPosition: 0, targetKnowledge: 0 });
    expect(neg).toBe(0);
  });

  it("来源为 inferred 且其他因子为 0 → L0", () => {
    const score = granularityScore({ source: "inferred", distanceToActor: 1, faculty: 0, structuralPosition: 0, targetKnowledge: 0 });
    expect(scoreToGranularity(score)).toBe("L0");
  });

  it("高来源 + 高因子 → L3/L4（阿尔敏式）", () => {
    const score = granularityScore({ source: "canon", distanceToActor: 0.1, faculty: 0.9, structuralPosition: 0.8, targetKnowledge: 0.9 });
    expect(["L3", "L4"]).toContain(scoreToGranularity(score));
  });

  it("可见度三档（§23.5）；非法 confidence → invisible", () => {
    expect(visibilityOf(0.9)).toBe("clear");
    expect(visibilityOf(0.5)).toBe("blurred");
    expect(visibilityOf(0.1)).toBe("invisible");
    expect(visibilityOf(NaN)).toBe("invisible");
  });

  it("L2 以上才能断言某维度", () => {
    expect(canAssertDimension("L1")).toBe(false);
    expect(canAssertDimension("L2")).toBe(true);
  });

  it("投射悖论（§23.6）：越亲近偏差风险越高；clamp 到 [0,1]", () => {
    expect(biasRisk("balance", 90)).toBeGreaterThan(biasRisk("balance", 10));
    expect(biasRisk("balance", 999)).toBeLessThanOrEqual(1);
    expect(biasRisk("balance", 999)).toBeGreaterThanOrEqual(0);
    expect(biasRisk("balance", -500)).toBe(biasRisk("balance", 0)); // 负亲近度 clamp 到 0
    expect(biasRisk("balance", NaN)).toBe(biasRisk("balance", 0));
  });

  it("认知准确性（Krackhardt CSS）；越界输入 clamp", () => {
    expect(perceptionAccuracy({ positivity: 100 }, { positivity: 100 })).toBe(1);
    expect(perceptionAccuracy({ positivity: 0 }, { positivity: 100 })).toBeLessThan(0.6);
    expect(perceptionAccuracy({ positivity: 999 }, { positivity: 200 })).toBe(1);
  });

  it("scoreToGranularity 阈值边界稳定（0.2/0.4/0.6/0.8）", () => {
    expect(scoreToGranularity(0)).toBe("L0");
    expect(scoreToGranularity(0.2)).toBe("L1");
    expect(scoreToGranularity(0.4)).toBe("L2");
    expect(scoreToGranularity(0.6)).toBe("L3");
    expect(scoreToGranularity(0.8)).toBe("L4");
    expect(scoreToGranularity(NaN)).toBe("L0");
  });
});

describe("词表与版本（§27.3 单一事实源）", () => {
  it("Fiske 四型都在", () => {
    expect(RELATION_FORMS).toEqual(["CS", "AR", "EM", "MP"]);
  });
  it("每个 kind 都有默认 form", () => {
    for (const k of RELATION_KINDS) expect(RELATION_KIND_TO_FORM[k]).toBeDefined();
  });
  it("昵称四层有序", () => {
    expect(NICKNAME_LAYER_RANK.public).toBeLessThan(NICKNAME_LAYER_RANK.secret);
  });
  it("版本号齐全", () => {
    for (const k of ["relations", "nicknames", "perception", "delta", "cast", "weave", "invocation"]) {
      expect((MECHANISM_VERSION as Record<string, string>)[k]).toBeTruthy();
    }
  });
});
