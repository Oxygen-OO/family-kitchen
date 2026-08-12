'use strict'

const { test } = require('node:test')
const assert = require('node:assert/strict')

const { createMemStore } = require('./mem-store.js')
const { createFamilyEngine } = require('../lib/family-engine/index.js')

const FIXED_NOW = 1700000000000
const WEEK = 7 * 24 * 3600 * 1000

// 固定时钟: 冻结时间, 跨外部 seam 断言 expires_at / joined_at / created_at
const fixedClock = { now: () => FIXED_NOW }

function make() {
  const store = createMemStore()
  return { store, engine: createFamilyEngine(store, fixedClock) }
}

function seedFamily(store, overrides = {}) {
  const doc = {
    _id: 'fam-main',
    name: '快乐一家',
    creator_openid: 'openid-mama',
    invite_code: 'ABC123',
    expires_at: FIXED_NOW + WEEK,
    member_count: 1,
    status: 'active',
    created_at: FIXED_NOW - 1000,
    ...overrides,
  }
  store._seedFamily(doc)
  return doc
}

test('立家: 写 families + family_members(creator), 返回含 6 位字母数字邀请码与 7 天有效期', async () => {
  const { store, engine } = make()

  const family = await engine.createFamily({ openid: 'openid-mama', nickname: '妈妈', name: ' 快乐一家 ' })

  assert.match(family.invite_code, /^[A-Z0-9]{6}$/)
  assert.equal(family.expires_at, FIXED_NOW + WEEK)
  assert.equal(family.member_count, 1)
  assert.equal(family.status, 'active')
  assert.equal(family.created_at, FIXED_NOW)
  assert.equal(family.my_role, 'creator')
  assert.ok(family.family_id)
  const stored = await store.getFamily(family.family_id)
  assert.equal(stored.name, '快乐一家')
  assert.equal(stored.creator_openid, 'openid-mama')
  const memberships = await store.listFamilyMembers('openid-mama')
  assert.deepEqual(memberships, [{
    family_id: family.family_id,
    user_openid: 'openid-mama',
    role: 'creator',
    joined_at: FIXED_NOW,
  }])
})

test('立家名称限制 2–12 字符: 越界/空白拒绝 FAMILY_NAME_INVALID 且不产生写入', async () => {
  for (const bad of ['', '   ', '家', '二'.repeat(13)]) {
    const { store, engine } = make()
    await assert.rejects(
      () => engine.createFamily({ openid: 'openid-mama', nickname: '妈妈', name: bad }),
      (err) => err.code === 'FAMILY_NAME_INVALID'
    )
    assert.equal((await store.getFamily('family-1')), null)
  }
  const { store, engine } = make()
  const two = await engine.createFamily({ openid: 'openid-mama', nickname: '妈妈', name: '二家' })
  assert.equal(two.name, '二家')
  const twelve = await engine.createFamily({ openid: 'openid-mama', nickname: '妈妈', name: '二'.repeat(12) })
  assert.equal(twelve.name, '二'.repeat(12))
})

test('立家超家庭数上限: 已属 3 个家庭再立家 → USER_FAMILY_CAP, 不写 families', async () => {
  const { store, engine } = make()
  for (let i = 1; i <= 3; i++) {
    store._seedFamilyMember({ family_id: 'fam-' + i, user_openid: 'openid-mama', role: 'member', joined_at: FIXED_NOW - i })
  }

  await assert.rejects(
    () => engine.createFamily({ openid: 'openid-mama', nickname: '妈妈', name: '第四个家' }),
    (err) => err.code === 'USER_FAMILY_CAP'
  )
  assert.equal((await store.getFamily('family-4')), null)
})

test('凭码加入: 码不区分大小写, 写 member 行且 member_count+1, joined_at 取注入时钟', async () => {
  const { store, engine } = make()
  seedFamily(store, { invite_code: 'ABCD12', member_count: 2 })

  const family = await engine.joinByCode({ code: ' abcd12 ' }, 'openid-baba', { nickname: '爸爸', now: FIXED_NOW })

  assert.equal(family.family_id, 'fam-main')
  assert.equal(family.member_count, 3)
  assert.equal(family.my_role, 'member')
  const stored = await store.getFamily('fam-main')
  assert.equal(stored.member_count, 3)
  assert.equal(stored.invite_code, 'ABCD12')
  const memberships = await store.listFamilyMembers('openid-baba')
  assert.deepEqual(memberships, [{
    family_id: 'fam-main',
    user_openid: 'openid-baba',
    role: 'member',
    joined_at: FIXED_NOW,
  }])
})

test('凭码加入: 码不存在 → INVITE_NOT_FOUND, 不写任何行', async () => {
  const { store, engine } = make()
  seedFamily(store)

  await assert.rejects(
    () => engine.joinByCode({ code: 'ZZZ999' }, 'openid-baba', { nickname: '爸爸', now: FIXED_NOW }),
    (err) => err.code === 'INVITE_NOT_FOUND'
  )
  assert.equal((await store.getFamily('fam-main')).member_count, 1)
  assert.equal((await store.listFamilyMembers('openid-baba')).length, 0)
})

test('凭码加入: 过期码(expires_at 到点即失效) → INVITE_EXPIRED', async () => {
  for (const expiresAt of [FIXED_NOW - 1, FIXED_NOW]) {
    const { store, engine } = make()
    seedFamily(store, { expires_at: expiresAt })

    await assert.rejects(
      () => engine.joinByCode({ code: 'ABC123' }, 'openid-baba', { nickname: '爸爸', now: FIXED_NOW }),
      (err) => err.code === 'INVITE_EXPIRED'
    )
    assert.equal((await store.getFamily('fam-main')).member_count, 1)
  }
})

test('凭码加入: 家庭满 5 人 → FAMILY_FULL, member_count 不动', async () => {
  const { store, engine } = make()
  seedFamily(store, { member_count: 5 })

  await assert.rejects(
    () => engine.joinByCode({ code: 'ABC123' }, 'openid-baba', { nickname: '爸爸', now: FIXED_NOW }),
    (err) => err.code === 'FAMILY_FULL'
  )
  assert.equal((await store.getFamily('fam-main')).member_count, 5)
  assert.equal((await store.listFamilyMembers('openid-baba')).length, 0)
})

test('凭码加入: 用户已属 3 个家庭 → USER_FAMILY_CAP', async () => {
  const { store, engine } = make()
  seedFamily(store)
  for (let i = 1; i <= 3; i++) {
    store._seedFamilyMember({ family_id: 'fam-' + i, user_openid: 'openid-baba', role: 'member', joined_at: FIXED_NOW - i })
  }

  await assert.rejects(
    () => engine.joinByCode({ code: 'ABC123' }, 'openid-baba', { nickname: '爸爸', now: FIXED_NOW }),
    (err) => err.code === 'USER_FAMILY_CAP'
  )
  assert.equal((await store.getFamily('fam-main')).member_count, 1)
})

test('凭码加入: 已在家庭中重复加入 → ALREADY_MEMBER(预检拦住, 不产生第二行)', async () => {
  const { store, engine } = make()
  seedFamily(store)
  store._seedFamilyMember({ family_id: 'fam-main', user_openid: 'openid-baba', role: 'member', joined_at: FIXED_NOW - 100 })

  await assert.rejects(
    () => engine.joinByCode({ code: 'ABC123' }, 'openid-baba', { nickname: '爸爸', now: FIXED_NOW }),
    (err) => err.code === 'ALREADY_MEMBER'
  )
  assert.equal((await store.getFamily('fam-main')).member_count, 1)
  assert.equal((await store.listFamilyMembers('openid-baba')).filter((r) => r.family_id === 'fam-main').length, 1)
})

test('冻结家庭 → FAMILY_FROZEN', async () => {
  const { store, engine } = make()
  seedFamily(store, { status: 'frozen' })

  await assert.rejects(
    () => engine.joinByCode({ code: 'ABC123' }, 'openid-baba', { nickname: '爸爸', now: FIXED_NOW }),
    (err) => err.code === 'FAMILY_FROZEN'
  )
  assert.equal((await store.getFamily('fam-main')).member_count, 1)
})

test('重新生成邀请码: 覆盖旧码且 7 天新有效期, 旧码立即失效(单码覆盖模型)', async () => {
  const { store, engine } = make()
  seedFamily(store)
  store._seedFamilyMember({ family_id: 'fam-main', user_openid: 'openid-mama', role: 'creator', joined_at: FIXED_NOW - 1000 })

  const { code, expiresAt } = await engine.generateInviteCode({ familyId: 'fam-main' }, 'openid-mama', { now: FIXED_NOW })

  assert.match(code, /^[A-Z0-9]{6}$/)
  assert.equal(expiresAt, FIXED_NOW + WEEK)
  const stored = await store.getFamily('fam-main')
  assert.equal(stored.invite_code, code)
  assert.equal(stored.expires_at, FIXED_NOW + WEEK)
  assert.notEqual(stored.invite_code, 'ABC123')
  await assert.rejects(
    () => engine.joinByCode({ code: 'ABC123' }, 'openid-baba', { nickname: '爸爸', now: FIXED_NOW }),
    (err) => err.code === 'INVITE_NOT_FOUND'
  )
})

test('生成邀请码: 家庭满 5 人 → FAMILY_FULL(邀请功能自动禁用)', async () => {
  const { store, engine } = make()
  seedFamily(store, { member_count: 5 })
  store._seedFamilyMember({ family_id: 'fam-main', user_openid: 'openid-mama', role: 'creator', joined_at: FIXED_NOW - 1000 })

  await assert.rejects(
    () => engine.generateInviteCode({ familyId: 'fam-main' }, 'openid-mama', { now: FIXED_NOW }),
    (err) => err.code === 'FAMILY_FULL'
  )
  assert.equal((await store.getFamily('fam-main')).invite_code, 'ABC123')
})

test('生成邀请码: 非成员或家庭不存在 → NOT_MEMBER', async () => {
  const { store, engine } = make()
  seedFamily(store)

  await assert.rejects(
    () => engine.generateInviteCode({ familyId: 'fam-main' }, 'openid-baba', { now: FIXED_NOW }),
    (err) => err.code === 'NOT_MEMBER'
  )
  await assert.rejects(
    () => engine.generateInviteCode({ familyId: 'fam-nope' }, 'openid-mama', { now: FIXED_NOW }),
    (err) => err.code === 'NOT_MEMBER'
  )
  assert.equal((await store.getFamily('fam-main')).invite_code, 'ABC123')
})

test('生成邀请码: 冻结家庭 → FAMILY_FROZEN', async () => {
  const { store, engine } = make()
  seedFamily(store, { status: 'frozen' })
  store._seedFamilyMember({ family_id: 'fam-main', user_openid: 'openid-mama', role: 'creator', joined_at: FIXED_NOW - 1000 })

  await assert.rejects(
    () => engine.generateInviteCode({ familyId: 'fam-main' }, 'openid-mama', { now: FIXED_NOW }),
    (err) => err.code === 'FAMILY_FROZEN'
  )
})

test('myFamilies: 按 joined_at 降序返回全部家庭, 含名称/角色/状态, 冻结家庭仍可见', async () => {
  const { store, engine } = make()
  store._seedFamily({ _id: 'fam-old', name: '老家', creator_openid: 'openid-mama', invite_code: 'AAA111', expires_at: FIXED_NOW + WEEK, member_count: 2, status: 'active', created_at: FIXED_NOW - 5000 })
  store._seedFamily({ _id: 'fam-new', name: '新家', creator_openid: 'openid-mama', invite_code: 'BBB222', expires_at: FIXED_NOW + WEEK, member_count: 1, status: 'active', created_at: FIXED_NOW - 3000 })
  store._seedFamily({ _id: 'fam-frozen', name: '冻结家', creator_openid: 'openid-mama', invite_code: 'CCC333', expires_at: FIXED_NOW + WEEK, member_count: 3, status: 'frozen', created_at: FIXED_NOW - 2000 })
  store._seedFamily({ _id: 'fam-other', name: '别家', creator_openid: 'openid-baba', invite_code: 'DDD444', expires_at: FIXED_NOW + WEEK, member_count: 1, status: 'active', created_at: FIXED_NOW - 1000 })
  store._seedFamilyMember({ family_id: 'fam-old', user_openid: 'openid-mama', role: 'creator', joined_at: FIXED_NOW - 100 })
  store._seedFamilyMember({ family_id: 'fam-new', user_openid: 'openid-mama', role: 'member', joined_at: FIXED_NOW - 50 })
  store._seedFamilyMember({ family_id: 'fam-frozen', user_openid: 'openid-mama', role: 'member', joined_at: FIXED_NOW })
  store._seedFamilyMember({ family_id: 'fam-other', user_openid: 'openid-baba', role: 'creator', joined_at: FIXED_NOW })

  const families = await engine.myFamilies('openid-mama')

  assert.deepEqual(families.map((f) => f.family_id), ['fam-frozen', 'fam-new', 'fam-old'])
  assert.deepEqual(families.map((f) => f.my_role), ['member', 'member', 'creator'])
  assert.equal(families[0].name, '冻结家')
  assert.equal(families[0].status, 'frozen')
  assert.equal(families[1].status, 'active')
})