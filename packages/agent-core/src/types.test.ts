import { describe, expect, it } from "vitest";

import { AGENT_CORE_VERSION, ToolAuthorizationError, ToolInputError } from "./index.js";

describe("agent-core 骨架契约", () => {
  it("导出骨架版本标记（证明包边界连通）", () => {
    expect(AGENT_CORE_VERSION).toBe("0.0.0");
  });

  it("工具失败类型可实例化且分类稳定（t4 §5：失败一律 throw）", () => {
    const input = new ToolInputError("bad params", { field: "path" });
    const authz = new ToolAuthorizationError("outside workspace");

    expect(input).toBeInstanceOf(Error);
    expect(input.kind).toBe("input");
    expect(input.name).toBe("ToolInputError");
    expect(authz.kind).toBe("authorization");
    expect(authz.name).toBe("ToolAuthorizationError");
  });
});
