# FamilyEngine · 家庭引擎接口 (锁定 v1)

**位置**：`cloudfunctions/family-kitchen/lib/family-engine/`。零 I/O 纯逻辑，MealStore 集合中的 `families`/`invites` 归它独占写入；MealEngine 经同一集合只读（家庭守卫）。

## 接口

```ts
interface FamilyEngine {
  createFamily({openid, nickname, name}): Family          // 立家者即第一名成员
  joinFamily({code}, openid, {nickname, now}): Family     // 唯一的加入途径(邀请)
  myFamilies(openid): Family[]                            // ≤3, memberOpenids 查询
  createInvite({familyId}, openid, {now}): Invite         // code 短码, expiresAt = now + 7 天
  leaveFamily({familyId}, openid): void
  transferOwnership({familyId}, from: openid, to: openid): void
  dissolveFamily({familyId}, openid): void                // 冻结 frozen=true, 不物理删(ADR-0003)
}
```

## 不变量（三条规则的落点）

1. **成员上限 5（含立家者）**：joinFamily / createInvite 时校验 `members.length ≥ 5 → FAMILY_FULL`，邀请功能自动禁用即由此而来。
2. **一人至多属 3 个家庭**：joinFamily / createFamily 前统计该 openid 所在家庭数 `≥ 3 → USER_FAMILY_CAP`。
3. **立家者退出前置**：`leaveFamily` 对 creator → `CREATOR_LEAVE_FORBIDDEN`，必须先 `transferOwnership`（to 必须是现役成员，`TRANSFER_NOT_CREATOR` / `TRANSFER_TO_NON_MEMBER`）或 `dissolveFamily`（仅 creator 可调，冻结后全库唯此接口接受 frozen 状态）；`dissolveFamily` 后 family 永久冻结，任何引擎接口的守卫（`FAMILY_FROZEN`）与邀请校验共同封死残余路径。

**邀请有效性** = code 存在 ∧ 未使用（usedBy 空）∧ `expiresAt > now` ∧ 家庭未满 ∪ 未冻结 —— 7 天过期即需重新生成（createInvite），旧码过期后自然失效，无需显式作废。加入成功即写 `usedBy`。

## 错误模式

`Err = NOT_MEMBER | FAMILY_FROZEN | FAMILY_FULL | USER_FAMILY_CAP | INVITE_NOT_FOUND | INVITE_EXPIRED | INVITE_USED | CREATOR_LEAVE_FORBIDDEN | TRANSFER_NOT_CREATOR | TRANSFER_TO_NON_MEMBER`

## 测试

与 MealEngine 同构：内存 Store 双胞胎 + 固定时钟，跨外部 seam 断言——满员/过期/已用邀请逐一拒绝、转让后原立家者可正常退出、冻结后全部接口逐一拒绝、解散不产生物理删除（记录仍在库中）。