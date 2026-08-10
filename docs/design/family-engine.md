# FamilyEngine · 家庭引擎接口 (锁定 v1)

**位置**：`cloudfunctions/family-kitchen/lib/family-engine/`。零 I/O 纯逻辑，`families`/`family_members` 集合归它独占写入；MealEngine 经同一集合只读（家庭守卫）。

## 接口

```ts
interface FamilyEngine {
  createFamily({openid, nickname, name}): Family           // 立家者即首名成员(role: creator)
  joinByCode({code}, openid, {nickname, now}): Family      // 唯一加入途径(邀请码, 不区分大小写)
  myFamilies(openid): Family[]                             // ≤3
  generateInviteCode({familyId}, openid, {now}): {code, expiresAt}   // 覆盖旧码, expiresAt = now + 7 天
  leaveFamily({familyId}, openid): void
  transferOwnership({familyId}, from: openid, to: openid): void
  dissolveFamily({familyId}, openid): void                 // status="frozen", 不物理删(ADR-0003)
}
```

## 不变量（三条规则的落点）

1. **成员上限 5（含立家者）**：joinByCode / generateInviteCode 时校验 `member_count ≥ 5 → FAMILY_FULL`，邀请功能自动禁用即由此而来。
2. **一人至多属 3 个家庭**：joinByCode / createFamily 前统计该 openid 的家庭数 `≥ 3 → USER_FAMILY_CAP`。
3. **立家者退出前置**：`leaveFamily` 对 creator → `CREATOR_LEAVE_FORBIDDEN`，必须先 `transferOwnership`（to 必须是现役成员，`TRANSFER_NOT_CREATOR` / `TRANSFER_TO_NON_MEMBER`）或 `dissolveFamily`（仅 creator 可调，冻结后全库唯此接口接受 frozen 状态）；冻结家庭从主页切换器置灰，任何引擎接口的守卫（`FAMILY_FROZEN`）封死残余路径。

**邀请码有效性** = 与 families.invite_code 一致 ∧ `expires_at > now` ∧ 家庭未满 ∪ 未冻结。**单码覆盖模型**：重新生成即旧码失效，7 天过期需重新生成；无需作废逻辑。

## 错误模式

`Err = NOT_MEMBER | FAMILY_FROZEN | FAMILY_FULL | USER_FAMILY_CAP | INVITE_NOT_FOUND | INVITE_EXPIRED | CREATOR_LEAVE_FORBIDDEN | TRANSFER_NOT_CREATOR | TRANSFER_TO_NON_MEMBER`

## 测试

与 MealEngine 同构：内存 Store 双胞胎 + 固定时钟，跨外部 seam 断言——满员/过期码逐一拒绝、覆盖后旧码失效、转让后原立家者可正常退出、冻结后全部接口逐一拒绝、解散不产生物理删除（记录仍在库中）。