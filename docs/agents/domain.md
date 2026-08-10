# 域文档

工程技能在探索代码库时应如何消费本仓库的域文档。

## 探索前先读这些

- 仓库根目录的 **`CONTEXT.md`**（本仓库已有：术语与不变量），或
- 若存在 **`CONTEXT-MAP.md`**（本仓库无，单上下文），它指向每个上下文各自的 `CONTEXT.md`；
- **`docs/adr/`**（本仓库已有 3 篇决策，见 `docs/adr/0001-0003`）——工作涉及的领域先读相关 ADR；多上下文仓库还要看 `src/<context>/docs/adr/`。

`CONTEXT.md` 是纯词汇表，不含实现细节；实现蓝图在 `docs/design/`（architecture / meal-engine / prep-summarizer / family-engine）。

若上述文件不存在，**静默继续**。不要标记缺失，不要主动建议补建。`/domain-modeling` 技能（经 `/grill-with-docs` 与 `/improve-codebase-architecture` 可达）在术语或决策真正敲定时惰性创建它们。

## 文件结构

单上下文仓库（大多数仓库、含本仓库）：

```
/
├── CONTEXT.md
├── docs/adr/
│   ├── 0001-family-independent-entity.md
│   └── ...
└── src/
```

多上下文仓库（根目录出现 `CONTEXT-MAP.md` 时）：

```
/
├── CONTEXT-MAP.md
├── docs/adr/                          ← 系统级决策
└── src/
    ├── ordering/
    │   ├── CONTEXT.md
    │   └── docs/adr/                  ← 上下文级决策
    └── billing/
```

## 使用词汇表的语言

输出命名领域概念时（issue 标题、重构提案、假设、测试名），使用 `CONTEXT.md` 中定义的术语，不要漂移到词汇表明确回避的同义词（如「群组」取代「家庭」、「下单」取代「点餐」）。

若所需概念不在词汇表中，这是一个信号——要么你在发明项目不用的语言（重新考虑），要么真有空缺（记给 `/domain-modeling`）。

## 标记 ADR 冲突

若输出与既有 ADR 矛盾，显式提出而不是静默覆盖：

> _与 ADR-0002（一次性订阅提醒）冲突——但值得重新讨论，因为…_