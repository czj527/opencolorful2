/**
 * 渲染层最小占位（M1 骨架）：只显示"构建产物已加载 + 版本戳来源"，
 * 证明「窗口 → 构建产物 → 版本戳」链路连通。
 *
 * 版本号**不硬编码**：一律经 preload 桥接读构建期注入的 build-info.json（t3 §6-6 / t7 FG-05）。
 * 真实聊天 UI 由 t5 视觉规范（`docs/design/tokens.md`、`docs/design/ia-and-interaction.md`）
 * 驱动落地，视图与组件均落 `apps/desktop`。
 */

const BUILD_LABEL = "M1 骨架 · 桌面入口";

function paragraph(text: string): HTMLParagraphElement {
  const element = document.createElement("p");
  element.textContent = text;
  return element;
}

function appendNotice(root: HTMLElement, text: string): void {
  const notice = paragraph(text);
  notice.className = "ap-notice";
  root.append(notice);
}

async function render(): Promise<void> {
  const root = document.getElementById("app");
  if (root === null) {
    return;
  }

  root.textContent = "";
  const heading = document.createElement("h1");
  heading.textContent = "AgentPlant";
  root.append(heading, paragraph(BUILD_LABEL));

  const bridge = window.agentplant;
  if (bridge === undefined) {
    appendNotice(root, "版本信息不可用：preload 桥接未注入（不回退到硬编码版本，t7 FG-05）");
    appendNotice(root, "聊天 / 工具 / 记忆 尚未实现（后续任务）。");
    return;
  }

  try {
    const payload = await bridge.getBuildInfo();
    if (!payload.available) {
      appendNotice(root, `版本信息不可用：${payload.reason}`);
      appendNotice(root, "聊天 / 工具 / 记忆 尚未实现（后续任务）。");
      return;
    }

    const { buildInfo, appVersion, versionConsistent } = payload;
    const releaseTag = buildInfo.isReleaseVersion ? "" : "（非发布版本：骨架/开发）";
    root.append(paragraph(`版本 ${buildInfo.version}${releaseTag}`));
    root.append(
      paragraph(`git ${buildInfo.gitSha ?? "未知"} · 构建于 ${buildInfo.buildTime}`),
    );
    if (!versionConsistent) {
      appendNotice(
        root,
        `⚠ 版本戳不一致：app.getVersion()=${appVersion} != build-info.version=${buildInfo.version}（t7 P2 四方一致）`,
      );
    }
    appendNotice(root, "聊天 / 工具 / 记忆 尚未实现（后续任务）。");
  } catch (error) {
    appendNotice(root, `版本信息读取失败：${String(error)}`);
  }
}

void render();
