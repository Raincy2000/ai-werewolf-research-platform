import { describe, expect, it } from "vitest";
import { buildPrompt } from "./ai/prompts";
import { injectCircleText } from "./personaVisibility";
import { buildMirrorPrompt } from "../persona/pipeline";
import { makeCard, makePending } from "../persona/pipeline.test";
import { buildPersonaContext } from "../persona/context";

describe("心镜人格名册与自主模仿边界", () => {
  it("主体独立定向保留可见人格性别，不让女巫角色代替宿傩的男性人称", () => {
    const pending = makePending("daySpeech");
    const base = buildPrompt(pending, {});
    base.user = injectCircleText(base.user, "【人格圈层】3号=两面宿傩（男性，人称用「他」）（《咒术回战》），基本印象：力量至上。\n除此之外的玩家对你而言都是迷雾。");
    const prompt = buildMirrorPrompt(makeCard(), null, pending, null, base);
    expect(prompt.user).toContain("【主体独立定向】");
    expect(prompt.user).toContain("3号=两面宿傩（男性，人称用「他」）");
  });

  it("迷雾模式不向心镜泄露人格名册", () => {
    const pending = makePending("daySpeech");
    const base = buildPrompt(pending, {});
    base.user = injectCircleText(base.user, "【人格迷雾】本局所有玩家对你而言都是迷雾：你未获得任何玩家的人格姓名。");
    const prompt = buildMirrorPrompt(makeCard(), null, pending, null, base);
    expect(prompt.user).toContain("【人格迷雾】");
    expect(prompt.user).not.toContain("两面宿傩");
  });

  it("他人动作可以被主体观察、学习或模仿，但不由系统预置为本人习惯", () => {
    const card = makeCard({
      profile: { ...makeCard().profile, quirks: "围巾是与三笠一生羁绊的信物" },
    });
    const text = buildPersonaContext(card, null).conscious;
    expect(text).toContain("可通过主体自己的观察、学习或模仿逐渐形成");
    expect(text).toContain("系统不把他人动作预置为本人习惯");
    expect(text).not.toContain("不得挪作本人习惯");
  });
});
