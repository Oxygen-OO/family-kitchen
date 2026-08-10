# PrepSummarizer · 备餐汇总器接口 (锁定 v1)

**位置**：`cloudfunctions/family-kitchen/lib/summarizer/`。**纯函数，零 I/O**，同时服务两个形态：进行中实时预览（viewMeal 的 live，算出即弃）与截止物化（关闭管线写入 meals.summary）——预览与定案共用同一实现，杜绝「预览对、物化错」的双实现漂移。

## 接口

```ts
// orders: 该餐次全部订单(含 user_openid 与 user_nickname 快照)
// dishes: 参与聚合的菜品全量(含已软删 —— 历史引用必须回显)
buildSummary(orders: OrderDoc[], dishes: DishDoc[]): PrepSummary
```

```ts
interface PrepSummary {
  byDish: {
    dishId, dishName,                 // 快照名
    totalQuantity: number,            // 份数合计
    orderedBy: {openid, nickname, quantity}[],   // nickname 随单快照
    removed: boolean                  // 菜品已下架/软删时标注
  }[]
  ingredients: { name, amountText: string, dishCount: number }[]   // 按 name 精确去重合并
  generatedAt: number
}
```

## 聚合规则（全部在这一个函数里）

- **按菜聚合**：以订单 dishes[] 中的 `dish_id + name 快照` 为准——菜品软删后历史照常回显并标注 removed；同一道菜多人点选 → orderedBy 列出每人份数，totalQuantity 合计。
- **食材精确去重**：提取各菜的 ingredients[]（结构化 `{name, amount}`），仅**名称完全一致**才合并为一行（「西红柿」与「番茄」是两行，ADR-0003）；同名食材的用量文本按菜品/份数**拼接而绝不计算**：
  - 同菜多人点或多份：`amount ×N`（如 `鸡蛋 2 个 ×2`）；
  - 不同菜品同名食材：文本直接拼接（如 `2 个 + 3 个`）；
  - `dishCount` 记录涉及几道菜，供备餐者判断冗余。
- 订单为空 → 空数组的干净汇总；同一成员同一菜去重（一条订单内 dishes 合并 quantity）。

## 正确性即测试面

直接纯函数单测，断言逐字段：两菜共享食材合并一行、名称仅精确匹配、软删菜快照回显+removed、memberName 快照、quantity 的 ×N 标注、空订单边界。