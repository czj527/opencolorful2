/**
 * builtin/read_file：读工作区内的文本文件（t5 §4.2 工具名 `read_file`）。
 *
 * 顺序纪律（t4 §6）：**先 `guard.check(path, "read")`，再碰磁盘**。守卫拒绝时抛
 * `ToolAuthorizationError`（403 口径），因此"越权路径存在与否"不会从错误消息里泄露。
 *
 * 输出：
 * - `content` = **带行号**的文本（`<行号>\t<正文>`），行号是 1-based 且在 `offset` 下连续，
 *   便于模型引用"第 42 行"而不用自己数。
 * - `details` = 截断三项（`truncated/totalLines/totalBytes`）+ 本次窗口范围。
 */
import { readFileSync } from "node:fs";
import { ToolInputError } from "@agentplant/agent-core";
import { TOOL_PARAM_SCHEMAS } from "@agentplant/protocol";
import { materializeParams } from "../params.js";
import { assertAllowed } from "../../policy/guard.js";
import { readLineWindow } from "./text.js";
import type { Tool, ToolServices } from "../types.js";

/** 读文件默认字节上限（50KiB，与 t4 §5 的窗口同一量级）。 */
export const READ_FILE_MAX_BYTES = 51_200;

export interface ReadFileDetails {
  readonly path: string;
  readonly truncated: boolean;
  readonly truncatedBy?: "lines" | "bytes";
  readonly totalLines: number;
  readonly totalBytes: number;
  readonly returnedLines: number;
  readonly offset: number;
}

/** 给正文加行号（1-based；`startLine` 是本次窗口首行的绝对行号）。 */
export function numberLines(text: string, startLine: number): string {
  if (text.length === 0) {
    return "";
  }
  return text
    .split("\n")
    .map((line, index) => `${startLine + index}\t${line}`)
    .join("\n");
}

export function createReadFileTool(services: ToolServices): Tool<unknown, ReadFileDetails> {
  return {
    name: "read_file",
    label: "读取文件",
    description:
      "读取工作区内一个文本文件的内容（返回带行号的文本）。何时用：需要查看某个已存在的" +
      "文件的当前内容。何时不用：写/改文件用 write_file；探索目录结构不在本工具范围" +
      "（M1 无 ls 工具，需要时用 run_command 并自行承担审批提示）。",
    parameters: TOOL_PARAM_SCHEMAS.read_file,
    risk: "safe",
    execute: async (_ctx, rawParams) => {
      const params = materializeParams("read_file", rawParams);
      const checked = services.guard.check(params.path, "read");
      const absolute = assertAllowed(checked, params.path);
      let raw: string;
      try {
        raw = readFileSync(absolute, "utf8");
      } catch (error) {
        throw new ToolInputError(
          `read_file 读不到文件：${params.path}（${error instanceof Error ? error.message : String(error)}）`,
          { path: params.path },
        );
      }
      const window = readLineWindow(raw, {
        offset: params.offset,
        limit: params.limit,
        maxBytes: READ_FILE_MAX_BYTES,
      });
      const returnedLines = window.text.length === 0 ? 0 : window.text.split("\n").length;
      const details: ReadFileDetails = {
        path: params.path,
        truncated: window.truncated,
        ...(window.truncatedBy === undefined ? {} : { truncatedBy: window.truncatedBy }),
        totalLines: window.totalLines,
        totalBytes: window.totalBytes,
        returnedLines,
        offset: params.offset,
      };
      const header =
        `# ${params.path}（第 ${params.offset + 1} 行起，共 ${window.totalLines} 行 / ` +
        `${window.totalBytes} 字节${window.truncated ? `，已截断（${window.truncatedBy ?? "lines"}）` : ""}）`;
      return {
        content: `${header}\n${numberLines(window.text, params.offset + 1)}`,
        details,
      };
    },
  };
}
