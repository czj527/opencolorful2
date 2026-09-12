/**
 * turn：回合级纯函数（t5 §6.3 交付语义 + t4 §4 治理内核）。
 *
 * 本文件与 `completion.ts` 的分工：
 * - `completion.ts` 回答「本回合**是不是**交付」（事实口径：有没有成功工具调用 / 有没有证据）；
 * - `turn.ts` 回答「本回合**看起来像什么**」（文本提示）与「证据怎么组装」「该不该提议写记忆」。
 *
 * 三条纪律：
 * 1. **文本永不覆盖事实**：命中计划词只用于给前端一个 `blockedHint` 提示位与后续轮次的提醒，
 *    `delivery` 只由 `decideTurnDelivery` 的事实口径产出（t4 §4 不变量「进度文本≠交付」）。
 * 2. **纯度**：不读时钟、不读 env、不碰 I/O（`purity.test.ts` 会扫源码断言）——
 *    因此本文件可以在无 DB、无网络的环境里穷举单测。
 * 3. **不猜时态**：命中判定是**子串匹配**（大小写不敏感），不做中文时态解析。
 *    理由见下。
 */
import { PLAN_PATTERN_HINTS } from "./completion.js";

/**
 * 单回合内「模型 ⇄ 工具」往返的轮数上限（t4 §5：防止模型在工具之间无限打转）。
 *
 * 语义是**上限而不是目标**：正常回合 1–3 轮就收尾；用满 8 轮说明模型在空转，
 * 此时主循环必须停下并如实标注（`finishReason: "tool_calls"`），不许继续烧钱也不是静默截断。
 */
export const MAX_TOOL_ITERATIONS = 8;

/**
 * 文本是否命中「计划/将来时」提示词（t5 §6.3「待验证声明」的触发面）。
 *
 * 为什么是**子串匹配**而不是时态解析：主循环拿到的正文是自然语言，任何时态解析都会
 * 在"我将要/我会/接下来"这类中文表达上失手，而失手的方向恰恰是**把计划渲染成交付**
 * （最危险的方向）。因此这里只做保守的正向命中：命中 = 需要提示，不命中 = 不提示。
 * 提示本身**不改判定**（判定看工具调用事实），所以宁可多命中，不可漏命中。
 *
 * 大小写不敏感：词表是中文，但用户/模型正文里可能出现英文夹写（`TODO` 之类）时口径统一。
 *
 * 嵌套依赖关系：命中的是 `PLAN_PATTERN_HINTS`（`completion.ts` 导出的同一份词表），
 * 主循环与前端因此引用同一处，不会两处漂移。
 */
export function matchesPlanPattern(text: string): boolean {
  if (text.length === 0) {
    return false;
  }
  const lowered = text.toLowerCase();
  return PLAN_PATTERN_HINTS.some((hint) => lowered.includes(hint.toLowerCase()));
}

/**
 * 证据汇总（`done.evidence` / 非流式 `evidence` 的组装）。
 *
 * 口径（对齐 protocol `DeliveryEvidenceSchema` 与 t5 §5「依据 <工具名>×N」）：
 * - `toolName`：**首个**工具名（多工具轮次里前端只展示一个主依据，多者由 `count` 表达）；
 * - `count`：证据总数（成功的工具结果条数），**不是**去重后的工具种类数；
 * - `toolCallIds`：按传入顺序原样保留（前端据它逐条核对工具卡片，顺序即事件顺序）。
 *
 * 空列表返回 `toolName: "none"` 而不是空串：空串在 UI 里会被读成"漏填"，
 * `none` 是"确切地没有工具"（与 `turn.end` 审计的 `toolName` 口径一致）。
 */
export function summarizeEvidence(toolResults: readonly { name: string; callId: string }[]): {
  readonly toolName: string;
  readonly count: number;
  readonly toolCallIds: readonly string[];
} {
  const first = toolResults[0];
  if (first === undefined) {
    return { toolName: "none", count: 0, toolCallIds: [] };
  }
  return {
    toolName: first.name,
    count: toolResults.length,
    toolCallIds: toolResults.map((result) => result.callId),
  };
}

/** `maybeSuggestMemory` 的输入：本回合工具使用的事实（**只有名字，没有正文**）。 */
export interface MemorySuggestionFacts {
  /** 本回合所有工具调用（含失败）的名字。 */
  readonly toolNames: readonly string[];
  /** 本回合**成功**的工具调用名字。 */
  readonly successfulToolNames: readonly string[];
}

/** 建议位：`suggest === true` 时 `text` 必非空；`false` 时 `text` 为空串。 */
export interface MemorySuggestion {
  readonly suggest: boolean;
  readonly text: string;
}

/** 触发记忆建议的成功工具（产出"值得记住的东西"的两类）。 */
export const MEMORY_SUGGEST_TRIGGER_TOOLS: readonly string[] = ["write_file", "run_command"];

/**
 * 记忆挂钩的**最小化**启发式（t4 §5 / ia §5）。
 *
 * 规则：本回合有成功的 `write_file` / `run_command`，**且**整轮没有调用 `memory_write`
 * → 返回一段建议串（供模型**下一轮**参考）；否则 `{suggest:false}`。
 *
 * 为什么**不自动写库**：记忆是长期事实，来源必须可追溯到用户的明确表达（ia §5）。
 * "助手自己判断该记什么"会污染来源（用户从没说过的话被记成偏好），
 * 修复代价远高于收益。因此本函数只产出一句提示，写不写由模型按工具纪律决定。
 *
 * 注意这里看的是**整轮**是否调用过 `memory_write`（`toolNames`，含失败）：
 * 试过但失败也算"模型已经想过记忆这件事"，再提醒一次只会让它重复无效调用。
 */
export function maybeSuggestMemory(facts: MemorySuggestionFacts): MemorySuggestion {
  if (facts.toolNames.includes("memory_write")) {
    return { suggest: false, text: "" };
  }
  const triggered = facts.successfulToolNames.some((name) =>
    MEMORY_SUGGEST_TRIGGER_TOOLS.includes(name),
  );
  if (!triggered) {
    return { suggest: false, text: "" };
  }
  return {
    suggest: true,
    text:
      "本轮成功执行了会改变环境/状态的操作，但还没有写入长期记忆。" +
      "若其中包含**用户明确表达**的偏好或跨会话仍然成立的事实，" +
      "可在后续轮次调用 memory_write 记下来（不确定就不要写：宁缺勿污染来源）。",
  };
}
