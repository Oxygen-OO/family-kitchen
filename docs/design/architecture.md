# 家庭厨房 · 代码库架构 (v2)

## 分层与 seam

业务逻辑只允许出现在黑线以下；页面永远不直接碰云数据库。

```
小程序页面 (薄壳: onboarding / index / dishes / meal / plan / my / settings)
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

**MVP 用一个云函数** `family-kitchen`：微信云开发允许同一函数挂多个定时触发器，cron 触发的 event 与客户端 action 都进 `index.js`，按 action 分派——零共享代码问题、零冷启动差异。未来拆分时只换壳文件与触发器配置，lib 原封不动。cron：每 5 分钟一次截止扫描（表达式 `0 */5 * * * * *`，7 段含秒）。

## 数据模型（云数据库集合）

主键约定：`meals` 用派生复合 ID（`familyId:date:slot`）保证 日期×slot 唯一；其余集合用随机 `_id`，唯一性经查询+业务校验保证（成员上限类不变量由引擎把守）。

| 集合 | _id | 关键字段 | 约定 |
|---|---|---|---|
| `families` | 随机 | name, creator_openid, invite_code, expires_at(+7天), member_count, status('active'\|'frozen'), dissolved_at?, created_at | 成员数 ≤5（含立家者）；**同一时刻只有一个有效邀请码，重新生成即旧码失效** |
| `family_members` | 随机 | family_id, user_openid, role('creator'\|'member'), joined_at | 主权限链表；一人至多属 3 个家庭 |
| `dishes` | 随机 | family_id, name, image?, description?, tags[], ingredients: [{name, amount}], is_available, is_deleted, created_by, created_at | 软删：`is_deleted: true`；**食材必为结构化 [{name, amount}]**（汇总器精确去重的输入契约） |
| `meals` | `familyId:date:slot` | family_id, date, slot('breakfast'\|'lunch'\|'dinner'), status('ongoing'\|'closed'\|'prepared'), initiated_by, deadline, closed_at?, prepared_by?, prepared_at?, summary?: PrepSummary | 日期×slot 唯一由 ID 空间天然保证；summary 为截止时物化的备餐快照 |
| `orders` | 随机 | meal_id, family_id, user_openid, user_nickname(快照), dishes: [{dish_id, name, quantity}]（name 快照）, note, created_at | 每人每餐一单（upsert）；**取消 = 删除文档**，不存在 cancelled 态；快照固化不回退 |
| `subscribes` | 随机 | meal_id, user_openid, template_id, granted: bool, granted_at, consumed: bool, sent: bool | 一次性订阅配额记账：授权折叠（每人每餐只弹一次）、at-most-once 消费 |
| `users` | openid | openid, nickname, avatar, created_at | 2022 后微信不回传昵称，首登自填 |

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

领域规则源：CONTEXT.md（词汇与不变量）、docs/adr/0001-0003（家庭独立实体 / 一次性订阅 / 数据保守主义）。MVP 边界与工单见 GitHub Issues（T1–T11，含原生阻塞依赖）。