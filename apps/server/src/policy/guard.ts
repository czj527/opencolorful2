/**
 * policy/guard：PathGuard 简化版（t4 §6）。
 *
 * **诚实标注（必须原样保留）**：在引入 OS 级沙箱（seatbelt / landlock / job object）
 * 之前，workspace-only 是**约定级**约束，**不是安全边界**——本模块拦得住"工具按自己的
 * 参数写文件"，拦不住"被执行的命令自己往沙箱外写"。真正的硬保证只来自二期 OS 沙箱。
 *
 * 判定口径（t4 §6 逐条落定）：
 * 1. 先 realpath 再匹配：符号链接不得把 `inside` 变成 `outside`；不存在的路径**向上找
 *    最近的存在祖先**取 realpath，再拼回剩余段（写新文件也要判得准）。
 * 2. 包含判定 `target === base || target.startsWith(base + sep)`（字符串前缀会误判
 *    `/work` ↔ `/workshop`，必须带分隔符）。
 * 3. `<root>/.git` 与凭据文件名（`.env` / 私钥 / `credentials` / `id_rsa` …）**强制 blocked**，
 *    无论读写；这条在 realpath 之前判，理由是"不存在也要拒"，避免先探测磁盘状态。
 * 4. `workspaceRoot` 内 `rw`；以外 `blocked`（MVP 不提供 ro 白名单，少一条旁路）。
 *
 * 返回 `GuardDecision`（`allow | blocked | readonly`）而不是抛错：调用方（工具）负责把
 * `blocked` 翻成 `ToolAuthorizationError`（403 口径，t4 §5），本模块保持纯判定。
 */
import { realpathSync } from "node:fs";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import { ToolAuthorizationError, type GuardDecision } from "@agentplant/agent-core";

/** 守卫只区分读写两类操作（`op` 的取值面，避免调用方自造第三类）。 */
export type GuardOperation = "read" | "write";

export interface GuardCheckResult {
  readonly decision: GuardDecision;
  /** 判定为 `blocked`/`readonly` 时的原因（`allow` 时省略）。 */
  readonly reason?: string;
  /** realpath 之后的归一化绝对路径（供日志与审计，不含正文）。 */
  readonly resolvedPath: string;
}

export interface PathGuard {
  readonly workspaceRoot: string;
  check(path: string, op: GuardOperation): GuardCheckResult;
}

/**
 * 强制 blocked 的文件名（小写比较）。
 *
 * 只列"凭据类"：环境文件、私钥、包管理器/云厂商令牌文件。刻意**不**列 `package.json`
 * 之类普通文件——守卫每多一条无谓禁令，用户就更想关掉它。
 */
export const FORBIDDEN_FILE_NAMES: readonly string[] = [
  ".env",
  ".env.local",
  ".env.production",
  ".env.development",
  ".env.test",
  ".npmrc",
  ".pypirc",
  ".netrc",
  "_netrc",
  ".git-credentials",
  "credentials",
  "credentials.json",
  "id_rsa",
  "id_dsa",
  "id_ecdsa",
  "id_ed25519",
  "token.json",
  ".htpasswd",
];

/** 强制 blocked 的路径段（目录名，小写比较）。 */
export const FORBIDDEN_DIR_NAMES: readonly string[] = [".git", ".ssh", ".aws"];

/** 判定用的小写化：Windows 路径大小写不敏感，统一小写比较（宁严不宽）。 */
function lower(value: string): string {
  return process.platform === "win32" ? value.toLowerCase() : value;
}

/**
 * `target === base || target.startsWith(base + sep)`（t4 §6 的包含判定，逐字）。
 *
 * 先把分隔符统一成 `/` 再比较：Windows 上 `sep` 是 `\`，而调用方可能传 POSIX 风格的
 * 路径（配置里写死 `/` 很常见），混用分隔符会让前缀判定把工作区内的路径误判成"越界"。
 * 归一化只影响比较，不影响返回给调用方的路径。
 */
export function isInside(base: string, target: string): boolean {
  const normalize = (value: string): string => lower(value.replace(/\\/g, "/")).replace(/\/+$/, "");
  const b = normalize(base);
  const t = normalize(target);
  return t === b || t.startsWith(`${b}/`);
}

/**
 * realpath 先行 + 祖先回溯：返回"把不存在的尾段拼回最近存在祖先 realpath"的绝对路径。
 *
 * 尾段沿用调用方传入的原文（不额外归一化），因为对**不存在**的路径而言，
 * realpath 语义上本就无解；这里只保证"已存在部分"不撒谎。
 */
export function resolveRealPath(path: string): string {
  let current = resolve(path);
  const tail: string[] = [];
  for (;;) {
    try {
      const real = realpathSync(current);
      return tail.length === 0 ? real : join(real, ...tail);
    } catch {
      const parent = dirname(current);
      if (parent === current) {
        return join(current, ...tail);
      }
      tail.unshift(current.slice(parent.length).replace(/^[\\/]+/, ""));
      current = parent;
    }
  }
}

/** 绝对/相对路径统一成绝对路径；相对路径一律相对 `workspaceRoot`（沙箱内语义）。 */
export function toAbsolute(root: string, path: string): string {
  return isAbsolute(path) ? resolve(path) : resolve(root, path);
}

/** 目录段与文件名是否命中强制 blocked 名单。 */
function forbiddenReason(absolutePath: string): string | undefined {
  const segments = absolutePath.split(/[\\/]+/).filter((segment) => segment.length > 0);
  const fileName = lower(segments[segments.length - 1] ?? "");
  for (const segment of segments) {
    const name = lower(segment);
    if (name === ".git") {
      return "命中强制禁区：.git（版本库元数据，读写一律 blocked，t4 §6）";
    }
    if (FORBIDDEN_DIR_NAMES.includes(name)) {
      return `命中强制禁区：${segment}（凭据目录，读写一律 blocked，t4 §6）`;
    }
  }
  if (FORBIDDEN_FILE_NAMES.includes(fileName)) {
    return `命中强制禁区：${fileName}（凭据文件，读写一律 blocked，t4 §6）`;
  }
  // `id_rsa.pub` 之类派生态：私钥族的后缀形态也拒（公钥泄露无害但比"漏判私钥"安全）。
  if (/^id_(rsa|dsa|ecdsa|ed25519)(\.|$)/.test(fileName)) {
    return `命中强制禁区：${fileName}（SSH 密钥族，读写一律 blocked，t4 §6）`;
  }
  return undefined;
}

/** 构造守卫；`workspaceRoot` 自身也过一遍 realpath（用户可能用符号链接指向工作区）。 */
export function createPathGuard(workspaceRoot: string): PathGuard {
  const root = resolveRealPath(workspaceRoot);
  return {
    workspaceRoot: root,
    check(path: string, op: GuardOperation): GuardCheckResult {
      if (path.trim().length === 0) {
        return { decision: "blocked", reason: "空路径", resolvedPath: root };
      }
      const absolute = toAbsolute(root, path);
      // 强制禁区在 realpath 之前判：**路径不存在也要拒**（否则能用"先探测再判断"绕过）。
      // 读写口径刻意不对称（t4 §6）：**读**被拦死（`.git`/凭据内容不该进模型上下文），
      // **写**返回 `readonly`——语义是"写不进去，而不是你有权写"，调用方一样按 403 处理，
      // 但 UI/审计能区分"权限不足"与"该文件只读"。
      const forbidden = forbiddenReason(absolute);
      if (forbidden !== undefined) {
        return op === "write"
          ? { decision: "readonly", reason: `${forbidden}；写操作被降级为只读`, resolvedPath: absolute }
          : { decision: "blocked", reason: forbidden, resolvedPath: absolute };
      }
      const real = resolveRealPath(absolute);
      if (!isInside(root, real)) {
        return {
          decision: "blocked",
          reason:
            `越出工作区：${real} 不在 ${root} 内；` +
            "MVP 沙箱是 workspace-only（约定级约束，t4 §6）",
          resolvedPath: real,
        };
      }
      // 已存在的路径若与 realpath 不一致，说明中间有符号链接——仍按 realpath 结论判定。
      const realForbidden = forbiddenReason(real);
      if (realForbidden !== undefined) {
        return op === "write"
          ? { decision: "readonly", reason: `${realForbidden}；写操作被降级为只读`, resolvedPath: real }
          : { decision: "blocked", reason: realForbidden, resolvedPath: real };
      }
      return { decision: "allow", resolvedPath: real };
    },
  };
}

/**
 * 把守卫结论翻成工具层语义：`allow` 放行并返回 realpath，其余抛
 * `ToolAuthorizationError`（403 口径，t4 §5）。
 *
 * 放在 policy 层而不是各工具里：403 口径只有一处定义，工具只写一行 `assertAllowed(...)`。
 */
export function assertAllowed(result: GuardCheckResult, path: string): string {
  if (result.decision === "allow") {
    return result.resolvedPath;
  }
  const reason = result.reason ?? "被沙箱策略拒绝";
  throw new ToolAuthorizationError(`${path} 被沙箱策略拒绝：${reason}`, {
    path,
    decision: result.decision,
  });
}

/** 相对工作区的展示路径（日志/审计里避免泄露绝对路径）。 */
export function relativeToRoot(root: string, absolutePath: string): string {
  const rel = relative(root, absolutePath);
  return rel.length === 0 ? "." : rel;
}

/** 路径校验结果里"给模型看"的字段（工具 details 用）。 */
export function guardDecisionOf(result: GuardCheckResult): GuardDecision {
  return result.decision;
}
