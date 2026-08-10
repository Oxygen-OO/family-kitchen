# MealEngine · 餐次引擎接口 (锁定 v1)

**位置**：`cloudfunctions/family-kitchen/lib/meal-engine/`。零 I/O 纯逻辑，三 port 注入。调用方只有云函数入口壳与 cron 触发器（同一函数、按 action 分派）。

## 接口

```ts
type Slot = 'breakfast' | 'lunch' | 'dinner'
// 餐次键: mealKey = { familyId, date: 'YYYY-MM-DD', slot } → meals._id = familyId:date:slot
// 写命令的 close-if-due 前置守卫: 实体为 open 且 now >= closeAt 时, 先走关闭管线(claimClose),
// 再按关闭后的真实状态判定本次命令 —— cron 因此只是兜底, 分钟级窗口被人肉操作补上。

interface MealEngine {
  // ── 高频: 当天餐次页一条路径 ──
  viewMeal(k: {familyId, date, slot}, openid): MealView            // 无副作用
  placeOrder(k: {familyId, date, slot}, openid,
             {selection: string[], subscribed?: boolean}): MealView
    // 全量替换语义: selection=[] 即取消本人点选; subscribed=true 且本餐尚无 grant 时写入
    // subscribe_grants(consumed=false) —— 授权仅随点餐提交发生, 无事后开关(ADR-0002);
    // 服务端过滤已下架菜, 快照 dishName/memberName, 返回 dropped 提示(非致命)
  // ── 低频: 生命周期 ──
  initiate(k: {familyId, date, slot}, openid, {closeAt?}): MealView
    // 已存在(任何状态) → MEAL_EXISTS(不可重开); closeAt 默认 早餐08:00/午餐11:30/晚餐17:30,
    // 必须 > now
  copyLastSelection(k: {familyId, date, slot}, openid): MealView
    // 昨日同餐次全员副本: fill-only(本餐已有订单的成员不覆盖), 过滤 isDeleted,
    // 写入时重解析 dishName 快照, 记录 copiedFromMealId
  closeEarly(k: {familyId, date, slot}, openid): CloseResult       // 与 scanDue 共用同一关闭管线
  markPrepped(k: {familyId, date, slot}, openid): MealView         // 仅 closed → prepped
  // ── 系统入口 ──
  scanDue(): {closed: number, skipped: number}                     // cron 触发, 无参幂等
}

interface MealView {
  meal:   {date, slot, status, closeAt, closedAt?, preppedAt?, summary?}
  menu:   {dishId, name, ingredients: {name, amount}[]}[]          // 未删菜品全池
  myOrder: {openid, memberName, entries: {dishId, dishName}[], updatedAt} | null
  live?:  PrepSummary        // 仅进行中: 实时预览, 只算不物化; 已截止后读 meals.summary 快照
  canOrder, granted, dropped: string[]                             // dropped = 刚被过滤的下架菜
}
```

## 错误模式

`Err = NOT_MEMBER | FAMILY_FROZEN | MEAL_EXISTS | MEAL_NOT_FOUND | MEAL_LOCKED(closed 禁写) | NOT_OPEN(closeEarly/markPrepped 状态不符) | PAST_CUTOFF(进行中但已过 closeAt, 由 close-if-due 先代截止后落此) | DISH_UNKNOWN | DISH_REMOVED(非致命, 随 dropped 返回) | CLOSE_AT_IN_PAST`

不变量与顺序约束（调用方需知的全部事实）：
- 所有入口第一步过家庭守卫：成员 ∧ 未冻结（经 MealStore.familyCtx）；非成员/冻结一律拒绝。
- `(familyId, date, slot)` 唯一，撞键 = MEAL_EXISTS；closed 不可重开（命令集里根本没有 reopen）。
- 写命令（placeOrder/copyLastSelection/markPrepped）仅 open；closeEarly 仅 open；markPrepped 仅 closed。所有写命令先跑 close-if-due。
- viewMeal 永不产生副作用。
- 授权消耗只发生在关闭那一刻，语义 = **at-most-once**（见下）。

## 关闭管线（内部单点，手动与扫描共用）

```
closeIfDue / closeEarly / scanDue
  → claimClose: 条件更新 {_id, status:'open'} → 'closed', 命中 0 行 = 已被抢先(skipped)
  → 读全量 orders → buildSummary(orders, dishes) → 写 meals.summary (物化快照)
  → 逐条未消费 grant: claimGrant(条件更新 consumed=false→true) → Notifier.send
     → 发送成功才标 consumedAt; 崩溃窗口语义: 抢了没发成 = 丢一条, 绝不重复(at-most-once,
       超配额会长期毒化该用户提醒, 宁丢勿重); 发送失败非崩溃 → 原样留下 + 日志
```

幂等性：claim 抢占是唯一裁决点——同餐次被扫两次、手动与 cron 竞态、scanDue 与 close-if-due 撞车，都只有一方执行管线，不会二次物化、二次发消息。

## Ports 与测试适配器

| Port | 分类 | 生产 adapter | 测试 adapter |
|---|---|---|---|
| MealStore（families/meals/orders/dishes/subscribe_grants） | remote-but-owned | wx-server-sdk（唯一 import 点） | 内存 Map 双胞胎，**忠实复刻条件更新语义** |
| Clock | in-process 注入 | Date.now | Fixed(now) 冻结时间 |
| Notifier（订阅消息发送） | true external | subscribeMessage.send，失败记日志 | Spy：断言「每人恰一条、未授权零条、按 claim 顺序」 |

测试全部跨外部 seam：固定时钟的时序剧本（截止前改单、到期瞬间 placeOrder→PAST_CUTOFF、scanDue 补刀、复制过滤下架菜、summary 逐字段断言、grant 消费顺序）只看可观测结果。

## 内部结构（不进接口）

显式状态表 `open→closed→prepped`（数据驱动、可审计）、close-if-due 守卫、computeSummary 与 Preview 共用汇总器（一个算出即弃、一个物化）、复合 _id 即并发原语。