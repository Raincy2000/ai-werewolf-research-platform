// ============================================================
// 对局标题号 — 纯函数单测
// ============================================================

import { describe, expect, it } from "vitest";
import { formatGameTitleNo } from "./game";

describe("formatGameTitleNo（对局标题号：YYYYMMDD+当日序号3位）", () => {
  it("格式与补零", () => {
    expect(formatGameTitleNo(new Date(2026, 7, 11, 9, 30), 1)).toBe("20260811001");
    expect(formatGameTitleNo(new Date(2026, 7, 11), 12)).toBe("20260811012");
    expect(formatGameTitleNo(new Date(2026, 0, 5), 123)).toBe("20260105123");
    expect(formatGameTitleNo(new Date(2026, 11, 31), 999)).toBe("20261231999");
  });
});
