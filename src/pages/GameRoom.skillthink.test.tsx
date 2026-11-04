import { describe, expect, it } from 'vitest'
import { renderToStaticMarkup } from 'react-dom/server'
import type { GameEvent } from '@contracts/game'
import { SkillThinkRow } from './GameRoom'

describe('SkillThinkRow 技能发动心理展示', () => {
  it('发动事实保持红字，人格心理恢复心镜模板而非整段红字', () => {
    const event = {
      seq: 1,
      day: 1,
      phase: 'day.skill',
      type: 'action',
      actor: 7,
      actorLabel: '7号玩家',
      title: '白日交刀',
      content: '7号玩家代表狼队宣布胜利！',
      thought: '这里是需要按原模板展示的心理正文',
      createdAt: '2026-11-03T00:00:00.000Z',
      meta: {
        channel: 'skillFired',
        skillObject: '4号的技能询问',
        skillChoice: 'fired',
        persona: { name: 'L', dual: true, tensions: [], gt: '博弈解释', psy: '心理解释' },
      },
    } as GameEvent
    const html = renderToStaticMarkup(<SkillThinkRow e={event} roleNameOf={() => '狼人'} />)
    expect(html).toContain('心镜 · 权衡心理')
    expect(html).toContain('这里是需要按原模板展示的心理正文')
    expect(html).not.toContain('font-bold leading-5 text-wolf')
    expect(html).toContain('发动')
  })
})
