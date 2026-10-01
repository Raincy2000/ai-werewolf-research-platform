// 未登录守卫的错误判定测试（tRPC UNAUTHORIZED 识别）
import { describe, expect, it } from "vitest";
import { isUnauthorizedError } from "@/lib/utils";

describe("isUnauthorizedError 未登录错误判定", () => {
  it("识别 data.code = UNAUTHORIZED", () => {
    expect(isUnauthorizedError({ data: { code: "UNAUTHORIZED", httpStatus: 401 } })).toBe(true);
  });

  it("识别 data.httpStatus = 401", () => {
    expect(isUnauthorizedError({ data: { httpStatus: 401 } })).toBe(true);
  });

  it("识别 shape.code = -32001（JSON-RPC UNAUTHORIZED）", () => {
    expect(isUnauthorizedError({ shape: { code: -32001 } })).toBe(true);
  });

  it("其他错误不误判", () => {
    expect(isUnauthorizedError(null)).toBe(false);
    expect(isUnauthorizedError(undefined)).toBe(false);
    expect(isUnauthorizedError("UNAUTHORIZED")).toBe(false);
    expect(isUnauthorizedError(new Error("网络错误"))).toBe(false);
    expect(isUnauthorizedError({ data: { code: "NOT_FOUND", httpStatus: 404 } })).toBe(false);
    expect(isUnauthorizedError({ data: { code: "CONFLICT", httpStatus: 409 } })).toBe(false);
    expect(isUnauthorizedError({ shape: { code: -32603 } })).toBe(false);
  });
});
