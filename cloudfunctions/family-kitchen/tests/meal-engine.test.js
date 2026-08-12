'use strict'

const { test } = require('node:test')
const assert = require('node:assert/strict')

const { createMemStore } = require('./mem-store.js')
const { createMealEngine } = require('../lib/meal-engine/index.js')

// 本地 06:00: 无论运行机时区, 三档默认截止(08:00/11:30/17:30)都必在未来 → 断言跨 TZ 成立
const FIXED_NOW = (() => {
  const d = new Date()
  d.setHours(6, 0, 0, 0)
  return d.getTime()
})()

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

function localDateOf(ts) {
  const d = new Date(ts)
  const m = String(d.getMonth() + 1).padStart(2, '0')
  const day = String(d.getDate()).padStart(2, '0')
  return `${d.getFullYear()}-${m}-${day}`
}

const TODAY = localDateOf(FIXED_NOW)

function seedMeal(store, overrides = {}) {
  const doc = {
    _id: `fam-main:${TODAY}:breakfast`,
    family_id: 'fam-main',
    date: TODAY,
    slot: 'breakfast',
    status: 'ongoing',
    initiated_by: 'openid-mama',
    deadline: FIXED_NOW + 3600_000,
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

function orderKey(mealId, openid) {
  return `${mealId}:${openid}`
}

test('initiate: 派生 _id=familyId:date:slot, 默认截止=当日 08:00, 文档字段齐全, 返回 MealView', async () => {
  const { store, engine } = make()
  seedFamily(store)

  const view = await engine.initiate({ familyId: 'fam-main', slot: 'breakfast' }, 'openid-mama')

  const doc = await store.getMeal(`fam-main:${TODAY}:breakfast`)
  assert.ok(doc, 'meals 文档按派生 ID 落库')
  assert.equal(doc.family_id, 'fam-main')
  assert.equal(doc.date, TODAY)
  assert.equal(doc.slot, 'breakfast')
  assert.equal(doc.status, 'ongoing')
  assert.equal(doc.summary, null)
  assert.equal(doc.initiated_by, 'openid-mama')
  assert.equal(doc.created_at, FIXED_NOW)
  const deadline = new Date(doc.deadline)
  assert.equal(`${deadline.getFullYear()}-${String(deadline.getMonth() + 1).padStart(2, '0')}-${String(deadline.getDate()).padStart(2, '0')}`, TODAY)
  assert.equal(deadline.getHours(), 8)
  assert.equal(deadline.getMinutes(), 0)

  assert.equal(view.meal.date, TODAY)
  assert.equal(view.meal.slot, 'breakfast')
  assert.equal(view.meal.status, 'ongoing')
  assert.equal(view.meal.deadline, doc.deadline)
  assert.equal(view.meal.summary, null)
  assert.deepEqual(view.menu, [])
  assert.equal(view.myOrder, null)
  assert.equal(view.canOrder, true)
  assert.equal(view.granted, false)
  assert.deepEqual(view.dropped, [])
  assert.deepEqual(view.live, { byDish: [], ingredients: [], generatedAt: FIXED_NOW })
})

test('initiate: 默认截止按 slot 表 早餐08:00/午餐11:30/晚餐17:30', async () => {
  const { store, engine } = make()
  seedFamily(store)

  const slots = [
    ['breakfast', 8, 0],
    ['lunch', 11, 30],
    ['dinner', 17, 30],
  ]
  for (const [slot, hour, minute] of slots) {
    const view = await engine.initiate({ familyId: 'fam-main', date: TODAY, slot }, 'openid-baba')
    const deadline = new Date(view.meal.deadline)
    assert.equal(deadline.getHours(), hour, `${slot} 小时`)
    assert.equal(deadline.getMinutes(), minute, `${slot} 分钟`)
    assert.equal(view.meal.date, TODAY)
  }
})

test('initiate: 显式 deadline 生效并 > now 时放行', async () => {
  const { store, engine } = make()
  seedFamily(store)

  const explicit = FIXED_NOW + 3600_000
  const view = await engine.initiate(
    { familyId: 'fam-main', date: TODAY, slot: 'lunch' },
    'openid-mama',
    { deadline: explicit }
  )

  assert.equal(view.meal.deadline, explicit)
})

test('initiate: 非成员 → NOT_MEMBER 且不产生写入', async () => {
  const { store, engine } = make()
  seedFamily(store)

  await assert.rejects(
    () => engine.initiate({ familyId: 'fam-main', slot: 'breakfast' }, 'openid-stranger'),
    (err) => err.code === 'NOT_MEMBER'
  )
  assert.equal(await store.getMeal(`fam-main:${TODAY}:breakfast`), null)
})

test('initiate: 冻结家庭 → FAMILY_FROZEN', async () => {
  const { store, engine } = make()
  seedFamily(store, { status: 'frozen' })

  await assert.rejects(
    () => engine.initiate({ familyId: 'fam-main', slot: 'breakfast' }, 'openid-mama'),
    (err) => err.code === 'FAMILY_FROZEN'
  )
})

test('initiate: 同键已存在(任意状态) → MEAL_EXISTS, 不可重开', async () => {
  const { store, engine } = make()
  seedFamily(store)
  seedMeal(store) // 早餐 ongoing
  const states = [['lunch', 'closed'], ['dinner', 'prepared']]
  for (const [slot, status] of states) {
    await store.createMeal({
      _id: `fam-main:${TODAY}:${slot}`,
      family_id: 'fam-main',
      date: TODAY,
      slot,
      status,
      initiated_by: 'openid-mama',
      deadline: FIXED_NOW + 3600_000,
      created_at: FIXED_NOW - 500,
      summary: null,
    })
  }
  for (const slot of ['breakfast', 'lunch', 'dinner']) {
    await assert.rejects(
      () => engine.initiate({ familyId: 'fam-main', slot }, 'openid-mama'),
      (err) => err.code === 'MEAL_EXISTS'
    )
  }
  // 未重开也未覆盖: 原文档原样保留
  assert.equal((await store.getMeal(`fam-main:${TODAY}:dinner`)).status, 'prepared')
  assert.equal((await store.getMeal(`fam-main:${TODAY}:breakfast`)).status, 'ongoing')
})

test('initiate: 显式 deadline 不晚于 now → DEADLINE_IN_PAST', async () => {
  const { store, engine } = make()
  seedFamily(store)

  await assert.rejects(
    () => engine.initiate(
      { familyId: 'fam-main', slot: 'breakfast' },
      'openid-mama',
      { deadline: FIXED_NOW } // 恰等于 now 也拒绝
    ),
    (err) => err.code === 'DEADLINE_IN_PAST'
  )
})

test('initiate: 默认截止已过(深夜发起早餐) → DEADLINE_IN_PAST', async () => {
  const store = createMemStore()
  const night = new Date()
  night.setHours(23, 30, 0, 0)
  const engine = createMealEngine(store, { now: () => night.getTime() })
  seedFamily(store)

  await assert.rejects(
    () => engine.initiate({ familyId: 'fam-main', slot: 'breakfast' }, 'openid-mama'),
    (err) => err.code === 'DEADLINE_IN_PAST'
  )
})

test('initiate: 非法 slot / date → SLOT_INVALID / DATE_INVALID, 不产生写入', async () => {
  const { store, engine } = make()
  seedFamily(store)

  await assert.rejects(
    () => engine.initiate({ familyId: 'fam-main', slot: 'night' }, 'openid-mama'),
    (err) => err.code === 'SLOT_INVALID'
  )
  await assert.rejects(
    () => engine.initiate({ familyId: 'fam-main', date: '2026/01/15', slot: 'breakfast' }, 'openid-mama'),
    (err) => err.code === 'DATE_INVALID'
  )
  assert.equal(await store.getMeal(`fam-main:${TODAY}:breakfast`), null)
})

test('viewMeal: menu 只含 is_available 且未软删的菜品, 结构化食材透传', async () => {
  const { store, engine } = make()
  seedFamily(store)
  seedMeal(store)
  seedDish(store, {
    _id: 'dish-tomato',
    name: '番茄炒蛋',
    ingredients: [{ name: '鸡蛋', amount: '2 个' }, { name: '番茄', amount: '1 个' }],
  })
  seedDish(store, { _id: 'dish-off', name: '已下架菜', is_available: false })
  seedDish(store, { _id: 'dish-gone', name: '已删菜', is_deleted: true })
  store._seedDish({
    _id: 'dish-other', family_id: 'fam-other', name: '别家菜', ingredients: [],
    is_available: true, is_deleted: false, created_by: 'x', created_at: 1,
  })

  const view = await engine.viewMeal(`fam-main:${TODAY}:breakfast`, 'openid-baba')

  assert.deepEqual(view.menu, [{
    dishId: 'dish-tomato',
    name: '番茄炒蛋',
    ingredients: [{ name: '鸡蛋', amount: '2 个' }, { name: '番茄', amount: '1 个' }],
  }])
})

test('viewMeal: 进行中 myOrder=null(未下单), 实时 live 只算不物化(meals.summary 保持 null)', async () => {
  const { store, engine } = make()
  seedFamily(store)
  seedMeal(store)

  const view = await engine.viewMeal(`fam-main:${TODAY}:breakfast`, 'openid-baba')

  assert.equal(view.myOrder, null)
  assert.deepEqual(view.live, { byDish: [], ingredients: [], generatedAt: FIXED_NOW })
  const doc = await store.getMeal(`fam-main:${TODAY}:breakfast`)
  assert.equal(doc.summary, null, '预览不算物化, meals.summary 必须保持 null')
})

test('viewMeal: 无副作用 —— 读操作不写任何集合', async () => {
  const { store, engine } = make()
  seedFamily(store)
  seedMeal(store)
  seedDish(store)
  store._seedOrder({
    _id: orderKey(`fam-main:${TODAY}:breakfast`, 'openid-mama'),
    meal_id: `fam-main:${TODAY}:breakfast`,
    family_id: 'fam-main',
    user_openid: 'openid-mama',
    user_nickname: '妈妈',
    dishes: [{ dish_id: 'dish-tomato', name: '番茄炒蛋', quantity: 2 }],
    note: '',
    created_at: FIXED_NOW - 500,
  })

  const before = await store.getMeal(`fam-main:${TODAY}:breakfast`)
  const beforeOrders = await store.listOrders(`fam-main:${TODAY}:breakfast`)
  await engine.viewMeal(`fam-main:${TODAY}:breakfast`, 'openid-mama')
  const after = await store.getMeal(`fam-main:${TODAY}:breakfast`)
  const afterOrders = await store.listOrders(`fam-main:${TODAY}:breakfast`)

  assert.deepEqual(after, before)
  assert.deepEqual(afterOrders, beforeOrders)
})

test('viewMeal: 我已下单 → myOrder 回显快照与数量, live 用 buildSummary 汇总', async () => {
  const { store, engine } = make()
  seedFamily(store)
  seedMeal(store)
  seedDish(store)
  store._seedOrder({
    _id: orderKey(`fam-main:${TODAY}:breakfast`, 'openid-mama'),
    meal_id: `fam-main:${TODAY}:breakfast`,
    family_id: 'fam-main',
    user_openid: 'openid-mama',
    user_nickname: '妈妈',
    dishes: [{ dish_id: 'dish-tomato', name: '番茄炒蛋', quantity: 2 }],
    note: '不要香菜',
    created_at: FIXED_NOW - 500,
  })

  const view = await engine.viewMeal(`fam-main:${TODAY}:breakfast`, 'openid-mama')

  assert.deepEqual(view.myOrder, {
    user_openid: 'openid-mama',
    user_nickname: '妈妈',
    dishes: [{ dishId: 'dish-tomato', name: '番茄炒蛋', quantity: 2 }],
    note: '不要香菜',
  })
  assert.deepEqual(view.live, {
    byDish: [{
      dishId: 'dish-tomato',
      dishName: '番茄炒蛋',
      totalQuantity: 2,
      orderedBy: [{ openid: 'openid-mama', nickname: '妈妈', quantity: 2 }],
      removed: false,
    }],
    ingredients: [{ name: '鸡蛋', amountText: '2 个 ×2', dishCount: 1 }],
    generatedAt: FIXED_NOW,
  })
})

test('viewMeal: canOrder 语义 = 进行中 ∧ 当前时刻 < deadline; granted=false; dropped 恒空', async () => {
  const { store, engine } = make()
  seedFamily(store)
  const soon = FIXED_NOW + 500
  seedMeal(store, { deadline: soon })

  const view = await engine.viewMeal(`fam-main:${TODAY}:breakfast`, 'openid-baba')
  assert.equal(view.canOrder, true, 'deadline 前可点')
  assert.equal(view.granted, false)
  assert.deepEqual(view.dropped, [])

  const pastEngine = createMealEngine(store, { now: () => soon })
  const expired = await pastEngine.viewMeal(`fam-main:${TODAY}:breakfast`, 'openid-baba')
  assert.equal(expired.canOrder, false, '到达 deadline 即不可点(T8 前由 canOrder 承担展示语义)')
})

test('viewMeal: 不存在 → MEAL_NOT_FOUND', async () => {
  const { store, engine } = make()
  seedFamily(store)

  await assert.rejects(
    () => engine.viewMeal(`fam-main:${TODAY}:lunch`, 'openid-mama'),
    (err) => err.code === 'MEAL_NOT_FOUND'
  )
})

test('viewMeal: 非成员 → NOT_MEMBER; 冻结家庭 → FAMILY_FROZEN', async () => {
  const { store, engine } = make()
  seedFamily(store)
  seedMeal(store)

  await assert.rejects(
    () => engine.viewMeal(`fam-main:${TODAY}:breakfast`, 'openid-stranger'),
    (err) => err.code === 'NOT_MEMBER'
  )

  const frozenStore = createMemStore()
  seedFamily(frozenStore, { status: 'frozen' })
  seedMeal(frozenStore)
  const frozenEngine = createMealEngine(frozenStore, fixedClock)
  await assert.rejects(
    () => frozenEngine.viewMeal(`fam-main:${TODAY}:breakfast`, 'openid-mama'),
    (err) => err.code === 'FAMILY_FROZEN'
  )
})

test('viewMeal: closed 只读 —— live 读物化快照(不重算), canOrder=false, 菜单/我的单仍展示', async () => {
  const { store, engine } = make()
  seedFamily(store)
  const snapshot = {
    byDish: [{
      dishId: 'dish-tomato', dishName: '番茄炒蛋', totalQuantity: 3,
      orderedBy: [{ openid: 'openid-mama', nickname: '妈妈', quantity: 3 }], removed: false,
    }],
    ingredients: [{ name: '鸡蛋', amountText: '2 个 ×3', dishCount: 1 }],
    generatedAt: FIXED_NOW - 60_000,
  }
  seedMeal(store, {
    status: 'closed',
    closed_at: FIXED_NOW - 60_000,
    summary: snapshot,
  })
  seedDish(store)
  store._seedOrder({
    _id: orderKey(`fam-main:${TODAY}:breakfast`, 'openid-mama'),
    meal_id: `fam-main:${TODAY}:breakfast`,
    family_id: 'fam-main',
    user_openid: 'openid-mama',
    user_nickname: '妈妈',
    dishes: [{ dish_id: 'dish-tomato', name: '番茄炒蛋', quantity: 3 }],
    note: '',
    created_at: FIXED_NOW - 120_000,
  })

  const view = await engine.viewMeal(`fam-main:${TODAY}:breakfast`, 'openid-mama')

  assert.equal(view.meal.status, 'closed')
  assert.ok(view.meal.closed_at)
  assert.deepEqual(view.live, snapshot, '直接透传物化快照, 不重算(generatedAt 保持一致)')
  assert.equal(view.canOrder, false)
  assert.equal(view.menu.length, 1)
  assert.equal(view.myOrder.user_nickname, '妈妈')
})

test('viewMeal: prepared 只读 —— 状态与 prepared_by/prepared_at 透传, live 读快照', async () => {
  const { store, engine } = make()
  seedFamily(store)
  seedMeal(store, {
    status: 'prepared',
    closed_at: FIXED_NOW - 120_000,
    prepared_by: 'openid-baba',
    prepared_at: FIXED_NOW - 60_000,
    summary: { byDish: [], ingredients: [], generatedAt: FIXED_NOW - 120_000 },
  })

  const view = await engine.viewMeal(`fam-main:${TODAY}:breakfast`, 'openid-mama')

  assert.equal(view.meal.status, 'prepared')
  assert.equal(view.meal.prepared_by, 'openid-baba')
  assert.equal(view.meal.prepared_at, FIXED_NOW - 60_000)
  assert.equal(view.canOrder, false)
  assert.deepEqual(view.live, { byDish: [], ingredients: [], generatedAt: FIXED_NOW - 120_000 })
})

test('viewMeal: closed 且快照缺失(崩溃窗口) → live=null, 前端容错空清单', async () => {
  const { store, engine } = make()
  seedFamily(store)
  seedMeal(store, { status: 'closed', closed_at: FIXED_NOW - 60_000, summary: null })

  const view = await engine.viewMeal(`fam-main:${TODAY}:breakfast`, 'openid-mama')

  assert.equal(view.live, null)
})

test('placeOrder: 首单写入派生 _id=mealId:openid, 快照 dishName+昵称, 返回 MealView 回显', async () => {
  const { store, engine } = make()
  seedFamily(store)
  seedMeal(store)
  seedDish(store)

  const view = await engine.placeOrder(
    `fam-main:${TODAY}:breakfast`,
    'openid-baba',
    { dishes: [{ dishId: 'dish-tomato', quantity: 2 }], note: ' 少油 ' },
    { nickname: '爸爸' }
  )

  const doc = await store.getOrder(`fam-main:${TODAY}:breakfast`, 'openid-baba')
  assert.ok(doc, '订单按派生 ID 落库')
  assert.equal(doc._id, `fam-main:${TODAY}:breakfast:openid-baba`)
  assert.equal(doc.meal_id, `fam-main:${TODAY}:breakfast`)
  assert.equal(doc.family_id, 'fam-main')
  assert.equal(doc.user_openid, 'openid-baba')
  assert.equal(doc.user_nickname, '爸爸', '昵称快照')
  assert.deepEqual(doc.dishes, [{ dish_id: 'dish-tomato', name: '番茄炒蛋', quantity: 2 }], '菜名快照')
  assert.equal(doc.note, '少油', 'note 首尾裁剪')
  assert.equal(doc.created_at, FIXED_NOW)

  assert.deepEqual(view.myOrder, {
    user_openid: 'openid-baba',
    user_nickname: '爸爸',
    dishes: [{ dishId: 'dish-tomato', name: '番茄炒蛋', quantity: 2 }],
    note: '少油',
  })
  assert.deepEqual(view.dropped, [])
  assert.equal(view.canOrder, true)
  assert.deepEqual(view.live.byDish, [{
    dishId: 'dish-tomato', dishName: '番茄炒蛋', totalQuantity: 2,
    orderedBy: [{ openid: 'openid-baba', nickname: '爸爸', quantity: 2 }], removed: false,
  }])
})

test('placeOrder: 二次提交全量替换 —— 同一文档, 旧点选无残留', async () => {
  const { store, engine } = make()
  seedFamily(store)
  seedMeal(store)
  seedDish(store)
  seedDish(store, { _id: 'dish-cucumber', name: '黄瓜炒肉' })
  await engine.placeOrder(
    `fam-main:${TODAY}:breakfast`, 'openid-mama',
    { dishes: [{ dishId: 'dish-tomato', quantity: 1 }], note: '初版' },
    { nickname: '妈妈' }
  )

  const view = await engine.placeOrder(
    `fam-main:${TODAY}:breakfast`, 'openid-mama',
    { dishes: [{ dishId: 'dish-tomato', quantity: 3 }, { dishId: 'dish-cucumber', quantity: 1 }], note: '改版' },
    { nickname: '妈妈' }
  )

  const doc = await store.getOrder(`fam-main:${TODAY}:breakfast`, 'openid-mama')
  assert.equal(doc._id, `fam-main:${TODAY}:breakfast:openid-mama`)
  assert.deepEqual(doc.dishes, [
    { dish_id: 'dish-tomato', name: '番茄炒蛋', quantity: 3 },
    { dish_id: 'dish-cucumber', name: '黄瓜炒肉', quantity: 1 },
  ])
  assert.equal(doc.note, '改版')
  assert.equal((await store.listOrders(`fam-main:${TODAY}:breakfast`)).length, 1, '每人每餐仍是一单')
  assert.equal(view.myOrder.dishes.length, 2)
})

test('placeOrder: dishes=[] → 取消 = 删除订单文档(无 cancelled 态), myOrder=null', async () => {
  const { store, engine } = make()
  seedFamily(store)
  seedMeal(store)
  seedDish(store)
  await engine.placeOrder(
    `fam-main:${TODAY}:breakfast`, 'openid-mama',
    { dishes: [{ dishId: 'dish-tomato', quantity: 1 }] },
    { nickname: '妈妈' }
  )
  assert.ok(await store.getOrder(`fam-main:${TODAY}:breakfast`, 'openid-mama'))

  const view = await engine.placeOrder(`fam-main:${TODAY}:breakfast`, 'openid-mama', { dishes: [] })

  assert.equal(await store.getOrder(`fam-main:${TODAY}:breakfast`, 'openid-mama'), null)
  assert.equal((await store.listOrders(`fam-main:${TODAY}:breakfast`)).length, 0)
  assert.equal(view.myOrder, null)
})

test('placeOrder: 每人每餐一单 —— 两成员各自 upsert 互不覆盖', async () => {
  const { store, engine } = make()
  seedFamily(store)
  seedMeal(store)
  seedDish(store)
  await engine.placeOrder(
    `fam-main:${TODAY}:breakfast`, 'openid-mama',
    { dishes: [{ dishId: 'dish-tomato', quantity: 1 }] },
    { nickname: '妈妈' }
  )
  await engine.placeOrder(
    `fam-main:${TODAY}:breakfast`, 'openid-baba',
    { dishes: [{ dishId: 'dish-tomato', quantity: 2 }] },
    { nickname: '爸爸' }
  )

  const orders = await store.listOrders(`fam-main:${TODAY}:breakfast`)
  assert.equal(orders.length, 2)
  assert.equal(orders.find((o) => o.user_openid === 'openid-mama').dishes[0].quantity, 1)
  assert.equal(orders.find((o) => o.user_openid === 'openid-baba').dishes[0].quantity, 2)
})

test('placeOrder: 同一订单内同菜重复条目 → 合并份数, 不产生重复行', async () => {
  const { store, engine } = make()
  seedFamily(store)
  seedMeal(store)
  seedDish(store)

  const view = await engine.placeOrder(
    `fam-main:${TODAY}:breakfast`, 'openid-mama',
    { dishes: [{ dishId: 'dish-tomato', quantity: 2 }, { dishId: 'dish-tomato', quantity: 1 }] },
    { nickname: '妈妈' }
  )

  const doc = await store.getOrder(`fam-main:${TODAY}:breakfast`, 'openid-mama')
  assert.deepEqual(doc.dishes, [{ dish_id: 'dish-tomato', name: '番茄炒蛋', quantity: 3 }])
  assert.equal(view.myOrder.dishes.length, 1)
})

test('placeOrder: 下架/软删菜 → 非致命过滤, 随 dropped 返回, 有效菜正常写入', async () => {
  const { store, engine } = make()
  seedFamily(store)
  seedMeal(store)
  seedDish(store, { _id: 'dish-off', name: '已下架菜', is_available: false })
  seedDish(store, { _id: 'dish-gone', name: '已删菜', is_deleted: true })
  seedDish(store, { _id: 'dish-cucumber', name: '黄瓜炒肉' })

  const view = await engine.placeOrder(
    `fam-main:${TODAY}:breakfast`, 'openid-mama',
    { dishes: [
      { dishId: 'dish-off', quantity: 1 },
      { dishId: 'dish-gone', quantity: 2 },
      { dishId: 'dish-cucumber', quantity: 1 },
    ] },
    { nickname: '妈妈' }
  )

  assert.deepEqual(view.dropped, [
    { dishId: 'dish-off', dishName: '已下架菜' },
    { dishId: 'dish-gone', dishName: '已删菜' },
  ])
  const doc = await store.getOrder(`fam-main:${TODAY}:breakfast`, 'openid-mama')
  assert.deepEqual(doc.dishes, [{ dish_id: 'dish-cucumber', name: '黄瓜炒肉', quantity: 1 }])
  assert.equal(view.myOrder.dishes.length, 1)
})

test('placeOrder: 所点全部被过滤 → 等价取消(删文档), dropped 照常返回', async () => {
  const { store, engine } = make()
  seedFamily(store)
  seedMeal(store)
  seedDish(store, { _id: 'dish-off', name: '已下架菜', is_available: false })
  await engine.placeOrder(
    `fam-main:${TODAY}:breakfast`, 'openid-mama',
    { dishes: [{ dishId: 'dish-off', quantity: 1 }] },
    { nickname: '妈妈' }
  )

  const view = await engine.placeOrder(
    `fam-main:${TODAY}:breakfast`, 'openid-mama',
    { dishes: [{ dishId: 'dish-off', quantity: 2 }] },
    { nickname: '妈妈' }
  )

  assert.deepEqual(view.dropped, [{ dishId: 'dish-off', dishName: '已下架菜' }])
  assert.equal(view.myOrder, null, '旧单被清掉, 无遗留')
  assert.equal(await store.getOrder(`fam-main:${TODAY}:breakfast`, 'openid-mama'), null)
})

test('placeOrder: 不存在/别家菜品 → DISH_UNKNOWN 致命, 不产生写入', async () => {
  const { store, engine } = make()
  seedFamily(store)
  seedMeal(store)
  seedDish(store)
  store._seedDish({
    _id: 'dish-other', family_id: 'fam-other', name: '别家菜', ingredients: [],
    is_available: true, is_deleted: false, created_by: 'x', created_at: 1,
  })

  await assert.rejects(
    () => engine.placeOrder(
      `fam-main:${TODAY}:breakfast`, 'openid-mama',
      { dishes: [{ dishId: 'dish-nope', quantity: 1 }] },
      { nickname: '妈妈' }
    ),
    (err) => err.code === 'DISH_UNKNOWN'
  )
  await assert.rejects(
    () => engine.placeOrder(
      `fam-main:${TODAY}:breakfast`, 'openid-mama',
      { dishes: [{ dishId: 'dish-other', quantity: 1 }] },
      { nickname: '妈妈' }
    ),
    (err) => err.code === 'DISH_UNKNOWN'
  )
  assert.equal(await store.getOrder(`fam-main:${TODAY}:breakfast`, 'openid-mama'), null)
})

test('placeOrder: 撞 deadline(恰等与已过) → 先代截止(PAST_CUTOFF), 后再写落 MEAL_LOCKED, 不产生写入', async () => {
  const { store, engine } = make()
  seedFamily(store)
  const soon = FIXED_NOW + 3600_000
  seedMeal(store, { deadline: soon })
  seedDish(store)

  await assert.rejects(
    () => engine.placeOrder(
      `fam-main:${TODAY}:breakfast`, 'openid-mama',
      { dishes: [{ dishId: 'dish-tomato', quantity: 1 }] },
      { nickname: '妈妈', now: soon } // 恰等于 deadline: T8 代截止后落 PAST_CUTOFF
    ),
    (err) => err.code === 'PAST_CUTOFF'
  )
  assert.equal((await store.getMeal(`fam-main:${TODAY}:breakfast`)).status, 'closed', '代截止已铺开')
  await assert.rejects(
    () => engine.placeOrder(
      `fam-main:${TODAY}:breakfast`, 'openid-mama',
      { dishes: [{ dishId: 'dish-tomato', quantity: 1 }] },
      { nickname: '妈妈', now: soon + 1 }
    ),
    (err) => err.code === 'MEAL_LOCKED' // 已 closed(非本次代截止) → MEAL_LOCKED
  )
  assert.equal(await store.getOrder(`fam-main:${TODAY}:breakfast`, 'openid-mama'), null)
  // 截止只拒绝写: 读视图仍可用(经固定时钟的引擎)
  const pastEngine = createMealEngine(store, { now: () => soon + 1 })
  assert.equal((await pastEngine.viewMeal(`fam-main:${TODAY}:breakfast`, 'openid-mama')).canOrder, false)
})

test('placeOrder: closed/prepared 餐次 → MEAL_LOCKED, 不产生写入', async () => {
  const { store, engine } = make()
  seedFamily(store)
  seedDish(store)
  for (const status of ['closed', 'prepared']) {
    seedMeal(store, { status })
    await assert.rejects(
      () => engine.placeOrder(
        `fam-main:${TODAY}:breakfast`, 'openid-mama',
        { dishes: [{ dishId: 'dish-tomato', quantity: 1 }] },
        { nickname: '妈妈' }
      ),
      (err) => err.code === 'MEAL_LOCKED'
    )
  }
  assert.equal(await store.getOrder(`fam-main:${TODAY}:breakfast`, 'openid-mama'), null)
})

test('placeOrder: quantity 非 ≥1 整数 / dishes 非数组 / 缺 dishId → 参数错误, 不产生写入', async () => {
  const { store, engine } = make()
  seedFamily(store)
  seedMeal(store)
  seedDish(store)
  const badPayloads = [
    [{ dishId: 'dish-tomato', quantity: 0 }],
    [{ dishId: 'dish-tomato', quantity: -1 }],
    [{ dishId: 'dish-tomato', quantity: 1.5 }],
    [{ dishId: 'dish-tomato', quantity: '2' }],
    [{ dishId: 'dish-tomato' }],
    [{ quantity: 1 }],
    'not-an-array',
  ]
  for (const dishes of badPayloads) {
    await assert.rejects(
      () => engine.placeOrder(`fam-main:${TODAY}:breakfast`, 'openid-mama', { dishes }, { nickname: '妈妈' }),
      (err) => err.code === 'DISHES_INVALID' || err.code === 'QUANTITY_INVALID'
    )
  }
  assert.equal(await store.getOrder(`fam-main:${TODAY}:breakfast`, 'openid-mama'), null)
})

test('placeOrder: 快照固化 —— 下单后改名, myOrder/live 保持旧快照名, menu 显示新名', async () => {
  const { store, engine } = make()
  seedFamily(store)
  seedMeal(store)
  seedDish(store)
  await engine.placeOrder(
    `fam-main:${TODAY}:breakfast`, 'openid-mama',
    { dishes: [{ dishId: 'dish-tomato', quantity: 2 }] },
    { nickname: '妈妈' }
  )

  await store.updateDish('dish-tomato', { name: '番茄炒蛋(改名版)', updated_at: FIXED_NOW + 100 })

  const view = await engine.viewMeal(`fam-main:${TODAY}:breakfast`, 'openid-mama')
  assert.deepEqual(view.myOrder.dishes, [{ dishId: 'dish-tomato', name: '番茄炒蛋', quantity: 2 }])
  assert.equal(view.live.byDish[0].dishName, '番茄炒蛋')
  assert.equal(view.menu[0].name, '番茄炒蛋(改名版)')
  const doc = await store.getOrder(`fam-main:${TODAY}:breakfast`, 'openid-mama')
  assert.equal(doc.dishes[0].name, '番茄炒蛋')
})

test('placeOrder: 非成员/冻结/餐次不存在 → NOT_MEMBER / FAMILY_FROZEN / MEAL_NOT_FOUND', async () => {
  const { store, engine } = make()
  seedFamily(store)
  seedMeal(store)
  seedDish(store)

  await assert.rejects(
    () => engine.placeOrder(`fam-main:${TODAY}:breakfast`, 'openid-stranger', { dishes: [{ dishId: 'dish-tomato', quantity: 1 }] }),
    (err) => err.code === 'NOT_MEMBER'
  )
  await assert.rejects(
    () => engine.placeOrder(`fam-main:${TODAY}:lunch`, 'openid-mama', { dishes: [{ dishId: 'dish-tomato', quantity: 1 }] }),
    (err) => err.code === 'MEAL_NOT_FOUND'
  )
  const frozenStore = createMemStore()
  seedFamily(frozenStore, { status: 'frozen' })
  seedMeal(frozenStore)
  seedDish(frozenStore)
  const frozenEngine = createMealEngine(frozenStore, fixedClock)
  await assert.rejects(
    () => frozenEngine.placeOrder(`fam-main:${TODAY}:breakfast`, 'openid-mama', { dishes: [{ dishId: 'dish-tomato', quantity: 1 }] }),
    (err) => err.code === 'FAMILY_FROZEN'
  )
})