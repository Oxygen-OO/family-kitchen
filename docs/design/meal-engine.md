# MealEngine · 餐次引擎接口 (锁定 v1)

**位置**：`cloudfunctions/family-kitchen/lib/meal-engine/`。零 I/O 纯逻辑，三 port 注入。调用方只有云函数入口壳与 cron 触发器（同一函数、按 action 分派）。

## 接口

```ts
type Slot = 'breakfast' | 'lunch' | 'dinner'
// 餐次键: (family_id, date, slot) → meals._id = familyId:date:slot
// 写命令的 close-if-due 前置守卫: 实体为 ongoing 且 now >= deadline 时, 先走关闭管线
// (claimClose 原子抢占), 再按关闭后的真实状态判定本次命令 —— cron 因此只是兜底。

interface MealEngine {
  // ── 高频: 当天餐次页一条路径 ──
  viewMeal(mealId, openid): MealView                                // 无副作用
  placeOrder(mealId, openid, {dishes: {dishId, quantity}[], subscribed?: bool, note?}): MealView
    // 全量替换: 空数组 = 取消(删除该订单文档, 无 cancelled 态); 服务端校验下架/软删菜,
    // 过滤并返回 dropped(非致命); 下单即快照 dishName(user_nickname);
    // subscribed=true 且本餐无授权记录时写 subscribes(granted 折叠, 每餐每人一次)
  // ── 低频: 生命周期 ──
  initiate({familyId, date, slot}, openid, {deadline?}): MealView
    // 已存在(任何状态) → MEAL_EXISTS(不可重开); deadline 默认 早餐08:00/午餐11:30/晚餐17:30,
    // 必须 > now
  copyLastSelection(mealId, openid): MealView
    // 昨日同 slot 全员副本: fill-only(今日已有订单的成员不覆盖), 过滤 is_deleted/!is_available,
    // 重解析 dishName 快照, note 追加「[复制自昨日]」
  closeEarly(mealId, openid): CloseResult                           // 与 scanDue 共用同一关闭管线
  markPrepared(mealId, openid): MealView                            // 仅 closed → prepared
  // ── 系统入口 ──
  scanDue(): {closed: number, skipped: number}                      // cron 触发, 无参幂等
}

interface MealView {
  meal:    {date, slot, status: 'ongoing'|'closed'|'prepared', deadline, closed_at?, prepared_by?, prepared_at?, summary?}
  menu:    {dishId, name, ingredients: {name, amount}[]}[]          // is_available && !is_deleted 全池
  myOrder: {user_openid, user_nickname, dishes: {dishId, name, quantity}[], note} | null
  live?:   PrepSummary          // ongoing: 实时预览(只算不物化); closed/prepared: 读 meals.summary 快照
  canOrder, granted, dropped: {dishId, dishName}[]
}
```

## 错误模式

`Err = NOT_MEMBER | FAMILY_FROZEN | MEAL_EXISTS | MEAL_NOT_FOUND | MEAL_LOCKED(closed/prepared 禁写) | NOT_ONGOING(closeEarly/markPrepared 状态不符) | PAST_CUTOFF(由 close-if-due 代截止后落此) | DISH_UNKNOWN | DISH_REMOVED(非致命, 随 dropped 返回) | DEADLINE_IN_PAST`

不变量与顺序约束（调用方需知的全部事实）：
- 所有入口第一步过家庭守卫：成员 ∧ 家庭未冻结（经 MealStore.familyCtx）；非成员/冻结一律拒绝。
- `(family_id, date, slot)` 唯一，撞键 = MEAL_EXISTS；closed/prepared 不可重开（命令集里根本没有 reopen）。
- 写命令（placeOrder/copyLastSelection/markPrepared）仅 ongoing；closeEarly 仅 ongoing；markPrepared 仅 closed。所有写命令先跑 close-if-due。
- viewMeal 永不产生副作用。
- 授权消费只发生在关闭那一刻，语义 = **at-most-once**（见下）。

## 关闭管线（内部单点，手动与扫描共用）

```
closeIfDue / closeEarly / scanDue
  → claimClose 原子抢占: 条件更新 where {_id, status:'ongoing', deadline ≤ now}
     update {status:'closed'}, stats.updated === 1 才算赢家(不用中间态, 无双写窗口)
  → 读全量 orders → buildSummary(orders, dishes) → 写 meals.summary (物化快照)
     (崩溃窗口下 summary 缺失 → 前端容错为空清单)
  → 逐条 granted 且未 consumed 的 subscribes 记录: 条件更新 consumed=true 抢占 →
     Notifier.send → 成功才置 sent=true; 失败不自动重试, 原样留下 + 日志
```

幂等性：claimClose 是单一裁决点——同餐次被扫两次、手动与 cron 竞态、scanDue 与 close-if-due 撞车，都只有一方执行管线，不会二次物化、二次发消息。

## Ports 与测试适配器

| Port | 分类 | 生产 adapter | 测试 adapter |
|---|---|---|---|
| MealStore（families/family_members/meals/orders/dishes/subscribes） | remote-but-owned | wx-server-sdk（唯一 import 点） | 内存 Map 双胞胎，**忠实复刻条件更新语义** |
| Clock | in-process 注入 | Date.now | Fixed(now) 冻结时间 |
| Notifier（订阅消息发送） | true external | cloud.openapi.subscribeMessage.send | Spy：断言「每人恰一条、未授权零条、按 claim 顺序」 |

测试全部跨外部 seam：固定时钟的时序剧本（截止前改单、到期瞬间 placeOrder→PAST_CUTOFF、scanDue 补刀、复制过滤下架菜、summary 逐字段断言、grant 消费顺序）只看可观测结果。

## 内部结构（不进接口）

显式状态表 `ongoing→closed→prepared`（数据驱动、可审计）、close-if-due 守卫、预览与物化共用同一汇总器、quantity 语义（份数随单，汇总标注 ×N、不做数值换算）。