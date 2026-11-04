import type { RoleId } from "@contracts/game";

export type RoleAssignments = Record<number, RoleId>;

/** 将一个角色分配到座位；目标原角色自然回池，来源座位角色被移动而非复制。 */
export function assignRole(
  current: RoleAssignments,
  seat: number,
  role: RoleId,
  fromSeat?: number,
): RoleAssignments {
  const next = { ...current };
  if (fromSeat === seat) return next;
  if (fromSeat !== undefined) delete next[fromSeat];
  next[seat] = role;
  return next;
}

export function unassignRole(current: RoleAssignments, seat: number): RoleAssignments {
  const next = { ...current };
  delete next[seat];
  return next;
}

/** 按版型角色 multiset 扣除已分配角色，保留重复角色各自的剩余数量。 */
export function remainingRoles(boardRoles: readonly RoleId[], current: RoleAssignments): RoleId[] {
  const used = new Map<RoleId, number>();
  for (const role of Object.values(current)) used.set(role, (used.get(role) ?? 0) + 1);
  const remaining = new Map<RoleId, number>();
  for (const role of boardRoles) remaining.set(role, (remaining.get(role) ?? 0) + 1);
  for (const [role, count] of used) remaining.set(role, (remaining.get(role) ?? 0) - count);
  return boardRoles.filter((role) => {
    const count = remaining.get(role) ?? 0;
    if (count <= 0) return false;
    remaining.set(role, count - 1);
    return true;
  });
}

export function isRoleAssignmentComplete(boardRoles: readonly RoleId[], current: RoleAssignments): boolean {
  if (Object.keys(current).length !== boardRoles.length) return false;
  const expected = [...boardRoles].sort().join("|");
  const actual = Object.values(current).sort().join("|");
  return expected === actual;
}

/** 仅在真实座位与版型角色全部吻合时，按座位顺序生成启动参数。 */
export function seatRolesForPlayers(
  boardRoles: readonly RoleId[],
  current: RoleAssignments,
  seats: readonly number[],
): RoleId[] | null {
  if (seats.length !== boardRoles.length || new Set(seats).size !== seats.length) return null;
  const seatSet = new Set(seats);
  if (Object.keys(current).some((seat) => !seatSet.has(Number(seat)))) return null;
  if (seats.some((seat) => current[seat] === undefined)) return null;
  if (!isRoleAssignmentComplete(boardRoles, current)) return null;
  return seats.map((seat) => current[seat]);
}
