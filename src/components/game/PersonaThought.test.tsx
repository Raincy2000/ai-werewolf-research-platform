import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { PersonaThought } from "./PersonaThought";

describe("PersonaThought 空状态", () => {
  it("没有主体反应和观察解释时不渲染空心理框", () => {
    expect(renderToStaticMarkup(React.createElement(PersonaThought, { thought: "", persona: null }))).toBe("");
  });
});
