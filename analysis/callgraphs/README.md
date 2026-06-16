# 调用链图索引

[返回总目录](../README.md)

本目录提供三层可视化图，用于辅助学习 Claude Code 源码的调用链路。

每条调用关系均基于源码真实 import 和函数调用扫描得出，非文档推断。

---

## 三层结构

| 层 | 目录 | 关注点 | 适用场景 |
|----|------|--------|----------|
| **宏观** | [`01-macro/`](./01-macro/) | 系统六层架构，层间调用方向 | 初次了解整体结构 |
| **中观** | [`02-meso/`](./02-meso/) | ~25 个核心文件之间的依赖拓扑 | 理清模块边界和核心枢纽文件 |
| **微观** | [`03-micro/`](./03-micro/) | 4 条关键链路的方法级调用序列 | 深入每条核心执行路径 |

## 三种格式

| 格式 | 扩展名 | 渲染方式 | 适用场景 |
|------|--------|----------|----------|
| **Mermaid** | `.mmd.md` | GitHub / mermaid.live 自动渲染 | 在线浏览，嵌入 Markdown |
| **ASCII** | `.txt` | 终端 `cat` 直接查看 | 最朴素，零依赖 |
| **Graphviz DOT** | `.dot` | `dot -Tpng file.dot -o file.png` | 复杂图的高质量渲染 |

---

## 宏观层：分层架构图

系统按六层组织，从 CLI 入口到能力扩展层逐层展开。

- [`architecture.mmd.md`](./01-macro/architecture.mmd.md) — Mermaid 版
- [`architecture.txt`](./01-macro/architecture.txt) — ASCII 版
- [`architecture.dot`](./01-macro/architecture.dot) — Graphviz 版

---

## 中观层：模块间文件依赖图

~25 个核心文件作为节点，按模块分组着色，展示跨模块调用关系。

- [`module-deps.mmd.md`](./02-meso/module-deps.mmd.md) — Mermaid 版
- [`module-deps.txt`](./02-meso/module-deps.txt) — ASCII 版
- [`module-deps.dot`](./02-meso/module-deps.dot) — Graphviz 版

---

## 微观层：关键链路时序图

4 条核心执行路径的方法级调用链。

### 链路 1：启动链路

从进程启动到 REPL 工作台就绪的完整流程。

- [`startup-sequence.mmd.md`](./03-micro/startup-sequence.mmd.md) — Mermaid 版
- [`startup-sequence.txt`](./03-micro/startup-sequence.txt) — ASCII 版
- [`startup-sequence.dot`](./03-micro/startup-sequence.dot) — Graphviz 版

### 链路 2：Query 执行循环

从用户输入到模型响应 + 工具执行 + 结果回流的完整循环。

- [`query-loop-sequence.mmd.md`](./03-micro/query-loop-sequence.mmd.md) — Mermaid 版
- [`query-loop-sequence.txt`](./03-micro/query-loop-sequence.txt) — ASCII 版
- [`query-loop-sequence.dot`](./03-micro/query-loop-sequence.dot) — Graphviz 版

### 链路 3：Tool 执行链路

工具调度的完整路径：分组 → 权限 → Hook → 执行 → 结果处理。

- [`tool-execution-sequence.mmd.md`](./03-micro/tool-execution-sequence.mmd.md) — Mermaid 版
- [`tool-execution-sequence.txt`](./03-micro/tool-execution-sequence.txt) — ASCII 版
- [`tool-execution-sequence.dot`](./03-micro/tool-execution-sequence.dot) — Graphviz 版

### 链路 4：Memory 注入链路

Memory 从文件读取 → 召回 → 注入 system prompt 的完整路径。

- [`memory-injection-sequence.mmd.md`](./03-micro/memory-injection-sequence.mmd.md) — Mermaid 版
- [`memory-injection-sequence.txt`](./03-micro/memory-injection-sequence.txt) — ASCII 版
- [`memory-injection-sequence.dot`](./03-micro/memory-injection-sequence.dot) — Graphviz 版

---

## 渲染说明

### Mermaid

GitHub 直接支持。或粘贴到 [mermaid.live](https://mermaid.live) 在线预览。

### Graphviz

```bash
# 安装 Graphviz（如未安装）
# macOS: brew install graphviz
# Ubuntu: sudo apt install graphviz
# Windows: choco install graphviz

# 渲染为 PNG
dot -Tpng architecture.dot -o architecture.png

# 渲染为 SVG
dot -Tsvg architecture.dot -o architecture.svg
```

---

## 学习建议

1. **先宏观**：通读分层架构图，建立整体印象
2. **再中观**：看模块依赖图，找出核心枢纽文件（如 `query.ts`、`main.tsx`）
3. **后微观**：按启动 → Query → Tool → Memory 的顺序，逐条链路阅读时序图
4. **对照源码**：时序图中每个函数名都对应真实源文件，可直接跳转阅读
