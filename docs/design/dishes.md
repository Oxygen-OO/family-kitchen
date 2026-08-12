# DishEngine · 菜品管理接口 (锁定 v1)

**位置**：`cloudfunctions/family-kitchen/lib/dish-engine/`。零 SDK、零 I/O 深模块，Store port + Clock 注入。`dishes` 集合归它独占写入；`meals`/`orders` 仅**只读**做删除前置引用保护（T6 建集合前，查询按「集合不存在视为空」防御处理）。调用方只有云函数入口壳 `index.js`（按 action 分派）。

## 职责边界

- **dishes 为家庭菜单池**：`family_id, name, image?, description?, tags[], ingredients[], is_available, is_deleted, created_by, created_at`；软删 `is_deleted: true`，历史点餐记录不受影响（订单内是 name 快照，见 summarizer）。
- **结构化食材契约**：`ingredients` 必为 `[{name, amount}]`（name/amount 均为非空文本），这是 T5 备餐汇总器精确去重合并的输入契约——**绝不降级为纯文本数组**。解除引用保护后已软删菜品仍被历史订单引用，汇总侧按 `removed: true` 标注（T5 已交付）。
- **信任模型**：任何成员可新增/修改/删除/恢复/上下架任何菜品，不设创建者独占权限（T2 家族守卫覆盖成员资格与冻结）。
- **删除 = 软删 + 当日引用保护**：`deleteDish` 前置查询**今日**（由注入时钟求日期）各餐次 ongoing/closed 的订单是否引用该 dish_id；存在引用 → `DISH_IN_USE` 拒绝，否则仅置 `is_deleted: true`。
- **日期权威**：meals 的 date 格式为 `YYYY-MM-DD`；本引擎从注入的 `now` 求服务器本地日期，T6 MealEngine 是餐次日期/时段的权威定义方，本模块只复用其 date 形态。

## 接口

```ts
interface DishEngine {
  listDishes({familyId}, openid): DishView[]         // is_deleted:false, created_at 降序
  listRemovedDishes({familyId}, openid): DishView[]  // is_deleted:true（已下架列表）
  createDish({familyId, name, image?, description?, ingredients, tags?}, openid, {now}): DishView
  updateDish({familyId, dishId, name, image?, description?, ingredients, tags?}, openid, {now}): DishView
  setDishAvailable({familyId, dishId, isAvailable}, openid): DishView  // 上下架开关
  deleteDish({familyId, dishId}, openid, {now}): void   // 软删；当日有引用 → DISH_IN_USE
  restoreDish({familyId, dishId}, openid): DishView     // 一键恢复 is_deleted:false（幂等）
}
// DishView = {…doc, dish_id: string}（非删除态菜品在点餐/菜单两个视图的可见性由 is_available 控制）
```

**校验**：name 去首尾空白必填 ≤30 字符；image 可为空串或 `cloud://` 路径；ingredients 为数组、每行 name/amount 非空（各 ≤20 字符）、≤50 行；tags 为字符串数组、每项去重后 ≤6 个、每个 ≤10 字符（预设：家常菜、快手菜、汤、硬菜、素菜、早餐；允许自定义）。`createDish` 落库 `is_available: true, is_deleted: false, created_by: openid`；`updateDish` 只改内容五个字段并置 `updated_at`，**不触碰 is_available/is_deleted**（上下架与软删走各自方法）；`setDishAvailable` 只改 is_available；`deleteDish`/`restoreDish` 只改 is_deleted（顺带 updated_at）。

## 守卫

一切方法（含列表）先过家族守卫：非成员**或家庭不存在** → `NOT_MEMBER`（与 family-engine `generateInviteCode` 同构），家庭 `status !== 'active'` → `FAMILY_FROZEN`；**菜品**不存在或不属于该家庭 → `DISH_NOT_FOUND`（`ownDish` 校验）。

## 错误模式

`Err = NOT_MEMBER | FAMILY_FROZEN | DISH_NOT_FOUND | DISH_IN_USE | DISH_NAME_REQUIRED | DISH_NAME_TOO_LONG | IMAGE_INVALID | INGREDIENTS_INVALID | TAGS_INVALID`（T2 的守卫码复用；`DISH_*` 系为 T4 增补，命名风格与 family-engine 锁定码一致）

## Ports 与测试适配器

| Port | 分类 | 生产 adapter | 测试 adapter |
|---|---|---|---|
| DishStore（dishes 读写 + meals/orders 只读） | remote-but-owned | `lib/ports/db.js` 的 `createDishStore`（wx-server-sdk，唯一 import 点） | 内存 Map 双胞胎，**忠实复刻**：getDish 未命中 null、createDish 自动 _id、updateDish 未命中 NOT_FOUND、findOrderRefs 按 meals/orders 扫描（无集合/无数据即空） |
| Clock（created_at / updated_at / 引用保护的“今日”） | in-process 注入 | `now()` | Fixed(now) 冻结时间 |

`findOrderRefs({familyId, dishId, date})`：先查 meals（family_id+date+status ∈ ongoing/closed）取 _id，再查 orders（`dishes.dish_id` 命中）；**meals/orders 集合尚不存在时（T6 前）返回空数组，绝不因缺集合报错**——生产端 catch“集合不存在”错误折叠为空，双胞胎天然空。`listDishes` 同理由 port 折叠「dishes 集合尚未建」为空（首次进入菜单页呈现空态而非报错）。

## 开放协议（seam 1，action 路由壳）

| action | payload | 成功 data |
|---|---|---|
| `listDishes` | `{familyId}` | `DishView[]` |
| `listRemovedDishes` | `{familyId}` | `DishView[]` |
| `createDish` | `{familyId, name, image, description, ingredients, tags}` | `DishView` |
| `updateDish` | `{familyId, dishId, name, image, description, ingredients, tags}` | `DishView` |
| `setDishAvailable` | `{familyId, dishId, isAvailable}` | `DishView` |
| `deleteDish` | `{familyId, dishId}` | 无（`{ok: true}`） |
| `restoreDish` | `{familyId, dishId}` | `DishView` |

统一错误形状 `{ok: false, error: {code, message}}`。

## 测试落点（跨 seam）

内存 DishStore 双胞胎 + 固定时钟，逐条断言错误码与落库文档：守卫（非成员/冻结逐一拒绝）、创建（默认标志/校验/created_by）、修改（信任模型：他人可改任意字段，updated_at 推进，不触碰可用与软删标志）、软删（无引用→is_deleted:true 且文档保留；当日 ongoing/closed 引用→DISH_IN_USE；隔日引用→放行；菜品缺失→DISH_NOT_FOUND）、恢复（is_deleted:false，幂等）、上下架（is_available 翻转不影响 is_deleted）、列表（非删/已删两视图互斥）。