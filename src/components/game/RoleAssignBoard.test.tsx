import { describe, expect, it } from 'vitest'
import { renderToStaticMarkup } from 'react-dom/server'
import { BOARDS } from '@contracts/game'
import { RoleAssignBoard } from './RoleAssignBoard'

const roles = BOARDS.find((board) => board.id === 'standard9')!.roles

describe('RoleAssignBoard 角色牌桌', () => {
  it('逐个渲染剩余角色并保留重复角色，可拖入座位或接收拖回', () => {
    const html = renderToStaticMarkup(
      <RoleAssignBoard
        boardRoles={roles}
        assignments={{ 1: 'seer', 2: 'villager' }}
        onRoleDragStart={() => {}}
        onRoleDrop={() => {}}
      />,
    )
    expect(html).toContain('角色牌桌')
    expect(html).toContain('data-testid="role-table-drop"')
    expect(html).toContain('拖到座位')
    expect(html).not.toContain('>预言家</')
    expect((html.match(/>平民</g) ?? []).length).toBe(2)
    expect((html.match(/>狼人</g) ?? []).length).toBe(3)
    expect((html.match(/draggable="true"/g) ?? []).length).toBe(7)
  })

  it('全部分配后显示空牌桌提示', () => {
    const assignments = Object.fromEntries(roles.map((role, index) => [index + 1, role]))
    const html = renderToStaticMarkup(
      <RoleAssignBoard boardRoles={roles} assignments={assignments} onRoleDragStart={() => {}} onRoleDrop={() => {}} />,
    )
    expect(html).toContain('所有角色均已分配')
    expect(html).not.toContain('draggable="true"')
  })
})
