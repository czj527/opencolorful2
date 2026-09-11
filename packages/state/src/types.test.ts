import { describe, expect, it } from "vitest";

import { SCHEMA_VERSION, STATE_DB_FILENAME } from "./index.js";

describe("state 骨架契约", () => {
  it("schema 初版为 1（升级需用户显式同意，t3 §2）", () => {
    expect(SCHEMA_VERSION).toBe(1);
  });

  it("单库文件名固定且为 .sqlite（t7 要求 *.sqlite 不入仓）", () => {
    expect(STATE_DB_FILENAME.endsWith(".sqlite")).toBe(true);
  });
});
