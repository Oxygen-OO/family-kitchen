'use strict'

// T3 集成级跨 seam: 全引擎共享同一内存 Store 双胞胎 + 固定时钟, 钉死守卫一致性 ——
// 「解散 = 冻结后, 菜肴/餐次/家庭全部用户入口逐一拒绝(FAMILY_FROZEN)」,
// 且冻结不产生任何物理删除(ADR-0003, 备餐清单可追溯)。断言只跨外部 seam(错误码/在库状态)。

const { test } = require('node:test')
const assert = require('node:assert/strict')

const { createMemStore } = require('./mem-store.js')
const { createFamilyEngine } = require('../lib/family-engine/index.js')
const { createDishEngine } = require('../lib/dish-engine/index.js')
const { createMealEngine } = require('../lib/meal-engine/index.js')

const FIXED_NOW = 1700000000000
const WEEK = 7 * 24 * 3600 * 1000

const fixedClock = { now: () => FIXED_NOW }

function makeWorld() {
  const store = createMemStore()
  return {
    store,
    family: createFamilyEngine(store, fixedClock),
    dish: createDishEngine(store, fixedClock),
    meal: createMealEngine(store, fixedClock),
  }
}

function seedWorld(store) {
  store._seedFamily({
    _id: 'fam-main',
    name: '快乐一家',
    creator_openid: 'openid-mama',
    invite_code: 'ABC123',
    expires_at: FIXED_NOW + WEEK,
    member_count: 3,
    status: 'active',
    created_at: FIXED_NOW - 1000,
  })
  store._seedFamilyMember({ family_id: 'fam-main', user_openid: 'openid-mama', role: 'creator', joined_at: FIXED_NOW - 500 })
  store._seedFamilyMember({ family_id: 'fam-main', user_openid: 'openid-baba', role: 'member', joined_at: FIXED_NOW - 300 })
  store._seedFamilyMember({ family_id: 'fam-main', user_openid: 'openid-keke', role: 'member', joined_at: FIXED_NOW - 100 })
  store._seedDish({ _id: 'dish-tomato', family_id: 'fam-main', name: '番茄炒蛋', ingredients: [{ name: '番茄', amount: '2个' }, { name: '鸡蛋', amount: '2个' }], is_available: true, is_deleted: false, created_by: 'openid-mama', created_at: FIXED_NOW - 500 })
  store._seedDish({ _id: 'dish-removed', family_id: 'fam-main', name: '老菜', ingredients: [{ name: '盐', amount: '少许' }], is_available: true, is_deleted: true, created_by: 'openid-mama', created_at: FIXED_NOW - 450 })
  store._seedMeal({ _id: 'fam-main:2024-01-01:lunch', family_id: 'fam-main', date: '2024-01-01', slot: 'lunch', status: 'ongoing', initiated_by: 'openid-mama', deadline: FIXED_NOW + 1000, created_at: FIXED_NOW - 400, summary: null })
  store._seedOrder({ _id: 'fam-main:2024-01-01:lunch:openid-baba', meal_id: 'fam-main:2024-01-01:lunch', family_id: 'fam-main', user_openid: 'openid-baba', user_nickname: '爸爸', dishes: [{ dish_id: 'dish-tomato', name: '番茄炒蛋', quantity: 1 }], note: '', created_at: FIXED_NOW - 300 })
  store._seedSubscribe({ _id: 'fam-main:2024-01-01:lunch:openid-baba', meal_id: 'fam-main:2024-01-01:lunch', user_openid: 'openid-baba', template_id: '', granted: true, granted_at: FIXED_NOW - 300, consumed: false, sent: false })
}

test('冻结后全引擎拒绝(集成级跨 seam): 解散 → 菜肴/餐次/家庭全部用户入口 FAMILY_FROZEN, 仅 dissolveFamily 幂等接受', async () => {
  const { store, family, dish, meal } = makeWorld()
  seedWorld(store)

  await family.dissolveFamily({ familyId: 'fam-main' }, 'openid-mama')
  assert.equal((await store.getFamily('fam-main')).status, 'frozen')

  // 菜品引擎 7 入口全拒(守卫一致性: dish-engine 的 guard 与 meal-engine/family-engine 同语义)
  const dishCalls = [
    () => dish.listDishes({ familyId: 'fam-main' }, 'openid-mama'),
    () => dish.listRemovedDishes({ familyId: 'fam-main' }, 'openid-mama'),
    () => dish.createDish({ familyId: 'fam-main', name: '新菜', ingredients: [{ name: '盐', amount: '1g' }] }, 'openid-mama'),
    () => dish.updateDish({ familyId: 'fam-main', dishId: 'dish-tomato', name: '改名', ingredients: [{ name: '番茄', amount: '1个' }] }, 'openid-mama'),
    () => dish.setDishAvailable({ familyId: 'fam-main', dishId: 'dish-tomato', isAvailable: false }, 'openid-mama'),
    () => dish.deleteDish({ familyId: 'fam-main', dishId: 'dish-tomato' }, 'openid-mama'),
    () => dish.restoreDish({ familyId: 'fam-main', dishId: 'dish-removed' }, 'openid-mama'),
  ]
  for (const call of dishCalls) await assert.rejects(call, (err) => err.code === 'FAMILY_FROZEN')

  // 餐次引擎 4 个用户入口全拒(scanDue 为 cron 系统动作, 无成员上下文, 不在用户入口之列)
  const mealCalls = [
    () => meal.initiate({ familyId: 'fam-main', date: '2024-01-02', slot: 'dinner' }, 'openid-mama', { now: FIXED_NOW }),
    () => meal.viewMeal('fam-main:2024-01-01:lunch', 'openid-mama'),
    () => meal.viewMeal('fam-main:2024-01-01:lunch', 'openid-baba'),
    () => meal.placeOrder('fam-main:2024-01-01:lunch', 'openid-mama', { dishes: [{ dishId: 'dish-tomato', quantity: 1 }] }, { nickname: '妈妈', now: FIXED_NOW }),
    () => meal.closeEarly('fam-main:2024-01-01:lunch', 'openid-mama', { now: FIXED_NOW }),
  ]
  for (const call of mealCalls) await assert.rejects(call, (err) => err.code === 'FAMILY_FROZEN')

  // 家庭引擎余下用户入口全拒(join 冻结门 / 邀请 / 退出 / 转让 / 成员列表)
  const familyCalls = [
    () => family.joinByCode({ code: 'ABC123' }, 'openid-waipo', { nickname: '外婆', now: FIXED_NOW }),
    () => family.generateInviteCode({ familyId: 'fam-main' }, 'openid-mama', { now: FIXED_NOW }),
    () => family.leaveFamily({ familyId: 'fam-main' }, 'openid-baba'),
    () => family.transferOwnership({ familyId: 'fam-main' }, 'openid-mama', 'openid-baba'),
    () => family.listMembers({ familyId: 'fam-main' }, 'openid-baba'),
  ]
  for (const call of familyCalls) await assert.rejects(call, (err) => err.code === 'FAMILY_FROZEN')

  // 冻结后全库仅 dissolveFamily 接受 frozen: 现任立家者可幂等重调, 成员调则被角色守卫拦
  await family.dissolveFamily({ familyId: 'fam-main' }, 'openid-mama')
  await assert.rejects(
    () => family.dissolveFamily({ familyId: 'fam-main' }, 'openid-baba'),
    (err) => err.code === 'DISSOLVE_NOT_CREATOR'
  )
})

test('冻结后数据全部保留: 家庭/成员/菜品(含软删)/餐次/订单/订阅 原样在库', async () => {
  const { store, family } = makeWorld()
  seedWorld(store)

  await family.dissolveFamily({ familyId: 'fam-main' }, 'openid-mama')

  const fam = await store.getFamily('fam-main')
  assert.equal(fam.status, 'frozen')
  assert.equal(fam.dissolved_at, FIXED_NOW)
  assert.equal(fam.member_count, 3)
  assert.equal((await store.getFamilyMember('fam-main', 'openid-mama')).role, 'creator')
  assert.equal((await store.getFamilyMember('fam-main', 'openid-baba')).role, 'member')
  assert.equal((await store.getFamilyMember('fam-main', 'openid-keke')).role, 'member')
  assert.equal((await store.getDish('dish-tomato')).is_deleted, false)
  assert.equal((await store.getDish('dish-removed')).is_deleted, true)
  assert.equal((await store.getMeal('fam-main:2024-01-01:lunch')).status, 'ongoing')
  assert.equal((await store.getOrder('fam-main:2024-01-01:lunch', 'openid-baba')).user_openid, 'openid-baba')
  assert.equal((await store.getSubscribe('fam-main:2024-01-01:lunch', 'openid-baba')).sent, false)
})