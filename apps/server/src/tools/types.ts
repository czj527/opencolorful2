/**
 * tools/types：工具运行时的本地类型面（t4 §5）。
 *
 * 纪律：**工具契约本身不在这里重新定义**。`Tool / ToolContext / ToolResult /
 * ToolInputError / ToolAuthorizationError / GuardDecision / CommandRisk` 一律从
 * `@agentplant/agent-core` 重导出（t4 §1：契约在 core，实现在 server），本文件只补
 * server 侧需要的**注入面**（`ToolServices`）与提示词可见的工具清单分组。
 *
 * 依赖方向：server → agent-core / protocol / state；core 永不 import apps/*。
 */
import type { Tool } from "@agentplant/agent-core";
import type { StateDao } from "@agentplant/state";
import type { ToolName } from "@agentplant/protocol";
import type { LlmConfig } from "../agent/llm.js";
import type { PathGuard } from "../policy/guard.js";
import type { Redactor } from "../policy/redactor.js";

export type {
  CommandRisk,
  GuardDecision,
  Tool,
  ToolContext,
  ToolFailureKind,
  ToolResult,
} from "@agentplant/agent-core";
export { ToolAuthorizationError, ToolInputError } from "@agentplant/agent-core";

/**
 * `fetchImpl` 的最小结构面（`globalThis.fetch` 与 `undici` 都满足）。
 *
 * 只声明本仓真正用到的成员（`status / headers / url / text()`），因此测试可以注入一个
 * **本地回环真 socket stub** 的薄实现，而生产路径直接用 `globalThis.fetch`。
 * 这里**不**暴露 `body` 流：本仓只需要文本正文，流式读取会引入额外状态。
 */
export interface FetchLike {
  (input: string | URL, init?: FetchInitLike): Promise<FetchResponseLike>;
}

export interface FetchInitLike {
  readonly method?: string;
  readonly headers?: Record<string, string>;
  readonly redirect?: "follow" | "manual" | "error";
  readonly signal?: AbortSignal;
  /**
   * 请求体（模型 provider 的 chat completions 是 POST + JSON）。
   *
   * 本仓只用到**字符串**形态：本包不构造 `ReadableStream` 请求体，
   * 也就不需要为它引入 `lib.dom` 的流类型。
   */
  readonly body?: string;
}

export interface FetchResponseLike {
  readonly status: number;
  readonly url: string;
  readonly headers: { get(name: string): string | null };
  text(): Promise<string>;
}

/** SSRF 守卫用的主机解析函数（缺省 = `node:dns/promises` 的 `lookup(host,{all:true})`）。 */
export type ResolveHostAddresses = (
  hostname: string,
) => Promise<readonly string[]>;

/**
 * 模型 provider 的注入面（t15 主循环用）。
 *
 * 与 `ToolServices.fetchImpl` 分开是刻意的：那是"出网工具打哪个主机"的注入点（联网搜索/抓网页），
 * 这里是"模型请求打哪个主机"的注入点（OpenAI-compatible endpoint）。两者在真实部署里是
 * **不同的提供方**，合并成一个字段会逼测试用一个 stub 冒充两个服务，断言立刻失去意义。
 *
 * 生产路径两者都留 undefined → 各自走 `globalThis.fetch`。
 */
export interface ModelConfigOverride {
  /** 覆盖 `readLlmConfig` 的结果（`null` = 显式未配置，用于"未配置 → 诚实报错"用例）。 */
  readonly llm?: LlmConfig | null;
  /** 仅测试注入：本地回环 stub（真 socket）。 */
  readonly fetchImpl?: FetchLike;
}

/**
 * 工具运行时注入面：由调用方（`index.ts` / 测试）构造，工具实现只读消费。
 *
 * 三件事刻意做成注入而不是模块级单例：
 * 1. `workspaceRoot` —— 沙箱根随会话/测试目录变化，不能是进程常量。
 * 2. `guard` / `redactor` —— 策略对象要能被独立单测，且运行时可有不同实例。
 * 3. `fetchImpl` —— **仅测试注入本地回环 stub 服务器用**（AGENTS.md 禁 mock 回放：
 *    测试必须打真 socket）；生产**默认 `globalThis.fetch`**，此字段保持 undefined。
 *
 * `memoryDb` 是可选位：骨架期 `routes.ts` 还没有主循环，DB 由调用方（t15 主循环）经
 * `@agentplant/state` 的 `openDatabase` + `migrate` 打开后注入；未注入时记忆工具
 * **诚实报错**（ToolInputError），不伪造成功（t7 §1.2 禁假绿）。
 */
export interface ToolServices {
  /** 沙箱工作区根（绝对路径）。 */
  readonly workspaceRoot: string;
  /** 路径守卫（`policy/guard.ts`）。 */
  readonly guard: PathGuard;
  /** 日志脱敏器（`policy/redactor.ts`）。 */
  readonly redactor: Redactor;
  /** 记忆 DAO；未注入时 `memory_*` 工具诚实报错。 */
  readonly memoryDb?: StateDao;
  /** 仅测试注入：本地回环 stub（生产默认 global fetch，见类注释）。 */
  readonly fetchImpl?: FetchLike;
  /** 仅测试注入：SSRF 主机解析替身（生产走真实 DNS）。 */
  readonly resolveHost?: ResolveHostAddresses;
}

/** 工具清单分组：`core` = t5 §4.2 冻结的 7 个内置工具（窄腰纪律，禁止第 8 个）。 */
export const CORE_TOOL_GROUP = "core" as const;

/** 注册表条目：`Tool` + 归属组（`registerModule` 用，M2 插件扩展点 B）。 */
export interface RegisteredTool {
  /**
   * 参数类型是 `unknown` 而不是 `never`：模型/前端的原始入参形状不可信，
   * 一律由 `params.ts` 的 `materializeParams` 校验后才使用（校验前的类型都是幻觉）。
   */
  readonly tool: Tool<unknown, unknown>;
  readonly group: string;
  /** 是否由本进程注册（`core`）；M2 插件注册的为 `false`。 */
  readonly builtin: boolean;
}

/** 取值口径：注册表里永远只放 7 个冻结名字之一。 */
export type CoreToolName = ToolName;
