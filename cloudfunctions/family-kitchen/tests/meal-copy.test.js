'use strict'

const { test } = require('node:test')
const assert = require('node:assert/strict')

const { createMemStore } = require('./mem-store.js')
const { createMealEngine } = require('../lib/meal-engine/index.js')

// T7 复制昨天: copyLastSelection —— 昨日同 slot 全员副本(fill-only 不覆盖已有选点)、
// 重解析 dishName 为今日现名并按 dishId 校验(不存在/别家 → DISH_UNKNOWN 致命,
// 下架/软删 → 非致命 dropped)、note 追加「[复制自昨日]」、昨日无数据 → NO_YESTERDAY_DATA。
// 断言只跨外部 seam(错误码/视图/落库文档), 内存双胞胎 + 固定时钟 + 日期字面量(非自算)。
const FIXED_NOW = new Date(2026, 7, 12, 6, 0, 0).getTime() // 本地 2026-08-12 06:00
const TODAY = '2026-08-12'
const YESTERDAY = '2026-08-11'
const HOUR = 3600_000
const TODAY_MEAL = `fam-main:${TODAY}:breakfast`
const YESTERDAY_MEAL = `fam-main:${YESTERDAY}:breakfast`

const fixedClock = { now: () => FIXED_NOW }

function make() {
  const store = createMemStore()
  return { store, engine: createMealEngine(store, fixedClock) }
}

function seedFamily(store, overrides = {}) {
  const doc = {
    _id: 'fam-main',
    name: '快乐一家',
    creator_openid: 'openid-mama',
    invite_code: 'ABC123',
    expires_at: FIXED_NOW + 1000,
    member_count: 2,
    status: 'active',
    created_at: FIXED_NOW - 1000,
    ...overrides,
  }
  store._seedFamily(doc)
  store._seedFamilyMember({ family_id: 'fam-main', user_openid: 'openid-mama', role: 'creator', joined_at: FIXED_NOW - 1000 })
  store._seedFamilyMember({ family_id: 'fam-main', user_openid: 'openid-baba', role: 'member', joined_at: FIXED_NOW - 500 })
  return doc
}

function seedMeal(store, overrides = {}, date = TODAY, slot = 'breakfast') {
  const doc = {
    _id: `fam-main:${date}:${slot}`,
    family_id: 'fam-main',
    date,
    slot,
    status: 'ongoing',
    initiated_by: 'openid-mama',
    deadline: FIXED_NOW + HOUR,
    created_at: FIXED_NOW - 1000,
    summary: null,
    ...overrides,
  }
  store._seedMeal(doc)
  return doc
}

function seedDish(store, overrides = {}) {
  const doc = {
    _id: 'dish-tomato',
    family_id: 'fam-main',
    name: '番茄炒蛋',
    ingredients: [{ name: '鸡蛋', amount: '2 个' }],
    is_available: true,
    is_deleted: false,
    created_by: 'openid-mama',
    created_at: FIXED_NOW - 1000,
    ...overrides,
  }
  store._seedDish(doc)
  return doc
}

function seedOrder(store, mealId, openid, nickname, dishes, note = '', created_at = FIXED_NOW - 2000) {
  store._seedOrder({
    _id: `${mealId}:${openid}`,
    meal_id: mealId,
    family_id: 'fam-main',
    user_openid: openid,
    user_nickname: nickname,
    dishes,
    note,
    created_at,
  })
}

test('copyLastSelection: 昨日同 slot 全员副本 —— 每名昨日点餐成员各自落今日单(昨日状态无关), dishName 重解析为今日现名', async () => {
  const { store, engine } = make()
  seedFamily(store)
  seedMeal(store) // 今日早餐 ongoing
  seedMeal(store, { status: 'closed', closed_at: FIXED_NOW - 3000 }, YESTERDAY) // 昨日已截止: 订单仍有效
  seedDish(store, { _id: 'dish-tomato', name: '番茄炒蛋(现名)' })
  seedDish(store, { _id: 'dish-cucumber', name: '黄瓜炒肉' })
  seedOrder(store, YESTERDAY_MEAL, 'openid-mama', '妈妈', [
    { dish_id: 'dish-tomato', name: '番茄炒蛋(旧名)', quantity: 2 },
  ])
  seedOrder(store, YESTERDAY_MEAL, 'openid-baba', '爸爸', [
    { dish_id: 'dish-cucumber', name: '黄瓜炒肉', quantity: 1 },
  ])

  const view = await engine.copyLastSelection(TODAY_MEAL, 'openid-baba')

  const mamaDoc = await store.getOrder(TODAY_MEAL, 'openid-mama')
  assert.ok(mamaDoc, '全员副本: 妈妈的昨日选点也复制进今日')
  assert.deepEqual(mamaDoc.dishes, [{ dish_id: 'dish-tomato', name: '番茄炒蛋(现名)', quantity: 2 }], '快照按今日现名重解析')
  assert.equal(mamaDoc.user_nickname, '妈妈', '昵称快照沿用昨日')
  const babaDoc = await store.getOrder(TODAY_MEAL, 'openid-baba')
  assert.deepEqual(babaDoc.dishes, [{ dish_id: 'dish-cucumber', name: '黄瓜炒肉', quantity: 1 }])
  assert.equal((await store.listOrders(YESTERDAY_MEAL)).length, 2, '拷贝源昨日单原样保留')
  assert.equal((await store.listOrders(TODAY_MEAL)).length, 2, '每人每餐一单')

  assert.deepEqual(view.myOrder.dishes, [{ dishId: 'dish-cucumber', name: '黄瓜炒肉', quantity: 1 }], '调用者视图回显自己的复制结果')
  assert.deepEqual(view.copied, [{ dishId: 'dish-cucumber', dishName: '黄瓜炒肉', quantity: 1 }], 'copied 为调用者本人的复制清单')
  assert.deepEqual(view.dropped, [])
  assert.equal(view.canOrder, true)
  assert.equal(view.live.byDish.length, 2, '实时预览已含全部今日订单')
})

test('copyLastSelection: 昨日同 slot 无餐次 → NO_YESTERDAY_DATA, 无任何写入', async () => {
  const { store, engine } = make()
  seedFamily(store)
  seedMeal(store) // 今日有餐次, 昨日从未发起
  seedDish(store)

  await assert.rejects(
    () => engine.copyLastSelection(TODAY_MEAL, 'openid-mama'),
    (err) => err.code === 'NO_YESTERDAY_DATA'
  )
  assert.equal((await store.listOrders(TODAY_MEAL)).length, 0)
})

test('copyLastSelection: 昨日餐次存在但无人点餐 → NO_YESTERDAY_DATA', async () => {
  const { store, engine } = make()
  seedFamily(store)
  seedMeal(store)
  seedMeal(store, {}, YESTERDAY)
  seedDish(store)

  await assert.rejects(
    () => engine.copyLastSelection(TODAY_MEAL, 'openid-mama'),
    (err) => err.code === 'NO_YESTERDAY_DATA'
  )
  assert.equal((await store.listOrders(TODAY_MEAL)).length, 0)
})

test('copyLastSelection: fill-only —— 今日已有选点的成员跳过不覆盖, 其余成员照常复制', async () => {
  const { store, engine } = make()
  seedFamily(store)
  seedMeal(store)
  seedMeal(store, {}, YESTERDAY)
  seedDish(store, { _id: 'dish-tomato', name: '番茄炒蛋' })
  seedDish(store, { _id: 'dish-cucumber', name: '黄瓜炒肉' })
  seedOrder(store, YESTERDAY_MEAL, 'openid-mama', '妈妈', [
    { dish_id: 'dish-tomato', name: '番茄炒蛋', quantity: 2 },
  ])
  seedOrder(store, YESTERDAY_MEAL, 'openid-baba', '爸爸', [
    { dish_id: 'dish-cucumber', name: '黄瓜炒肉', quantity: 1 },
  ])
  seedOrder(store, TODAY_MEAL, 'openid-mama', '妈妈', [
    { dish_id: 'dish-cucumber', name: '黄瓜炒肉', quantity: 3 },
  ], '', FIXED_NOW - 1000) // 妈妈今日已有自己的选点

  const view = await engine.copyLastSelection(TODAY_MEAL, 'openid-mama')

  const mamaDoc = await store.getOrder(TODAY_MEAL, 'openid-mama')
  assert.deepEqual(mamaDoc.dishes, [{ dish_id: 'dish-cucumber', name: '黄瓜炒肉', quantity: 3 }], 'fill-only: 已有选点不被昨日副本覆盖')
  assert.equal(mamaDoc.note, '', 'note 也不动')
  const babaDoc = await store.getOrder(TODAY_MEAL, 'openid-baba')
  assert.deepEqual(babaDoc.dishes, [{ dish_id: 'dish-cucumber', name: '黄瓜炒肉', quantity: 1 }], '无今日选点的成员照常复制')
  assert.deepEqual(view.copied, [], '调用者已被跳过 → copied 为空')
  assert.deepEqual(view.myOrder.dishes, [{ dishId: 'dish-cucumber', name: '黄瓜炒肉', quantity: 3 }], '视图仍是自己的今日点选')
})

test('copyLastSelection: 调用者昨日未点餐 → copied/dropped 为空, 但全员复制照常执行', async () => {
  const { store, engine } = make()
  seedFamily(store)
  seedMeal(store)
  seedMeal(store, {}, YESTERDAY)
  seedDish(store)
  seedOrder(store, YESTERDAY_MEAL, 'openid-mama', '妈妈', [
    { dish_id: 'dish-tomato', name: '番茄炒蛋', quantity: 2 },
  ])

  const view = await engine.copyLastSelection(TODAY_MEAL, 'openid-baba')

  assert.ok(await store.getOrder(TODAY_MEAL, 'openid-mama'), '妈妈照常被复制')
  assert.deepEqual(view.copied, [])
  assert.deepEqual(view.dropped, [])
  assert.equal(view.myOrder, null)
})

test('copyLastSelection: 下架/软删菜 → 非致命过滤, 随 dropped 返回, 有效菜照常复制, 他人单不受牵连', async () => {
  const { store, engine } = make()
  seedFamily(store)
  seedMeal(store)
  seedMeal(store, {}, YESTERDAY)
  seedDish(store, { _id: 'dish-off', name: '已下架菜', is_available: false })
  seedDish(store, { _id: 'dish-gone', name: '已删菜', is_deleted: true })
  seedDish(store, { _id: 'dish-tomato', name: '番茄炒蛋' })
  seedOrder(store, YESTERDAY_MEAL, 'openid-mama', '妈妈', [
    { dish_id: 'dish-tomato', name: '番茄炒蛋', quantity: 2 },
    { dish_id: 'dish-off', name: '已下架菜', quantity: 1 },
    { dish_id: 'dish-gone', name: '已删菜', quantity: 1 },
  ])
  seedOrder(store, YESTERDAY_MEAL, 'openid-baba', '爸爸', [
    { dish_id: 'dish-tomato', name: '番茄炒蛋', quantity: 1 },
  ])

  const view = await engine.copyLastSelection(TODAY_MEAL, 'openid-mama')

  const mamaDoc = await store.getOrder(TODAY_MEAL, 'openid-mama')
  assert.deepEqual(mamaDoc.dishes, [{ dish_id: 'dish-tomato', name: '番茄炒蛋', quantity: 2 }], '过滤仅作用于自己的复制')
  assert.deepEqual(view.dropped, [
    { dishId: 'dish-off', dishName: '已下架菜' },
    { dishId: 'dish-gone', dishName: '已删菜' },
  ])
  assert.deepEqual(view.copied, [{ dishId: 'dish-tomato', dishName: '番茄炒蛋', quantity: 2 }])
  assert.equal((await store.getOrder(TODAY_MEAL, 'openid-baba')).dishes.length, 1, '爸爸的复制不受妈妈过滤牵连')
})

test('copyLastSelection: 昨日选点全被过滤 → 该成员不落今日单(不产生空单), dropped 照常返回', async () => {
  const { store, engine } = make()
  seedFamily(store)
  seedMeal(store)
  seedMeal(store, {}, YESTERDAY)
  seedDish(store, { _id: 'dish-off', name: '已下架菜', is_available: false })
  seedOrder(store, YESTERDAY_MEAL, 'openid-mama', '妈妈', [
    { dish_id: 'dish-off', name: '已下架菜', quantity: 1 },
  ])

  const view = await engine.copyLastSelection(TODAY_MEAL, 'openid-mama')

  assert.equal(await store.getOrder(TODAY_MEAL, 'openid-mama'), null, '无有效菜 → 不落空单')
  assert.equal((await store.listOrders(TODAY_MEAL)).length, 0)
  assert.deepEqual(view.dropped, [{ dishId: 'dish-off', dishName: '已下架菜' }])
  assert.deepEqual(view.copied, [])
})

test('copyLastSelection: note 溯源 —— 复制单携带昨日 note 并追加「[复制自昨日]」, 昨日单不被篡改', async () => {
  const { store, engine } = make()
  seedFamily(store)
  seedMeal(store)
  seedMeal(store, {}, YESTERDAY)
  seedDish(store)
  seedOrder(store, YESTERDAY_MEAL, 'openid-mama', '妈妈', [
    { dish_id: 'dish-tomato', name: '番茄炒蛋', quantity: 2 },
  ], '少油')
  seedOrder(store, YESTERDAY_MEAL, 'openid-baba', '爸爸', [
    { dish_id: 'dish-tomato', name: '番茄炒蛋', quantity: 1 },
  ], '')

  await engine.copyLastSelection(TODAY_MEAL, 'openid-baba')

  const mamaDoc = await store.getOrder(TODAY_MEAL, 'openid-mama')
  assert.equal(mamaDoc.note, '少油 [复制自昨日]', '昨日 note 保留 + 追加标记')
  const babaDoc = await store.getOrder(TODAY_MEAL, 'openid-baba')
  assert.equal(babaDoc.note, '[复制自昨日]', '无昨日 note → 标记本身作为 note')
  const prevMama = await store.getOrder(YESTERDAY_MEAL, 'openid-mama')
  assert.equal(prevMama.note, '少油', '拷贝源不被篡改')
})

test('copyLastSelection: 昨日单含不存在/别家菜品 → DISH_UNKNOWN 致命, 先预校验后写入, 任何顺序下无部分写入', async () => {
  const { store, engine } = make()
  seedFamily(store)
  seedMeal(store)
  seedMeal(store, {}, YESTERDAY)
  seedDish(store)
  store._seedDish({
    _id: 'dish-other', family_id: 'fam-other', name: '别家菜', ingredients: [],
    is_available: true, is_deleted: false, created_by: 'x', created_at: 1,
  })
  // 有效单排在前、病单排在后: 若校验与写入不分离, 前单会先落库造成部分写入
  seedOrder(store, YESTERDAY_MEAL, 'openid-baba', '爸爸', [
    { dish_id: 'dish-tomato', name: '番茄炒蛋', quantity: 1 },
  ])
  seedOrder(store, YESTERDAY_MEAL, 'openid-mama', '妈妈', [
    { dish_id: 'dish-nope', name: '鬼菜', quantity: 1 },
  ])

  await assert.rejects(
    () => engine.copyLastSelection(TODAY_MEAL, 'openid-mama'),
    (err) => err.code === 'DISH_UNKNOWN'
  )
  assert.equal((await store.listOrders(TODAY_MEAL)).length, 0, '预校验失败整体拒绝, 先通过校验的单也不落库')
})

test('copyLastSelection: 非 ongoing 拒绝 —— closed/prepared → MEAL_LOCKED; 到点由 close-if-due 代截止 → PAST_CUTOFF', async () => {
  const { store, engine } = make()
  seedFamily(store)
  seedDish(store)
  seedMeal(store, {}, YESTERDAY)
  seedOrder(store, YESTERDAY_MEAL, 'openid-mama', '妈妈', [
    { dish_id: 'dish-tomato', name: '番茄炒蛋', quantity: 2 },
  ])

  seedMeal(store, { status: 'closed', closed_at: FIXED_NOW - 1000 })
  await assert.rejects(
    () => engine.copyLastSelection(TODAY_MEAL, 'openid-mama'),
    (err) => err.code === 'MEAL_LOCKED'
  )
  seedMeal(store, { status: 'prepared', closed_at: FIXED_NOW - 1000, prepared_by: 'openid-baba', prepared_at: FIXED_NOW - 500 })
  await assert.rejects(
    () => engine.copyLastSelection(TODAY_MEAL, 'openid-mama'),
    (err) => err.code === 'MEAL_LOCKED'
  )
  assert.equal((await store.listOrders(TODAY_MEAL)).length, 0, '被锁餐次无写入')

  seedMeal(store, { status: 'ongoing', deadline: FIXED_NOW }) // 恰在截止点
  await assert.rejects(
    () => engine.copyLastSelection(TODAY_MEAL, 'openid-mama'),
    (err) => err.code === 'PAST_CUTOFF'
  )
  assert.equal((await store.getMeal(TODAY_MEAL)).status, 'closed', '到点即被代截止铺设')
  await assert.rejects(
    () => engine.copyLastSelection(TODAY_MEAL, 'openid-mama'),
    (err) => err.code === 'MEAL_LOCKED'
  )
})

test('copyLastSelection: 非成员 / 冻结家庭 / 今日餐次不存在 → NOT_MEMBER / FAMILY_FROZEN / MEAL_NOT_FOUND', async () => {
  const { store, engine } = make()
  seedFamily(store)
  seedMeal(store)
  seedMeal(store, {}, YESTERDAY)
  seedDish(store)
  seedOrder(store, YESTERDAY_MEAL, 'openid-mama', '妈妈', [
    { dish_id: 'dish-tomato', name: '番茄炒蛋', quantity: 1 },
  ])

  await assert.rejects(
    () => engine.copyLastSelection(TODAY_MEAL, 'openid-stranger'),
    (err) => err.code === 'NOT_MEMBER'
  )
  await assert.rejects(
    () => engine.copyLastSelection(`fam-main:${TODAY}:dinner`, 'openid-mama'),
    (err) => err.code === 'MEAL_NOT_FOUND'
  )
  const frozenStore = createMemStore()
  seedFamily(frozenStore, { status: 'frozen' })
  seedMeal(frozenStore)
  const frozenEngine = createMealEngine(frozenStore, fixedClock)
  await assert.rejects(
    () => frozenEngine.copyLastSelection(TODAY_MEAL, 'openid-mama'),
    (err) => err.code === 'FAMILY_FROZEN'
  )
})