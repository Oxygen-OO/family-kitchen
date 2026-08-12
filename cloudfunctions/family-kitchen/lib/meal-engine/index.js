'use strict'

const { buildSummary } = require('../summarizer/index.js')

// MealEngine：餐次引擎核心（发起/单路径查看/下单全量替换/截止管线）。
// 零 SDK、零 I/O，Store port + Clock 注入。契约见 docs/design/meal-engine.md。
// meals/orders/subscribes 集合归本引擎独占写入（T6 只碰前两者，subscribes 为 T9 领地）。
const SLOTS = ['breakfast', 'lunch', 'dinner']
// 缺省截止: 早餐 08:00 / 午餐 11:30 / 晚餐 17:30(当日, 服务器本地时区)
const DEFAULT_DEADLINES = { breakfast: '08:00', lunch: '11:30', dinner: '17:30' }
const MEAL_ONGOING = 'ongoing'

/**
 * @param {{
 *   getFamily: Function, listFamilyMembers: Function,
 *   getMeal: Function, createMeal: Function, updateMeal: Function,
 *   claimClose: Function, findDueMeals: Function,
 *   getDish: Function, listDishes: Function,
 *   getOrder: Function, upsertOrder: Function, deleteOrder: Function, listOrders: Function,
 * }} store
 * @param {{now: Function}} clock 固定时钟注入点（生产 = Date.now）
 */
function createMealEngine(store, clock = { now: () => Date.now() }) {
  return { initiate, viewMeal, placeOrder, closeEarly, scanDue }

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
    const opened = await openMeal(store, mealId, openid)
    // 写命令先跑 close-if-due（T8）: ongoing ∧ now>=deadline → 代截止(claimClose 赢家),
    // 赢家本次命令落 PAST_CUTOFF; 已 closed/prepared(含抢占输家) → MEAL_LOCKED。
    const guard = await closeIfDue(store, opened.meal, at)
    if (guard.closed) throw domainError('PAST_CUTOFF', '该餐次已截止，无法下单')
    const meal = guard.meal
    if (meal.status !== MEAL_ONGOING) throw domainError('MEAL_LOCKED', '该餐次已锁定，无法修改点选')

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

  // ── 关闭管线（内部单点: closeIfDue/closeEarly/scanDue 共用, 手动与自动同一实现）──
  // 拒绝码以锁定文档 meal-engine.md 为准: 本守卫当场代截止(赢家) → 调用方落 PAST_CUTOFF;
  // 已 closed/prepared(含抢占输家) → MEAL_LOCKED。issue #8 AC 写 MEAL_CLOSED 与文档不一致,
  // 文档优先, 引擎不产生 MEAL_CLOSED 码(差异说明见 meal-engine.md 错误模式, 先例: T6 DISH_REMOVED)。
  // T9 届时在管线尾部补订阅授权消费(此处只留钩子语义: 物化后 closed_at 已可判定)。
  async function closePipeline(store, mealId, now, requireDue) {
    const { updated } = await store.claimClose(mealId, { now, requireDue })
    const meal = await store.getMeal(mealId)
    if (updated !== 1) return { won: false, meal }
    // 赢家: 读全量订单 → buildSummary(全量传参含软删) → 写 meals.summary 物化快照
    // (崩溃窗口下 summary 缺失 → 前端容错空清单, 见 meal-engine.md)
    const [orders, dishPool] = await Promise.all([store.listOrders(mealId), allDishes(store, meal.family_id)])
    const summary = buildSummary(orders, dishPool, now)
    await store.updateMeal(mealId, { summary })
    return { won: true, meal: { ...meal, summary } }
  }

  // ── 到期守卫（T8）: 写命令前置 —— ongoing ∧ now>=deadline 时先代截止再按真实状态判定 ──
  // 无论是否代截止都重读 meal 返回真实状态(守护「按关闭后的真实状态判定」: 读后-判定前
  // 若有并发 closeEarly 抢先, 本守卫看到 closed 而不是陈旧 ongoing); 返回
  // {meal: 当前真实状态, closed: 本次是否由本守卫代截止}(输家 closed=false, 调用方落 MEAL_LOCKED)。
  async function closeIfDue(store, meal, now) {
    if (meal.status !== MEAL_ONGOING || now < meal.deadline) {
      const fresh = await store.getMeal(meal._id)
      return { meal: fresh, closed: false }
    }
    const { won, meal: fresh } = await closePipeline(store, meal._id, now, true)
    return { meal: fresh, closed: won }
  }

  // ── 手动提前截止: 与自动截止走完全相同的关闭管线(requireDue=false, 不受 deadline 约束) ──
  // 家庭守卫后仅 ongoing 可触发; 抢占输家(他人抢先关了)同样落 NOT_ONGOING, 与直接关过的餐次同码。
  async function closeEarly(mealId, openid, { now } = {}) {
    const at = now == null ? clock.now() : now
    const { meal } = await openMeal(store, mealId, openid)
    if (meal.status !== MEAL_ONGOING) throw domainError('NOT_ONGOING', '仅进行中的餐次可提前截止')
    const { won, meal: closed } = await closePipeline(store, mealId, at, false)
    if (!won) throw domainError('NOT_ONGOING', '该餐次刚被其他成员截止')
    return buildView(store, closed, openid, { now: at })
  }

  // ── cron 扫描: 无参幂等, 到期(ongoing ∧ deadline<=now)逐个走关闭管线 ──
  // closed = 本趟赢家数; skipped = 读到但抢占失败数(并发下只有先手赢, 输家不物化)。
  async function scanDue() {
    const now = clock.now()
    const due = await store.findDueMeals(now)
    let closed = 0
    let skipped = 0
    for (const row of due) {
      const { won } = await closePipeline(store, row._id, now, true)
      if (won) closed += 1
      else skipped += 1
    }
    return { closed, skipped }
  }
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
  const activeRows = await store.listDishes(familyId, false)
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
    live = buildSummary(orders, await allDishes(store, familyId), now)
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

// 该家庭全量菜品池(含软删): 汇总器「全量传入」契约(见 prep-summarizer.md)——预览与物化共用
async function allDishes(store, familyId) {
  const [activeRows, removedRows] = await Promise.all([
    store.listDishes(familyId, false),
    store.listDishes(familyId, true),
  ])
  return activeRows.concat(removedRows)
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