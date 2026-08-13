'use strict'

const { test } = require('node:test')
const assert = require('node:assert/strict')

const { createMemStore } = require('./mem-store.js')
const { createMealEngine } = require('../lib/meal-engine/index.js')

// T10 备餐标记: markPrepared 仅 closed → prepared(记录 prepared_by/prepared_at, 不可撤销),
// 非 closed 一律 NOT_ONGOING(不走 close-if-due、不存在 PAST_CUTOFF 语义 —— 备餐标记是关闭后动作);
// claimPrepared 条件更新为并发双标的胜负裁决(后到不覆盖先手); summary 缺失(T8 崩溃窗口)
// 由 viewMeal 透传 null、前端空态容错, 后端零改动; 备餐页数据源 = 按 (date, slot) 三连 viewMeal。
const FIXED_NOW = (() => {
  const d = new Date()
  d.setHours(6, 0, 0, 0)
  return d.getTime()
})()

const HOUR = 3600_000

function makeClock(initial = FIXED_NOW) {
  let t = initial
  return { now: () => t, set: (v) => { t = v } }
}

function make() {
  const store = createMemStore()
  return { store, engine: createMealEngine(store, { now: () => FIXED_NOW }) }
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
const YESTERDAY = localDateOf(new Date(`${TODAY}T00:00:00`).getTime() - 86400000)

function seedDish(store, overrides = {}) {
  const doc = {
    _id: 'dish-tomato',
    family_id: 'fam-main',
    name: '番茄炒蛋',
    ingredients: [{ name: '鸡蛋', amount: '2 个' }, { name: '西红柿', amount: '2 个' }],
    is_available: true,
    is_deleted: false,
    created_by: 'openid-mama',
    created_at: FIXED_NOW - 1000,
    ...overrides,
  }
  store._seedDish(doc)
  return doc
}

function seedOrder(store, mealId, openid, dishes, overrides = {}) {
  store._seedOrder({
    _id: `${mealId}:${openid}`,
    meal_id: mealId,
    family_id: 'fam-main',
    user_openid: openid,
    user_nickname: overrides.nickname || (openid === 'openid-mama' ? '妈妈' : '爸爸'),
    dishes,
    note: '',
    created_at: FIXED_NOW - 1000,
    ...overrides,
  })
}

// ── 内存双胞胎条件更新契约先行: claimPrepared 必须忠实复刻「仅 closed → prepared」──
test('store 契约: claimPrepared 条件更新 —— 仅当存在 ∧ closed 才 updated:1(带 prepared_by/prepared_at), 其余 stale 且不覆盖', async () => {
  const store = createMemStore()
  seedFamily(store)
  const mealId = `fam-main:${TODAY}:breakfast`
  const base = {
    _id: mealId, family_id: 'fam-main', date: TODAY, slot: 'breakfast',
    status: 'closed', initiated_by: 'openid-mama', deadline: FIXED_NOW - 1000,
    closed_at: FIXED_NOW - 2000, created_at: FIXED_NOW - 1000, summary: null,
  }
  store._seedMeal(base)

  assert.deepEqual(await store.claimPrepared('fam-nope', 'openid-mama', FIXED_NOW), { updated: 0 }, '不存在 → 0')
  store._seedMeal({ ...base, _id: `fam-main:${TODAY}:lunch`, date: TODAY, slot: 'lunch', status: 'ongoing' })
  assert.deepEqual(await store.claimPrepared(`fam-main:${TODAY}:lunch`, 'openid-mama', FIXED_NOW), { updated: 0 }, 'ongoing → 0')
  assert.equal((await store.getMeal(`fam-main:${TODAY}:lunch`)).status, 'ongoing', 'ongoing 不翻转')

  assert.deepEqual(await store.claimPrepared(mealId, 'openid-mama', FIXED_NOW), { updated: 1 })
  const fresh = await store.getMeal(mealId)
  assert.equal(fresh.status, 'prepared')
  assert.equal(fresh.prepared_by, 'openid-mama')
  assert.equal(fresh.prepared_at, FIXED_NOW)
  assert.equal(fresh.closed_at, FIXED_NOW - 2000, 'patch 不改未涉及字段')

  // 不可撤销: prepared 再抢占恒 stale, 先手记账不被覆盖
  assert.deepEqual(await store.claimPrepared(mealId, 'openid-baba', FIXED_NOW + 1000), { updated: 0 })
  const after = await store.getMeal(mealId)
  assert.equal(after.prepared_by, 'openid-mama', '后到者不覆盖先手')
  assert.equal(after.prepared_at, FIXED_NOW)
  await store.updateMeal(mealId, { status: 'closed' })
  const re = await store.claimPrepared(mealId, 'openid-baba', FIXED_NOW + 1000)
  assert.deepEqual(re, { updated: 1 }, '状态被外力改回 closed 后 claim 恢复可抢(与生产条件更新一致)')
  assert.equal((await store.getMeal(mealId)).prepared_by, 'openid-baba')
})

// ── markPrepared: 主路径 ──
test('markPrepared: closed → prepared —— 落库 prepared_by/prepared_at, 视图只读 + live 读快照, 成员皆可标记', async () => {
  const { store } = make()
  seedFamily(store)
  const soon = FIXED_NOW + 500
  seedMealDue(store, soon)
  seedDish(store)
  seedDish(store, { _id: 'dish-gone', name: '软删老菜', ingredients: [{ name: '黄瓜', amount: '1 根' }], is_deleted: true })
  const mealId = `fam-main:${TODAY}:breakfast`
  seedOrder(store, mealId, 'openid-mama', [{ dish_id: 'dish-tomato', name: '番茄炒蛋', quantity: 2 }], { nickname: '妈妈' })
  seedOrder(store, mealId, 'openid-baba', [{ dish_id: 'dish-gone', name: '软删老菜', quantity: 1 }], { nickname: '爸爸' })
  const engine = createMealEngine(store, { now: () => soon })
  // 先手: 时间推进到截止后, cron/写守卫代截止并物化快照
  await engine.scanDue()
  const snapshot = (await store.getMeal(mealId)).summary

  const view = await engine.markPrepared(mealId, 'openid-baba')

  assert.equal(view.meal.status, 'prepared')
  assert.equal(view.meal.prepared_by, 'openid-baba')
  assert.equal(view.meal.prepared_at, soon)
  assert.equal(view.canOrder, false)
  assert.equal(view.live, snapshot, 'live 直传物化快照对象')
  assert.deepEqual(view.live.byDish, [
    {
      dishId: 'dish-tomato', dishName: '番茄炒蛋', totalQuantity: 2,
      orderedBy: [{ openid: 'openid-mama', nickname: '妈妈', quantity: 2 }], removed: false,
    },
    {
      dishId: 'dish-gone', dishName: '软删老菜', totalQuantity: 1,
      orderedBy: [{ openid: 'openid-baba', nickname: '爸爸', quantity: 1 }], removed: true,
    },
  ], '按菜视图: 谁点了/共几份/软删菜 removed 标注')
  assert.deepEqual(view.live.ingredients, [
    { name: '鸡蛋', amountText: '2 个 ×2', dishCount: 1 },
    { name: '西红柿', amountText: '2 个 ×2', dishCount: 1 },
    { name: '黄瓜', amountText: '1 根', dishCount: 1 },
  ], '按食材视图: 精确去重合并')

  const doc = await store.getMeal(mealId)
  assert.equal(doc.status, 'prepared')
  assert.equal(doc.prepared_by, 'openid-baba')
  assert.equal(doc.prepared_at, soon)
  assert.deepEqual(doc.summary, snapshot, '快照不被重写')
})

function seedMealDue(store, soon, overrides = {}) {
  store._seedMeal({
    _id: `fam-main:${TODAY}:breakfast`,
    family_id: 'fam-main', date: TODAY, slot: 'breakfast',
    status: 'ongoing', initiated_by: 'openid-mama', deadline: soon,
    created_at: FIXED_NOW - 1000, summary: null,
    ...overrides,
  })
}

const BREAKFAST_ID = `fam-main:${TODAY}:breakfast`

// ── 不可撤销 ──
test('markPrepared: 不可撤销 —— 已 prepared 再标记/closeEarly → NOT_ONGOING, 写命令 → MEAL_LOCKED, 记账零篡改', async () => {
  const { store, engine } = make()
  seedFamily(store)
  const soon = FIXED_NOW + 500
  seedMealDue(store, soon)
  seedDish(store)
  const engineClock = makeClock(soon)
  const eng = createMealEngine(store, engineClock)
  await eng.scanDue()
  await eng.markPrepared(BREAKFAST_ID, 'openid-mama')
  const before = await store.getMeal(BREAKFAST_ID)

  await assert.rejects(
    () => eng.markPrepared(BREAKFAST_ID, 'openid-baba'),
    (err) => err.code === 'NOT_ONGOING', '已备餐再标 → NOT_ONGOING'
  )
  await assert.rejects(
    () => eng.closeEarly(BREAKFAST_ID, 'openid-mama'),
    (err) => err.code === 'NOT_ONGOING', '已备餐不可重关'
  )
  await assert.rejects(
    () => eng.placeOrder(BREAKFAST_ID, 'openid-baba', { dishes: [{ dishId: 'dish-tomato', quantity: 1 }] }, { nickname: '爸爸' }),
    (err) => err.code === 'MEAL_LOCKED', '已备餐禁写'
  )
  await assert.rejects(
    () => eng.copyLastSelection(BREAKFAST_ID, 'openid-baba'),
    (err) => err.code === 'MEAL_LOCKED', '已备餐禁复制'
  )

  const after = await store.getMeal(BREAKFAST_ID)
  assert.equal(after.prepared_by, 'openid-mama', '先手记账不被篡改')
  assert.equal(after.prepared_at, before.prepared_at)
  assert.deepEqual(after.summary, before.summary)
})

// ── 非 closed 状态处理 ──
test('markPrepared: ongoing 且已过截止(未关) → NOT_ONGOING, 不代截止(无 PAST_CUTOFF 语义), 零写入', async () => {
  const { store } = make()
  seedFamily(store)
  const soon = FIXED_NOW + 500
  seedMealDue(store, soon)
  seedDish(store)
  const clock = makeClock(soon + HOUR)
  const engine = createMealEngine(store, clock)

  await assert.rejects(
    () => engine.markPrepared(BREAKFAST_ID, 'openid-mama'),
    (err) => err.code === 'NOT_ONGOING', '仅 closed 可标: 到点未关也拒绝'
  )
  const doc = await store.getMeal(BREAKFAST_ID)
  assert.equal(doc.status, 'ongoing', '备餐标记不参与截止裁决(close-if-due 只管写命令)')
  assert.equal(doc.summary, null, '不物化')
  assert.equal(doc.prepared_by, undefined)
})

test('markPrepared: ongoing(未到截止)/prepared → NOT_ONGOING, 零写入', async () => {
  const { store, engine } = make()
  seedFamily(store)
  seedDish(store)
  seedMealDue(store, FIXED_NOW + HOUR)

  await assert.rejects(
    () => engine.markPrepared(BREAKFAST_ID, 'openid-mama'),
    (err) => err.code === 'NOT_ONGOING'
  )
  await store.updateMeal(BREAKFAST_ID, {
    status: 'prepared', closed_at: FIXED_NOW - 1000,
    prepared_by: 'openid-baba', prepared_at: FIXED_NOW - 500, summary: null,
  })
  await assert.rejects(
    () => engine.markPrepared(BREAKFAST_ID, 'openid-baba'),
    (err) => err.code === 'NOT_ONGOING', '已备餐再标不可撤销'
  )
  const doc = await store.getMeal(BREAKFAST_ID)
  assert.equal(doc.prepared_by, 'openid-baba', '失败路径零写入')
})

// ── 家庭守卫 ──
test('markPrepared: 非成员 → NOT_MEMBER; 家庭冻结 → FAMILY_FROZEN; 不存在 → MEAL_NOT_FOUND', async () => {
  const { store, engine } = make()
  seedFamily(store)
  seedMealDue(store, FIXED_NOW - 100)

  await assert.rejects(
    () => engine.markPrepared(BREAKFAST_ID, 'openid-stranger'),
    (err) => err.code === 'NOT_MEMBER'
  )
  await assert.rejects(
    () => engine.markPrepared(`fam-main:${TODAY}:lunch`, 'openid-mama'),
    (err) => err.code === 'MEAL_NOT_FOUND'
  )
  await assert.rejects(
    () => engine.markPrepared(`fam-nope:${TODAY}:lunch`, 'openid-mama'),
    (err) => err.code === 'MEAL_NOT_FOUND', '餐次不存在优先于家庭判定(openMeal 先查餐次)'
  )
  assert.equal((await store.getMeal(BREAKFAST_ID)).status, 'ongoing', '失败不产生写入')

  const frozenStore = createMemStore()
  seedFamily(frozenStore, { status: 'frozen' })
  seedMealDue(frozenStore, FIXED_NOW - 100)
  const frozenEngine = createMealEngine(frozenStore, { now: () => FIXED_NOW })
  await assert.rejects(
    () => frozenEngine.markPrepared(BREAKFAST_ID, 'openid-mama'),
    (err) => err.code === 'FAMILY_FROZEN'
  )
})

// ── 并发双标: claimPrepared 是胜负唯一裁决点 ──
test('markPrepared: 抢占输家(读 closed 后 claim 输) → NOT_ONGOING, 零写入', async () => {
  const store = createMemStore()
  seedFamily(store)
  seedMealDue(store, FIXED_NOW - 100, { status: 'closed', closed_at: FIXED_NOW - 100 })
  // 包装 store: 本路径 claim 恒报输(模拟他人先手抢走裁决), 不产生副作用
  const losingStore = {
    ...store,
    claimPrepared: async () => ({ updated: 0 }),
  }
  const engine = createMealEngine(losingStore, { now: () => FIXED_NOW })

  await assert.rejects(
    () => engine.markPrepared(BREAKFAST_ID, 'openid-mama'),
    (err) => err.code === 'NOT_ONGOING'
  )
  const doc = await store.getMeal(BREAKFAST_ID)
  assert.equal(doc.status, 'closed', '输家不翻转状态')
  assert.equal(doc.prepared_by, undefined, '输家零写入')
})

test('markPrepared: 先手已标记, 后到读判拒 → NOT_ONGOING, 先手记账原样', async () => {
  const { store, engine } = make()
  seedFamily(store)
  seedMealDue(store, FIXED_NOW - 100)
  seedDish(store)
  await engine.scanDue() // 代截止 → closed 且有快照

  await engine.markPrepared(BREAKFAST_ID, 'openid-baba')
  await assert.rejects(
    () => engine.markPrepared(BREAKFAST_ID, 'openid-mama'),
    (err) => err.code === 'NOT_ONGOING'
  )
  assert.equal((await store.getMeal(BREAKFAST_ID)).prepared_by, 'openid-baba')
})

// ── summary 缺失容错(T8 崩溃窗口): 后端零改动, 视图透传 null 供前端空态 ──
test('summary 缺失容错: closed/prepared 且 summary=null → viewMeal.live === null(前端显式空态的依据)', async () => {
  const { store, engine } = make()
  seedFamily(store)
  seedDish(store)
  seedMealDue(store, FIXED_NOW - 100)
  await store.updateMeal(BREAKFAST_ID, { status: 'closed', closed_at: FIXED_NOW - 100 })

  const closed = await engine.viewMeal(BREAKFAST_ID, 'openid-baba')
  assert.equal(closed.meal.status, 'closed')
  assert.equal(closed.live, null, '崩溃窗口下 summary 缺失 → null(空清单 + 显式空态提示, 前端负责)')

  await store.updateMeal(BREAKFAST_ID, { status: 'prepared', prepared_by: 'openid-baba', prepared_at: FIXED_NOW })
  const prepared = await engine.viewMeal(BREAKFAST_ID, 'openid-mama')
  assert.equal(prepared.meal.status, 'prepared')
  assert.equal(prepared.live, null)
})

// ── 历史只读 + live 与快照切换 ──
test('历史只读: 昨日 prepared 餐次 viewMeal 零副作用(文档逐字段不变), live 恒读快照', async () => {
  const { store, engine } = make()
  seedFamily(store)
  seedDish(store)
  const mealId = `fam-main:${YESTERDAY}:dinner`
  const snapshot = {
    byDish: [{
      dishId: 'dish-tomato', dishName: '番茄炒蛋', totalQuantity: 2,
      orderedBy: [{ openid: 'openid-mama', nickname: '妈妈', quantity: 2 }], removed: false,
    }],
    ingredients: [{ name: '鸡蛋', amountText: '2 个 ×2', dishCount: 1 }, { name: '西红柿', amountText: '2 个 ×2', dishCount: 1 }],
    generatedAt: FIXED_NOW - 2000,
  }
  store._seedMeal({
    _id: mealId, family_id: 'fam-main', date: YESTERDAY, slot: 'dinner',
    status: 'prepared', initiated_by: 'openid-mama', deadline: FIXED_NOW - 10 * HOUR,
    closed_at: FIXED_NOW - 2000, prepared_by: 'openid-baba', prepared_at: FIXED_NOW - 1000,
    created_at: FIXED_NOW - 12 * HOUR, summary: snapshot,
  })
  const before = JSON.stringify(await store.getMeal(mealId))

  const view = await engine.viewMeal(mealId, 'openid-baba')
  assert.equal(view.meal.status, 'prepared')
  assert.equal(view.meal.prepared_by, 'openid-baba')
  assert.equal(view.meal.prepared_at, FIXED_NOW - 1000)
  assert.deepEqual(view.live, snapshot, '历史快照恒读')

  await store.updateDish('dish-tomato', { name: '番茄炒蛋(改名后)' })
  const after = await engine.viewMeal(mealId, 'openid-mama')
  assert.deepEqual(after.live, snapshot, '物化即冻结: 菜品改名不影响历史快照')
  assert.equal(JSON.stringify(await store.getMeal(mealId)), before, 'viewMeal 永不产生副作用')
})

test('live 与快照切换: ongoing 实时实算(summary 未物化), closed/prepared 读快照, 同餐同一数据源', async () => {
  const { store } = make()
  seedFamily(store)
  const soon = FIXED_NOW + 500
  seedMealDue(store, soon)
  seedDish(store)
  seedOrder(store, BREAKFAST_ID, 'openid-mama', [{ dish_id: 'dish-tomato', name: '番茄炒蛋', quantity: 1 }], { nickname: '妈妈' })
  const clock = makeClock(FIXED_NOW)
  const engine = createMealEngine(store, clock)

  const ongoing = await engine.viewMeal(BREAKFAST_ID, 'openid-mama')
  assert.equal(ongoing.meal.status, 'ongoing')
  assert.equal((await store.getMeal(BREAKFAST_ID)).summary, null, '实时预览只算不物化')
  assert.deepEqual(ongoing.live, {
    byDish: [{
      dishId: 'dish-tomato', dishName: '番茄炒蛋', totalQuantity: 1,
      orderedBy: [{ openid: 'openid-mama', nickname: '妈妈', quantity: 1 }], removed: false,
    }],
    ingredients: [{ name: '鸡蛋', amountText: '2 个', dishCount: 1 }, { name: '西红柿', amountText: '2 个', dishCount: 1 }],
    generatedAt: FIXED_NOW,
  })

  clock.set(soon)
  await engine.scanDue()
  const snapshot = (await store.getMeal(BREAKFAST_ID)).summary
  const closed = await engine.viewMeal(BREAKFAST_ID, 'openid-baba')
  assert.deepEqual(closed.live, snapshot, 'closed 读快照')
  assert.notEqual(closed.live, ongoing.live)

  clock.set(soon + 1000)
  await engine.markPrepared(BREAKFAST_ID, 'openid-mama')
  const prepared = await engine.viewMeal(BREAKFAST_ID, 'openid-baba')
  assert.equal(prepared.meal.status, 'prepared')
  assert.deepEqual(prepared.live, snapshot, 'prepared 继续读同一快照(与 live 切换同源)')
})

// ── 备餐页数据源契约: 按 (date, slot) 三连先读后发, 引擎侧不发明「按日列表」──
test('备餐页数据源: 同日三餐各自独立 viewMeal —— 存在者返回视图, 缺失者 MEAL_NOT_FOUND, 单餐次互不影响', async () => {
  const { store, engine } = make()
  seedFamily(store)
  seedDish(store)
  store._seedMeal({
    _id: `fam-main:${TODAY}:breakfast`, family_id: 'fam-main', date: TODAY, slot: 'breakfast',
    status: 'ongoing', initiated_by: 'openid-mama', deadline: FIXED_NOW + HOUR,
    created_at: FIXED_NOW - 1000, summary: null,
  })
  store._seedMeal({
    _id: `fam-main:${TODAY}:dinner`, family_id: 'fam-main', date: TODAY, slot: 'dinner',
    status: 'closed', initiated_by: 'openid-mama', deadline: FIXED_NOW - 1000,
    closed_at: FIXED_NOW - 500, created_at: FIXED_NOW - 1000, summary: {
      byDish: [], ingredients: [], generatedAt: FIXED_NOW - 500,
    },
  })

  const breakfast = await engine.viewMeal(`fam-main:${TODAY}:breakfast`, 'openid-baba')
  assert.equal(breakfast.meal.status, 'ongoing')
  const dinner = await engine.viewMeal(`fam-main:${TODAY}:dinner`, 'openid-baba')
  assert.equal(dinner.meal.status, 'closed')
  await assert.rejects(
    () => engine.viewMeal(`fam-main:${TODAY}:lunch`, 'openid-baba'),
    (err) => err.code === 'MEAL_NOT_FOUND', '无餐次 → MEAL_NOT_FOUND, 页面据此不渲染卡片'
  )
})