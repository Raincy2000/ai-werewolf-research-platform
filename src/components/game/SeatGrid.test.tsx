import { describe, expect, it } from 'vitest'
import { renderToStaticMarkup } from 'react-dom/server'
import type { PlayerSnapshot } from '@contracts/game'
import { SeatGrid } from './SeatGrid'

function player(patch: Partial<PlayerSnapshot> = {}): PlayerSnapshot {
  return {
    seat: 1,
    role: 'seer',
    roleName: '预言家',
    camp: 'god',
    alive: true,
    sheriff: false,
    deathInfo: null,
    aiModel: 'mock-model',
    personaName: null,
    personaImageData: null,
    ...patch,
  }
}

function render(players: PlayerSnapshot[], props: Partial<Parameters<typeof SeatGrid>[0]> = {}) {
  return renderToStaticMarkup(
    <SeatGrid players={players} pendingActs={[]} selectedSeat={null} onSelect={() => {}} {...props} />,
  )
}

describe('SeatGrid 座位视图', () => {
  it('有人格时使用默认边框小头像与黑体加粗文字，边框跟随状态环颜色', () => {
    const withImage = render([player({ personaName: '沉思者', personaImageData: 'data:image/png;base64,abc' })])
    expect(withImage).toContain('data-testid="seat-avatar"')
    expect(withImage).toContain('h-14 w-11')
    expect(withImage).toMatch(/data-testid="seat-avatar"[^>]*rounded-sm/)
    expect(withImage).toMatch(/data-testid="seat-avatar"[^>]*border border-border/)
    expect(withImage).toContain('<img')
    expect(withImage).toContain('号玩家')
    expect(withImage).toContain('data-testid="seat-number"')
    expect(withImage).toMatch(/data-testid="seat-number"[^>]*>1</)
    expect(withImage).not.toMatch(/data-testid="seat-number"[^>]*writing-mode/)
    expect(withImage).toContain('data-testid="persona-name"')
    expect(withImage).toContain('text-[11px] font-semibold leading-4 text-foreground')
    expect(withImage).not.toContain('border-purple')
    expect(withImage).not.toContain('text-purple')

    const selected = render([player({ personaName: '沉思者' })], { selectedSeat: 1 })
    expect(selected).toMatch(/data-testid="seat-avatar"[^>]*border-color:#78716c/)

    const fallback = render([player({ personaName: '沉思者' })])
    expect(fallback).toContain('data-testid="seat-avatar"')
    expect(fallback).toContain('>沉</')
    expect(fallback).not.toContain('<img')
  })

  it('人格名视口与头像上下边平齐，长名循环居中且副本留白', () => {
    const longName = render([player({ personaName: '一个名字特别长的人格' })])
    expect(longName).toContain('persona-name-marquee')
    expect(longName).toContain('data-testid="persona-name-viewport"')
    expect(longName).toMatch(/data-testid="persona-name-viewport"[^>]*h-14/)
    expect(longName).toContain('top-1/2')
    expect(longName).toContain('-translate-y-1/2')
    expect(longName).toContain('pb-6')

    const shortName = render([player({ personaName: '短名' })])
    expect(shortName).not.toContain('persona-name-marquee')
    expect(shortName).toContain('flex items-center')
  })

  it('无人格只显示横排座位号与角色卡，组合在座位框内垂直居中', () => {
    const html = render([player()])
    expect(html).not.toContain('data-testid="seat-avatar"')
    expect(html).not.toContain('writing-mode:vertical-rl')
    expect(html).toMatch(/data-testid="seat-main"[^>]*justify-center/)
    expect(html).toContain('1号玩家')
    expect(html).toContain('预言家')
  })

  it('角色卡按角色名收缩宽度，使用小圆角和同款待分配框', () => {
    const pending = render([player()], { manualRoleAssignEnabled: true, roleAssignments: {} })
    expect(pending).toContain('data-testid="role-pending"')
    expect(pending).toContain('border-dashed')
    expect(pending).toContain('h-6 min-w-12 w-fit')
    expect(pending).toContain('rounded-sm')
    expect(pending).not.toContain('>预言家</')

    const assigned = render([player({ personaName: '沉思者' })], {
      manualRoleAssignEnabled: true,
      roleAssignments: { 1: 'seer' },
      onRoleDragStart: () => {},
      onRoleDrop: () => {},
    })
    expect(assigned).toContain('data-testid="seat-role-card"')
    expect(assigned).toContain('h-6 min-w-12 w-fit')
    expect(assigned).toContain('whitespace-nowrap')
    expect(assigned).toContain('rounded-sm')
    expect(assigned).not.toMatch(/data-testid="seat-role-card"[^>]*w-\[5.25rem\]/)
    expect(assigned).toContain('draggable="true"')
    expect(assigned).toContain('data-role-seat="1"')
    expect(assigned).toContain('预言家')
  })

  it('上警和警长图标位于角色卡右侧，角色卡与图标组合整体居中', () => {
    for (const personaName of ['沉思者', null] as const) {
      const html = render([player({ personaName, sheriff: true })])
      expect(html).toContain('data-testid="role-status-group"')
      expect(html).toMatch(/data-testid="role-status-group"[^>]*flex items-center justify-center gap-1/)
      expect(html.indexOf('data-testid="seat-role-card"')).toBeLessThan(html.indexOf('aria-label="警长"'))
      expect(html).toContain('aria-label="警长"')
    }
    const candidate = render([player({ sheriffCandidate: true })])
    expect(candidate.indexOf('data-testid="seat-role-card"')).toBeLessThan(candidate.indexOf('aria-label="上警竞选中"'))
  })

  it('出局座位整体更灰但状态边框保持原色，死亡条天数使用中文数字', () => {
    const html = render([player({ alive: false, deathInfo: '第1夜被刀', personaName: '沉思者' })], { selectedSeat: 1 })
    expect(html).toContain('seat-marquee')
    expect(html).toContain('第一夜被刀')
    expect(html.slice(html.indexOf('seat-marquee'))).not.toContain('第1夜被刀')
    expect(html).toContain('bg-stone-100 dark:bg-stone-900')
    expect(html).toContain('data-testid="seat-status"')
    expect(html).toMatch(/data-testid="seat-main"[\s\S]*data-testid="seat-status"[\s\S]*seat-marquee/)
    expect(html).toContain('出局')
    expect(html).toMatch(/data-testid="seat-avatar"[^>]*border-color:#78716c/)
    expect(html).not.toMatch(/data-testid="persona-composition"[^>]*grayscale/)
    expect(html).not.toContain('opacity-60')
  })

  it('长人格名和出局原因显式保持滚动播放，不绑定对局暂停状态', () => {
    const html = render([player({ alive: false, deathInfo: '第1夜被刀', personaName: '一个名字特别长的人格' })])
    expect(html).toMatch(/persona-name-marquee[^>]*animation-play-state:running/)
    expect(html).toMatch(/seat-marquee[^>]*animation-play-state:running/)
  })
})
