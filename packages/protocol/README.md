# packages/protocol（待定占位 —— 结构口径未统一）

**本包为空目录占位，不含实现，不得实质分叉。**

依据 `docs/decisions/t3-repo-ci.md` §8：t3 §1 按**领域划分**包
（`agent-core` / `state` / `gateway-protocol` / `plugin-sdk`），t4 §1 按**纯度分层**
（`protocol` 共享 schema + `agent-core` 纯函数）——两种划分尚未统一。统一前本目录只作
占位，避免同一职责出现两个包。

落地时的方向（供参考）：若沿用纯度分层，`protocol` 承载前后端共享的类型/schema；
若沿用领域划分，其职责由 `agent-core`/`state` 的公开类型面承担。

**在 t4/t3 对齐并更新决策文档前，不要在此目录创建源码或 package.json。**
