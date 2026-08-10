# PrepSummarizer · 备餐汇总器接口 (锁定 v1)

**位置**：`cloudfunctions/family-kitchen/lib/summarizer/`。**纯函数，零 I/O**，同时服务两个形态：进行中实时预览（viewMeal 的 live，算出即弃）与截止物化（关闭管线写入 meals.summary）——预览与定案共用同一实现，杜绝「预览对、物化错」的双实现漂移。

## 接口

```ts
// orders: 该餐次全部订单(含成员 openid 与 memberName 快照)
// dishes: 参与聚合的菜品全量(含已软删 —— 历史引用必须回显)
buildSummary(orders: OrderDoc[], dishes: DishDoc[]): PrepSummary
```

```ts
interface PrepSummary {
  byDish: { dishId, dishName, members: {openid, nickname}[] }[]   // 按菜聚合, 列出点选成员
  ingredients: { name, amount: string, dishCount: number }[]      // 按食材精确去重合并
  generatedAt: number
}
```

## 聚合规则（全部在这一个函数里）

- **按菜聚合**：以订单 entries 中的 `dishId + dishName 快照` 为准——菜品软删后历史照常回显；同一道菜被多个成员点选则 members 列出全部（MemberName 随单快照，成员改名不影响历史汇总）。
- **食材精确去重**：仅**名称完全一致**才合并为一行（「西红柿」与「番茄」是两行，ADR-0003）；`amount` 为该食材在各菜用量文本的**直接拼接**（如「300克 · 200克」，不做计量换算）；`dishCount` 记录来自几道菜，供备餐者判断冗余。
- 订单为空 → 空数组的干净汇总；重复点选同一菜去重（每人每菜一条）。

## 正确性即测试面

直接纯函数单测，断言逐字段：两菜共享食材合并一行、名称仅精确匹配、软删菜回显快照名、memberName 快照、空订单边界。