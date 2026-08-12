'use strict'

const { buildSummary } = require('../summarizer/index.js')

// MealEngine：餐次引擎核心（发起/单路径查看/下单全量替换）。
// 零 SDK、零 I/O，Store port + Clock 注入。契约见 docs/design/meal-engine.md。
// meals/orders/subscribes 集合归本引擎独占写入（T6 只碰前两者，subscribes 为 T9 领地）。
const SLOTS = ['breakfast', 'lunch', 'dinner']
// 缺省截止: 早餐 08:00 / 午餐 11:30 / 晚餐 17:30(当日, 服务器本地时区)
const DEFAULT_DEADLINES = { breakfast: '08:00', lunch: '11:30', dinner: '17:30' }
const MEAL_ONGOING = 'ongoing'

/**
 * @param {{
 *   getFamily: Function, listFamilyMembers: Function,
 *   getMeal: Function, createMeal: Function,
 *   getDish: Function, listDishes: Function,
 *   getOrder: Function, upsertOrder: Function, deleteOrder: Function, listOrders: Function,
 * }} store
 * @param {{now: Function}} clock 固定时钟注入点（生产 = Date.now）
 */
function createMealEngine(store, clock = { now: () => Date.now() }) {
  return { initiate, viewMeal, placeOrder }

  // ── 发起: (family_id, date, slot) 唯一场; 同键已存在任何状态 → MEAL_EXISTS(命令集无 reopen) ──
  async function initiate({ familyId, date, slot }, openid, { deadline, now } = {}) {
    const at = now == null ? clock.now() : now
    await guardFamily(store, familyId, openid)
    const slotValue = String(slot == null ? '' : slot)
    if (!SLOTS.includes(slotValue)) throw domainError('SLOT_INVALID', '餐次类型只能是 breakfast/lunch/dinner')
    const dateValue = date == null ? localDateOf(at) : String(date)
    if (!/^\d{4}-\d{2}-\d{2}$/.test(dateValue)) throw domainError('DATE_INVALID', '日期格式须为 YYYY-MM-DD')
    const ddl = deadline == null ? deadlineOf(slotValue, dateValue) : deadline
    if (typeof ddl !== 'number' || ddl <= at) throw domainError('DEADLINE_IN_PAST', '截止时间必须晚于当前时间')

    const mealDoc = {
      _id: `${familyId}:${dateValue}:${slotValue}`,
      family_id: familyId,
      date: dateValue,
      slot: slotValue,
      status: MEAL_ONGOING,
      initiated_by: openid,
      deadline: ddl,
      created_at: at,
      summary: null,
    }
    try {
      await store.createMeal(mealDoc)
    } catch (err) {
      if (err && err.code === 'DUPLICATE_KEY') {
        throw domainError('MEAL_EXISTS', '该日期该餐次已存在，不可重复发起')
      }
      throw err
    }
    return buildView(store, mealDoc, openid, { now: at })
  }

  async function viewMeal(mealId, openid) {
    const { meal } = await openMeal(store, mealId, openid)
    return buildView(store, meal, openid, { now: clock.now() })
  }

  // placeOrder(mealId, openid, {dishes, note, subscribed?}, {nickname, now}):
  // subscribed 属 T9 授权领地的入参, T6 只透传不消费(入口壳不传即无感);
  // nickname 由入口壳经 users 档案解析(下单即快照, 引擎不查 users)
  async function placeOrder(mealId, openid, { dishes, note } = {}, { nickname, now } = {}) {
    const at = now == null ? clock.now() : now
    const { meal } = await openMeal(store, mealId, openid)
    // 写命令先跑 close-if-due（T8 钩子，见下）
    const { closed } = await closeIfDue(store, meal, at)
    if (closed) throw domainError('PAST_CUTOFF', '该餐次已截止，无法下单')
    if (meal.status !== MEAL_ONGOING) throw domainError('MEAL_LOCKED', '该餐次已锁定，无法修改点选')
    if (at >= meal.deadline) throw domainError('PAST_CUTOFF', '已过截止时间，无法下单')

    if (dishes == null || !Array.isArray(dishes)) {
      throw domainError('DISHES_INVALID', 'dishes 须为数组')
    }
    if (dishes.length === 0) {
      // 全量替换语义: 空数组 = 取消 → 删除订单文档（无 cancelled 态）
      await store.deleteOrder(mealId, openid)
      return buildView(store, meal, openid, { dropped: [], now: at })
    }

    const { kept, dropped } = await resolveDishes(store, meal, dishes)
    if (kept.length === 0) {
      // 过滤后无有效菜品: 按取消处理(空数组语义), 下架/软删菜随 dropped 提示
      await store.deleteOrder(mealId, openid)
      return buildView(store, meal, openid, { dropped, now: at })
    }

    const orderDoc = {
      _id: `${mealId}:${openid}`,
      meal_id: mealId,
      family_id: meal.family_id,
      user_openid: openid,
      user_nickname: nickname || '',
      dishes: kept.map((row) => ({ dish_id: row.dishId, name: row.name, quantity: row.quantity })),
      note: String(note == null ? '' : note).trim(),
      created_at: at,
    }
    await store.upsertOrder(orderDoc)
    return buildView(store, meal, openid, { dropped, now: at })
  }
}

// ── 到期最小守卫（T8 钩子）──
// T8 将在此实现关闭管线: claimClose 原子抢占(条件更新 where {_id, status:'ongoing', deadline<=now})
// → 物化 buildSummary 快照 → 订阅授权消费(见 meal-engine.md「关闭管线」)。T6 不做自动截止,
// 一律返回 {closed:false}, 由调用方按 now>=deadline 落 PAST_CUTOFF —— 本函数是 T8 的唯一改动点,
// T8 落地后即可期语义: 代截止后 closed=true → 本次命令落 PAST_CUTOFF, 其余判定天然成立。
async function closeIfDue(store, meal, now) {
  return { meal, closed: false }
}

// ── 菜品解析: 归属校验为致命(DISH_UNKNOWN); 下架/软删为过滤(非致命, 随视图 dropped 返回) ──
async function resolveDishes(store, meal, rawDishes) {
  const merged = new Map()
  for (const item of rawDishes) {
    const dishId = item && typeof item.dishId === 'string' ? item.dishId : ''
    if (!dishId) throw domainError('DISHES_INVALID', 'dishes 每项须含 dishId')
    const qty = item.quantity
    if (typeof qty !== 'number' || !Number.isInteger(qty) || qty < 1) {
      throw domainError('QUANTITY_INVALID', '数量须为不小于 1 的整数')
    }
    merged.set(dishId, (merged.get(dishId) || 0) + qty)
  }

  const kept = []
  const dropped = []
  for (const [dishId, quantity] of merged) {
    const dish = await store.getDish(dishId)
    if (!dish || dish.family_id !== meal.family_id) {
      throw domainError('DISH_UNKNOWN', '菜品不存在或不属于该家庭')
    }
    if (dish.is_deleted || !dish.is_available) {
      dropped.push({ dishId, dishName: dish.name })
      continue
    }
    kept.push({ dishId, name: dish.name, quantity })
  }
  return { kept, dropped }
}

// ── 视图: initiate/viewMeal/placeOrder 共用同一构建(餐次页单路径) ──
async function buildView(store, meal, openid, { dropped = [], now } = {}) {
  const at = now == null ? Date.now() : now
  const familyId = meal.family_id
  const [activeRows, removedRows] = await Promise.all([
    store.listDishes(familyId, false),
    store.listDishes(familyId, true),
  ])
  const menu = activeRows
    .filter((d) => d.is_available)
    .map((d) => ({
      dishId: d._id,
      name: d.name,
      ingredients: (d.ingredients || []).map((i) => ({ name: i.name, amount: i.amount })),
    }))

  const orderDoc = await store.getOrder(meal._id, openid)
  const myOrder = orderDoc && {
    user_openid: orderDoc.user_openid,
    user_nickname: orderDoc.user_nickname,
    dishes: (orderDoc.dishes || []).map((d) => ({ dishId: d.dish_id, name: d.name, quantity: d.quantity })),
    note: orderDoc.note || '',
  }

  let live = null
  if (meal.status === MEAL_ONGOING) {
    // 实时预览: 全量传参(含软删)调 buildSummary, 只算不物化
    const orders = await store.listOrders(meal._id)
    live = buildSummary(orders, activeRows.concat(removedRows), now)
  } else {
    // closed/prepared: 读 meals.summary 物化快照; 崩溃窗口缺失 → null, 前端容错空清单
    live = meal.summary || null
  }

  return {
    meal: {
      date: meal.date,
      slot: meal.slot,
      status: meal.status,
      deadline: meal.deadline,
      closed_at: meal.closed_at,
      prepared_by: meal.prepared_by,
      prepared_at: meal.prepared_at,
      summary: meal.summary,
    },
    menu,
    myOrder,
    live,
    canOrder: meal.status === MEAL_ONGOING && at < meal.deadline,
    granted: false, // T9 钩子: 本餐当前用户订阅授权记录查询
    dropped,
  }
}

async function guardFamily(store, familyId, openid) {
  const family = await store.getFamily(familyId)
  const memberships = await store.listFamilyMembers(openid)
  if (!family || !memberships.some((row) => row.family_id === familyId)) {
    throw domainError('NOT_MEMBER', '你不是该家庭成员')
  }
  if (family.status !== 'active') throw domainError('FAMILY_FROZEN', '家庭已冻结')
}

async function openMeal(store, mealId, openid) {
  const meal = await store.getMeal(mealId)
  if (!meal) throw domainError('MEAL_NOT_FOUND', '餐次不存在')
  await guardFamily(store, meal.family_id, openid)
  return { meal }
}

function deadlineOf(slot, date) {
  return new Date(`${date}T${DEFAULT_DEADLINES[slot]}:00`).getTime()
}

function localDateOf(ts) {
  const d = new Date(ts)
  const m = String(d.getMonth() + 1).padStart(2, '0')
  const day = String(d.getDate()).padStart(2, '0')
  return `${d.getFullYear()}-${m}-${day}`
}

function domainError(code, message) {
  const err = new Error(message)
  err.code = code
  return err
}

module.exports = { createMealEngine }