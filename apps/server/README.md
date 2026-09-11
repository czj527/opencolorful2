# apps/server（待定占位 —— 结构口径未统一）

**本目录为空目录占位，不含任何实现，不得实质分叉。**

依据 `docs/decisions/t3-repo-ci.md` §8：t3 §1 的入口口径（`apps/desktop` 单入口，
Electron 桌面优先）与 t4 §1 的运行内核口径（`apps/server` + `apps/web`，HTTP+SSE）尚未
统一。在统一口径落定前，本目录**只作为占位存在**，用于避免两个口径在仓内提前分叉。

落地时的方向（供参考，不由本目录决定）：二者可调和为——`apps/server` + `apps/web`
是运行内核（HTTP+SSE 单进程，t4 §2），`apps/desktop` 是 Electron 壳、复用 web 构建。

**在 t4/t3 对齐并更新决策文档前，不要在此目录创建源码或 package.json。**
