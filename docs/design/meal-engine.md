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
    // subscribed 为布尔时写 subscribes 记账(折叠: 每人每餐至多一条, 以先到者为准, 不可覆盖);
    // subscribed 缺省(旧调用方)不记账; 模板 ID 由入口壳注入服务端配置(绝不信任客户端)
  // ── 低频: 生命周期 ──
  initiate({familyId, date, slot}, openid, {deadline?}): MealView
    // 已存在(任何状态) → MEAL_EXISTS(不可重开); deadline 默认 早餐08:00/午餐11:30/晚餐17:30,
    // 必须 > now
  copyLastSelection(mealId, openid): MealView
    // 昨日同 slot 全员副本: fill-only(今日已有订单的成员不覆盖), 过滤 is_deleted/!is_available,
    // 重解析 dishName 快照, note 追加「[复制自昨日]」
  closeEarly(mealId, openid): MealView                            // 关闭后即只读视图; 走与 scanDue 同一关闭管线; 非 ongoing → NOT_ONGOING
  markPrepared(mealId, openid): MealView                            // 仅 closed → prepared
  // ── 系统入口 ──
  scanDue(): {closed: number, skipped: number}                      // cron 触发, 无参幂等
}

interface MealView {
  meal:    {date, slot, status: 'ongoing'|'closed'|'prepared', deadline, closed_at?, prepared_by?, prepared_at?, summary?}
  menu:    {dishId, name, ingredients: {name, amount}[]}[]          // is_available && !is_deleted 全池
  myOrder: {user_openid, user_nickname, dishes: {dishId, name, quantity}[], note} | null
  live?:   PrepSummary          // ongoing: 实时预览(只算不物化); closed/prepared: 读 meals.summary 快照
  canOrder, granted, dropped: {dishId, dishName}[], copied: {dishId, dishName, quantity}[]
  // granted(T9): 本餐当前用户订阅记录是否已存在(授权或拒绝皆回显 true) —— 前端据此只弹一次授权窗
  // copied(T7): copyLastSelection 特有(调用者本人的复制清单), 其余命令恒空 —— 形状稳定供前端透传
}
```

## 错误模式

`Err = NOT_MEMBER | FAMILY_FROZEN | MEAL_EXISTS | MEAL_NOT_FOUND | MEAL_LOCKED(closed/prepared 禁写) | NOT_ONGOING(closeEarly/markPrepared 状态不符) | PAST_CUTOFF(由 close-if-due 代截止后落此) | DISH_UNKNOWN | DISH_REMOVED(非致命, 随 dropped 返回) | DEADLINE_IN_PAST | NO_YESTERDAY_DATA(T7)`

T6 增补（入参形状校验，代码即契约，同 dishes.md 的 T4 增补先例）：
`SLOT_INVALID | DATE_INVALID | DISHES_INVALID | QUANTITY_INVALID`。
`DISH_REMOVED` 在错误表属预留：T6 实际以下架/软删菜的 `dropped: [{dishId, dishName}]` 视图返回（非致命）承载，不抛错误码。

T8 订正（issue #8 AC 与锁定文档不一致时文档优先，代码已按文档实现，先例同上）：
AC 的拒绝码写作 `MEAL_CLOSED`；本表以 `MEAL_LOCKED(closed/prepared 禁写)` 与
`PAST_CUTOFF(由 close-if-due 代截止后落此)` 为准，**不产生 MEAL_CLOSED 码**——
同一命令撞已锁餐次时：本次由 close-if-due 当场代截止（抢到 claim）→ `PAST_CUTOFF`；
已 closed/prepared（含竞争输家）→ `MEAL_LOCKED`。

T7 增补（issue #7 AC 与锁定文档措辞差异，文档优先，先例同上）：
- **复制范围 = 全员副本**（非仅发起者）：昨日同 slot 每名成员的选点复制到今日各自名下；
  AC 中「当前用户…无 → 复制」是 fill-only 判定步骤对每名成员的逐人措辞，勿误读为只复制发起者。
- 复制重解析 dishName 为今日现名（快照按今日再固化）；按 dishId 校验同 resolveDishes
  契约：不存在/别家 → `DISH_UNKNOWN` 致命整体拒绝；is_deleted / !is_available → 非致命
  `dropped`。昨日单全被过滤 → 该成员不落空单但 dropped 照常返回。
- `NO_YESTERDAY_DATA`（昨日同 slot 无餐次或无人点餐。订单存在即有效——取消即删除无
  cancelled 态，昨日餐次自身状态无关紧要）。
- 返回视图的 `copied: [{dishId, dishName, quantity}]` 与 `dropped: [{dishId, dishName}]`
  （dropped 形状沿用 T6 文档，AC 所写 {dishName} 为其子集）**以调用者本人为范围**——
  全员复制照常执行，提示只给调用者。
- 溯源：复制生成的订单 note 携带昨日 note（若有）并追加「[复制自昨日]」，拷贝源昨日单不被篡改。

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
     update {status:'closed', closed_at}, stats.updated === 1 才算赢家(不用中间态, 无双写窗口)
     —— closeEarly(手动) 同条件但 deadline 不设上下界(未到期也允许提前关), 裁决依旧只靠 status 条件
  → 读全量 orders → buildSummary(orders, dishes) → 写 meals.summary (物化快照)
     (崩溃窗口下 summary 缺失 → 前端容错为空清单)
  → 订阅消费 at-most-once (T9): 逐条 granted ∧ 未 consumed 的 subscribes 记录:
     ① claimGrant 条件更新(consumed: false→true, 输家跳过, 与 claimClose 同一裁决模式)
     ② notifier.send(内容: 家庭名称 / 餐次文案·早餐午餐晚餐+已截止 / 备餐清单摘要, page 直达餐次页;
        模板 ID 用记录自身记账值, 数据字段映射见 config 部署说明;
        thing 字段 20 字符上限, 名称与摘要超长自动截断兜底)
     ③ 仅 send 返回 ok 才置 sent:true + sent_at; 失败/未配置/异常一律原样留下
        (consumed=true, sent=false) 不自动重试 —— 宁丢勿重(ADR-0002), 恒不阻塞截止
```

幂等性：claimClose 是单一裁决点——同餐次被扫两次、手动与 cron 竞态、scanDue 与 close-if-due 撞车，都只有一方执行管线，不会二次物化、二次发消息。输家（updated=0）直接跳过后续，由调用方按真实状态判定（写命令落 MEAL_LOCKED；closeEarly 输家与直接关过的餐次同码 NOT_ONGOING）。订阅消费的幂等同理：claimGrant 先到者赢，失败记录已被 consumed 抢占，后续任何扫描/关闭都不会重发——「漏发一条的成本远低于重复发送带来的投诉」。

授权记账（T9，placeOrder 内）：
- `subscribed` 为布尔 → upsert subscribes（派生 `_id = mealId:openid`，每人每餐至多一条）。
  撞键（已存在）即折叠：无论先到记录是 granted:true 还是 false 都原样保留——已授权不被
  降级（后到 subscribed=false 不覆盖 granted），已拒绝也不因后来点头而反转（漏授权不再补发）。
- 记账在订单写入成功后执行：若记账写失败（非撞键），命令整体报错但订单已落库——
  重试幂等（订单 upsert 与折叠都无副作用），CloudBase 无事务，按此容忍（T8 崩溃窗口同一策略）。
- `subscribed` 缺省（T6 旧调用方/取消单路径）→ 不产生订阅记录。
- 记录字段：`meal_id, user_openid, template_id(服务端配置注入), granted: bool, granted_at,
  consumed: bool, sent: bool, sent_at?`。
- 前端弹窗折叠：wx.requestSubscribeMessage 只在「提交订单」动作且本餐无记录时调用一次；
  view.granted 有记录（含拒绝）即不再打扰。
- ⚠️ 未配置模板 ID 的授权记录：截止时同样被 claimGrant 抢占(consumed)后由适配器判
  「未配置跳过+日志」——配额即失效且不补发(宁丢勿重)。上线前务必先申请模板 ID
  (见 cloudfunctions/family-kitchen/config.js 部署说明)再正式运行。

## Cron 触发器

定时触发器由仓库根 `cloudbaserc.json` 配置（`family-kitchen` 函数挂 `meal-scan-due`，cron 表达式 `0 */5 * * * * *` 7 段含秒）；亦可在微信开发者工具云开发控制台的「云函数 → 定时触发」里等效配置。cron 触发的 event 只含 `action: 'scanDue'`（系统 action，入口壳不注入 openid），周期 5 分钟一次兜底扫描——真正的截止裁决由各写命令的 close-if-due 前置守卫在到点瞬间完成。

## Ports 与测试适配器

| Port | 分类 | 生产 adapter | 测试 adapter |
|---|---|---|---|
| MealStore（families/family_members/meals/orders/dishes/subscribes） | remote-but-owned | wx-server-sdk（唯一 import 点） | 内存 Map 双胞胎，**忠实复刻条件更新语义**(claimGrant 同 claimClose) |
| Clock | in-process 注入 | Date.now | Fixed(now) 冻结时间 |
| Notifier（订阅消息发送） | true external | lib/ports/notifier.js 适配器(注入 cloud.openapi.subscribeMessage.send; 模板 ID 走 config, 未配置 → 跳过+日志不发送) | Spy：断言「每人恰一条、未授权零条、按 claim 顺序」 |

测试全部跨外部 seam：固定时钟的时序剧本（截止前改单、到期瞬间 placeOrder→PAST_CUTOFF、scanDue 补刀、复制过滤下架菜、summary 逐字段断言、grant 消费顺序）只看可观测结果。

## 内部结构（不进接口）

显式状态表 `ongoing→closed→prepared`（数据驱动、可审计）、close-if-due 守卫、预览与物化共用同一汇总器、quantity 语义（份数随单，汇总标注 ×N、不做数值换算）。