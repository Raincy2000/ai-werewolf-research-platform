// ============================================================
// M2 审计链的数据层保证：观测幂等 + φ 计数准确性
// 直接对 SQLite DDL 建库验证（不经过 drizzle 单例），锁定「数据层」不变量。
// ============================================================
import { describe, expect, it, beforeAll } from "vitest";
import { DatabaseSync } from "node:sqlite";
import { SQLITE_DDL } from "../../db/sqlite-ddl";

let db: DatabaseSync;

const obs = (over: {
  personaId?: number; scenarioId?: string; traitPath?: string;
  direction?: string; stateValue?: number; situationClassId?: string;
}) => ({
  personaId: over.personaId ?? 1,
  scenarioId: over.scenarioId ?? "g1",
  traitPath: over.traitPath ?? "bigFive.neuroticism",
  direction: over.direction ?? "up",
  stateValue: over.stateValue ?? 70,
  situationClassId: over.situationClassId ?? "game:wolf",
});

const insert = (o: ReturnType<typeof obs>) =>
  db
    .prepare(
      `INSERT OR IGNORE INTO persona_state_observations
       (persona_id, scenario_id, scenario_kind, scenario_index, cumulative_salience,
        trait_path, state_value, direction, situation_class_id, situation_signature,
        salience, exposure_in_class, indicator_kind, source_param, created_at)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    )
    .run(
      o.personaId, o.scenarioId, "game", 1, 0,
      o.traitPath, o.stateValue, o.direction, o.situationClassId, o.situationClassId,
      50, 1, "behavior", o.traitPath, Date.now(),
    );

const count = (personaId: number, cls: string, traitPath: string, dir: string) =>
  (db
    .prepare(
      `SELECT COUNT(*) c FROM persona_state_observations
       WHERE persona_id=? AND situation_class_id=? AND trait_path=? AND direction=?`,
    )
    .get(personaId, cls, traitPath, dir) as { c: number }).c;

beforeAll(() => {
  db = new DatabaseSync(":memory:");
  // 新库路径：基础 DDL 已含 direction 列与去重唯一索引
  // （旧库路径由增量 0019 覆盖：ALTER 加列 + CREATE UNIQUE INDEX IF NOT EXISTS）
  db.exec(SQLITE_DDL);
});

describe("观测表：幂等（idx_pso_dedup 唯一索引）", () => {
  it("★ 同一 场次×参数×方向 重复写入不虚增（重放/续跑安全）", () => {
    insert(obs({}));
    insert(obs({}));
    insert(obs({}));
    expect(count(1, "game:wolf", "bigFive.neuroticism", "up")).toBe(1);
  });

  it("同参数但**异向**算两条（φ 只计同向）", () => {
    insert(obs({ scenarioId: "g2", direction: "down", stateValue: 40 }));
    expect(count(1, "game:wolf", "bigFive.neuroticism", "up")).toBe(1);
    expect(count(1, "game:wolf", "bigFive.neuroticism", "down")).toBe(1);
  });

  it("**异情境类**不并入计数", () => {
    insert(obs({ scenarioId: "g3", situationClassId: "game:good" }));
    expect(count(1, "game:wolf", "bigFive.neuroticism", "up")).toBe(1);
    expect(count(1, "game:good", "bigFive.neuroticism", "up")).toBe(1);
  });

  it("**异参数**不并入计数", () => {
    insert(obs({ scenarioId: "g4", traitPath: "bigFive.agreeableness" }));
    expect(count(1, "game:wolf", "bigFive.neuroticism", "up")).toBe(1);
    expect(count(1, "game:wolf", "bigFive.agreeableness", "up")).toBe(1);
  });

  it("**异人格**不并入计数", () => {
    insert(obs({ personaId: 2, scenarioId: "g5" }));
    expect(count(1, "game:wolf", "bigFive.neuroticism", "up")).toBe(1);
    expect(count(2, "game:wolf", "bigFive.neuroticism", "up")).toBe(1);
  });
});

describe("台账表：α_eff 与四因子必须完整落库（铁律7 可追溯）", () => {
  it("插入后可读回全部审计字段", () => {
    db.prepare(
      `INSERT INTO persona_trait_updates
       (persona_id, scenario_id, trait_path, value_from, value_to, alpha_eff,
        factors_json, observation_ids, mechanism_version, created_at)
       VALUES (?,?,?,?,?,?,?,?,?,?)`,
    ).run(1, "g1", "bigFive.neuroticism", 70, 71, 0.0085,
      JSON.stringify({ repeatCount: 1, salience: 0.4, kappa: 1, appraisal: 1 }), JSON.stringify([1]), "ewma-3.0", Date.now());
    const row = db.prepare("SELECT * FROM persona_trait_updates LIMIT 1").get() as Record<string, unknown>;
    expect(row.alpha_eff).toBeCloseTo(0.0085, 6);
    expect(row.mechanism_version).toBe("ewma-3.0");
    expect(JSON.parse(row.factors_json as string).repeatCount).toBe(1);
    expect(JSON.parse(row.observation_ids as string)).toEqual([1]);
  });

  it("value_from / value_to 必为整数（铁律1）", () => {
    const rows = db.prepare("SELECT value_from, value_to FROM persona_trait_updates").all() as { value_from: number; value_to: number }[];
    for (const r of rows) {
      expect(Number.isInteger(r.value_from)).toBe(true);
      expect(Number.isInteger(r.value_to)).toBe(true);
    }
  });
});
