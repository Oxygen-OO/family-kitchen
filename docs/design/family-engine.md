# FamilyEngine · 家庭引擎接口 (锁定 v1)

**位置**：`cloudfunctions/family-kitchen/lib/family-engine/`。零 I/O 纯逻辑，`families`/`family_members` 集合归它独占写入；MealEngine 经同一集合只读（家庭守卫）。

> 进度注记：T2 已交付 `createFamily / joinByCode / myFamilies / generateInviteCode`；T3 已交付 `leaveFamily / transferOwnership / dissolveFamily` 及补增的 `listMembers`（成员管理页数据源），下方「接口」即当前全量。

## 接口

```ts
interface FamilyEngine {
  createFamily({openid, nickname, name}): Family           // 立家者即首名成员(role: creator)
  joinByCode({code}, openid, {nickname, now}): Family      // 唯一加入途径(邀请码, 不区分大小写)
  myFamilies(openid): Family[]                             // ≤3
  generateInviteCode({familyId}, openid, {now}): {code, expiresAt}   // 覆盖旧码, expiresAt = now + 7 天
  listMembers({familyId}, openid): Member[]                // T3 增补: 成员管理页数据源, joined_at 升序(立家者在前)
  leaveFamily({familyId}, openid): void                    // 删成员行 + member_count -1
  transferOwnership({familyId}, from: openid, to: openid): void
  dissolveFamily({familyId}, openid): void                 // status="frozen", 不物理删(ADR-0003)
}
// Member = {family_id, user_openid, role('creator'|'member'), joined_at}
```

## 不变量（三条规则的落点）

1. **成员上限 5（含立家者）**：joinByCode / generateInviteCode 时校验 `member_count ≥ 5 → FAMILY_FULL`，邀请功能自动禁用即由此而来。
2. **一人至多属 3 个家庭**：joinByCode / createFamily 前统计该 openid 的家庭数 `≥ 3 → USER_FAMILY_CAP`。
3. **立家者退出前置**：`leaveFamily` 对 creator → `CREATOR_LEAVE_FORBIDDEN`，必须先 `transferOwnership`（to 必须是现役成员，`TRANSFER_NOT_CREATOR` / `TRANSFER_TO_NON_MEMBER`）或 `dissolveFamily`（仅 creator 可调，`DISSOLVE_NOT_CREATOR`；冻结后全库唯此接口接受 frozen 状态且幂等，不覆盖首次 `dissolved_at`）；冻结家庭从主页切换器置灰，任何引擎接口的守卫（`FAMILY_FROZEN`）封死残余路径。转让写序固定「先升目标、再降原立家者、后改 creator_openid」——任一瞬间都至少存在一名立家者，无「无立家者」空窗；自我转让由 `to===from` 短路为幂等空操作。

**邀请码有效性** = 与 families.invite_code 一致 ∧ `expires_at > now` ∧ 家庭未满 ∪ 未冻结。**单码覆盖模型**：重新生成即旧码失效，7 天过期需重新生成；无需作废逻辑。

**家庭名称**：2–12 个字符（去首尾空白后判定），越界 → `FAMILY_NAME_INVALID`。**重复加入**：already-in-family 预检与 family_members 撞键回退都落 `ALREADY_MEMBER`。

**nickname 参数**：`createFamily/joinByCode` 的 `nickname` 由入口壳从 users 档案解析注入（复用 T1 查询能力，不信任客户端自称）；当前不入库（family_members 无昵称列），预留给后续成员展示链路（成员管理页 T3 以掩码 openid 呈现，订单 `user_nickname` 快照链路见 meal-engine）。

**listMembers（T3 增补）**：返回该家庭全部成员行（`{family_id, user_openid, role, joined_at}`），按 `joined_at` 升序（立家者居首）；守卫与全引擎一致 `NOT_MEMBER`/`FAMILY_FROZEN`。视图只含成员行自身字段——family_members 无昵称列，昵称展示属预留能力，不在此面世。

## 错误模式

`Err = NOT_MEMBER | FAMILY_FROZEN | FAMILY_FULL | USER_FAMILY_CAP | INVITE_NOT_FOUND | INVITE_EXPIRED | CREATOR_LEAVE_FORBIDDEN | TRANSFER_NOT_CREATOR | TRANSFER_TO_NON_MEMBER`（T2 增补：`FAMILY_NAME_INVALID | ALREADY_MEMBER`；T3 增补：`DISSOLVE_NOT_CREATOR`（仅立家者可解散），增补随交付入库）

## 测试

与 MealEngine 同构：内存 Store 双胞胎 + 固定时钟，跨外部 seam 断言——满员/过期码逐一拒绝、覆盖后旧码失效、转让后原立家者可正常退出、冻结后全部接口逐一拒绝、解散不产生物理删除（记录仍在库中）。T3 另设 family-frozen-integration.test.js：全引擎（Family/Dish/Meal）共享同一 Store 双胞胎，解散后逐一走全部用户入口断言 `FAMILY_FROZEN`，守卫一致性靠该集成测试钉死；退出后路由断言复用 identity.startup（引擎只删行不造路由）。