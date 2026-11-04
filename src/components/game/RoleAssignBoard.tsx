import type { Camp, RoleId } from '@contracts/game'
import { ROLE_META } from '@contracts/game'
import { cn } from '@/lib/utils'
import { remainingRoles, type RoleAssignments } from '@/lib/roleAssignment'

const CAMP_CARD_CLASS: Record<Camp, string> = {
  wolf: 'border-wolf/50 bg-wolf/10 text-wolf',
  god: 'border-god/50 bg-god/10 text-god',
  villager: 'border-villager/50 bg-villager/10 text-villager',
}

interface RoleAssignBoardProps {
  boardRoles: readonly RoleId[]
  assignments: RoleAssignments
  onRoleDragStart: (role: RoleId, fromSeat?: number) => void
  /** 牌桌接收从座位拖回的角色；具体来源由 GameRoom 的拖动状态给出 */
  onRoleDrop: () => void
}

/** 创建阶段的中央角色牌桌：每张剩余角色牌都可拖动，牌桌本身也是拖回取消区。 */
export function RoleAssignBoard({
  boardRoles,
  assignments,
  onRoleDragStart,
  onRoleDrop,
}: RoleAssignBoardProps) {
  const remaining = remainingRoles(boardRoles, assignments)
  return (
    <div
      data-testid="role-table-drop"
      onDragOver={(event) => {
        event.preventDefault()
        event.dataTransfer.dropEffect = 'move'
      }}
      onDrop={(event) => {
        event.preventDefault()
        onRoleDrop()
      }}
      className="rounded-lg border border-dashed border-border bg-muted/20 p-4"
    >
      <div className="mb-4 text-center">
        <h2 className="text-lg font-semibold text-foreground">角色牌桌</h2>
        <p className="mt-1 text-sm text-muted-foreground">
          拖到座位完成分配；座位角色可换座，也可拖回这里取消
        </p>
      </div>
      {remaining.length === 0 ? (
        <p className="flex min-h-24 items-center justify-center rounded-lg border border-border bg-card text-sm text-muted-foreground">
          所有角色均已分配，可开始对局；仍可拖动座位角色调整
        </p>
      ) : (
        <div className="grid grid-cols-3 justify-items-center gap-2.5 sm:grid-cols-4">
          {remaining.map((role, index) => {
            const meta = ROLE_META[role]
            return (
              <span
                key={`${role}-${index}`}
                draggable
                onDragStart={(event) => {
                  event.dataTransfer.effectAllowed = 'move'
                  event.dataTransfer.setData('text/plain', role)
                  onRoleDragStart(role)
                }}
                title={meta.description}
                className={cn(
                  'flex h-24 w-[6.5rem] cursor-grab flex-col items-center justify-center gap-2 rounded-lg border bg-card text-center shadow-sm active:cursor-grabbing',
                  CAMP_CARD_CLASS[meta.camp],
                )}
              >
                <span className="text-base font-semibold">{meta.name}</span>
                <span className="text-[11px] font-normal opacity-70">拖到座位</span>
              </span>
            )
          })}
        </div>
      )}
    </div>
  )
}
