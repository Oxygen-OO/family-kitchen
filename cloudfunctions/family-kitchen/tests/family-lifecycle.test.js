'use strict'

// T3 成员生命周期: 退出 / 转让所有权 / 解散(冻结) / 成员列表 —— 跨外部 seam 断言
// (内存双胞胎 + 固定时钟), 错误码/角色置换/成员数/路由判定只经 public 接口观察。
// 冻结后全引擎拒绝与数据保留见 family-frozen-integration.test.js。

const { test } = require('node:test')
const assert = require('node:assert/strict')

const { createMemStore } = require('./mem-store.js')
const { createFamilyEngine } = require('../lib/family-engine/index.js')
const { createIdentityEngine } = require('../lib/identity/index.js')

const FIXED_NOW = 1700000000000
const WEEK = 7 * 24 * 3600 * 1000

const fixedClock = { now: () => FIXED_NOW }

function make() {
  const store = createMemStore()
  return {
    store,
    family: createFamilyEngine(store, fixedClock),
    identity: createIdentityEngine(store),
  }
}

function seedFamily(store, overrides = {}) {
  const doc = {
    _id: 'fam-main',
    name: '快乐一家',
    creator_openid: 'openid-mama',
    invite_code: 'ABC123',
    expires_at: FIXED_NOW + WEEK,
    member_count: 3,
    status: 'active',
    created_at: FIXED_NOW - 1000,
    ...overrides,
  }
  store._seedFamily(doc)
  return doc
}

function seedMember(store, openid, role, familyId = 'fam-main', joinedAt = FIXED_NOW - 100) {
  store._seedFamilyMember({ family_id: familyId, user_openid: openid, role, joined_at: joinedAt })
}

async function seedUser(store, openid) {
  await store.createUser({ _id: openid, openid, nickname: '', avatar: '', created_at: FIXED_NOW - 600 })
}

// ── AC1: 普通成员退出 ──

test('成员退出: 删 family_members 行, families.member_count -1, 其余成员不受影响', async () => {
  const { store, family } = make()
  seedFamily(store)
  seedMember(store, 'openid-mama', 'creator', 'fam-main', FIXED_NOW - 500)
  seedMember(store, 'openid-baba', 'member', 'fam-main', FIXED_NOW - 300)
  seedMember(store, 'openid-keke', 'member', 'fam-main', FIXED_NOW - 100)

  const result = await family.leaveFamily({ familyId: 'fam-main' }, 'openid-baba')

  assert.equal(result, undefined)
  assert.equal(await store.getFamilyMember('fam-main', 'openid-baba'), null)
  assert.equal((await store.getFamily('fam-main')).member_count, 2)
  const rows = await store.listMembersByFamily('fam-main')
  assert.deepEqual(rows.map((r) => r.user_openid).sort(), ['openid-keke', 'openid-mama'])
  assert.equal((await store.getFamilyMember('fam-main', 'openid-mama')).role, 'creator')
})

test('立家者退出 → CREATOR_LEAVE_FORBIDDEN: 须先转让或解散, 不产生写入', async () => {
  const { store, family } = make()
  seedFamily(store, { member_count: 2 })
  seedMember(store, 'openid-mama', 'creator')
  seedMember(store, 'openid-baba', 'member')

  await assert.rejects(
    () => family.leaveFamily({ familyId: 'fam-main' }, 'openid-mama'),
    (err) => err.code === 'CREATOR_LEAVE_FORBIDDEN'
  )
  assert.notEqual(await store.getFamilyMember('fam-main', 'openid-mama'), null)
  assert.equal((await store.getFamily('fam-main')).member_count, 2)
})

test('退出: 非成员/家庭不存在 → NOT_MEMBER, 不产生写入', async () => {
  const { store, family } = make()
  seedFamily(store, { member_count: 2 })
  seedMember(store, 'openid-mama', 'creator')
  seedMember(store, 'openid-baba', 'member')

  await assert.rejects(
    () => family.leaveFamily({ familyId: 'fam-main' }, 'openid-waipo'),
    (err) => err.code === 'NOT_MEMBER'
  )
  await assert.rejects(
    () => family.leaveFamily({ familyId: 'fam-nope' }, 'openid-mama'),
    (err) => err.code === 'NOT_MEMBER'
  )
  assert.equal((await store.getFamily('fam-main')).member_count, 2)
})

test('退出只删目标家庭关系: 该用户在其它家庭的成员关系不受影响', async () => {
  const { store, family } = make()
  seedFamily(store)
  seedMember(store, 'openid-mama', 'creator')
  seedMember(store, 'openid-baba', 'member')
  store._seedFamily({ _id: 'fam-other', name: '别家', creator_openid: 'openid-waipo', invite_code: 'BBB222', expires_at: FIXED_NOW + WEEK, member_count: 1, status: 'active', created_at: FIXED_NOW - 900 })
  seedMember(store, 'openid-baba', 'member', 'fam-other', FIXED_NOW - 50)

  await family.leaveFamily({ familyId: 'fam-main' }, 'openid-baba')

  assert.deepEqual(await store.listFamilyMembers('openid-baba'), [{
    family_id: 'fam-other',
    user_openid: 'openid-baba',
    role: 'member',
    joined_at: FIXED_NOW - 50,
  }])
})

test('退出: 冻结家庭 → FAMILY_FROZEN(冻结后全库仅 dissolveFamily 接受 frozen)', async () => {
  const { store, family } = make()
  seedFamily(store, { status: 'frozen', dissolved_at: FIXED_NOW - 10 })
  seedMember(store, 'openid-mama', 'creator')
  seedMember(store, 'openid-baba', 'member')

  await assert.rejects(
    () => family.leaveFamily({ familyId: 'fam-main' }, 'openid-baba'),
    (err) => err.code === 'FAMILY_FROZEN'
  )
  assert.notEqual(await store.getFamilyMember('fam-main', 'openid-baba'), null)
})

// ── AC2: 立家者转让 ──

test('转让所有权: 目标 role→creator, 原 creator→member, families.creator_openid 更新', async () => {
  const { store, family } = make()
  seedFamily(store, { member_count: 2 })
  seedMember(store, 'openid-mama', 'creator', 'fam-main', FIXED_NOW - 500)
  seedMember(store, 'openid-baba', 'member', 'fam-main', FIXED_NOW - 300)

  const result = await family.transferOwnership({ familyId: 'fam-main' }, 'openid-mama', 'openid-baba')

  assert.equal(result, undefined)
  assert.equal((await store.getFamilyMember('fam-main', 'openid-baba')).role, 'creator')
  assert.equal((await store.getFamilyMember('fam-main', 'openid-mama')).role, 'member')
  assert.equal((await store.getFamily('fam-main')).creator_openid, 'openid-baba')
  assert.equal((await store.getFamily('fam-main')).member_count, 2)
})

test('转让链: 逐棒传递后最终现任立家者才有封闭权, 历任立家者可正常退出', async () => {
  const { store, family } = make()
  seedFamily(store)
  seedMember(store, 'openid-mama', 'creator', 'fam-main', FIXED_NOW - 500)
  seedMember(store, 'openid-baba', 'member', 'fam-main', FIXED_NOW - 300)
  seedMember(store, 'openid-keke', 'member', 'fam-main', FIXED_NOW - 100)

  await family.transferOwnership({ familyId: 'fam-main' }, 'openid-mama', 'openid-baba')
  await family.transferOwnership({ familyId: 'fam-main' }, 'openid-baba', 'openid-keke')

  const fam = await store.getFamily('fam-main')
  assert.equal(fam.creator_openid, 'openid-keke')
  assert.equal((await store.getFamilyMember('fam-main', 'openid-keke')).role, 'creator')
  assert.equal((await store.getFamilyMember('fam-main', 'openid-baba')).role, 'member')

  // 历任立家者已成普通成员: 退出不再被 CREATOR_LEAVE_FORBIDDEN 拦
  await family.leaveFamily({ familyId: 'fam-main' }, 'openid-mama')
  assert.equal((await store.getFamily('fam-main')).member_count, 2)
  // 现任立家者仍不可退出
  await assert.rejects(
    () => family.leaveFamily({ familyId: 'fam-main' }, 'openid-keke'),
    (err) => err.code === 'CREATOR_LEAVE_FORBIDDEN'
  )
})

test('转让守卫: 非立家者 → TRANSFER_NOT_CREATOR; 目标非现役成员 → TRANSFER_TO_NON_MEMBER; 非成员 → NOT_MEMBER', async () => {
  const { store, family } = make()
  seedFamily(store)
  seedMember(store, 'openid-mama', 'creator')
  seedMember(store, 'openid-baba', 'member')

  await assert.rejects(
    () => family.transferOwnership({ familyId: 'fam-main' }, 'openid-baba', 'openid-mama'),
    (err) => err.code === 'TRANSFER_NOT_CREATOR'
  )
  await assert.rejects(
    () => family.transferOwnership({ familyId: 'fam-main' }, 'openid-mama', 'openid-waipo'),
    (err) => err.code === 'TRANSFER_TO_NON_MEMBER'
  )
  await assert.rejects(
    () => family.transferOwnership({ familyId: 'fam-main' }, 'openid-waipo', 'openid-baba'),
    (err) => err.code === 'NOT_MEMBER'
  )
  await assert.rejects(
    () => family.transferOwnership({ familyId: 'fam-nope' }, 'openid-mama', 'openid-baba'),
    (err) => err.code === 'NOT_MEMBER'
  )
  // 全拒后状态零变化
  assert.equal((await store.getFamily('fam-main')).creator_openid, 'openid-mama')
  assert.equal((await store.getFamilyMember('fam-main', 'openid-mama')).role, 'creator')
  assert.equal((await store.getFamilyMember('fam-main', 'openid-baba')).role, 'member')
})

test('转让: 冻结家庭 → FAMILY_FROZEN, 不产生写入', async () => {
  const { store, family } = make()
  seedFamily(store, { status: 'frozen' })
  seedMember(store, 'openid-mama', 'creator')
  seedMember(store, 'openid-baba', 'member')

  await assert.rejects(
    () => family.transferOwnership({ familyId: 'fam-main' }, 'openid-mama', 'openid-baba'),
    (err) => err.code === 'FAMILY_FROZEN'
  )
  assert.equal((await store.getFamilyMember('fam-main', 'openid-mama')).role, 'creator')
  assert.equal((await store.getFamily('fam-main')).creator_openid, 'openid-mama')
})

test('转让给本人: 幂等空操作不报错, 角色与 creator_openid 原样保留', async () => {
  const { store, family } = make()
  seedFamily(store)
  seedMember(store, 'openid-mama', 'creator')

  await family.transferOwnership({ familyId: 'fam-main' }, 'openid-mama', 'openid-mama')

  assert.equal((await store.getFamilyMember('fam-main', 'openid-mama')).role, 'creator')
  assert.equal((await store.getFamily('fam-main')).creator_openid, 'openid-mama')
})

// ── AC3: 立家者解散(冻结) ──

test('立家者解散: status→frozen + dissolved_at=now, 不删除任何关联数据(ADR-0003)', async () => {
  const { store, family } = make()
  seedFamily(store, { member_count: 2 })
  seedMember(store, 'openid-mama', 'creator', 'fam-main', FIXED_NOW - 500)
  seedMember(store, 'openid-baba', 'member', 'fam-main', FIXED_NOW - 300)
  store._seedDish({ _id: 'dish-main', family_id: 'fam-main', name: '番茄炒蛋', ingredients: [{ name: '番茄', amount: '2个' }], is_available: true, is_deleted: false, created_by: 'openid-mama', created_at: FIXED_NOW - 500 })
  store._seedMeal({ _id: 'fam-main:2024-01-01:lunch', family_id: 'fam-main', date: '2024-01-01', slot: 'lunch', status: 'ongoing', initiated_by: 'openid-mama', deadline: FIXED_NOW + 1000, created_at: FIXED_NOW - 400, summary: null })
  store._seedOrder({ _id: 'fam-main:2024-01-01:lunch:openid-baba', meal_id: 'fam-main:2024-01-01:lunch', family_id: 'fam-main', user_openid: 'openid-baba', user_nickname: '爸爸', dishes: [{ dish_id: 'dish-main', name: '番茄炒蛋', quantity: 1 }], note: '', created_at: FIXED_NOW - 300 })
  store._seedSubscribe({ _id: 'fam-main:2024-01-01:lunch:openid-baba', meal_id: 'fam-main:2024-01-01:lunch', user_openid: 'openid-baba', template_id: '', granted: true, granted_at: FIXED_NOW - 300, consumed: false, sent: false })

  const result = await family.dissolveFamily({ familyId: 'fam-main' }, 'openid-mama')

  assert.equal(result, undefined)
  const fam = await store.getFamily('fam-main')
  assert.equal(fam.status, 'frozen')
  assert.equal(fam.dissolved_at, FIXED_NOW)
  // 无任何物理删除: 家庭/成员/菜品/餐次/订单/订阅 原样在库
  assert.equal(fam.member_count, 2)
  assert.equal(fam.creator_openid, 'openid-mama')
  assert.equal((await store.getFamilyMember('fam-main', 'openid-baba')).role, 'member')
  assert.equal((await store.getDish('dish-main')).name, '番茄炒蛋')
  assert.equal((await store.getMeal('fam-main:2024-01-01:lunch')).status, 'ongoing')
  assert.equal((await store.getOrder('fam-main:2024-01-01:lunch', 'openid-baba')).user_openid, 'openid-baba')
  assert.equal((await store.getSubscribe('fam-main:2024-01-01:lunch', 'openid-baba')).granted, true)
})

test('解散守卫: 非立家者 → DISSOLVE_NOT_CREATOR; 非成员 → NOT_MEMBER; 均不产生写入', async () => {
  const { store, family } = make()
  seedFamily(store)
  seedMember(store, 'openid-mama', 'creator')
  seedMember(store, 'openid-baba', 'member')

  await assert.rejects(
    () => family.dissolveFamily({ familyId: 'fam-main' }, 'openid-baba'),
    (err) => err.code === 'DISSOLVE_NOT_CREATOR'
  )
  await assert.rejects(
    () => family.dissolveFamily({ familyId: 'fam-main' }, 'openid-waipo'),
    (err) => err.code === 'NOT_MEMBER'
  )
  await assert.rejects(
    () => family.dissolveFamily({ familyId: 'fam-nope' }, 'openid-mama'),
    (err) => err.code === 'NOT_MEMBER'
  )
  assert.equal((await store.getFamily('fam-main')).status, 'active')
  assert.equal((await store.getFamily('fam-main')).dissolved_at, undefined)
})

test('解散幂等: 已冻结家庭再次解散不报错, dissolved_at 不被覆盖', async () => {
  const { store, family } = make()
  seedFamily(store, { status: 'frozen', dissolved_at: FIXED_NOW - 100 })
  seedMember(store, 'openid-mama', 'creator')

  await family.dissolveFamily({ familyId: 'fam-main' }, 'openid-mama')

  assert.equal((await store.getFamily('fam-main')).dissolved_at, FIXED_NOW - 100)
})

// ── 成员列表(成员管理页数据源) ──

test('listMembers: 返回全部成员(角色+加入时间), 按 joined_at 升序, 立家者在前', async () => {
  const { store, family } = make()
  seedFamily(store)
  seedMember(store, 'openid-mama', 'creator', 'fam-main', FIXED_NOW - 500)
  seedMember(store, 'openid-baba', 'member', 'fam-main', FIXED_NOW - 300)
  seedMember(store, 'openid-keke', 'member', 'fam-main', FIXED_NOW - 100)

  const members = await family.listMembers({ familyId: 'fam-main' }, 'openid-baba')

  assert.deepEqual(members.map((m) => m.user_openid), ['openid-mama', 'openid-baba', 'openid-keke'])
  assert.deepEqual(members.map((m) => m.role), ['creator', 'member', 'member'])
  assert.deepEqual(members.map((m) => m.joined_at), [FIXED_NOW - 500, FIXED_NOW - 300, FIXED_NOW - 100])
})

test('listMembers 守卫: 非成员/家庭不存在 → NOT_MEMBER; 冻结家庭 → FAMILY_FROZEN', async () => {
  const { store, family } = make()
  seedFamily(store)
  seedMember(store, 'openid-mama', 'creator')

  await assert.rejects(
    () => family.listMembers({ familyId: 'fam-main' }, 'openid-waipo'),
    (err) => err.code === 'NOT_MEMBER'
  )
  await assert.rejects(
    () => family.listMembers({ familyId: 'fam-nope' }, 'openid-mama'),
    (err) => err.code === 'NOT_MEMBER'
  )

  const frozen = make()
  seedFamily(frozen.store, { status: 'frozen' })
  seedMember(frozen.store, 'openid-mama', 'creator')
  await assert.rejects(
    () => frozen.family.listMembers({ familyId: 'fam-main' }, 'openid-mama'),
    (err) => err.code === 'FAMILY_FROZEN'
  )
})

// ── AC: 退出后无任何家庭 → startup 路由 onboarding(复用 T1 判定, 引擎只删行不造路由) ──

test('退出后路由: 退出最后一个家庭 → startup 路由 onboarding', async () => {
  const { store, family, identity } = make()
  await seedUser(store, 'openid-baba')
  seedFamily(store)
  seedMember(store, 'openid-mama', 'creator')
  seedMember(store, 'openid-baba', 'member')

  await family.leaveFamily({ familyId: 'fam-main' }, 'openid-baba')

  const { route } = await identity.startup('openid-baba')
  assert.equal(route, 'onboarding')
})

test('退出后路由: 仍有其它家庭 → 路由 home 不变', async () => {
  const { store, family, identity } = make()
  await seedUser(store, 'openid-baba')
  seedFamily(store)
  seedMember(store, 'openid-mama', 'creator')
  seedMember(store, 'openid-baba', 'member')
  store._seedFamily({ _id: 'fam-other', name: '别家', creator_openid: 'openid-waipo', invite_code: 'BBB222', expires_at: FIXED_NOW + WEEK, member_count: 1, status: 'active', created_at: FIXED_NOW - 900 })
  seedMember(store, 'openid-baba', 'member', 'fam-other', FIXED_NOW - 50)

  await family.leaveFamily({ familyId: 'fam-main' }, 'openid-baba')

  const { route } = await identity.startup('openid-baba')
  assert.equal(route, 'home')
})