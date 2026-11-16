import { describe, expect, it } from 'vitest'
import type { MirrorReport } from '../../../contracts/persona'
import { ROLE_META, type RoleId } from '../../../contracts/game'
import type { PendingDecision } from '../engine/api'
import { buildPrompt } from './prompts'
import { buildBehaviorBridge } from '../../persona/behavior-bridge'
import { buildMirrorPrompt, buildEmergencePrompt } from '../../persona/pipeline'
import { defaultPersonaParams, emptyPersonaProfile, type PersonaCard } from '../../../contracts/persona'

function makePending(role: RoleId, kind: PendingDecision['kind']): PendingDecision {
  return {
    seat: 5,
    role,
    kind,
    options: [0, 1],
    allowSkip: true,
    hint: '请结合当前局势独立判断',
    view: {
      seat: 5,
      role,
      roleName: ROLE_META[role].name,
      camp: ROLE_META[role].camp,
      day: 1,
      phase: kind === 'sheriffSpeech' ? 'day.sheriff.speech' : kind === 'sheriffRun' ? 'day.sheriff.run' : 'day.speech',
      aliveSeats: [1, 2, 3, 4, 5, 6, 7, 8, 9],
      deadSeats: [],
      revealedRoles: {},
      sheriffSeat: null,
      selfAlive: true,
      rules: { witchSelfSave: 'never' },
      publicLog: [],
      private: { seerChecks: [{ seat: 9, result: 'good' }] },
    },
  }
}

function promptFor(seed: string): string {
  return buildPrompt(makePending('seer', 'sheriffSpeech'), { strategySeed: seed } as never).user
}

const card: PersonaCard = {
  id: 1,
  name: '测试人格',
  source: 'manual',
  originName: null,
  originSource: null,
  profile: emptyPersonaProfile(),
  params: defaultPersonaParams(),
  notes: '',
  imageData: null,
  gameCount: 0,
  createdAt: new Date().toISOString(),
  updatedAt: new Date().toISOString(),
}

describe('策略主体性：系统只给规则与合法契约，不给战术答案', () => {
  it('不注入预写路线、反收敛菜单或角色打法库', () => {
    const user = promptFor('20261105003')
    expect(user).not.toContain('【策略分歧与反收敛】')
    expect(user).not.toContain('【路线：')
    expect(user).not.toContain('完整公开')
    expect(user).not.toContain('部分公开')
    expect(user).not.toContain('暂不报验')
    expect(user).not.toContain('主动带队')
    expect(user).not.toContain('切割倒钩')
    expect(user).toContain('【输出契约】')
  })

  it('对局种子不再改变提示内容或战术呈现顺序', () => {
    const a = promptFor('20261105003')
    const b = promptFor('20261106001')
    const c = promptFor('another-game')
    expect(a).toBe(b)
    expect(a).toBe(c)
  })

  it('不强制比较路线，也不额外审查与历史相同的选择', () => {
    const user = promptFor('20261105003')
    expect(user).not.toContain('至少两条')
    expect(user).not.toContain('路径依赖')
    expect(user).not.toContain('只有当下事实支持时才沿用')
    expect(user).not.toContain('认真考虑其他路线')
  })

  it('心镜与行动保留同一主体已经形成的具体战术意图', () => {
    const mirror: MirrorReport = {
      pressures: [{ param: 'sdt.autonomy', value: 90, reason: '被注视' }],
      tensions: [{ poles: [
        { param: 'sdt.autonomy', urge: '立刻上警抢归票' },
        { param: 'bigFive.neuroticism', urge: '害怕被全场误解' },
      ], intensity: 0.8 }],
      defenses: [],
      trauma: null,
      impulse: '第一天起跳报验，拿走警徽',
      selfControl: 50,
      bonds: [],
    }
    const text = buildBehaviorBridge(mirror)
    expect(text).toContain('上警')
    expect(text).toContain('起跳报验')
    expect(text).toContain('警徽')
    expect(text).toContain('害怕被全场误解')
    expect(text).not.toContain('必须重新比较合法路线')
  })

  it('心镜允许连续形成感受、意图与战术，不再进行思想内容审查', () => {
    const { system, user } = buildMirrorPrompt(card, null, makePending('seer', 'sheriffSpeech'))
    const text = `${system}\n${user}`
    expect(text).not.toContain('只报告情绪需求')
    expect(text).not.toContain('不得把冲动或诉求写成游戏动作')
    expect(text).not.toContain('具体战术由后续候选路线比较决定')
  })

  it('人格目标不由系统统一规定为求胜', () => {
    const mirror: MirrorReport = {
      pressures: [], tensions: [], defenses: [], trauma: null,
      impulse: '', selfControl: 50, bonds: [],
    }
    const { system } = buildEmergencePrompt(card, mirror, null, buildPrompt(makePending('seer', 'sheriffSpeech'), {}))
    expect(system).not.toContain('去赢')
    expect(system).not.toContain('好胜心')
  })
})
