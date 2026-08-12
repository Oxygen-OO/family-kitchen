'use strict'

const { test } = require('node:test')
const assert = require('node:assert/strict')

const { createMemStore } = require('./mem-store.js')
const { createMealEngine } = require('../lib/meal-engine/index.js')
const { createSubscribeNotifier } = require('../lib/ports/notifier.js')

// T9 订阅授权记账 + 关闭管线消费: 授权折叠(每人每餐一条)、grant 消费 at-most-once、
// 消息内容组装。断言只跨外部 seam(视图 granted/订阅记录/发送序列/claim 计数), 固定时钟 + Spy。
const FIXED_NOW = (() => {
  const d = new Date()
  d.setHours(6, 0, 0, 0)
  return d.getTime()
})()

const HOUR = 3600_000

function localDateOf(ts) {
  const d = new Date(ts)
  const m = String(d.getMonth() + 1).padStart(2, '0')
  const day = String(d.getDate()).padStart(2, '0')
  return `${d.getFullYear()}-${m}-${day}`
}

const TODAY = localDateOf(FIXED_NOW)

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

function seedMeal(store, overrides = {}) {
  const doc = {
    _id: `fam-main:${TODAY}:breakfast`,
    family_id: 'fam-main',
    date: TODAY,
    slot: 'breakfast',
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

function seedDish(store) {
  store._seedDish({
    _id: 'dish-tomato',
    family_id: 'fam-main',
    name: '番茄炒蛋',
    ingredients: [{ name: '鸡蛋', amount: '2 个' }],
    is_available: true,
    is_deleted: false,
    created_by: 'openid-mama',
    created_at: FIXED_NOW - 1000,
  })
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

function seedSubscribe(store, openid, overrides = {}) {
  const mealId = `fam-main:${TODAY}:breakfast`
  store._seedSubscribe({
    _id: `${mealId}:${openid}`,
    meal_id: mealId,
    user_openid: openid,
    template_id: 'TPL-REAL',
    granted: true,
    granted_at: FIXED_NOW - 500,
    consumed: false,
    sent: false,
    ...overrides,
  })
}

// ── Spies ──
function makeSpyNotifier() {
  const sends = []
  return {
    sends,
    async send(payload) {
      sends.push(payload)
      return { ok: true }
    },
  }
}

// ── store 契约: 内存双胞胎必须忠实复刻生产条件更新语义 ──
test('store 契约: getSubscribe 未命中 null; addSubscribe 撞 _id 抛 DUPLICATE_KEY(fold 素材)', async () => {
  const store = createMemStore()
  assert.equal(await store.getSubscribe('m1', 'openid-mama'), null)

  const doc = {
    _id: 'm1:openid-mama',
    meal_id: 'm1',
    user_openid: 'openid-mama',
    template_id: 'TPL-X',
    granted: true,
    granted_at: FIXED_NOW,
    consumed: false,
    sent: false,
  }
  await store.addSubscribe(doc)
  assert.deepEqual((await store.getSubscribe('m1', 'openid-mama')).template_id, 'TPL-X')

  await assert.rejects(
    () => store.addSubscribe({ ...doc, template_id: 'TPL-Y' }),
    (err) => err.code === 'DUPLICATE_KEY',
    '同 _id 二次插入报重复 —— 引擎据此做原子授权折叠(不依赖读-写两步)'
  )
})

test('store 契约: claimGrant 条件更新 —— 仅当存在 ∧ consumed=false 才置 consumed+consumed_at', async () => {
  const store = createMemStore()
  seedSubscribe(store, 'openid-mama')

  assert.deepEqual(await store.claimGrant('m1', 'openid-mama', FIXED_NOW + 1), { updated: 0 }, '不存在的记录 → 0')
  assert.deepEqual(
    await store.claimGrant(`fam-main:${TODAY}:breakfast`, 'openid-mama', FIXED_NOW + 1),
    { updated: 1 }, '待发记录 → 抢占成功'
  )
  const doc = await store.getSubscribe(`fam-main:${TODAY}:breakfast`, 'openid-mama')
  assert.equal(doc.consumed, true)
  assert.equal(doc.consumed_at, FIXED_NOW + 1)
  assert.equal(doc.sent, false, 'claim 只标记 consumed, 发送成败由管线后续决定')

  assert.deepEqual(
    await store.claimGrant(`fam-main:${TODAY}:breakfast`, 'openid-mama', FIXED_NOW + 2),
    { updated: 0 }, '已 consumed(stale) 重复抢占 → 0 —— 双写窗口不存在的裁决依据'
  )
})

test('store 契约: updateSubscribe 未命中抛 NOT_FOUND; listSubscribes 按 granted/consumed 过滤且 granted_at 升序', async () => {
  const store = createMemStore()
  seedSubscribe(store, 'openid-mama', { template_id: 'TPL-1', granted_at: FIXED_NOW - 300 })
  seedSubscribe(store, 'openid-baba', { template_id: 'TPL-2', granted_at: FIXED_NOW - 100 })
  seedSubscribe(store, 'openid-kid', { granted: false, granted_at: FIXED_NOW - 200 })
  seedSubscribe(store, 'openid-gone', { consumed: true, granted_at: FIXED_NOW - 50 })

  await assert.rejects(
    () => store.updateSubscribe('m1', 'openid-mama', { sent: true, sent_at: FIXED_NOW }),
    (err) => err.code === 'NOT_FOUND'
  )

  const pending = await store.listSubscribes(`fam-main:${TODAY}:breakfast`, { granted: true, consumed: false })
  assert.deepEqual(
    pending.map((r) => r.user_openid),
    ['openid-mama', 'openid-baba'],
    '只含 granted=true ∧ consumed=false, 按 granted_at 升序(先授权先发)'
  )
  assert.deepEqual(
    (await store.listSubscribes(`fam-main:${TODAY}:breakfast`, { granted: false, consumed: false })).map((r) => r.user_openid),
    ['openid-kid']
  )
  assert.deepEqual(
    (await store.listSubscribes(`fam-main:${TODAY}:breakfast`, { granted: true, consumed: true })).map((r) => r.user_openid),
    ['openid-gone']
  )
})

test('store 契约: 授权折叠 —— 同 _id 撞键 insert 后旧记录原样(不覆盖 granted_at/不降级)', async () => {
  const store = createMemStore()
  seedSubscribe(store, 'openid-mama')
  const first = await store.getSubscribe(`fam-main:${TODAY}:breakfast`, 'openid-mama')

  await assert.rejects(
    () => store.addSubscribe({ ...first, granted: false, granted_at: FIXED_NOW }),
    (err) => err.code === 'DUPLICATE_KEY'
  )

  const after = await store.getSubscribe(`fam-main:${TODAY}:breakfast`, 'openid-mama')
  assert.equal(after.granted, true, '撞键即折叠: 已存在记录必须原样, 授权结果不降级')
  assert.equal(after.granted_at, FIXED_NOW - 500)
})

// ── 授权记账(折叠): 点餐提交 subscribed 落 subscribes 集合 ──
test('placeOrder: subscribed=true → 记录 granted:true 全字段落库(meal_id/user_openid/template_id/granted_at), view.granted=true', async () => {
  const { store, engine } = make()
  seedFamily(store)
  seedMeal(store)
  seedDish(store)
  const mealId = `fam-main:${TODAY}:breakfast`

  const view = await engine.placeOrder(
    mealId, 'openid-mama',
    { dishes: [{ dishId: 'dish-tomato', quantity: 2 }], subscribed: true },
    { nickname: '妈妈', now: FIXED_NOW, templateId: 'TPL-SRV' }
  )

  const sub = await store.getSubscribe(mealId, 'openid-mama')
  assert.deepEqual(sub, {
    _id: `${mealId}:openid-mama`,
    meal_id: mealId,
    user_openid: 'openid-mama',
    template_id: 'TPL-SRV',
    granted: true,
    granted_at: FIXED_NOW,
    consumed: false,
    sent: false,
  }, '授权记账全字段: 模板 ID 由服务端配置注入(不信任客户端), 待消费态')
  const order = await store.getOrder(mealId, 'openid-mama')
  assert.ok(order, '下单与记账同命令生效')
  assert.equal(view.granted, true, '视图透传「本餐已有授权记录」→ 前端据此不再弹窗')
})

test('授权折叠: 同一用户同餐次多次下单 subscribed=true → 只记一条, granted_at 不被刷新; view.granted 恒 true', async () => {
  const { store, engine } = make()
  seedFamily(store)
  seedMeal(store)
  seedDish(store)
  const mealId = `fam-main:${TODAY}:breakfast`

  await engine.placeOrder(
    mealId, 'openid-mama',
    { dishes: [{ dishId: 'dish-tomato', quantity: 1 }], subscribed: true },
    { nickname: '妈妈', now: FIXED_NOW, templateId: 'TPL-SRV' }
  )
  const first = await store.getSubscribe(mealId, 'openid-mama')

  const view = await engine.placeOrder(
    mealId, 'openid-mama',
    { dishes: [{ dishId: 'dish-tomato', quantity: 2 }], subscribed: true },
    { nickname: '妈妈', now: FIXED_NOW + 600_000, templateId: 'TPL-SRV' }
  )
  await assert.rejects(
    () => store.addSubscribe({ ...first }),
    (err) => err.code === 'DUPLICATE_KEY'
  )

  const after = await store.getSubscribe(mealId, 'openid-mama')
  assert.equal(after.granted_at, FIXED_NOW, '二次点餐不刷新授权时间(折叠不重复记账)')
  assert.equal(after.granted, true)
  assert.equal(view.granted, true)
})

test('授权折叠: 已授权记录不被后续 subscribed=false 降级(已存在则不再覆盖 granted 为 false)', async () => {
  const { store, engine } = make()
  seedFamily(store)
  seedMeal(store)
  seedDish(store)
  const mealId = `fam-main:${TODAY}:breakfast`

  await engine.placeOrder(
    mealId, 'openid-mama',
    { dishes: [{ dishId: 'dish-tomato', quantity: 1 }], subscribed: true },
    { nickname: '妈妈', now: FIXED_NOW, templateId: 'TPL-SRV' }
  )
  await engine.placeOrder(
    mealId, 'openid-mama',
    { dishes: [{ dishId: 'dish-tomato', quantity: 3 }], subscribed: false },
    { nickname: '妈妈', now: FIXED_NOW + 600_000, templateId: 'TPL-SRV' }
  )

  const sub = await store.getSubscribe(mealId, 'openid-mama')
  assert.equal(sub.granted, true, '后到的 subscribed=false 不得覆盖已授权记录')
  assert.equal(sub.granted_at, FIXED_NOW)
})

test('授权折叠: subscribed=false 且无记录 → 记 granted:false(拒绝结果落库), view.granted=true(不再打扰)', async () => {
  const { store, engine } = make()
  seedFamily(store)
  seedMeal(store)
  seedDish(store)
  const mealId = `fam-main:${TODAY}:breakfast`

  const view = await engine.placeOrder(
    mealId, 'openid-baba',
    { dishes: [{ dishId: 'dish-tomato', quantity: 1 }], subscribed: false },
    { nickname: '爸爸', now: FIXED_NOW, templateId: 'TPL-SRV' }
  )

  const sub = await store.getSubscribe(mealId, 'openid-baba')
  assert.equal(sub.granted, false, '拒绝也是一种授权结果(AC: granted: boolean), 落库供消费段过滤')
  assert.equal(sub.template_id, 'TPL-SRV')
  assert.equal(view.granted, true, '无论授权与否, 有记录即不再弹窗(只弹一次的后端支撑)')
})

test('授权折叠: 拒绝记录同样不可升级(granted:false 后到 subscribed=true 原样) —— 漏授权不再补发(ADR-0002)', async () => {
  const { store, engine } = make()
  seedFamily(store)
  seedMeal(store)
  seedDish(store)
  const mealId = `fam-main:${TODAY}:breakfast`

  await engine.placeOrder(
    mealId, 'openid-baba',
    { dishes: [{ dishId: 'dish-tomato', quantity: 1 }], subscribed: false },
    { nickname: '爸爸', now: FIXED_NOW, templateId: 'TPL-SRV' }
  )
  await engine.placeOrder(
    mealId, 'openid-baba',
    { dishes: [{ dishId: 'dish-tomato', quantity: 2 }], subscribed: true },
    { nickname: '爸爸', now: FIXED_NOW + 600_000, templateId: 'TPL-SRV' }
  )

  const sub = await store.getSubscribe(mealId, 'openid-baba')
  assert.equal(sub.granted, false, '折叠语义: 以先到者为准, 拒绝不因后来授权而反转')
  assert.equal(sub.granted_at, FIXED_NOW)
})

test('placeOrder: subscribed 缺省(T6 旧调用方/取消单) → 不产生任何订阅记录', async () => {
  const { store, engine } = make()
  seedFamily(store)
  seedMeal(store)
  seedDish(store)
  const mealId = `fam-main:${TODAY}:breakfast`

  await engine.placeOrder(
    mealId, 'openid-mama',
    { dishes: [{ dishId: 'dish-tomato', quantity: 1 }] },
    { nickname: '妈妈', now: FIXED_NOW, templateId: 'TPL-SRV' }
  )

  assert.equal(await store.getSubscribe(mealId, 'openid-mama'), null)
})

// ── 关闭管线消费: at-most-once 逐条 claimGrant → send → 成功才 sent ──
test('scanDue: 每人恰一条 —— 授权成员逐个发送, 内容含家庭名/餐次文案/已截止/清单摘要, 成功置 sent+时间戳', async () => {
  const store = createMemStore()
  seedFamily(store)
  const soon = FIXED_NOW + 500
  seedMeal(store, { deadline: soon })
  seedDish(store)
  seedOrder(store, `fam-main:${TODAY}:breakfast`, 'openid-mama', [{ dish_id: 'dish-tomato', name: '番茄炒蛋', quantity: 2 }], { nickname: '妈妈' })
  seedOrder(store, `fam-main:${TODAY}:breakfast`, 'openid-baba', [{ dish_id: 'dish-tomato', name: '番茄炒蛋', quantity: 1 }], { nickname: '爸爸' })
  // 先授权
  const mealId = `fam-main:${TODAY}:breakfast`
  const engine0 = createMealEngine(store, { now: () => FIXED_NOW - 10_000 })
  await engine0.placeOrder(mealId, 'openid-mama', { dishes: [{ dishId: 'dish-tomato', quantity: 2 }], subscribed: true }, { nickname: '妈妈', templateId: 'TPL-SRV' })
  await engine0.placeOrder(mealId, 'openid-baba', { dishes: [{ dishId: 'dish-tomato', quantity: 1 }], subscribed: true }, { nickname: '爸爸', templateId: 'TPL-SRV' })
  // 妈妈先授权 → 先发
  const spy = makeSpyNotifier()
  const engine = createMealEngine(store, { now: () => soon }, spy)

  const result = await engine.scanDue()

  assert.deepEqual(result, { closed: 1, skipped: 0 }, '消费不改变关闭账本语义')
  assert.equal(spy.sends.length, 2, '每人恰一条, 不重复')
  assert.deepEqual(
    spy.sends.map((s) => s.openid),
    ['openid-mama', 'openid-baba'],
    '按 granted_at 升序(先授权先发)逐个 claim 并发送'
  )
  assert.deepEqual(spy.sends[0], {
    openid: 'openid-mama',
    templateId: 'TPL-SRV',
    page: `pages/meal/meal?mealId=${mealId}`,
    data: {
      thing1: '快乐一家',          // 家庭名称
      thing2: '早餐已截止',        // 餐次文案 + 截止状态
      thing3: '番茄炒蛋 ×3',      // 备餐清单摘要(物化快照: 妈妈×2 + 爸爸×1)
    },
  }, '消息内容四要素逐字段')
  const mama = await store.getSubscribe(mealId, 'openid-mama')
  assert.equal(mama.consumed, true, '发送前已抢占 consumed')
  assert.equal(mama.sent, true, '成功才置 sent')
  assert.equal(mama.sent_at, soon)
  assert.equal((await store.getSubscribe(mealId, 'openid-baba')).sent, true)
})

test('未授权不发: granted=false 记录与无记录成员(只有订单) → 截止时零发送', async () => {
  const store = createMemStore()
  seedFamily(store)
  const soon = FIXED_NOW + 500
  seedMeal(store, { deadline: soon })
  seedDish(store)
  const mealId = `fam-main:${TODAY}:breakfast`
  seedOrder(store, mealId, 'openid-mama', [{ dish_id: 'dish-tomato', name: '番茄炒蛋', quantity: 1 }], { nickname: '妈妈' })
  seedOrder(store, mealId, 'openid-baba', [{ dish_id: 'dish-tomato', name: '番茄炒蛋', quantity: 1 }], { nickname: '爸爸' })
  seedSubscribe(store, 'openid-mama', { granted: false, template_id: 'TPL-0' }) // 拒绝过弹窗
  // openid-baba 只有订单、无订阅记录

  const spy = makeSpyNotifier()
  const engine = createMealEngine(store, { now: () => soon }, spy)
  await engine.scanDue()

  assert.equal(spy.sends.length, 0, 'granted=false 或记录不存在 → 跳过, 不发送')
  assert.equal((await store.getSubscribe(mealId, 'openid-mama')).consumed, false, '未授权记录连 consumed 都不抢占')
})

test('并发 claim 输家: claimGrant 报告输家(他人先手) → 本路径不发送, 记录已 consumed 由先手处理', async () => {
  const store = createMemStore()
  seedFamily(store)
  const soon = FIXED_NOW + 500
  seedMeal(store, { deadline: soon })
  seedDish(store)
  const mealId = `fam-main:${TODAY}:breakfast`
  seedOrder(store, mealId, 'openid-mama', [{ dish_id: 'dish-tomato', name: '番茄炒蛋', quantity: 1 }], { nickname: '妈妈' })
  seedSubscribe(store, 'openid-mama')

  // 模拟双扫描竞争: 真实 claim 由「先手」完成, 本路径被报告为 updated:0(输家)
  const losingStore = {
    ...store,
    claimGrant: async (mId, openid, now) => {
      await store.claimGrant(mId, openid, now)
      return { updated: 0 }
    },
  }
  const spy = makeSpyNotifier()
  const engine = createMealEngine(losingStore, { now: () => soon }, spy)

  const result = await engine.scanDue()
  assert.deepEqual(result, { closed: 1, skipped: 0 })
  assert.equal(spy.sends.length, 0, '输家不发送(发送只能由抢占赢家做一次)')
  const sub = await store.getSubscribe(mealId, 'openid-mama')
  assert.equal(sub.consumed, true, '先手 claim 已生效(记录不留可重抢窗口)')
  assert.equal(sub.sent, false, '发送权已失效: 即便先手崩在发送前, 也无人重发 —— 宁丢勿重')

  const result2 = await engine.scanDue()
  assert.deepEqual(result2, { closed: 0, skipped: 0 }, '后续扫描不重复消费')
  assert.equal(spy.sends.length, 0)
})

test('失败不重试: 发送失败 → 记录 consumed 原样留下(sent=false), 不阻塞其余成员, 下轮扫描零重试', async () => {
  const store = createMemStore()
  seedFamily(store)
  const soon = FIXED_NOW + 500
  seedMeal(store, { deadline: soon })
  seedDish(store)
  const mealId = `fam-main:${TODAY}:breakfast`
  seedOrder(store, mealId, 'openid-mama', [{ dish_id: 'dish-tomato', name: '番茄炒蛋', quantity: 1 }], { nickname: '妈妈' })
  seedOrder(store, mealId, 'openid-baba', [{ dish_id: 'dish-tomato', name: '番茄炒蛋', quantity: 1 }], { nickname: '爸爸' })
  seedSubscribe(store, 'openid-mama', { granted_at: FIXED_NOW - 400 }) // 先授权先 claim → 失败
  seedSubscribe(store, 'openid-baba', { granted_at: FIXED_NOW - 300 })

  const failOnce = makeSpyNotifier()
  let first = true
  const failingNotifier = {
    sends: failOnce.sends,
    async send(payload) {
      failOnce.sends.push(payload) // 记录每次尝试(含失败), 断言「不漏试/不重试」的观察点
      if (first) {
        first = false
        return { ok: false, code: 43101, message: '用户拒收' } // 适配器契约: 失败折叠, 不抛
      }
      return { ok: true }
    },
  }
  const engine = createMealEngine(store, { now: () => soon }, failingNotifier)

  await engine.scanDue()
  assert.equal(failOnce.sends.length, 2, '失败不阻塞: 其余成员照常发送')
  const mama = await store.getSubscribe(mealId, 'openid-mama')
  assert.equal(mama.consumed, true)
  assert.equal(mama.sent, false, '失败原样留下(sent=false), 不自动重试')
  assert.equal((await store.getSubscribe(mealId, 'openid-baba')).sent, true)

  await engine.scanDue()
  assert.equal(failOnce.sends.length, 2, '已 consumed 不可重抢: 失败记录零重试(宁丢勿重)')
})

test('消费幂等: 同餐次扫两遍只发一轮; closeEarly 与 scanDue 共用管线, 谁关谁发', async () => {
  const store = createMemStore()
  seedFamily(store)
  const far = FIXED_NOW + 10 * HOUR
  seedMeal(store, { deadline: far })
  seedDish(store)
  const mealId = `fam-main:${TODAY}:breakfast`
  seedOrder(store, mealId, 'openid-mama', [{ dish_id: 'dish-tomato', name: '番茄炒蛋', quantity: 1 }], { nickname: '妈妈' })
  seedSubscribe(store, 'openid-mama')

  const spy = makeSpyNotifier()
  const clock = { now: () => FIXED_NOW }
  const engine = createMealEngine(store, clock, spy)

  await engine.closeEarly(mealId, 'openid-baba')
  assert.equal(spy.sends.length, 1, '手动提前截止同样走管线消费')
  await engine.scanDue()
  assert.equal(spy.sends.length, 1, '扫描补刀不重复发(已 consumed)')
})

test('代截止路径(close-if-due)同样消费: 到点瞬间 placeOrder 触发关闭 → 授权成员收到一条', async () => {
  const { store } = make()
  seedFamily(store)
  const soon = FIXED_NOW + 500
  seedMeal(store, { deadline: soon })
  seedDish(store)
  seedOrder(store, `fam-main:${TODAY}:breakfast`, 'openid-mama', [{ dish_id: 'dish-tomato', name: '番茄炒蛋', quantity: 1 }], { nickname: '妈妈' })
  seedSubscribe(store, 'openid-mama')
  const spy = makeSpyNotifier()
  const engine = createMealEngine(store, { now: () => soon }, spy)

  await assert.rejects(
    () => engine.placeOrder(
      `fam-main:${TODAY}:breakfast`, 'openid-baba',
      { dishes: [{ dishId: 'dish-tomato', quantity: 1 }], subscribed: true },
      { nickname: '爸爸', templateId: 'TPL-X' }
    ),
    (err) => err.code === 'PAST_CUTOFF'
  )

  assert.equal(spy.sends.length, 1, '代截止赢家消费授权并发送')
  assert.equal((await store.getSubscribe(`fam-main:${TODAY}:breakfast`, 'openid-mama')).sent, true)
})

test('记录模板 ID 透传: 授权时未配置模板(空) → 引擎原样交给适配器(跳过+日志属适配器契约, 见 notifier 测试)', async () => {
  const store = createMemStore()
  seedFamily(store)
  const soon = FIXED_NOW + 500
  seedMeal(store, { deadline: soon })
  seedDish(store)
  const mealId = `fam-main:${TODAY}:breakfast`
  seedOrder(store, mealId, 'openid-mama', [{ dish_id: 'dish-tomato', name: '番茄炒蛋', quantity: 1 }], { nickname: '妈妈' })
  seedSubscribe(store, 'openid-mama', { template_id: '' })

  const spy = makeSpyNotifier()
  const engine = createMealEngine(store, { now: () => soon }, spy)
  await engine.scanDue()

  assert.equal(spy.sends.length, 1)
  assert.equal(spy.sends[0].templateId, '', '引擎不吞模板 ID, 未配置空串原样进发送契约')
  assert.equal((await store.getSubscribe(mealId, 'openid-mama')).sent, true, '引擎只认适配器返回值: ok → sent; 真适配器对空模板返回 not_configured 不 ok(见 notifier.test)')
})

test('消息内容: thing 字段 20 字符截断 —— 长家庭名/长清单摘要不超上限(微信拒收 47001 的兜底)', async () => {
  const store = createMemStore()
  seedFamily(store, { name: '这是一个特别特别特别特别特别长的家庭名称超过二十字符' })
  const soon = FIXED_NOW + 500
  seedMeal(store, { deadline: soon })
  seedDish(store)
  const mealId = `fam-main:${TODAY}:breakfast`
  seedOrder(store, mealId, 'openid-mama', [{ dish_id: 'dish-tomato', name: '超长菜名一号逼近二十字符边界的番茄炒鸡蛋', quantity: 1 }], { nickname: '妈妈' })
  seedSubscribe(store, 'openid-mama')

  const spy = makeSpyNotifier()
  const engine = createMealEngine(store, { now: () => soon }, spy)
  await engine.scanDue()

  assert.equal(spy.sends.length, 1)
  const data = spy.sends[0].data
  assert.ok(data.thing1.length <= 20, `家庭名称截断: ${data.thing1.length} 字符`)
  assert.ok(data.thing3.length <= 20, `清单摘要截断: ${data.thing3.length} 字符`)
  assert.equal(data.thing3.slice(-1), '…', '截断以省略号收尾')
  assert.ok(data.thing1.slice(-1) === '…' || data.thing1.length === 20)
})