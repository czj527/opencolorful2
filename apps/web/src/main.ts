/**
 * apps/web 入口：启动控制器 → 首次渲染 → 订阅变更。
 *
 * 反假绿（t7 FG-01/FG-02）：本文件是**构建产物**的一部分（`dist/main.js`），
 * 由 `index.html` 以 `<script type="module">` 直接加载，不依赖任何 dev server、不依赖打包器。
 *
 * 渲染节流：SSE token 事件可能非常密集，故把重绘收敛到"每帧一次"
 * （`requestAnimationFrame`），避免逐 token 重建 DOM 导致的整屏闪。
 */
import { AppController } from "./lib/controller.js";
import { mount } from "./views/ui.js";
import type { AppState } from "./lib/store.js";

const root = document.getElementById("app");
if (root === null) {
  throw new Error("缺少挂载点 #app（index.html 契约被破坏）");
}

let scheduled = false;

const controller = new AppController({
  onToken: () => {
    // 流式正文：把尾段增量直接写进当前流式节点（只动文本，不重建子树）。
    scheduleRender();
  },
  onStructureChange: () => {
    scheduleRender();
  },
  onStateChange: () => {
    scheduleRender();
  },
});

function render(state: AppState): void {
  mount(root as HTMLElement, controller);
  scrollToLatest(state);
}

function scheduleRender(): void {
  if (scheduled) {
    return;
  }
  scheduled = true;
  requestAnimationFrame(() => {
    scheduled = false;
    render(controller.store.state);
  });
}

/** 滚动锚定（IA §3.4）：只在"处于底部"时自动跟随，用户上滑后不再抢滚动。 */
function scrollToLatest(state: AppState): void {
  if (!state.chat.following) {
    return;
  }
  const stream = document.querySelector(".ap-stream");
  if (stream !== null) {
    stream.scrollTop = stream.scrollHeight;
  }
}

controller.store.subscribe(() => {
  scheduleRender();
});

window.addEventListener("keydown", (event) => {
  const modifier = event.ctrlKey || event.metaKey;
  if (!modifier) {
    if (event.key === "Escape") {
      const state = controller.store.state;
      if (state.settings.open) {
        controller.store.closeSettings();
      }
    }
    return;
  }
  switch (event.key) {
    case "1":
      controller.setView("chat");
      break;
    case "2":
      controller.setView("memory");
      break;
    case "3":
      controller.setView("tasks");
      break;
    case "n":
      void controller.createSession();
      break;
    case ",":
      controller.store.openSettings("main");
      break;
    case "b":
      controller.store.toggleSidebar();
      break;
    case ".":
      if (event.shiftKey) {
        controller.cycleColorScheme();
      }
      break;
    default:
      return;
  }
  event.preventDefault();
});

void controller.start();
