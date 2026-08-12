'use strict'

const { test } = require('node:test')
const assert = require('node:assert/strict')

const { createMemStore } = require('./mem-store.js')
const { createDishEngine } = require('../lib/dish-engine/index.js')

const FIXED_NOW = 1700000000000

const fixedClock = { now: () => FIXED_NOW }

function make() {
  const store = createMemStore()
  return { store, engine: createDishEngine(store, fixedClock) }
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

function seedDish(store, overrides = {}) {
  const doc = {
    _id: 'dish-tomato',
    family_id: 'fam-main',
    name: '番茄炒蛋',
    image: '',
    description: '',
    ingredients: [{ name: '鸡蛋', amount: '2 个' }],
    tags: ['家常菜'],
    is_available: true,
    is_deleted: false,
    created_by: 'openid-mama',
    created_at: FIXED_NOW - 1000,
    ...overrides,
  }
  store._seedDish(doc)
  return doc
}

// 引擎的「今日」= 注入时钟在服务器本地时区的日期, 测试按下述同源格式化推算引用保护的目标日期
function dayOf(ts) {
  const d = new Date(ts)
  const m = String(d.getMonth() + 1).padStart(2, '0')
  const day = String(d.getDate()).padStart(2, '0')
  return `${d.getFullYear()}-${m}-${day}`
}

const TODAY = String(dayOf(FIXED_NOW))
const OTHER_DAY = String(dayOf(FIXED_NOW + 7 * 24 * 3600 * 1000))

test('listDishes: 成员可见 全部未删菜品, created_at 降序, 含 dish_id', async () => {
  const { store, engine } = make()
  seedFamily(store)
  seedDish(store, { _id: 'dish-old', created_at: FIXED_NOW - 2000 })
  seedDish(store, { _id: 'dish-new', created_at: FIXED_NOW - 100 })
  seedDish(store, { _id: 'dish-removed', is_deleted: true, name: '已删菜' })
  store._seedDish({ _id: 'dish-other', family_id: 'fam-other', name: '别家菜', ingredients: [], tags: [], is_available: true, is_deleted: false, created_by: 'x', created_at: 1 })

  const dishes = await engine.listDishes({ familyId: 'fam-main' }, 'openid-baba')

  assert.deepEqual(dishes.map((d) => d.dish_id), ['dish-new', 'dish-old'])
  assert.equal(dishes[0].name, '番茄炒蛋')
  assert.equal(dishes[0].is_available, true)
  assert.equal(dishes[0].is_deleted, false)
})

test('listDishes/listRemovedDishes: 非成员 → NOT_MEMBER', async () => {
  const { store, engine } = make()
  seedFamily(store)

  await assert.rejects(
    () => engine.listDishes({ familyId: 'fam-main' }, 'openid-stranger'),
    (err) => err.code === 'NOT_MEMBER'
  )
  await assert.rejects(
    () => engine.listRemovedDishes({ familyId: 'fam-main' }, 'openid-stranger'),
    (err) => err.code === 'NOT_MEMBER'
  )
})

test('listDishes: 冻结家庭 → FAMILY_FROZEN', async () => {
  const { store, engine } = make()
  seedFamily(store, { status: 'frozen' })

  await assert.rejects(
    () => engine.listDishes({ familyId: 'fam-main' }, 'openid-baba'),
    (err) => err.code === 'FAMILY_FROZEN'
  )
})

test('listRemovedDishes: 只含 is_deleted: true 的菜品', async () => {
  const { store, engine } = make()
  seedFamily(store)
  seedDish(store, { _id: 'dish-live', name: '在售菜' })
  seedDish(store, { _id: 'dish-rm1', name: '已删一', is_deleted: true, created_at: FIXED_NOW - 300 })
  seedDish(store, { _id: 'dish-rm2', name: '已删二', is_deleted: true, created_at: FIXED_NOW - 200 })

  const dishes = await engine.listRemovedDishes({ familyId: 'fam-main' }, 'openid-mama')

  assert.deepEqual(dishes.map((d) => d.dish_id), ['dish-rm2', 'dish-rm1'])
})

test('createDish: 落库默认标志+结构化食材+created_by, 固定时钟断言 created_at, 返回 dish_id', async () => {
  const { store, engine } = make()
  seedFamily(store)

  const dish = await engine.createDish({
    familyId: 'fam-main',
    name: ' 番茄炒蛋 ',
    image: '',
    description: ' 下饭 ',
    ingredients: [{ name: '鸡蛋', amount: '2 个' }, { name: '番茄', amount: '1 个' }],
    tags: ['家常菜', '快手菜'],
  }, 'openid-baba', { now: FIXED_NOW })

  assert.equal(dish.dish_id, 'dish-1')
  assert.equal(dish.name, '番茄炒蛋')
  assert.equal(dish.description, '下饭')
  assert.deepEqual(dish.ingredients, [{ name: '鸡蛋', amount: '2 个' }, { name: '番茄', amount: '1 个' }])
  assert.equal(dish.is_available, true)
  assert.equal(dish.is_deleted, false)
  assert.equal(dish.created_by, 'openid-baba')
  assert.equal(dish.created_at, FIXED_NOW)
  const stored = await store.getDish('dish-1')
  assert.equal(stored.family_id, 'fam-main')
  assert.deepEqual(stored.ingredients, [{ name: '鸡蛋', amount: '2 个' }, { name: '番茄', amount: '1 个' }])
})

test('createDish 校验: 名称必填/超长, 图片非 cloud://, 食材缺名称或缺用量, 标签超量, 均拒绝且无写入', async () => {
  const base = {
    familyId: 'fam-main',
    name: '酸辣土豆丝',
    image: '',
    description: '',
    ingredients: [{ name: '土豆', amount: '2 个' }],
    tags: [],
  }
  const cases = [
    [{ ...base, name: '   ' }, 'DISH_NAME_REQUIRED'],
    [{ ...base, name: '辣'.repeat(31) }, 'DISH_NAME_TOO_LONG'],
    [{ ...base, image: 'https://x/y.png' }, 'IMAGE_INVALID'],
    [{ ...base, ingredients: '鸡蛋' }, 'INGREDIENTS_INVALID'],
    [{ ...base, ingredients: [{ name: '鸡蛋', amount: '' }] }, 'INGREDIENTS_INVALID'],
    [{ ...base, ingredients: [{ name: '', amount: '2 个' }] }, 'INGREDIENTS_INVALID'],
    [{ ...base, tags: ['a', 'b', 'c', 'd', 'e', 'f', 'g'] }, 'TAGS_INVALID'],
    [{ ...base, tags: ['超级长的标签名字超十一'] }, 'TAGS_INVALID'],
  ]
  for (const [payload, code] of cases) {
    const { store, engine } = make()
    seedFamily(store)
    await assert.rejects(
      () => engine.createDish(payload, 'openid-baba', { now: FIXED_NOW }),
      (err) => err.code === code,
      `expect ${code}`
    )
    assert.equal(await store.getDish('dish-1'), null)
  }
})

test('updateDish 信任模型: 非创建者成员可改全部内容字段, updated_at 推进, 不触碰上下架与软删标志', async () => {
  const { store, engine } = make()
  seedFamily(store)
  seedDish(store, { is_available: false })

  const updated = await engine.updateDish({
    familyId: 'fam-main',
    dishId: 'dish-tomato',
    name: '番茄炒蛋(改)',
    image: 'cloud://img/1.png',
    description: '新描述',
    ingredients: [{ name: '鸡蛋', amount: '3 个' }],
    tags: ['硬菜'],
  }, 'openid-baba', { now: FIXED_NOW })

  assert.equal(updated.name, '番茄炒蛋(改)')
  assert.equal(updated.image, 'cloud://img/1.png')
  assert.equal(updated.description, '新描述')
  assert.deepEqual(updated.ingredients, [{ name: '鸡蛋', amount: '3 个' }])
  assert.deepEqual(updated.tags, ['硬菜'])
  assert.equal(updated.is_available, false)
  assert.equal(updated.is_deleted, false)
  assert.equal(updated.created_by, 'openid-mama')
  assert.equal(updated.updated_at, FIXED_NOW)
  const stored = await store.getDish('dish-tomato')
  assert.equal(stored.is_available, false)
  assert.equal(stored.is_deleted, false)
})

test('updateDish: 菜品不存在或不属于该家庭 → DISH_NOT_FOUND', async () => {
  const { store, engine } = make()
  seedFamily(store)
  store._seedDish({ _id: 'dish-other', family_id: 'fam-other', name: '别家菜', ingredients: [{ name: 'x', amount: '1' }], tags: [], is_available: true, is_deleted: false, created_by: 'x', created_at: 1 })

  await assert.rejects(
    () => engine.updateDish({ familyId: 'fam-main', dishId: 'dish-missing', name: 'x', ingredients: [{ name: 'a', amount: '1' }], tags: [] }, 'openid-baba'),
    (err) => err.code === 'DISH_NOT_FOUND'
  )
  await assert.rejects(
    () => engine.updateDish({ familyId: 'fam-main', dishId: 'dish-other', name: 'x', ingredients: [{ name: 'a', amount: '1' }], tags: [] }, 'openid-baba'),
    (err) => err.code === 'DISH_NOT_FOUND'
  )
})

test('setDishAvailable: 任意成员可翻转上下架, 不影响 is_deleted', async () => {
  const { store, engine } = make()
  seedFamily(store)
  seedDish(store)

  const off = await engine.setDishAvailable({ familyId: 'fam-main', dishId: 'dish-tomato', isAvailable: false }, 'openid-baba')
  assert.equal(off.is_available, false)
  assert.equal(off.is_deleted, false)
  const on = await engine.setDishAvailable({ familyId: 'fam-main', dishId: 'dish-tomato', isAvailable: true }, 'openid-mama')
  assert.equal(on.is_available, true)
  assert.equal((await store.getDish('dish-tomato')).is_available, true)
})

test('deleteDish 软删: 无当日引用 → is_deleted: true, 文档保留, 更新 updated_at', async () => {
  const { store, engine } = make()
  seedFamily(store)
  seedDish(store)

  await engine.deleteDish({ familyId: 'fam-main', dishId: 'dish-tomato' }, 'openid-baba', { now: FIXED_NOW })

  const stored = await store.getDish('dish-tomato')
  assert.equal(stored.is_deleted, true)
  assert.equal(stored.updated_at, FIXED_NOW)
  assert.equal(stored.name, '番茄炒蛋')
})

test('deleteDish 引用保护: 今日 ongoing/closed 餐次订单引用 → DISH_IN_USE, 不产生软删', async () => {
  const cases = [
    { status: 'ongoing' },
    { status: 'closed' },
  ]
  for (const meal of cases) {
    const { store, engine } = make()
    seedFamily(store)
    seedDish(store)
    store._seedMeal({ _id: 'fam-main:' + TODAY + ':dinner', family_id: 'fam-main', date: TODAY, slot: 'dinner', status: meal.status, initiated_by: 'openid-mama', deadline: FIXED_NOW + 1000 })
    store._seedOrder({ _id: 'order-1', meal_id: 'fam-main:' + TODAY + ':dinner', family_id: 'fam-main', user_openid: 'openid-mama', user_nickname: '妈妈', dishes: [{ dish_id: 'dish-tomato', name: '番茄炒蛋', quantity: 1 }], created_at: FIXED_NOW })

    await assert.rejects(
      () => engine.deleteDish({ familyId: 'fam-main', dishId: 'dish-tomato' }, 'openid-baba', { now: FIXED_NOW }),
      (err) => err.code === 'DISH_IN_USE',
      `status=${meal.status}`
    )
    assert.equal((await store.getDish('dish-tomato')).is_deleted, false)
  }
})

test('deleteDish 引用保护: 隔日引用与今日 prepared 餐次引用不拦截(只看今日 ongoing/closed)', async () => {
  const { store, engine } = make()
  seedFamily(store)
  seedDish(store)
  store._seedMeal({ _id: 'fam-main:' + OTHER_DAY + ':dinner', family_id: 'fam-main', date: OTHER_DAY, slot: 'dinner', status: 'ongoing', initiated_by: 'openid-mama', deadline: FIXED_NOW + 1000 })
  store._seedOrder({ _id: 'order-tomorrow', meal_id: 'fam-main:' + OTHER_DAY + ':dinner', family_id: 'fam-main', user_openid: 'openid-mama', user_nickname: '妈妈', dishes: [{ dish_id: 'dish-tomato', name: '番茄炒蛋', quantity: 1 }], created_at: FIXED_NOW })
  store._seedMeal({ _id: 'fam-main:' + TODAY + ':breakfast', family_id: 'fam-main', date: TODAY, slot: 'breakfast', status: 'prepared', initiated_by: 'openid-mama', deadline: FIXED_NOW - 1000 })
  store._seedOrder({ _id: 'order-prepared', meal_id: 'fam-main:' + TODAY + ':breakfast', family_id: 'fam-main', user_openid: 'openid-mama', user_nickname: '妈妈', dishes: [{ dish_id: 'dish-tomato', name: '番茄炒蛋', quantity: 1 }], created_at: FIXED_NOW })

  await engine.deleteDish({ familyId: 'fam-main', dishId: 'dish-tomato' }, 'openid-baba', { now: FIXED_NOW })

  assert.equal((await store.getDish('dish-tomato')).is_deleted, true)
})

test('deleteDish/restoreDish: 菜品不存在或不属于该家庭 → DISH_NOT_FOUND', async () => {
  const { store, engine } = make()
  seedFamily(store)

  await assert.rejects(
    () => engine.deleteDish({ familyId: 'fam-main', dishId: 'dish-missing' }, 'openid-baba', { now: FIXED_NOW }),
    (err) => err.code === 'DISH_NOT_FOUND'
  )
  await assert.rejects(
    () => engine.restoreDish({ familyId: 'fam-main', dishId: 'dish-missing' }, 'openid-baba'),
    (err) => err.code === 'DISH_NOT_FOUND'
  )
})

test('restoreDish: 已下架菜品一键恢复 is_deleted: false, 成员可恢复他人创建; 在售菜品幂等不动', async () => {
  const { store, engine } = make()
  seedFamily(store)
  seedDish(store, { is_deleted: true, created_by: 'openid-mama', is_available: false })

  const restored = await engine.restoreDish({ familyId: 'fam-main', dishId: 'dish-tomato' }, 'openid-baba')
  assert.equal(restored.is_deleted, false)
  assert.equal(restored.is_available, false)
  const stored = await store.getDish('dish-tomato')
  assert.equal(stored.is_deleted, false)

  const again = await engine.restoreDish({ familyId: 'fam-main', dishId: 'dish-tomato' }, 'openid-baba')
  assert.equal(again.is_deleted, false)
  assert.equal((await store.getDish('dish-tomato')).updated_at, stored.updated_at)
})

test('守卫: 全部菜品接口对非成员 → NOT_MEMBER, 对冻结家庭 → FAMILY_FROZEN', async () => {
  const mutation = [
    (engine, openid) => engine.createDish({ familyId: 'fam-main', name: '菜', ingredients: [], tags: [] }, openid),
    (engine, openid) => engine.updateDish({ familyId: 'fam-main', dishId: 'dish-tomato', name: '菜', ingredients: [], tags: [] }, openid),
    (engine, openid) => engine.setDishAvailable({ familyId: 'fam-main', dishId: 'dish-tomato', isAvailable: false }, openid),
    (engine, openid) => engine.deleteDish({ familyId: 'fam-main', dishId: 'dish-tomato' }, openid),
    (engine, openid) => engine.restoreDish({ familyId: 'fam-main', dishId: 'dish-tomato' }, openid),
  ]
  for (const run of mutation) {
    const { store, engine } = make()
    seedFamily(store)
    seedDish(store, { is_deleted: true })
    await assert.rejects(() => run(engine, 'openid-stranger'), (err) => err.code === 'NOT_MEMBER')

    const frozen = make()
    seedFamily(frozen.store, { status: 'frozen' })
    seedDish(frozen.store, { is_deleted: true })
    await assert.rejects(() => run(frozen.engine, 'openid-baba'), (err) => err.code === 'FAMILY_FROZEN')
  }
})