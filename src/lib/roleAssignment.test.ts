import { describe, expect, it } from "vitest";
import { BOARDS } from "@contracts/game";
import { assignRole, isRoleAssignmentComplete, remainingRoles, seatRolesForPlayers, unassignRole, type RoleAssignments } from "./roleAssignment";

const board = BOARDS.find((b) => b.id === "standard9")!;

describe("角色拖拽分配", () => {
  it("重复角色分配、换座和拖回后数量守恒", () => {
    let assigned: RoleAssignments = {};
    assigned = assignRole(assigned, 1, "seer");
    assigned = assignRole(assigned, 2, "witch");
    assigned = assignRole(assigned, 3, "villager");
    expect(remainingRoles(board.roles, assigned).filter((r) => r === "villager")).toHaveLength(2);

    assigned = assignRole(assigned, 1, "werewolf");
    expect(remainingRoles(board.roles, assigned)).toContain("seer");
    expect(remainingRoles(board.roles, assigned).filter((r) => r === "werewolf")).toHaveLength(2);

    assigned = assignRole(assigned, 2, "werewolf", 1);
    expect(assigned[1]).toBeUndefined();
    expect(assigned[2]).toBe("werewolf");
    expect(remainingRoles(board.roles, assigned)).toContain("witch");

    assigned = unassignRole(assigned, 2);
    expect(assigned[2]).toBeUndefined();
    expect(remainingRoles(board.roles, assigned).filter((r) => r === "werewolf")).toHaveLength(3);
  });

  it("拖到已占座位时旧角色回池而不是复制或丢失", () => {
    let assigned = assignRole({}, 1, "seer");
    assigned = assignRole(assigned, 1, "witch");
    expect(assigned[1]).toBe("witch");
    expect(remainingRoles(board.roles, assigned)).toContain("seer");
    expect(remainingRoles(board.roles, assigned)).not.toContain("witch");
  });

  it("所有座位分配完成才可开始", () => {
    const assigned = Object.fromEntries(board.roles.map((role, i) => [i + 1, role]));
    expect(isRoleAssignmentComplete(board.roles, assigned)).toBe(true);
    delete assigned[3];
    expect(isRoleAssignmentComplete(board.roles, assigned)).toBe(false);
  });

  it("只按真实座位顺序提交完整角色，缺座或座位表外分配均返回空", () => {
    const seats = board.roles.map((_, i) => i + 1);
    const assigned = Object.fromEntries(board.roles.map((role, i) => [i + 1, role]));
    expect(seatRolesForPlayers(board.roles, assigned, seats)).toEqual(board.roles);

    const incomplete = { ...assigned };
    delete incomplete[2];
    expect(seatRolesForPlayers(board.roles, incomplete, seats)).toBeNull();
    expect(seatRolesForPlayers(board.roles, { ...assigned, 10: "seer" }, seats)).toBeNull();
    expect(seatRolesForPlayers(board.roles, assigned, seats.slice(1))).toBeNull();
  });
});
