import { describe, expect, it } from "vitest";
import { assertBoardSeatRoles, BOARDS } from "./game";

const board = BOARDS.find((b) => b.id === "standard9")!;

describe("版型角色分配校验", () => {
  it("完整角色 multiset 可以通过，顺序不限", () => {
    expect(() => assertBoardSeatRoles(board, [...board.roles].reverse())).not.toThrow();
  });

  it("缺座或座位数不符时拒绝", () => {
    expect(() => assertBoardSeatRoles(board, board.roles.slice(1))).toThrow("座位数");
  });

  it("版型外角色时拒绝", () => {
    const roles = [...board.roles];
    roles[0] = "knight";
    expect(() => assertBoardSeatRoles(board, roles)).toThrow("不属于该版型");
  });

  it("重复角色数量不符时拒绝", () => {
    const roles = [...board.roles];
    roles[0] = "werewolf";
    expect(() => assertBoardSeatRoles(board, roles)).toThrow("数量");
  });
});
