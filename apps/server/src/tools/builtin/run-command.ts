/**
 * builtin/run_command：跑一条真实命令（t5 §4.2 工具名 `run_command`）。
 *
 * 三条硬要求（t4 §6 + 验收点）：
 * 1. **超时默认 10s 且真杀进程树**：Windows 用 `taskkill /T /F`（Node 的 `child.kill`
 *    杀不掉 cmd 派生出的子进程），POSIX 用进程组 `kill(-pgid)`。
 * 2. **输出截断用 `truncateTail`**：报错和汇总在末尾，砍尾巴等于砍掉最有用的部分；
 *    进程运行期间用 `RollingBuffer` 限内存（防长跑命令 OOM）。
 * 3. `exitCode` / `timedOut` **原样返回**：不把非零退出码翻译成"工具失败"——
 *    退出码是命令的结论，`grep` 无匹配返回 1 是正常结果。运行时（t15）据此决定
 *    tool_result 的 error 与否。
 *
 * `cwd` 也过守卫：命令的工作目录决定它能相对写到哪儿，属于写路径的一部分。
 *
 * **诚实标注**：本工具**没有**真正的沙箱——命令自己能往工作区外写。真正拦住它的是
 * 二期 OS 沙箱（t4 §6）。本层只做路径参数守卫 + 风险提示。
 */
import { spawn, type ChildProcess } from "node:child_process";
import { ToolInputError, type CommandRisk } from "@agentplant/agent-core";
import { TOOL_PARAM_SCHEMAS } from "@agentplant/protocol";
import { assertAllowed } from "../../policy/guard.js";
import { materializeParams } from "../params.js";
import { RollingBuffer, truncateTail } from "./text.js";
import type { Tool, ToolServices } from "../types.js";

export interface RunCommandDetails {
  readonly cmd: string;
  /** 真实退出码；被信号杀死时为 null（原样透传，不编造 0）。 */
  readonly exitCode: number | null;
  readonly signal: string | null;
  readonly timedOut: boolean;
  readonly truncated: boolean;
  readonly risk: CommandRisk;
  readonly cwd: string;
  /** 进程号（审计/排查用；不是敏感信息）。 */
  readonly pid: number | null;
}

interface KillResult {
  readonly killed: boolean;
  readonly method: string;
}

/**
 * 杀进程树。
 *
 * - Windows：`taskkill /pid <pid> /T /F`（`/T` = 连同派生进程）。
 *   **必须靠 taskkill，不能只 `child.kill()`**：`shell: true` 时 `child.kill()` 只终止
 *   `cmd.exe`，真正干活的 node/孙进程会活下来继续写盘、继续占用 stdout 管道（实测如此，
 *   `apps/server/src/tools/__tests__/run-command.test.ts` 用 PID 存活探测守住这条）。
 * - POSIX：`detached: true` 让子进程自成进程组 → `process.kill(-pid, "SIGKILL")` 整组带走。
 */
export function killProcessTree(child: ChildProcess): KillResult {
  const pid = child.pid;
  if (pid === undefined) {
    return { killed: false, method: "no-pid" };
  }
  if (process.platform === "win32") {
    try {
      // `stdio: "ignore"` + `unref()`：杀进程的辅助进程绝不能让本次工具调用挂住
      const killer = spawn("taskkill", ["/pid", String(pid), "/T", "/F"], {
        stdio: "ignore",
        windowsHide: true,
      });
      killer.on("error", () => {
        child.kill();
      });
      killer.unref();
      return { killed: true, method: "taskkill" };
    } catch {
      child.kill("SIGKILL");
      return { killed: true, method: "child.kill" };
    }
  }
  try {
    process.kill(-pid, "SIGKILL");
    return { killed: true, method: "kill-pgid" };
  } catch {
    child.kill("SIGKILL");
    return { killed: true, method: "child.kill" };
  }
}

/**
 * 命令风险分类：**只做审批提示，不当拦截**（t4 §6 诚实标注原文）。
 *
 * 为什么不是拦截：字符串查表可被 `bash -c`、变量拼接、`$(...)` 轻易绕过——把它当门禁
 * 只会制造"我以为被拦住了"的错觉。它的价值是把 `rm -rf /` 这类调用在 UI 上标红让人多看一眼。
 * 因此：**M1 里没有任何调用点会因 `risk` 取值而拒绝执行**（`dangerous` 也照跑）。
 */
export function classifyCommand(cmd: string): CommandRisk {
  const normalized = cmd.toLowerCase();
  // 危险：不可逆的破坏性操作（提示等级最高）
  //  `rm` 带 `-r` + `-f`（无论目标写没写、写的是不是根）就是递归强删，一律最高档提示；
  //  只带 `-r` 或只带 `-f` 的普通删除留在 mutation 档。
  if (
    /\brm\b[^\n|;&]*\s-[a-z]*r[a-z]*f|\brm\b[^\n|;&]*\s-[a-z]*f[a-z]*r/.test(normalized) ||
    /\brm\b[^\n|;&]*\s-[rf]{2}\b/.test(normalized) ||
    /\b(mkfs|fdisk|diskpart|shutdown|reboot|halt)\b/.test(normalized) ||
    /\bdd\s+if=/.test(normalized) ||
    /:\(\)\s*\{.*\}\s*;?\s*:/.test(normalized) ||
    /\bformat\s+[a-z]:/.test(normalized) ||
    /(^|\s)>\s*\/dev\/sd[a-z]/.test(normalized)
  ) {
    return "dangerous";
  }
  // 变更：写文件 / 装依赖 / 改版本库状态
  if (
    /\b(rm|mv|cp|mkdir|rmdir|touch|chmod|chown|ln|tee|truncate)\b/.test(normalized) ||
    /\b(npm|pnpm|yarn|pip|pip3|apt|apt-get|brew|choco|winget|cargo|go)\s+(i|install|add|remove|uninstall|update|upgrade)\b/.test(
      normalized,
    ) ||
    /\bgit\s+(commit|push|pull|merge|rebase|reset|checkout|clean|tag)\b/.test(normalized) ||
    /(^|[^>])>(?!>)/.test(normalized) ||
    /\bsed\s+-i\b/.test(normalized)
  ) {
    return "mutation";
  }
  // 探针：只读地了解环境（ls/cat/git status/版本查询…）
  if (
    /^(ls|dir|pwd|cd|cat|type|head|tail|wc|file|stat|du|df|tree|which|where|whoami|hostname|env|echo|printenv|git\s+(status|log|diff|show|branch|remote)|node\s+-v|node\s+--version|npm\s+-v|pnpm\s+-v|python\s+--version|rg|grep|find|findstr|jq|curl|wget|ping|ipconfig|ifconfig|netstat|ps|tasklist)\b/.test(
      normalized,
    )
  ) {
    return "probe";
  }
  // 安全：纯求值/无害（本仓测试大量使用 `node -e`）
  if (
    /^(node|nodejs)\s+(-e|--eval)\b/.test(normalized) ||
    /^(true|false|:|exit\s+\d+)(\s|$)/.test(normalized)
  ) {
    return "safe";
  }
  return "unknown";
}

export function createRunCommandTool(services: ToolServices): Tool<unknown, RunCommandDetails> {
  return {
    name: "run_command",
    label: "执行命令",
    description:
      "在工作区内执行一条 shell 命令并返回退出码与输出。何时用：需要跑构建/测试/git 或" +
      "查看环境信息。何时不用：单纯的读文件用 read_file（更快也更安全）。" +
      "注意：命令无 OS 沙箱（约定级约束），输出只保留尾部 50KB，超时默认 10s 且真杀进程树。",
    parameters: TOOL_PARAM_SCHEMAS.run_command,
    sideEffect: { kind: "command", capability: "shell.exec" },
    risk: "review",
    execute: async (ctx, rawParams) => {
      const params = materializeParams("run_command", rawParams);
      const cwdCheck = services.guard.check(params.cwd ?? ".", "write");
      const cwd = assertAllowed(cwdCheck, params.cwd ?? ".");
      if (ctx.signal.aborted) {
        throw new ToolInputError("run_command：本次 run 已取消（abort），命令未启动");
      }
      const risk = classifyCommand(params.cmd);
      const stdout = new RollingBuffer(params.maxOutputBytes);
      const stderr = new RollingBuffer(params.maxOutputBytes);
      const outcome = await runProcess({
        cmd: params.cmd,
        cwd,
        timeoutMs: params.timeoutMs,
        stdout,
        stderr,
        signal: ctx.signal,
      });
      if (ctx.signal.aborted && !outcome.timedOut) {
        // 取消不是"命令跑完了"：返回一份被杀的输出会被下游当成正常结果（诚实优先）。
        throw new ToolInputError("run_command：本次 run 已取消（abort），命令进程树已被终止", {
          cmd: params.cmd,
        });
      }
      const stdoutTail = truncateTail(stdout.text(), params.maxOutputBytes);
      const stderrTail = truncateTail(stderr.text(), params.maxOutputBytes);
      // 滚动缓冲丢掉的字节 `truncateTail` 看不见：两个来源都要计入，否则会谎报"没截断"
      const truncated =
        stdoutTail.truncated ||
        stderrTail.truncated ||
        stdout.droppedBytes() > 0 ||
        stderr.droppedBytes() > 0;
      const details: RunCommandDetails = {
        cmd: params.cmd,
        exitCode: outcome.exitCode,
        signal: outcome.signal,
        timedOut: outcome.timedOut,
        truncated,
        risk,
        cwd,
        pid: outcome.pid,
      };
      const head = outcome.timedOut
        ? `命令超时（${params.timeoutMs}ms）已被杀死（进程树）：exitCode=${String(outcome.exitCode)}`
        : `exitCode=${String(outcome.exitCode)}${outcome.signal === null ? "" : ` (signal=${outcome.signal})`}`;
      return {
        content:
          `${head}\nrisk=${risk}（仅审批提示，不拦截）${truncated ? "；输出已截断（保留尾部）" : ""}\n` +
          `--- stdout ---\n${stdoutTail.text}\n--- stderr ---\n${stderrTail.text}`,
        details,
      };
    },
  };
}

interface RunProcessInput {
  readonly cmd: string;
  readonly cwd: string;
  readonly timeoutMs: number;
  readonly stdout: RollingBuffer;
  readonly stderr: RollingBuffer;
  readonly signal: AbortSignal;
}

interface RunProcessOutcome {
  readonly exitCode: number | null;
  readonly signal: string | null;
  readonly timedOut: boolean;
  readonly pid: number | null;
}

/**
 * 跑进程并等待收尾；超时/取消时杀**进程树**后再解决 Promise。
 *
 * `stdio: "pipe"` + 手工收集：不用 `exec` 的默认 1MB 上限（那会在长输出时直接报错丢结果），
 * 本工具的输出上限由 `maxOutputBytes` 决定且有滚动缓冲兜底。
 */
function runProcess(input: RunProcessInput): Promise<RunProcessOutcome> {
  return new Promise<RunProcessOutcome>((resolve) => {
    let child: ChildProcess;
    try {
      child = spawn(input.cmd, {
        cwd: input.cwd,
        shell: true,
        windowsHide: true,
        // POSIX 下自成进程组，超时才杀得掉整棵树（Windows 走 taskkill /T，见 killProcessTree）
        detached: process.platform !== "win32",
      });
    } catch {
      // spawn 同步抛错（非法 cwd/命令）→ 归一成"没有退出码"，由调用方读 exitCode=null
      resolve({ exitCode: null, signal: null, timedOut: false, pid: null });
      return;
    }
    let timedOut = false;
    let settled = false;

    const timer = setTimeout(() => {
      timedOut = true;
      killProcessTree(child);
    }, input.timeoutMs);

    const onAbort = (): void => {
      killProcessTree(child);
    };
    if (input.signal.aborted) {
      onAbort();
    } else {
      input.signal.addEventListener("abort", onAbort, { once: true });
    }

    const finish = (exitCode: number | null, signal: NodeJS.Signals | null): void => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timer);
      clearTimeout(hardDeadline);
      input.signal.removeEventListener("abort", onAbort);
      resolve({
        exitCode,
        signal: signal === null ? null : String(signal),
        timedOut,
        pid: child.pid ?? null,
      });
    };

    child.stdout?.on("data", (chunk: Buffer) => input.stdout.push(chunk));
    child.stderr?.on("data", (chunk: Buffer) => input.stderr.push(chunk));
    child.on("error", () => {
      // ENOENT 之类的 spawn 失败：以"没有退出码"收场，由调用方从 exitCode=null 看出来
      finish(null, null);
    });
    // 以 `exit` 而不是 `close` 收场：`close` 还要等**所有 stdio 管道**关闭，
    // 而被杀掉的子进程若留下一个继承了 stdout 的孙进程，管道就一直不关（实测会挂住整次调用）。
    // `exit` 在进程终止时立即触发，输出已经通过 data 事件收完（Node 保证 exit 前 data 已派发）。
    child.on("exit", (code: number | null, signal: NodeJS.Signals | null) => {
      finish(code, signal);
    });
    // 兜底：极端情况下 `exit` 也不来（句柄被外部持有），仍要在超时后有限时间内收场，
    // 不能让一次工具调用永远挂着（挂住的主循环比失败的工具更糟）。
    const hardDeadline = setTimeout(() => finish(null, null), input.timeoutMs + 5_000);
    hardDeadline.unref();
  });
}
