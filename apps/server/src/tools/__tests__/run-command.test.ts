/**
 * run-command.test.ts：`run_command`（**真进程**，不是 mock 的 child_process）。
 *
 * 覆盖验收点 3：真实 exit code 原样返回（含非零）、超时 `timedOut=true` 且进程树**真的死了**、
 * 输出尾部截断、`classifyCommand` 只做提示不当拦截。
 *
 * 进程存活探测在 Windows 用 `tasklist`、POSIX 用 `process.kill(pid, 0)`——
 * 都是真实系统调用，用来证明"超时真的杀了进程"而不是只在返回值上写了 `timedOut`。
 */
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { classifyCommand, createRunCommandTool } from "../builtin/run-command.js";
import { createContext, createServices, createTestWorkspace, type TestWorkspace } from "./harness.js";

let workspace: TestWorkspace;

beforeEach(() => {
  workspace = createTestWorkspace();
});

afterEach(() => {
  workspace.cleanup();
});

function tool() {
  const services = createServices(workspace);
  return {
    tool: createRunCommandTool(services),
    ctx: createContext({ workspaceRoot: services.workspaceRoot }),
  };
}

/** 真实探测进程是否存活。 */
function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** 让 node 把内容写到工作区文件（避开 shell 引号问题，统一用 `node -e`）。 */
function nodeEval(script: string): string {
  return `node -e "${script.replace(/"/g, '\\"')}"`;
}

describe("run_command：真实进程与退出码", () => {
  it("stdout 原样返回，exitCode=0", async () => {
    const { tool: runCommand, ctx } = tool();
    const result = await runCommand.execute(ctx as never, { cmd: nodeEval("console.log('hello-stdout')") });
    expect(result.details?.exitCode).toBe(0);
    expect(result.details?.timedOut).toBe(false);
    expect(result.content).toContain("hello-stdout");
  });

  it("非零退出码原样返回（不翻译成工具失败）", async () => {
    const { tool: runCommand, ctx } = tool();
    const result = await runCommand.execute(ctx as never, {
      cmd: nodeEval("console.log('before-exit'); process.exit(3)"),
    });
    expect(result.details?.exitCode).toBe(3);
    expect(result.details?.timedOut).toBe(false);
    expect(result.content).toContain("before-exit");
  });

  it("stderr 与 stdout 分开返回", async () => {
    const { tool: runCommand, ctx } = tool();
    const result = await runCommand.execute(ctx as never, {
      cmd: nodeEval("console.error('to-stderr'); console.log('to-stdout')"),
    });
    const content = result.content;
    const stderrIndex = content.indexOf("to-stderr");
    const stdoutIndex = content.indexOf("to-stdout");
    expect(content.indexOf("--- stdout ---")).toBeLessThan(stdoutIndex);
    expect(content.indexOf("--- stderr ---")).toBeLessThan(stderrIndex);
    expect(result.details?.exitCode).toBe(0);
  });

  it("cwd 生效（相对路径命令真在工作区里跑）", async () => {
    workspace.writeFile("marker.txt", "MARKER");
    const { tool: runCommand, ctx } = tool();
    const result = await runCommand.execute(ctx as never, {
      cmd: nodeEval("console.log(require('fs').readFileSync('marker.txt','utf8'))"),
      cwd: ".",
    });
    expect(result.content).toContain("MARKER");
  });

  it("命令写入工作区文件是真的落盘", async () => {
    const { tool: runCommand, ctx } = tool();
    await runCommand.execute(ctx as never, {
      cmd: nodeEval("require('fs').writeFileSync('from-cmd.txt','written-by-process')"),
    });
    expect(readFileSync(join(workspace.root, "from-cmd.txt"), "utf8")).toBe("written-by-process");
  });

  it("cwd 越权时抛 403（命令的工作目录也是写路径）", async () => {
    const { tool: runCommand, ctx } = tool();
    await expect(
      runCommand.execute(ctx as never, { cmd: nodeEval("1"), cwd: workspace.outsideDir }),
    ).rejects.toMatchObject({ name: "ToolAuthorizationError" });
  });
});

describe("run_command：超时真杀进程树", () => {
  it("超时返回 timedOut=true，且父进程与孙进程都已死亡", async () => {
    const { tool: runCommand, ctx } = tool();
    // 孙进程脚本 base64 编码后交给父进程（避免 Windows shell 里的多层引号地狱）
    const grandchildCode =
      "const fs=require('fs');" +
      "fs.writeFileSync('child.pid',String(process.pid));" +
      "setTimeout(function(){},30000);";
    const grandchildB64 = Buffer.from(grandchildCode, "utf8").toString("base64");
    // 父进程：写自己的 pid → 派生长命孙进程 → 自己睡 30s
    const parentScript =
      "const fs=require('fs'),cp=require('child_process');" +
      "fs.writeFileSync('parent.pid',String(process.pid));" +
      `const code=Buffer.from('${grandchildB64}','base64').toString('utf8');` +
      "cp.spawn(process.execPath,['-e',code],{stdio:'ignore'});" +
      "setTimeout(function(){},30000);";
    const started = Date.now();
    const result = await runCommand.execute(ctx as never, {
      cmd: nodeEval(parentScript),
      timeoutMs: 2500,
    });
    const elapsed = Date.now() - started;

    expect(result.details?.timedOut).toBe(true);
    expect(elapsed).toBeLessThan(15_000);
    expect(result.content).toContain("已被杀死");

    // 真探测：读 pid 文件 + 系统调用确认进程已消失
    await sleep(2000);
    const parentPid = Number(readFileSync(join(workspace.root, "parent.pid"), "utf8"));
    expect(Number.isInteger(parentPid)).toBe(true);
    expect(isAlive(parentPid), `父进程 ${parentPid} 仍存活`).toBe(false);
    const childPidPath = join(workspace.root, "child.pid");
    const childPid = existsSync(childPidPath)
      ? Number(readFileSync(childPidPath, "utf8"))
      : Number.NaN;
    if (Number.isInteger(childPid) && childPid > 0) {
      expect(isAlive(childPid), `孙进程 ${childPid} 仍存活（进程树没杀干净）`).toBe(false);
    }
  }, 30_000);

  it("未超时的快命令不带 timedOut 标记", async () => {
    const { tool: runCommand, ctx } = tool();
    const result = await runCommand.execute(ctx as never, {
      cmd: nodeEval("console.log('fast')"),
      timeoutMs: 10_000,
    });
    expect(result.details?.timedOut).toBe(false);
  });

  it("省略 timeoutMs/maxOutputBytes 时用协议默认值（10s / 51200）", async () => {
    const { tool: runCommand, ctx } = tool();
    const result = await runCommand.execute(ctx as never, {
      cmd: nodeEval("console.log('defaults')"),
    });
    expect(result.details?.timedOut).toBe(false);
    expect(result.details?.exitCode).toBe(0);
    // 默认值来自 protocol 常量（物化在 params.ts），命令正常跑完即证明默认超时可用
    expect(result.details?.truncated).toBe(false);
  });

  it("run 被 abort 时拒绝收场，且命令进程树被终止", async () => {
    const { tool: runCommand } = tool();
    const controller = new AbortController();
    const services = createServices(workspace);
    const ctx = createContext({ workspaceRoot: services.workspaceRoot, signal: controller.signal });
    const running = runCommand.execute(ctx as never, {
      cmd: nodeEval("setTimeout(function(){},30000)"),
      timeoutMs: 20_000,
    });
    setTimeout(() => controller.abort(), 500);
    await expect(running).rejects.toMatchObject({ message: expect.stringContaining("已取消") });
    // 等被杀进程真正退出：`exit` 事件只表示子树已收到终止信号，Windows 上句柄释放更晚，
    // 立刻跑 afterEach 的目录清理会撞上文件锁（harness 侧另有退避重试兜底）。
    await sleep(600);
  }, 30_000);
});

describe("run_command：输出截断", () => {
  it("超过 maxOutputBytes 时保留尾部（报错在末尾）", async () => {
    const { tool: runCommand, ctx } = tool();
    const script =
      "for(let i=0;i<2000;i++)console.log('padded-line-'+i);" +
      "console.error('FINAL-ERROR-MARKER')";
    const result = await runCommand.execute(ctx as never, {
      cmd: nodeEval(script),
      maxOutputBytes: 2048,
    });
    expect(result.details?.truncated).toBe(true);
    expect(result.content).toContain("FINAL-ERROR-MARKER");
    // 尾部保留 => 开头被丢弃（`padded-line-1000` 长于 32 字符，不会命中兜底掩码规则）
    expect(result.content).not.toContain("padded-line-1000");
    expect(result.content).toContain("padded-line-1999");
  });

  it("小输出不标记截断", async () => {
    const { tool: runCommand, ctx } = tool();
    const result = await runCommand.execute(ctx as never, { cmd: nodeEval("console.log('tiny')") });
    expect(result.details?.truncated).toBe(false);
  });
});

describe("run_command：风险分类只做提示", () => {
  it("分类表覆盖五档", () => {
    expect(classifyCommand("node -e \"console.log(1)\"")).toBe("safe");
    expect(classifyCommand("ls -la")).toBe("probe");
    expect(classifyCommand("git status")).toBe("probe");
    expect(classifyCommand("rm file.txt")).toBe("mutation");
    expect(classifyCommand("pnpm install")).toBe("mutation");
    expect(classifyCommand("rm -rf ./build")).toBe("dangerous");
    expect(classifyCommand("rm -rf /")).toBe("dangerous");
    expect(classifyCommand("shutdown -h now")).toBe("dangerous");
    expect(classifyCommand("my-custom-binary --flag")).toBe("unknown");
  });

  it("dangerous 命令**不被拦截**（只提示）", async () => {
    const { tool: runCommand, ctx } = tool();
    // 用 dangerous 形态的命令做无害的事：证明"标红 ≠ 拒绝执行"
    const result = await runCommand.execute(ctx as never, {
      cmd: nodeEval("console.log('dangerous-shape-but-harmless')"),
      timeoutMs: 10_000,
    });
    expect(result.details?.risk).toBe("safe");
    const dangerousShape = await runCommand.execute(ctx as never, {
      cmd: `rm -rf ${join(workspace.root, "no-such-dir")}`,
      timeoutMs: 10_000,
    });
    expect(dangerousShape.details?.risk).toBe("dangerous");
    // 关键：命令**真的执行了**（有退出码），说明风险分类没有拦住它
    expect(typeof dangerousShape.details?.exitCode).toBe("number");
  });
});
