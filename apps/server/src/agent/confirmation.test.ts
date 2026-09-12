/**
 * confirmation.test.ts：就地确认**判据**的穷举单测（M1-9 ③）。
 *
 * 纯函数 + 真守卫（`createPathGuard` 对真 tmpdir 做 realpath），零 mock：
 * 判据的价值就在于"哪些调用会停下来问人"，这必须能被逐条钉死。
 */
import { mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createPathGuard } from "../policy/guard.js";
import type { PathGuard } from "../policy/guard.js";
import { removeTempDirRetrying } from "../tools/__tests__/harness.js";
import { ALWAYS_CONFIRM_TOOLS, NEVER_CONFIRM_TOOLS, needsConfirmation } from "./confirmation.js";

let dir: string;
let workspaceRoot: string;
let guard: PathGuard;

beforeEach(() => {
  dir = join(tmpdir(), `agentplant-confirm-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  workspaceRoot = join(dir, "workspace");
  mkdirSync(join(workspaceRoot, "sub"), { recursive: true });
  guard = createPathGuard(workspaceRoot);
});

afterEach(() => {
  removeTempDirRetrying(dir);
});

describe("needsConfirmation：run_command 一律要确认", () => {
  it("探针类命令（echo/ls）也要确认：风险分级不当门禁（t4 §6）", () => {
    expect(ALWAYS_CONFIRM_TOOLS).toEqual(["run_command"]);
    expect(needsConfirmation("run_command", { cmd: "echo hi" }, guard)).toBe(true);
    expect(needsConfirmation("run_command", { cmd: "ls -la" }, guard)).toBe(true);
  });

  it("危险命令当然要确认；参数缺失/为空也一样（命令没有 OS 沙箱）", () => {
    expect(needsConfirmation("run_command", { cmd: "rm -rf /tmp/x" }, guard)).toBe(true);
    expect(needsConfirmation("run_command", {}, guard)).toBe(true);
    expect(needsConfirmation("run_command", undefined, guard)).toBe(true);
  });
});

describe("needsConfirmation：write_file 只在越出工作区时要确认", () => {
  it("相对路径逃逸（../x）→ true", () => {
    expect(needsConfirmation("write_file", { path: "../escape.md", content: "x" }, guard)).toBe(true);
    expect(needsConfirmation("write_file", { path: "sub/../../escape.md", content: "x" }, guard)).toBe(
      true,
    );
  });

  it("绝对路径在工作区外 → true", () => {
    const outside = join(dir, "outside.md");
    expect(needsConfirmation("write_file", { path: outside, content: "x" }, guard)).toBe(true);
  });

  it("工作区内（含尚不存在的子目录）→ false", () => {
    expect(needsConfirmation("write_file", { path: "note.md", content: "x" }, guard)).toBe(false);
    expect(needsConfirmation("write_file", { path: "sub/新目录/a.md", content: "x" }, guard)).toBe(false);
    // `..` 绕一圈仍落在工作区内：走 realpath 判定，不做字符串前缀游戏。
    expect(needsConfirmation("write_file", { path: "sub/../inside.md", content: "x" }, guard)).toBe(false);
  });

  it("工作区内的禁区路径（.env/.git）**不**进确认面：执行时守卫必然拒它", () => {
    expect(needsConfirmation("write_file", { path: ".env", content: "x" }, guard)).toBe(false);
    expect(needsConfirmation("write_file", { path: ".git/config", content: "x" }, guard)).toBe(false);
  });

  it("参数不合法（缺 path / path 非字符串 / 纯空白 / 参数不是对象）→ false", () => {
    expect(needsConfirmation("write_file", { content: "x" }, guard)).toBe(false);
    expect(needsConfirmation("write_file", { path: 42, content: "x" }, guard)).toBe(false);
    expect(needsConfirmation("write_file", { path: "   ", content: "x" }, guard)).toBe(false);
    expect(needsConfirmation("write_file", "../x.md", guard)).toBe(false);
    expect(needsConfirmation("write_file", null, guard)).toBe(false);
  });
});

describe("needsConfirmation：其余工具与未知工具一律不确认", () => {
  it("NEVER_CONFIRM_TOOLS 逐条 false（读与记忆写没有不可逆的外部副作用）", () => {
    expect([...NEVER_CONFIRM_TOOLS].sort()).toEqual([
      "browse_page",
      "memory_search",
      "memory_write",
      "read_file",
      "web_search",
    ]);
    for (const name of NEVER_CONFIRM_TOOLS) {
      expect(needsConfirmation(name, { path: "../escape.md", url: "http://x", query: "q" }, guard)).toBe(
        false,
      );
    }
  });

  it("未知工具名不确认：它连注册表都过不了，该由执行出口如实报「未知工具」", () => {
    expect(needsConfirmation("teleport", { to: "月球" }, guard)).toBe(false);
    expect(needsConfirmation("", {}, guard)).toBe(false);
  });
});
