'use strict'

const { test } = require('node:test')
const assert = require('node:assert/strict')

const { createMemStore } = require('./mem-store.js')
const { createIdentityEngine } = require('../lib/identity/index.js')

const OPENID = 'openid-mama'
const FIXED_NOW = 1700000000000

function racingStore(inner) {
  return {
    getUser: (openid) => inner.getUser(openid),
    // 并发写者恰在 create 前完成: 先落入底层, 再走真实 create → 必然撞键
    createUser: async (doc) => {
      await inner.createUser(doc)
      return inner.createUser(doc)
    },
    updateUser: (openid, patch) => inner.updateUser(openid, patch),
    listFamilyMembers: (openid) => inner.listFamilyMembers(openid),
  }
}

test('首登: get-or-create 写入 users 档案, isNew=true, created_at 取注入时钟', async () => {
  const store = createMemStore()
  const engine = createIdentityEngine(store)

  const result = await engine.login(OPENID, { now: FIXED_NOW })

  assert.equal(result.isNew, true)
  assert.equal(result.openid, OPENID)
  assert.deepEqual(result.user, {
    _id: OPENID,
    openid: OPENID,
    nickname: '',
    avatar: '',
    created_at: FIXED_NOW,
  })
  assert.deepEqual(await store.getUser(OPENID), result.user)
})

test('老用户: isNew=false, 原档案原样返回不覆盖', async () => {
  const store = createMemStore()
  const seeded = {
    _id: OPENID,
    openid: OPENID,
    nickname: '妈妈',
    avatar: 'cloud://avatar.png',
    created_at: FIXED_NOW - 1000,
  }
  await store.createUser(seeded)
  const engine = createIdentityEngine(store)

  const result = await engine.login(OPENID, { now: FIXED_NOW })

  assert.equal(result.isNew, false)
  assert.deepEqual(result.user, seeded)
})

test('并发首登撞键: 创建失败回退读取, isNew=false, 不抛错', async () => {
  const store = createMemStore()
  const engine = createIdentityEngine(racingStore(store))

  const result = await engine.login(OPENID, { now: FIXED_NOW })

  assert.equal(result.isNew, false)
  const stored = await store.getUser(OPENID)
  assert.ok(stored)
  assert.equal(stored.created_at, FIXED_NOW)
})

test('startup 有家庭记录: route=home, families 按 joined_at 降序随附', async () => {
  const store = createMemStore()
  await store.createUser({ _id: OPENID, openid: OPENID, nickname: '妈妈', avatar: '', created_at: FIXED_NOW })
  store._seedFamilyMember({ family_id: 'fam-old', user_openid: OPENID, role: 'member', joined_at: FIXED_NOW - 500 })
  store._seedFamilyMember({ family_id: 'fam-new', user_openid: OPENID, role: 'member', joined_at: FIXED_NOW })
  store._seedFamilyMember({ family_id: 'fam-other', user_openid: 'openid-baba', role: 'creator', joined_at: FIXED_NOW })
  const engine = createIdentityEngine(store)

  const result = await engine.startup(OPENID)

  assert.equal(result.route, 'home')
  assert.deepEqual(result.families.map((f) => f.family_id), ['fam-new', 'fam-old'])
  assert.equal(result.user.nickname, '妈妈')
})

test('startup 无家庭记录: route=onboarding, 不带 families', async () => {
  const store = createMemStore()
  await store.createUser({ _id: OPENID, openid: OPENID, nickname: '爸爸', avatar: '', created_at: FIXED_NOW })
  const engine = createIdentityEngine(store)

  const result = await engine.startup(OPENID)

  assert.equal(result.route, 'onboarding')
  assert.deepEqual(result.families, undefined)
})

test('startup 用户不存在: 抛 USER_NOT_FOUND（客户端据此判定缓存失效静默重登）', async () => {
  const store = createMemStore()
  const engine = createIdentityEngine(store)

  await assert.rejects(
    () => engine.startup(OPENID),
    (err) => err.code === 'USER_NOT_FOUND'
  )
})

test('startup 纯只读: 不产生任何写入', async () => {
  const store = createMemStore()
  await store.createUser({ _id: OPENID, openid: OPENID, nickname: '', avatar: '', created_at: FIXED_NOW })
  const engine = createIdentityEngine(store)
  await engine.startup(OPENID)
  const user = await store.getUser(OPENID)
  assert.equal(user.nickname, '')
  const members = await store.listFamilyMembers(OPENID)
  assert.equal(members.length, 0)
})

test('saveProfile 首登自填: 写入昵称头像, created_at 不被触碰', async () => {
  const store = createMemStore()
  await store.createUser({ _id: OPENID, openid: OPENID, nickname: '', avatar: '', created_at: FIXED_NOW })
  const engine = createIdentityEngine(store)

  const { user } = await engine.saveProfile(OPENID, {
    nickname: ' 妈妈 ',
    avatar: 'cloud://avatar.png',
  })

  assert.equal(user.nickname, '妈妈')
  assert.equal(user.avatar, 'cloud://avatar.png')
  assert.equal(user.created_at, FIXED_NOW)
})

test('saveProfile 纯空白昵称: NICKNAME_REQUIRED, 不产生写入', async () => {
  const store = createMemStore()
  await store.createUser({ _id: OPENID, openid: OPENID, nickname: '', avatar: '', created_at: FIXED_NOW })
  const engine = createIdentityEngine(store)

  await assert.rejects(
    () => engine.saveProfile(OPENID, { nickname: '   ', avatar: '' }),
    (err) => err.code === 'NICKNAME_REQUIRED'
  )
  assert.equal((await store.getUser(OPENID)).nickname, '')
})

test('saveProfile 昵称超 20 字符: NICKNAME_TOO_LONG', async () => {
  const store = createMemStore()
  await store.createUser({ _id: OPENID, openid: OPENID, nickname: '', avatar: '', created_at: FIXED_NOW })
  const engine = createIdentityEngine(store)

  await assert.rejects(
    () => engine.saveProfile(OPENID, { nickname: '二'.repeat(21), avatar: '' }),
    (err) => err.code === 'NICKNAME_TOO_LONG'
  )
})

test('saveProfile avatar 非空且非 cloud:// 形态: AVATAR_INVALID', async () => {
  const store = createMemStore()
  await store.createUser({ _id: OPENID, openid: OPENID, nickname: '', avatar: '', created_at: FIXED_NOW })
  const engine = createIdentityEngine(store)

  await assert.rejects(
    () => engine.saveProfile(OPENID, { nickname: '爸爸', avatar: 'http://evil.example/x.png' }),
    (err) => err.code === 'AVATAR_INVALID'
  )
})

test('saveProfile avatar 缺省: 写入空串', async () => {
  const store = createMemStore()
  await store.createUser({ _id: OPENID, openid: OPENID, nickname: '', avatar: '', created_at: FIXED_NOW })
  const engine = createIdentityEngine(store)

  const { user } = await engine.saveProfile(OPENID, { nickname: '爸爸' })

  assert.equal(user.avatar, '')
})

test('saveProfile 用户不存在: USER_NOT_FOUND（缓存残留 openid 的兜底路径）', async () => {
  const store = createMemStore()
  const engine = createIdentityEngine(store)

  await assert.rejects(
    () => engine.saveProfile(OPENID, { nickname: '爸爸', avatar: '' }),
    (err) => err.code === 'USER_NOT_FOUND'
  )
})