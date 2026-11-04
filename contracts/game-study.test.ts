import { describe, expect, it } from "vitest";
import { assertStudyOptions, studySourcesOf } from "./game";

describe("赛前学习范围", () => {
  it("旧配置缺省仍只学习图书馆", () => {
    expect(studySourcesOf({ libraryEnabled: true })).toEqual({
      history: false,
      guide: false,
      library: true,
    });
  });

  it("总开关开启但未选择来源时拒绝", () => {
    expect(() => assertStudyOptions({ libraryEnabled: true, studyLibraryEnabled: false }))
      .toThrow("赛前学习至少需要选择一个学习来源");
  });

  it("总开关关闭不限制来源字段", () => {
    expect(() => assertStudyOptions({ libraryEnabled: false, studyLibraryEnabled: false }))
      .not.toThrow();
  });
});
