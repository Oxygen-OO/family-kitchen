'use strict'

const { test } = require('node:test')
const assert = require('node:assert/strict')

const { createMemStore } = require('./mem-store.js')
const { createMealEngine } = require('../lib/meal-engine/index.js')

// T8 截止管线: close-if-due 前置守卫、手动提前截止、cron 扫描、claimClose 原子抢占幂等、物化。
// 断言只跨外部 seam(错误码/视图/快照/claim 计数), 固定时钟写时序剧本。
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

// ── 内存双胞胎条件更新契约先行: claimClose 必须有「stale 返回 false」的忠实语义 ──
test('store 契约: claimClose 条件更新 —— 仅当存在 ∧ ongoing ∧(可选 deadline<=now) 才 updated:1, 重复抢占 stale', async () => {
  const store = createMemStore()
  seedFamily(store)
  const mealId = `fam-main:${TODAY}:breakfast`
  const soon = FIXED_NOW + 500
  seedMeal(store, { deadline: soon })

  assert.deepEqual(await store.claimClose('fam-nope', { now: soon, requireDue: true }), { updated: 0 }, '不存在 → 0')
  assert.deepEqual(
    await store.claimClose(mealId, { now: soon - 1, requireDue: true }),
    { updated: 0 }, '未到期(requireDue) → 0'
  )
  assert.deepEqual(await store.claimClose(mealId, { now: soon, requireDue: true }), { updated: 1 }, '到期 ongoing → 1')
  assert.deepEqual(await store.claimClose(mealId, { now: soon + 1000, requireDue: true }), { updated: 0 }, '已 closed(stale) → 0')

  const closed = await store.getMeal(mealId)
  assert.equal(closed.status, 'closed')
  assert.equal(closed.closed_at, soon)
  assert.equal(closed.summary, null, 'claimClose 只翻转状态, 物化由管线负责')
})

test('store 契约: claimClose requireDue=false(手动提前) 不受 deadline 约束, 同一裁决点互斥', async () => {
  const store = createMemStore()
  seedFamily(store)
  const mealId = `fam-main:${TODAY}:breakfast`
  seedMeal(store, { deadline: FIXED_NOW + 10 * HOUR })

  assert.deepEqual(await store.claimClose(mealId, { now: FIXED_NOW, requireDue: false }), { updated: 1 }, '未到期手动抢占成功')
  assert.deepEqual(await store.claimClose(mealId, { now: FIXED_NOW, requireDue: false }), { updated: 0 }, '第二次即刻 stale')
  // status 是裁决唯一条件: 引擎命令集无 reopen, 若数据被外力改回 ongoing 则 claim 恢复可抢(与生产条件更新一致)
  await store.updateMeal(mealId, { status: 'ongoing' })
  assert.deepEqual(await store.claimClose(mealId, { now: FIXED_NOW, requireDue: false }), { updated: 1 })
})

test('store 契约: findDueMeals 只扫 ongoing ∧ deadline<=now; updateMeal 未命中抛 NOT_FOUND', async () => {
  const store = createMemStore()
  seedFamily(store)
  const soon = FIXED_NOW + 500
  seedMeal(store, { deadline: soon }) // breakfast 到期
  store.createMeal({
    _id: `fam-main:${TODAY}:lunch`, family_id: 'fam-main', date: TODAY, slot: 'lunch',
    status: 'ongoing', initiated_by: 'openid-mama', deadline: FIXED_NOW + HOUR,
    created_at: FIXED_NOW - 1000, summary: null,
  })
  store.createMeal({
    _id: `fam-main:${TODAY}:dinner`, family_id: 'fam-main', date: TODAY, slot: 'dinner',
    status: 'closed', initiated_by: 'openid-mama', deadline: soon, closed_at: soon,
    created_at: FIXED_NOW - 1000, summary: null,
  })

  const due = await store.findDueMeals(soon)
  assert.deepEqual(due.map((m) => m._id), [`fam-main:${TODAY}:breakfast`], '只含到期且 ongoing')

  await assert.rejects(
    () => store.updateMeal('fam-nope', { summary: {} }),
    (err) => err.code === 'NOT_FOUND'
  )
  const patched = await store.updateMeal(`fam-main:${TODAY}:breakfast`, { closed_at: soon })
  assert.equal(patched.closed_at, soon)
  assert.equal(patched.status, 'ongoing', 'patch 不改未涉及字段')
})

// ── close-if-due 前置守卫 ──
test('close-if-due: 未到期写命令不触发关闭, 正常下单', async () => {
  const { store, engine } = make()
  seedFamily(store)
  seedMeal(store, { deadline: FIXED_NOW + HOUR })
  seedDish(store)

  const view = await engine.placeOrder(
    `fam-main:${TODAY}:breakfast`, 'openid-baba',
    { dishes: [{ dishId: 'dish-tomato', quantity: 2 }] },
    { nickname: '爸爸', now: FIXED_NOW + 30 * 60_000 }
  )

  assert.equal(view.canOrder, true)
  const doc = await store.getMeal(`fam-main:${TODAY}:breakfast`)
  assert.equal(doc.status, 'ongoing', '未到期不代截止')
  assert.equal(doc.summary, null)
  assert.equal(doc.closed_at, undefined)
})

test('close-if-due: 到点瞬间写命令 → 先代截止(状态+物化) 再拒绝 PAST_CUTOFF, 本次命令零写入', async () => {
  const { store, engine } = make()
  seedFamily(store)
  const soon = FIXED_NOW + 500
  seedMeal(store, { deadline: soon })
  seedDish(store)
  seedOrder(store, `fam-main:${TODAY}:breakfast`, 'openid-mama', [{ dish_id: 'dish-tomato', name: '番茄炒蛋', quantity: 1 }])

  await assert.rejects(
    () => engine.placeOrder(
      `fam-main:${TODAY}:breakfast`, 'openid-baba',
      { dishes: [{ dishId: 'dish-tomato', quantity: 3 }] },
      { nickname: '爸爸', now: soon }
    ),
    (err) => err.code === 'PAST_CUTOFF'
  )

  const doc = await store.getMeal(`fam-main:${TODAY}:breakfast`)
  assert.equal(doc.status, 'closed', '代截止已铺开')
  assert.equal(doc.closed_at, soon)
  assert.deepEqual(doc.summary.byDish, [{
    dishId: 'dish-tomato', dishName: '番茄炒蛋', totalQuantity: 1,
    orderedBy: [{ openid: 'openid-mama', nickname: '妈妈', quantity: 1 }], removed: false,
  }], '物化含代截止前的全量订单')
  assert.equal(doc.summary.generatedAt, soon)
  assert.equal(await store.getOrder(`fam-main:${TODAY}:breakfast`, 'openid-baba'), null, '被拒命令不产生订单')
})

test('close-if-due: 边界 —— deadline-1 可写, deadline 整点截断(含等号)', async () => {
  const { store, engine } = make()
  seedFamily(store)
  const soon = FIXED_NOW + 1000
  seedMeal(store, { deadline: soon })
  seedDish(store)

  await engine.placeOrder(
    `fam-main:${TODAY}:breakfast`, 'openid-baba',
    { dishes: [{ dishId: 'dish-tomato', quantity: 1 }] },
    { nickname: '爸爸', now: soon - 1 }
  )
  assert.equal((await store.getMeal(`fam-main:${TODAY}:breakfast`)).status, 'ongoing')

  await assert.rejects(
    () => engine.placeOrder(
      `fam-main:${TODAY}:breakfast`, 'openid-mama',
      { dishes: [{ dishId: 'dish-tomato', quantity: 1 }] },
      { nickname: '妈妈', now: soon }
    ),
    (err) => err.code === 'PAST_CUTOFF'
  )
  assert.equal((await store.getMeal(`fam-main:${TODAY}:breakfast`)).status, 'closed')
})

test('close-if-due: 抢占输家(他人已代截止) → 本次命令落 MEAL_LOCKED, 不二次物化', async () => {
  const { store, engine } = make()
  seedFamily(store)
  const soon = FIXED_NOW + 500
  seedMeal(store, { deadline: soon })
  seedDish(store)
  seedOrder(store, `fam-main:${TODAY}:breakfast`, 'openid-mama', [{ dish_id: 'dish-tomato', name: '番茄炒蛋', quantity: 1 }])

  // 模拟并发 cron/他人先手 claim(条件更新先赢), 且尚未物化
  assert.deepEqual(await store.claimClose(`fam-main:${TODAY}:breakfast`, { now: soon, requireDue: true }), { updated: 1 })

  await assert.rejects(
    () => engine.placeOrder(
      `fam-main:${TODAY}:breakfast`, 'openid-baba',
      { dishes: [{ dishId: 'dish-tomato', quantity: 2 }] },
      { nickname: '爸爸', now: soon + 1 }
    ),
    (err) => err.code === 'MEAL_LOCKED', '输家不落 PAST_CUTOFF(代截止者才落), 按真实状态落 MEAL_LOCKED'
  )

  const doc = await store.getMeal(`fam-main:${TODAY}:breakfast`)
  assert.equal(doc.summary, null, '输家跳过物化(claim 计数未增)')
})

// ── scanDue: cron 扫描 ──
test('scanDue: 到期全关并物化, 未到期/已 closed 不动, 返回 {closed, skipped}', async () => {
  const store = createMemStore()
  seedFamily(store)
  const soon = FIXED_NOW + 500
  seedMeal(store, { deadline: soon })
  store.createMeal({
    _id: `fam-main:${TODAY}:lunch`, family_id: 'fam-main', date: TODAY, slot: 'lunch',
    status: 'ongoing', initiated_by: 'openid-mama', deadline: FIXED_NOW + HOUR,
    created_at: FIXED_NOW - 1000, summary: null,
  })
  seedDish(store)
  seedOrder(store, `fam-main:${TODAY}:breakfast`, 'openid-mama', [{ dish_id: 'dish-tomato', name: '番茄炒蛋', quantity: 2 }])

  const engine = createMealEngine(store, { now: () => soon })
  const result = await engine.scanDue()

  assert.deepEqual(result, { closed: 1, skipped: 0 })
  const closed = await store.getMeal(`fam-main:${TODAY}:breakfast`)
  assert.equal(closed.status, 'closed')
  assert.deepEqual(closed.summary.byDish[0], {
    dishId: 'dish-tomato', dishName: '番茄炒蛋', totalQuantity: 2,
    orderedBy: [{ openid: 'openid-mama', nickname: '妈妈', quantity: 2 }], removed: false,
  })
  assert.equal(closed.summary.generatedAt, soon)
  assert.equal((await store.getMeal(`fam-main:${TODAY}:lunch`)).status, 'ongoing', '未到期不动')
  assert.equal((await store.getMeal(`fam-main:${TODAY}:lunch`)).summary, null)
})

test('scanDue: 幂等 —— 同餐次扫两次, 第二次 {closed:0, skipped:0}, 不二次物化(快照原样)', async () => {
  const { store } = make()
  seedFamily(store)
  const soon = FIXED_NOW + 500
  seedMeal(store, { deadline: soon })
  seedDish(store)
  seedOrder(store, `fam-main:${TODAY}:breakfast`, 'openid-mama', [{ dish_id: 'dish-tomato', name: '番茄炒蛋', quantity: 1 }])
  const engine = createMealEngine(store, { now: () => soon })

  const first = await engine.scanDue()
  const firstSummary = (await store.getMeal(`fam-main:${TODAY}:breakfast`)).summary
  const second = await engine.scanDue()
  const secondSummary = (await store.getMeal(`fam-main:${TODAY}:breakfast`)).summary

  assert.deepEqual(first, { closed: 1, skipped: 0 })
  assert.deepEqual(second, { closed: 0, skipped: 0 })
  assert.deepEqual(secondSummary, firstSummary, '快照对象不被重写')
})

test('scanDue: 手动提前截止后扫描补刀为空 —— 竞态只有一方执行管线', async () => {
  const { store } = make()
  seedFamily(store)
  const far = FIXED_NOW + 10 * HOUR
  seedMeal(store, { deadline: far })
  seedDish(store)
  seedOrder(store, `fam-main:${TODAY}:breakfast`, 'openid-mama', [{ dish_id: 'dish-tomato', name: '番茄炒蛋', quantity: 1 }])
  const clock = makeClock(FIXED_NOW)
  const engine = createMealEngine(store, clock)

  // 手动先关(未到期, requireDue=false 抢占成功)
  await engine.closeEarly(`fam-main:${TODAY}:breakfast`, 'openid-mama')

  clock.set(far + 1)
  const result = await engine.scanDue()
  assert.deepEqual(result, { closed: 0, skipped: 0 }, '已 closed 不在扫描集内, 无二次物化')
  assert.equal((await store.getMeal(`fam-main:${TODAY}:breakfast`)).summary.generatedAt, FIXED_NOW, '物化时间仍为手动关的那一刻')
})

test('scanDue: claim 输家 —— 计数 skipped, 不物化(claim 是胜负唯一裁决)', async () => {
  const store = createMemStore()
  seedFamily(store)
  const soon = FIXED_NOW + 500
  seedMeal(store, { deadline: soon })
  seedDish(store)
  seedOrder(store, `fam-main:${TODAY}:breakfast`, 'openid-mama', [{ dish_id: 'dish-tomato', name: '番茄炒蛋', quantity: 1 }])

  // 包装 store: 让真实 claim 发生(先手赢), 但本路径报告 updated:0 → 本路径为输家
  const losingStore = {
    ...store,
    claimClose: async (mealId, opts) => {
      await store.claimClose(mealId, opts)
      return { updated: 0 }
    },
  }
  const engine = createMealEngine(losingStore, { now: () => soon })

  const result = await engine.scanDue()
  assert.deepEqual(result, { closed: 0, skipped: 1 })
  const doc = await store.getMeal(`fam-main:${TODAY}:breakfast`)
  assert.equal(doc.status, 'closed', '先手 claim 生效')
  assert.equal(doc.summary, null, '输家不执行物化')
})

test('scanDue: 无参调用(不依赖 openid/入参), 并发双触发仅一方物化', async () => {
  const store = createMemStore()
  seedFamily(store)
  const soon = FIXED_NOW + 500
  seedMeal(store, { deadline: soon })
  seedDish(store)
  seedOrder(store, `fam-main:${TODAY}:breakfast`, 'openid-mama', [{ dish_id: 'dish-tomato', name: '番茄炒蛋', quantity: 1 }])
  const engine = createMealEngine(store, { now: () => soon })

  // 双触发顺序执行: 首个赢, 次个 {0,0}(扫描集已空) —— 串联即并发裁决的等价物
  assert.deepEqual(await engine.scanDue(), { closed: 1, skipped: 0 })
  assert.deepEqual(await engine.scanDue(), { closed: 0, skipped: 0 })
})

// ── closeEarly 手动提前截止 ──
test('closeEarly: 未到期手动截止 —— 与自动同一管线, 物化逐字段断言, 视图只读', async () => {
  const { store } = make()
  seedFamily(store)
  const far = FIXED_NOW + 10 * HOUR
  seedMeal(store, { deadline: far })
  seedDish(store)
  seedDish(store, {
    _id: 'dish-egg', name: '韭菜炒蛋',
    ingredients: [{ name: '鸡蛋', amount: '2 个' }, { name: '韭菜', amount: '1 把' }],
  })
  seedDish(store, { _id: 'dish-gone', name: '软删老菜', ingredients: [{ name: '黄瓜', amount: '1 根' }], is_deleted: true })
  const mealId = `fam-main:${TODAY}:breakfast`
  seedOrder(store, mealId, 'openid-mama', [
    { dish_id: 'dish-tomato', name: '番茄炒蛋', quantity: 2 },
  ], { nickname: '妈妈' })
  seedOrder(store, mealId, 'openid-baba', [
    { dish_id: 'dish-egg', name: '韭菜炒蛋', quantity: 1 },
    { dish_id: 'dish-gone', name: '软删老菜', quantity: 2 },
  ], { nickname: '爸爸' })
  const engine = createMealEngine(store, { now: () => FIXED_NOW })

  const view = await engine.closeEarly(mealId, 'openid-mama')

  const doc = await store.getMeal(mealId)
  assert.equal(doc.status, 'closed')
  assert.equal(doc.closed_at, FIXED_NOW)
  assert.deepEqual(doc.summary, {
    byDish: [
      {
        dishId: 'dish-tomato', dishName: '番茄炒蛋', totalQuantity: 2,
        orderedBy: [{ openid: 'openid-mama', nickname: '妈妈', quantity: 2 }], removed: false,
      },
      {
        dishId: 'dish-egg', dishName: '韭菜炒蛋', totalQuantity: 1,
        orderedBy: [{ openid: 'openid-baba', nickname: '爸爸', quantity: 1 }], removed: false,
      },
      {
        dishId: 'dish-gone', dishName: '软删老菜', totalQuantity: 2,
        orderedBy: [{ openid: 'openid-baba', nickname: '爸爸', quantity: 2 }], removed: true,
      },
    ],
    ingredients: [
      { name: '鸡蛋', amountText: '2 个 ×2 + 2 个', dishCount: 2 },
      { name: '韭菜', amountText: '1 把', dishCount: 1 },
      { name: '黄瓜', amountText: '1 根 ×2', dishCount: 1 },
    ],
    generatedAt: FIXED_NOW,
  }, '物化快照逐字段: 按菜聚合/共享食材合并/软删回显 removed/昵称快照')
  assert.equal(view.meal.status, 'closed')
  assert.equal(view.canOrder, false)
  assert.deepEqual(view.live, doc.summary, '视图直接透传快照')
})

test('closeEarly: 已到期同样走管线(与 scanDue 撞车只有一个赢家)', async () => {
  const { store } = make()
  seedFamily(store)
  const soon = FIXED_NOW + 500
  seedMeal(store, { deadline: soon })
  seedDish(store)
  seedOrder(store, `fam-main:${TODAY}:breakfast`, 'openid-mama', [{ dish_id: 'dish-tomato', name: '番茄炒蛋', quantity: 1 }])
  const clock = makeClock(soon)
  const engine = createMealEngine(store, clock)

  await engine.closeEarly(`fam-main:${TODAY}:breakfast`, 'openid-baba')
  assert.equal((await store.getMeal(`fam-main:${TODAY}:breakfast`)).status, 'closed')

  clock.set(soon + HOUR)
  assert.deepEqual(await engine.scanDue(), { closed: 0, skipped: 0 }, 'cron 补刀空')
})

test('closeEarly: 非成员/冻结/不存在 → NOT_MEMBER / FAMILY_FROZEN / MEAL_NOT_FOUND, 不产生写入', async () => {
  const { store, engine } = make()
  seedFamily(store)
  seedMeal(store)
  seedDish(store)

  await assert.rejects(
    () => engine.closeEarly(`fam-main:${TODAY}:breakfast`, 'openid-stranger'),
    (err) => err.code === 'NOT_MEMBER'
  )
  await assert.rejects(
    () => engine.closeEarly(`fam-main:${TODAY}:lunch`, 'openid-mama'),
    (err) => err.code === 'MEAL_NOT_FOUND'
  )
  assert.equal((await store.getMeal(`fam-main:${TODAY}:breakfast`)).status, 'ongoing', '失败不产生写入')

  const frozenStore = createMemStore()
  seedFamily(frozenStore, { status: 'frozen' })
  seedMeal(frozenStore)
  seedDish(frozenStore)
  const frozenEngine = createMealEngine(frozenStore, { now: () => FIXED_NOW })
  await assert.rejects(
    () => frozenEngine.closeEarly(`fam-main:${TODAY}:breakfast`, 'openid-mama'),
    (err) => err.code === 'FAMILY_FROZEN'
  )
})

test('closeEarly: closed/prepared 状态不符 → NOT_ONGOING', async () => {
  const { store, engine } = make()
  seedFamily(store)
  seedDish(store)
  seedMeal(store, { status: 'closed', closed_at: FIXED_NOW - 1000 })
  await assert.rejects(
    () => engine.closeEarly(`fam-main:${TODAY}:breakfast`, 'openid-mama'),
    (err) => err.code === 'NOT_ONGOING'
  )
  await store.updateMeal(`fam-main:${TODAY}:breakfast`, {
    status: 'prepared', prepared_by: 'openid-baba', prepared_at: FIXED_NOW - 500,
  })
  await assert.rejects(
    () => engine.closeEarly(`fam-main:${TODAY}:breakfast`, 'openid-mama'),
    (err) => err.code === 'NOT_ONGOING'
  )
})

test('closeEarly: scan 先赢 → 手动触发按真实状态判定(已 closed → NOT_ONGOING 拒绝)', async () => {
  const { store } = make()
  seedFamily(store)
  const soon = FIXED_NOW + 500
  seedMeal(store, { deadline: soon })
  seedDish(store)
  seedOrder(store, `fam-main:${TODAY}:breakfast`, 'openid-mama', [{ dish_id: 'dish-tomato', name: '番茄炒蛋', quantity: 1 }])
  const engine = createMealEngine(store, { now: () => soon })

  assert.deepEqual(await engine.scanDue(), { closed: 1, skipped: 0 })
  await assert.rejects(
    () => engine.closeEarly(`fam-main:${TODAY}:breakfast`, 'openid-baba'),
    (err) => err.code === 'NOT_ONGOING', '竞态输家不重复关, 落 NOT_ONGOING'
  )
  assert.equal((await store.getMeal(`fam-main:${TODAY}:breakfast`)).summary.generatedAt, soon, '不二次物化')
})

test('closeEarly: 管线抢占输家(claim 被先手赢走) → 与直接关过的餐次同码 NOT_ONGOING, 不二次物化', async () => {
  const store = createMemStore()
  seedFamily(store)
  seedMeal(store, { deadline: FIXED_NOW + 10 * HOUR })
  seedDish(store)
  // 包装 store 模拟读后-抢占前的并发先手: 真实 claim 发生(先手赢), 本路径报告 updated:0
  const losingStore = {
    ...store,
    claimClose: async (mealId, opts) => {
      await store.claimClose(mealId, opts)
      return { updated: 0 }
    },
  }
  const engine = createMealEngine(losingStore, { now: () => FIXED_NOW })

  await assert.rejects(
    () => engine.closeEarly(`fam-main:${TODAY}:breakfast`, 'openid-mama'),
    (err) => err.code === 'NOT_ONGOING'
  )
  const doc = await store.getMeal(`fam-main:${TODAY}:breakfast`)
  assert.equal(doc.status, 'closed', '先手 claim 生效')
  assert.equal(doc.summary, null, '输家不物化')
})

test('closeIfDue: 写命令判定前被并发 closeEarly 抢先(未到期) → 守卫重读真实状态落 MEAL_LOCKED 而非放行', async () => {
  const { store, engine } = make()
  seedFamily(store)
  seedMeal(store, { deadline: FIXED_NOW + HOUR })
  seedDish(store)
  // 并发 closeEarly 在写命令守卫判定前关闭餐次(未到期抢占)
  await engine.closeEarly(`fam-main:${TODAY}:breakfast`, 'openid-mama')

  await assert.rejects(
    () => engine.placeOrder(
      `fam-main:${TODAY}:breakfast`, 'openid-baba',
      { dishes: [{ dishId: 'dish-tomato', quantity: 1 }] },
      { nickname: '爸爸', now: FIXED_NOW + 30 * 60_000 }
    ),
    (err) => err.code === 'MEAL_LOCKED', 'now<deadline 也按真实状态判定, 不得用陈旧 ongoing 放行'
  )
  assert.equal(await store.getOrder(`fam-main:${TODAY}:breakfast`, 'openid-baba'), null, '被拒命令不产生订单')
})

// ── 截止后的世界: 全锁只读 ──
test('截止后: 任意成员 viewMeal 只读(canOrder=false, live=快照), 所有写命令落锁', async () => {
  const { store } = make()
  seedFamily(store)
  const soon = FIXED_NOW + 500
  seedMeal(store, { deadline: soon })
  seedDish(store)
  seedOrder(store, `fam-main:${TODAY}:breakfast`, 'openid-mama', [{ dish_id: 'dish-tomato', name: '番茄炒蛋', quantity: 1 }])
  const clock = makeClock(soon)
  const engine = createMealEngine(store, clock)

  await engine.scanDue()

  const view = await engine.viewMeal(`fam-main:${TODAY}:breakfast`, 'openid-baba')
  assert.equal(view.canOrder, false)
  assert.equal(view.meal.status, 'closed')
  assert.deepEqual(view.live, (await store.getMeal(`fam-main:${TODAY}:breakfast`)).summary)

  clock.set(soon + HOUR)
  await assert.rejects(
    () => engine.placeOrder(
      `fam-main:${TODAY}:breakfast`, 'openid-baba',
      { dishes: [{ dishId: 'dish-tomato', quantity: 2 }] },
      { nickname: '爸爸' }
    ),
    (err) => err.code === 'MEAL_LOCKED'
  )
})

test('截止后快照固化: 菜品改名不影响 meals.summary(物化即冻结)', async () => {
  const { store } = make()
  seedFamily(store)
  const soon = FIXED_NOW + 500
  seedMeal(store, { deadline: soon })
  seedDish(store)
  seedOrder(store, `fam-main:${TODAY}:breakfast`, 'openid-mama', [{ dish_id: 'dish-tomato', name: '番茄炒蛋', quantity: 1 }], { nickname: '妈妈' })
  const engine = createMealEngine(store, { now: () => soon })

  await engine.scanDue()
  await store.updateDish('dish-tomato', { name: '番茄炒蛋(改名后)' })

  const doc = await store.getMeal(`fam-main:${TODAY}:breakfast`)
  assert.equal(doc.summary.byDish[0].dishName, '番茄炒蛋', 'summary 保持截止时快照名')
  assert.equal((await engine.viewMeal(`fam-main:${TODAY}:breakfast`, 'openid-mama')).live.byDish[0].dishName, '番茄炒蛋')
})