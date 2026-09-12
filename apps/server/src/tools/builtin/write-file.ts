/**
 * builtin/write_file：写工作区内的文本文件（t5 §4.2 工具名 `write_file`）。
 *
 * 顺序纪律（t4 §6）：**先 `guard.check(path, "write")`，再碰磁盘**；被拒 → 403 口径。
 *
 * 三种模式（`WRITE_MODES`，t4 §5）：
 * - `create`：目标**已存在**即 `ToolInputError`（400）。这是防"模型以为在新建、实际覆盖了
 *   用户文件"的核心保护——覆盖必须显式说 `overwrite`。
 * - `overwrite`：整体替换。
 * - `append`：追加（不自动补换行：补了就不是"用户要的内容"了）。
 *
 * **落盘三项**（验收点）：写完 `stat` 回读 `lines / bytes / mtimeMs`，并把守卫结论一并
 * 回显 —— 断言的对象必须是磁盘上的真实状态，不是"我以为写进去的内容"。
 */
import { appendFileSync, existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { ToolInputError, type GuardDecision } from "@agentplant/agent-core";
import { TOOL_PARAM_SCHEMAS } from "@agentplant/protocol";
import { assertAllowed } from "../../policy/guard.js";
import { materializeParams } from "../params.js";
import type { Tool, ToolServices } from "../types.js";

export interface WriteFileDetails {
  readonly path: string;
  /** 落盘三项之一：磁盘上行数（口径同 read_file：尾部换行不额外算一行）。 */
  readonly lines: number;
  /** 落盘三项之二：磁盘上 UTF-8 字节数。 */
  readonly bytes: number;
  /** 落盘三项之三：`stat.mtimeMs`（毫秒，来自磁盘而不是本地时钟）。 */
  readonly mtimeMs: number;
  /** 是否本次新建（`create` 恒为 true；`overwrite`/`append` 视落盘前状态）。 */
  readonly created: boolean;
  readonly mode: "create" | "overwrite" | "append";
  /** 守卫结论回显（`allow`；被拒的路径根本走不到这里）。 */
  readonly guardDecision: GuardDecision;
}

/** 统计文本行数（与 `read_file` 的 `totalLines` 同口径：空文本 0 行）。 */
export function countLines(text: string): number {
  if (text.length === 0) {
    return 0;
  }
  const lines = text.split("\n");
  if (lines.length > 1 && lines[lines.length - 1] === "") {
    lines.pop();
  }
  return lines.length;
}

export function createWriteFileTool(services: ToolServices): Tool<unknown, WriteFileDetails> {
  return {
    name: "write_file",
    label: "写入文件",
    description:
      "在工作区内创建 / 覆盖 / 追加一个文本文件。何时用：把完整的新内容写进文件。" +
      "何时不用：只想读内容用 read_file；局部改动没有专门的 patch 工具，M1 请自己 read 后" +
      "整体 write（`mode:\"create\"` 遇已存在文件会失败，覆盖必须显式 `mode:\"overwrite\"`）。",
    parameters: TOOL_PARAM_SCHEMAS.write_file,
    sideEffect: { kind: "fs_write", capability: "fs.write" },
    risk: "review",
    execute: async (_ctx, rawParams) => {
      const params = materializeParams("write_file", rawParams);
      const checked = services.guard.check(params.path, "write");
      const absolute = assertAllowed(checked, params.path);
      const existed = existsSync(absolute);
      if (params.mode === "create" && existed) {
        throw new ToolInputError(
          `write_file：${params.path} 已存在，mode:"create" 拒绝覆盖（要覆盖请显式 mode:"overwrite"）`,
          { path: params.path, mode: params.mode },
        );
      }
      try {
        mkdirSync(dirname(absolute), { recursive: true });
        if (params.mode === "append" && existed) {
          appendFileSync(absolute, params.content, "utf8");
        } else {
          writeFileSync(absolute, params.content, "utf8");
        }
      } catch (error) {
        throw new ToolInputError(
          `write_file 写不进去：${params.path}（${error instanceof Error ? error.message : String(error)}）`,
          { path: params.path },
        );
      }
      // 落盘回读三项：断言对象是磁盘状态（非预期值），避免"写成功但内容没落盘"的假绿。
      const stat = statSync(absolute);
      const onDisk = readFileSync(absolute, "utf8");
      const details: WriteFileDetails = {
        path: params.path,
        lines: countLines(onDisk),
        bytes: Buffer.byteLength(onDisk, "utf8"),
        mtimeMs: stat.mtimeMs,
        created: !existed,
        mode: params.mode,
        guardDecision: checked.decision,
      };
      return {
        content:
          `已写入 ${params.path}（mode=${params.mode}，${details.created ? "新建" : "已存在"}）：` +
          `${details.lines} 行 / ${details.bytes} 字节 / mtimeMs=${Math.round(details.mtimeMs)}，` +
          `guard=${details.guardDecision}`,
        details,
      };
    },
  };
}
