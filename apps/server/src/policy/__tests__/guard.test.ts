/**
 * guard.test.ts：PathGuard 简化版（t4 §6）——越权一律 blocked 的证据。
 *
 * 全部用**真盘**（tmpdir 工作区）+ 真符号链接（Windows 需要权限，故软链用例按平台跳过）。
 */
import { mkdtempSync, mkdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  FORBIDDEN_FILE_NAMES,
  assertAllowed,
  createPathGuard,
  isInside,
  resolveRealPath,
  type PathGuard,
} from "../../policy/guard.js";
import { ToolAuthorizationError } from "@agentplant/agent-core";

let base: string;
let root: string;
let outside: string;
let guard: PathGuard;

beforeEach(() => {
  base = mkdtempSync(join(tmpdir(), "agentplant-guard-test-"));
  root = join(base, "workspace");
  outside = join(base, "outside");
  mkdirSync(root, { recursive: true });
  mkdirSync(outside, { recursive: true });
  writeFileSync(join(outside, "secret.txt"), "OUTSIDE-SECRET", "utf8");
  guard = createPathGuard(root);
});

afterEach(() => {
  rmSync(base, { recursive: true, force: true });
});

describe("PathGuard：包含判定", () => {
  it("isInside 用分隔符判定，不把 /work 与 /workshop 混为一谈", () => {
    expect(isInside("/work", "/work")).toBe(true);
    expect(isInside("/work", "/work/a.txt")).toBe(true);
    expect(isInside("/work", "/workshop/a.txt")).toBe(false);
    expect(isInside("/work", "/work2")).toBe(false);
  });
});

describe("PathGuard：workspace 内放行", () => {
  it("相对路径解析到工作区根下", () => {
    const result = guard.check("notes/a.txt", "read");
    expect(result.decision).toBe("allow");
    expect(result.resolvedPath).toBe(resolveRealPath(join(root, "notes/a.txt")));
  });

  it("不存在的文件（写新文件）也判定为 allow", () => {
    const result = guard.check(join(root, "deep", "nested", "new.txt"), "write");
    expect(result.decision).toBe("allow");
  });

  it("绝对路径落在工作区内同样 allow", () => {
    expect(guard.check(join(root, "a.txt"), "read").decision).toBe("allow");
  });
});

describe("PathGuard：越权 blocked（403 口径）", () => {
  it("工作区外的读被 blocked，且理由说明 workspace-only 是约定级约束", () => {
    const result = guard.check(join(outside, "secret.txt"), "read");
    expect(result.decision).toBe("blocked");
    expect(result.reason).toContain("越出工作区");
    expect(result.reason).toContain("约定级");
  });

  it("工作区外的写被 blocked", () => {
    expect(guard.check(join(outside, "new.txt"), "write").decision).toBe("blocked");
  });

  it("../ 逃逸被 blocked（相对路径也不能出去）", () => {
    expect(guard.check("../outside/secret.txt", "read").decision).toBe("blocked");
    expect(guard.check("../../etc/passwd", "read").decision).toBe("blocked");
  });

  it("assertAllowed 把 blocked 翻成 ToolAuthorizationError（403 口径）", () => {
    const result = guard.check(join(outside, "secret.txt"), "read");
    let thrown: unknown;
    try {
      assertAllowed(result, join(outside, "secret.txt"));
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(ToolAuthorizationError);
    expect((thrown as ToolAuthorizationError).kind).toBe("authorization");
  });
});

describe("PathGuard：强制禁区", () => {
  it(".git 目录内读写都拒（读 blocked；写降级 readonly）", () => {
    mkdirSync(join(root, ".git"), { recursive: true });
    writeFileSync(join(root, ".git", "config"), "[core]", "utf8");
    const read = guard.check(join(root, ".git", "config"), "read");
    expect(read.decision).toBe("blocked");
    expect(read.reason).toContain(".git");
    const write = guard.check(join(root, ".git", "config"), "write");
    expect(write.decision).toBe("readonly");
  });

  it(".git 内不存在的路径也拒（不靠磁盘状态判断）", () => {
    expect(guard.check(join(root, ".git", "objects", "aa", "bb"), "read").decision).toBe("blocked");
  });

  it(".env 被强制 blocked（读写都拒）", () => {
    writeFileSync(join(root, ".env"), "OPENAI_API_KEY=sk-test", "utf8");
    expect(guard.check(join(root, ".env"), "read").decision).toBe("blocked");
    expect(guard.check(".env", "write").decision).toBe("readonly");
  });

  it("凭据文件名清单整体生效（读 blocked / 写 readonly）", () => {
    for (const name of FORBIDDEN_FILE_NAMES) {
      expect(guard.check(join(root, name), "read").decision, name).toBe("blocked");
      expect(guard.check(join(root, name), "write").decision, name).toBe("readonly");
    }
  });

  it("子目录里的 .env 同样被拒（不只看根目录）", () => {
    expect(guard.check(join(root, "apps", "server", ".env"), "read").decision).toBe("blocked");
  });

  it("SSH 私钥族（含 id_rsa.pub 派生态）被拒", () => {
    expect(guard.check("id_rsa", "read").decision).toBe("blocked");
    expect(guard.check("keys/id_ed25519.pub", "read").decision).toBe("blocked");
  });

  it("普通文件不受禁区清单影响", () => {
    expect(guard.check("README.md", "read").decision).toBe("allow");
    expect(guard.check("src/env.ts", "read").decision).toBe("allow");
  });
});

describe("PathGuard：realpath 先行", () => {
  it("符号链接指向工作区外的文件被 blocked（不是只看字面路径）", () => {
    const target = join(outside, "secret.txt");
    const link = join(root, "link.txt");
    try {
      symlinkSync(target, link);
    } catch {
      // Windows 无开发者模式/权限时 symlink 需要管理员；跳过而不是假装通过
      return;
    }
    const result = guard.check(link, "read");
    expect(result.decision).toBe("blocked");
    expect(result.reason).toContain("越出工作区");
  });

  it("工作区根自身经 realpath 归一（守卫返回的 workspaceRoot 是真实路径）", () => {
    expect(guard.workspaceRoot).toBe(resolveRealPath(root));
  });
});
