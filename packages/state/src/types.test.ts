import { describe, expect, it } from "vitest";

import { SCHEMA_VERSION, STATE_DB_FILENAME } from "./index.js";

describe("state 骨架契约", () => {
  it("schema 版本为 2（v2 = sessions 终态禁回退触发器；升级需用户显式同意，t3 §2）", () => {
    expect(SCHEMA_VERSION).toBe(2);
  });

  it("单库文件名固定且为 .sqlite（t7 要求 *.sqlite 不入仓）", () => {
    expect(STATE_DB_FILENAME.endsWith(".sqlite")).toBe(true);
  });
});
