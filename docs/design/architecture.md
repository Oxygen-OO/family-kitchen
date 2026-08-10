# 家庭厨房 · 代码库架构 (v1)

## 分层与 seam

业务逻辑只允许出现在黑线以下；页面永远不直接碰云数据库。

```
小程序页面 (薄壳: family-home / menu / dish-edit / meal / prep / settings / invite)
   │ seam 1: wx.cloud.callFunction(action, payload) —— 客户端只学 action 名与载荷
   ▼
云函数: cloudfunctions/family-kitchen/  (单函数起步, 见「部署形态」)
   ├── index.js       薄壳: 按 event.action 路由到 lib 深模块
   ├── lib/
   │   ├── meal-engine/        餐次引擎 (全部餐次/点餐/截止规则)
   │   ├── family-engine/      家庭引擎 (立家/邀请/转让/解散)
   │   ├── summarizer/         备餐汇总器 (纯函数)
   │   └── ports/              云数据库/Clock/订阅消息 适配器 (唯一 import wx-server-sdk 的地方)
   ▼ seam 2: ports —— 云数据库 / 微信订阅消息(外部) / 时间
```

- **seam 1** 的载荷就是引擎接口方法签名，无二次包装——入口壳只有校验+路由+错误翻译。
- **seam 2** 是 port/adapter seam（remote-but-owned 数据库、true external 订阅消息）：测试用内存双胞胎/Spy 跨 seam 全真演练，见各模块设计文档。
- lib 内**零 SDK import**、零 I/O，域逻辑全是可注入的纯 Node。

## 部署形态

**MVP 用一个云函数** `family-kitchen`：微信云开发允许同一函数挂多个定时触发器，cron 触发的 event 与客户端 action 都进 `index.js`，按 `event.action === 'scanDue'` 等分派——零共享代码问题、零冷启动差异。未来拆分（业务/cron 分离、独立缩放）时只换壳文件与触发器配置，lib 原封不动（这是 ports 收在 lib 的回报）。cron 粒度：每 5 分钟一次截止扫描。

## 数据模型（云数据库集合）

主键约定：**派生复合 ID 代替随机 `_id`**——文档库无跨文档事务与唯一索引，ID 空间是唯一可靠的并发/唯一性原语。文档键（date）与集合字段同名写法统一为 `date('YYYY-MM-DD')`。

| 集合 | _id | 关键字段 | 约定 |
|---|---|---|---|
| `families` | 自增/随机 | name, creator(openid), members: [{openid, nickname, joinedAt}], memberOpenids: [openid], frozen: bool, createdAt | 成员数 ≤5（含立家者）；`memberOpenids` 冗余数组供「我的家庭列表」查询（elemMatch 不可靠时兜底，数据量 ≤5×3 极小） |
| `invites` | 随机 | familyId, code(唯一), createdBy, createdAt, expiresAt(+7天), usedBy | 满员/过期/已用/冻结即失效 |
| `dishes` | 随机 | familyId, name, imageFileId?, description?, tags[], ingredients: [{name, amount}], isDeleted, updatedBy, updatedAt, createdAt | 软删：`isDeleted: true` |
| `meals` | `familyId:date:slot` | familyId, date, slot('breakfast'\|'lunch'\|'dinner'), status('open'\|'closed'\|'prepped'), initiatedBy, closeAt, closedAt?, preppedAt?, closedBy('scan'\|'manual'), summary?: PrepSummary | 日期×餐次唯一由 ID 空间天然保证；summary 为截止时物化的备餐快照 |
| `orders` | `mealId:openid` | mealId, openid, memberName(快照), entries: [{dishId, dishName快照}], copiedFromMealId?, updatedAt | 每人每餐一单（upsert），全量替换语义；同名快照保证菜品软删后历史可回显、点餐汇总可列出成员 |
| `subscribe_grants` | `mealId:openid` | mealId, openid, consumed: bool, consumedAt? | 一次性订阅配额记账：一人一餐一条 |
| `users` | openid | openid, nickname(登录时自填, 2022 后微信不回传昵称), createdAt | 昵称冗余进 families.members[] 供汇总显示 |

## 模块清单

| 模块 | 位置 | 接口 | 深度来源 |
|---|---|---|---|
| MealEngine | lib/meal-engine | 7 个方法（见 meal-engine.md） | 状态机+截止管线+幂等+授权消费，全部规则收在一个类后 |
| FamilyEngine | lib/family-engine | 7 个方法（见 family-engine.md） | 立家/邀请/转让/解散不变量 |
| PrepSummarizer | lib/summarizer | 1 个纯函数 `buildSummary` | 按菜聚合+食材精确去重合并 |
| 入口壳 | index.js | action 路由 | 刻意薄，不承载规则 |
| 页面 | pages/* | 呈现 + 调 seam 1 | 客户端规则知识为零 |

## 测试策略

- 单测跑在 lib 层：`new MealEngine(memStore, fixedClock, spyNotifier)`（内存双胞胎必须忠实复刻条件更新语义，否则幂等测试自我安慰）。
- 断言只跨外部 seam（错误码/视图/快照/发送序列/claim 计数），不窥探实现——replace, don't layer。
- PrepSummarizer 无 I/O，直接纯函数测。
- 外部 seam 1（action 路由壳）由集成冒烟覆盖，不进单测。

## 范围引用

领域规则源：CONTEXT.md（词汇与不变量）、docs/adr/0001-0003（家庭独立实体 / 一次性订阅 / 数据保守主义）。MVP 边界（无支付、无多余餐次、无推送催点、授权仅随点餐提交发生）见会话定案。