import { describe, expect, it } from "vitest";
import type { GameEvent, GameSnapshot } from "../../contracts/game";
import { defaultPersonaParams, emptyPersonaProfile, type PersonaCard } from "../../contracts/persona";
import { buildAnalysisPrompt } from "./analyst";
import { buildPsyCheckPrompt } from "../persona/anatomist";
import type { EvidenceRef } from "./evidence";

const evidence: EvidenceRef[] = [179, 401].map((seq) => ({
  gameId: "game-1",
  seq,
  day: 1,
  phase: "day.speech",
  visibility: "public",
  ownerSeat: seq === 179 ? 9 : 8,
  actorLabel: `${seq === 179 ? 9 : 8}号玩家`,
  title: seq === 401 ? "遗言" : "公开发言",
  text: seq === 179 ? "我第一夜的查验：1号，狼人。" : "交个底：女巫。",
  contentHash: "hash",
}));

const events: GameEvent[] = evidence.map((ref) => ({
  seq: ref.seq,
  day: ref.day,
  phase: ref.phase,
  type: "speech",
  actor: ref.ownerSeat,
  actorLabel: ref.actorLabel,
  title: ref.title,
  content: ref.text,
  thought: null,
  meta: null,
  createdAt: new Date().toISOString(),
}));

const snapshot = {
  boardId: "whiteWolfKnight12",
  boardName: "12人白狼王骑士",
  status: "finished",
  winner: "wolf",
  day: 5,
  players: [],
} as unknown as GameSnapshot;

describe("赛后生成的完整事实输入", () => {
  it("全局复盘同时保留公开查杀与遗言，不再用压缩摘要代替完整事实", () => {
    const { user } = buildAnalysisPrompt(snapshot, events);
    expect(user).toContain("【完整事实索引】");
    expect(user).toContain("我第一夜的查验：1号，狼人。");
    expect(user).toContain("交个底：女巫。");
  });

  it("人格心理检查也能读取同一份完整事实", () => {
    const card = {
      id: 6,
      name: "夜神月",
      params: defaultPersonaParams(),
      profile: { ...emptyPersonaProfile(), gender: "男" },
    } as unknown as PersonaCard;
    const { user } = buildPsyCheckPrompt({
      card,
      seat: 9,
      roleName: "预言家",
      outcome: "第一日出局",
      digest: "压缩摘要",
      gameTitleNo: "20261107002",
      evidence,
    });
    expect(user).toContain("【完整事实索引】");
    expect(user).toContain("我第一夜的查验：1号，狼人。");
    expect(user).toContain("交个底：女巫。");
  });
});
