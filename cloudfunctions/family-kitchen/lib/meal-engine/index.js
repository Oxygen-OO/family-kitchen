'use strict'

const { buildSummary } = require('../summarizer/index.js')

// MealEngine：餐次引擎核心（发起/单路径查看/下单全量替换/截止管线）。
// 零 SDK、零 I/O，Store port + Clock 注入。契约见 docs/design/meal-engine.md。
// meals/orders/subscribes 集合归本引擎独占写入（T6 只碰前两者，subscribes 为 T9 领地）。
const SLOTS = ['breakfast', 'lunch', 'dinner']
// 缺省截止: 早餐 08:00 / 午餐 11:30 / 晚餐 17:30(当日, 服务器本地时区)
const DEFAULT_DEADLINES = { breakfast: '08:00', lunch: '11:30', dinner: '17:30' }
const MEAL_ONGOING = 'ongoing'
// 订阅消息文案(与 miniprogram/pages/meal 的 SLOT_LABELS 同源)
const SLOT_LABELS = { breakfast: '早餐', lunch: '午餐', dinner: '晚餐' }
// 缺省 notifier: 未注入时消费段按失败折叠处理(不发送、不重试) —— 生产入口壳恒注入适配器
const NOOP_NOTIFIER = { send: async () => ({ ok: false, skipped: 'no_notifier' }) }

/**
 * @param {{
 *   getFamily: Function, listFamilyMembers: Function,
 *   getMeal: Function, createMeal: Function, updateMeal: Function,
 *   claimClose: Function, findDueMeals: Function,
 *   getDish: Function, listDishes: Function,
 *   getOrder: Function, upsertOrder: Function, deleteOrder: Function, listOrders: Function,
 *   getSubscribe: Function, addSubscribe: Function, updateSubscribe: Function,
 *   claimGrant: Function, listSubscribes: Function,
 * }} store
 * @param {{now: Function}} clock 固定时钟注入点（生产 = Date.now）
 * @param {{send: Function}} notifier 订阅消息发送 port（生产 = lib/ports/notifier 适配器, 测试 = Spy）
 */
function createMealEngine(store, clock = { now: () => Date.now() }, notifier = NOOP_NOTIFIER) {
  return { initiate, viewMeal, placeOrder, copyLastSelection, closeEarly, scanDue }

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

  // placeOrder(mealId, openid, {dishes, note, subscribed?}, {nickname, now, templateId?}):
  // subscribed 属 T9 授权领地: 布尔表示本次提交的订阅授权结果(undefined=旧调用方, 不记账);
  // templateId 由入口壳注入服务端配置的模板 ID(绝不信任客户端, 记账与发送同源);
  // nickname 由入口壳经 users 档案解析(下单即快照, 引擎不查 users)
  async function placeOrder(mealId, openid, { dishes, note, subscribed } = {}, { nickname, now, templateId } = {}) {
    const at = now == null ? clock.now() : now
    // 写命令先跑 close-if-due（T8）: ongoing ∧ now>=deadline → 代截止(claimClose 赢家),
    // 赢家本次命令落 PAST_CUTOFF; 已 closed/prepared(含抢占输家) → MEAL_LOCKED。
    const meal = await openWriteMeal(store, mealId, openid, at, '下单')

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

    const orderDoc = orderDocOf(meal, openid, {
      nickname: nickname || '',
      dishes: kept,
      note: String(note == null ? '' : note).trim(),
      at,
    })
    await store.upsertOrder(orderDoc)
    // 授权记账(折叠): 仅布尔显式结果才落库(undefined 即旧调用方无感);
    // 撞 _id 即「每人每餐只记一条」的原子折叠 —— 已存在(不论 granted 真伪)绝不覆盖
    if (typeof subscribed === 'boolean') {
      await recordSubscribe(store, mealId, openid, { granted: subscribed, templateId, now: at })
    }
    return buildView(store, meal, openid, { dropped, now: at })
  }

  // ── 关闭管线（内部单点: closeIfDue/closeEarly/scanDue 共用, 手动与自动同一实现）──
  // 拒绝码以锁定文档 meal-engine.md 为准: 本守卫当场代截止(赢家) → 调用方落 PAST_CUTOFF;
  // 已 closed/prepared(含抢占输家) → MEAL_LOCKED。issue #8 AC 写 MEAL_CLOSED 与文档不一致,
  // 文档优先, 引擎不产生 MEAL_CLOSED 码(差异说明见 meal-engine.md 错误模式, 先例: T6 DISH_REMOVED)。
  async function closePipeline(store, mealId, now, requireDue) {
    const { updated } = await store.claimClose(mealId, { now, requireDue })
    const meal = await store.getMeal(mealId)
    if (updated !== 1) return { won: false, meal }
    // 赢家: 读全量订单 → buildSummary(全量传参含软删) → 写 meals.summary 物化快照
    // (崩溃窗口下 summary 缺失 → 前端容错空清单, 见 meal-engine.md)
    const [orders, dishPool] = await Promise.all([store.listOrders(mealId), allDishes(store, meal.family_id)])
    const summary = buildSummary(orders, dishPool, now)
    await store.updateMeal(mealId, { summary })
    // T9 消费段(见 meal-engine.md 关闭管线): 物化后逐条 granted 且未 consumed 的记录,
    // claimGrant 原子抢占(输家跳过) → Notifier.send → 成功才置 sent; 失败不重试、不阻塞
    await consumeSubscribes(store, notifier, { ...meal, summary }, now)
    return { won: true, meal: { ...meal, summary } }
  }

  // ── 复制昨天（T7）: 昨日同 slot 全员副本, fill-only 不覆盖今日已有选点 ──
  // 契约见 meal-engine.md(锁定) + issue #7 AC 差异: 复制范围以文档为准 = 全员副本,
  // AC 中「当前用户…无 → 复制」是 fill-only 判定步骤对每名成员逐人的措辞。
  // 规则: 1) 写命令先跑 close-if-due(赢家落 PAST_CUTOFF, 已锁落 MEAL_LOCKED);
  //       2) 昨日餐次不存在或无人点餐 → NO_YESTERDAY_DATA(非致命, 前端提示);
  //       3) 先对昨日全部订单预校验(不存在/别家菜 → DISH_UNKNOWN 整体拒绝,
  //          保证无部分写入 —— 校验与写入分离, 不受 listOrders 返回顺序影响),
  //          再逐人写入: 今日已有订单(每人每餐一单, 存在即跳过) → 不覆盖;
  //          下架/软删 → 非致命 dropped; 全被过滤 → 不落空单;
  //          note 携带昨日 note 并追加「[复制自昨日]」(溯源);
  //       4) 返回 MealView, copied/dropped 以调用者本人为范围(全员复制照做, 提示只给调用者)。
  async function copyLastSelection(mealId, openid, { now } = {}) {
    const at = now == null ? clock.now() : now
    const meal = await openWriteMeal(store, mealId, openid, at, '复制昨日点选')

    const yesterdayId = `${meal.family_id}:${yesterdayOf(meal.date)}:${meal.slot}`
    const yesterdayMeal = await store.getMeal(yesterdayId)
    if (!yesterdayMeal) throw domainError('NO_YESTERDAY_DATA', '昨天该餐次没人点菜')
    const prevOrders = await store.listOrders(yesterdayId)
    if (prevOrders.length === 0) throw domainError('NO_YESTERDAY_DATA', '昨天该餐次没人点菜')

    // 第一趟: 预校验(无任何写入) —— 校验失败整体拒绝, 保证无部分写入
    const targets = []
    for (const prev of prevOrders) {
      // fill-only: 每人每餐一单(派生 _id=mealId:openid), 今日已有订单的成员跳过不覆盖
      if (await store.getOrder(mealId, prev.user_openid)) continue
      const prevDishes = (prev.dishes || []).map((row) => ({ dishId: row.dish_id, quantity: row.quantity }))
      targets.push({ prev, ...(await resolveDishes(store, meal, prevDishes)) })
    }
    // 第二趟: 逐个写入(校验已全部通过)
    let myCopied = []
    let myDropped = []
    for (const { prev, kept, dropped } of targets) {
      if (prev.user_openid === openid) {
        myCopied = kept.map((row) => ({ dishId: row.dishId, dishName: row.name, quantity: row.quantity }))
        myDropped = dropped // 全被过滤时也随 dropped 提示(不因不落单而丢)
      }
      if (kept.length === 0) continue // 全被过滤 → 不落空单, 过滤结果仍随 dropped 提示
      const prevNote = String(prev.note == null ? '' : prev.note).trim()
      await store.upsertOrder(orderDocOf(meal, prev.user_openid, {
        nickname: String(prev.user_nickname || ''),
        dishes: kept,
        note: `${prevNote}${prevNote ? ' ' : ''}[复制自昨日]`,
        at,
      }))
    }
    return buildView(store, meal, openid, { dropped: myDropped, copied: myCopied, now: at })
  }

  // ── 截止守卫（T8）: 写命令前置 —— ongoing ∧ now>=deadline 时先代截止再按真实状态判定 ──
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

  // ── 写命令前置守卫（placeOrder/copyLastSelection 共用）: close-if-due 后按真实状态判定 ──
  // 赢家(本守卫代截止) → PAST_CUTOFF; 已 closed/prepared(含抢占输家) → MEAL_LOCKED。
  async function openWriteMeal(store, mealId, openid, at, action) {
    const { meal: opened } = await openMeal(store, mealId, openid)
    const guard = await closeIfDue(store, opened, at)
    if (guard.closed) throw domainError('PAST_CUTOFF', `该餐次已截止，无法${action}`)
    const meal = guard.meal
    if (meal.status !== MEAL_ONGOING) throw domainError('MEAL_LOCKED', `该餐次已锁定，无法${action}`)
    return meal
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

// ── 订单文档构建（placeOrder/copyLastSelection 共用）: 派生 _id=mealId:openid, dishes 快照现名
function orderDocOf(meal, openid, { nickname, dishes, note, at }) {
  return {
    _id: `${meal._id}:${openid}`,
    meal_id: meal._id,
    family_id: meal.family_id,
    user_openid: openid,
    user_nickname: nickname,
    dishes: dishes.map((row) => ({ dish_id: row.dishId, name: row.name, quantity: row.quantity })),
    note,
    created_at: at,
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

// ── 订阅授权记账(折叠): 每人每餐至多一条, 以先到者为准, 不可覆盖 ──
// 原子性靠派生 _id(mealId:openid) 撞键裁决, 不做查-读-写两步(并发下单也只会落一条);
// 折叠语义(见 ADR-0002): 已存在记录无论 granted 真伪都原样保留 —— 已授权不被降级
// (不再覆盖 granted=false), 已拒绝也不因后来点头而反转(漏授权不再补发)。
async function recordSubscribe(store, mealId, openid, { granted, templateId, now }) {
  try {
    await store.addSubscribe({
      _id: `${mealId}:${openid}`,
      meal_id: mealId,
      user_openid: openid,
      template_id: templateId || '',
      granted,
      granted_at: now,
      consumed: false,
      sent: false,
    })
  } catch (err) {
    if (err && err.code === 'DUPLICATE_KEY') return // 已存在 → 折叠, 不覆盖任何字段
    throw err
  }
}

// ── 订阅消费(at-most-once): 截止赢家遍历 granted ∧ 未 consumed 记录逐个发送 ──
// 语义(ADR-0002「宁丢勿重」+ issue #9 AC):
//   1. claimGrant 条件更新抢占(consumed=false→true) —— 输家直接跳过, 发送只由赢家做;
//   2. notifier.send 按记录自身 template_id(授权时记账的模板, 与客户端授权同源);
//   3. 只有 send 返回 ok 才置 sent:true + sent_at; 失败/未配置/异常一律原样留下
//      (consumed=true, sent=false) 不重试 —— 宁可漏发也不重复打扰;
//   4. 恒不阻塞截止: 任何发送失败都不向上抛(记录已 consumed, 下轮扫描零残留)。
// 消息内容契约(模板字段映射见 config 部署说明): data = {thing1: 家庭名称, thing2: 餐次文案+已截止,
// thing3: 备餐清单摘要}; page 直达餐次页。微信 thing 字段上限 20 字符(超长发送报 47001),
// 名称与摘要统一 capText 截断兜底。
async function consumeSubscribes(store, notifier, meal, now) {
  const family = await store.getFamily(meal.family_id)
  const familyName = capText((family && family.name) || '', 20)
  const pending = await store.listSubscribes(meal._id, { granted: true, consumed: false })
  for (const row of pending) {
    const { updated } = await store.claimGrant(meal._id, row.user_openid, now)
    if (updated !== 1) continue // 抢占输家: 他人已在发送/已发送, 本路径不做任何事
    let result
    try {
      result = await notifier.send({
        openid: row.user_openid,
        templateId: row.template_id,
        page: `pages/meal/meal?mealId=${meal._id}`,
        data: {
          thing1: familyName,
          thing2: `${SLOT_LABELS[meal.slot] || meal.slot}已截止`,
          thing3: summaryText(meal.summary),
        },
      })
    } catch (err) {
      // 适配器契约本该折叠不抛, 这里兜底: 异常等同失败, 不阻塞后续成员
      result = { ok: false, message: err && err.message }
    }
    if (result && result.ok) {
      await store.updateSubscribe(meal._id, row.user_openid, { sent: true, sent_at: now })
    } else {
      // 失败/未配置模板: 原样留下 + 适配器已记日志; 不自动重试(宁丢勿重)
    }
  }
}

// 备餐清单摘要: 物化快照 byDish 逐条「菜名 ×总数」, 无记录给兜底文案(崩溃窗口容错)
function summaryText(summary) {
  const rows = summary && Array.isArray(summary.byDish) ? summary.byDish : []
  if (rows.length === 0) return '暂无备餐记录'
  return capText(rows.map((r) => `${r.dishName} ×${r.totalQuantity}`).join('、'), 20)
}

// 微信订阅消息 thing 字段 20 字符上限的截断兜底(超长发送会被微信拒收 count 为失败)
function capText(text, max) {
  if (text == null || text.length <= max) return String(text == null ? '' : text)
  return `${text.slice(0, max - 1)}…`
}

// ── 视图: initiate/viewMeal/placeOrder/copyLastSelection 共用同一构建(餐次页单路径) ──
// copied: copyLastSelection 特有(调用者本人的复制清单), 其余命令恒空 —— 形状稳定供前端透传
async function buildView(store, meal, openid, { dropped = [], copied = [], now } = {}) {
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

  // T9: 本餐当前用户订阅授权记录查询 —— 有记录(无论 granted 真伪)即 true,
  // 前端据此只弹一次授权窗(granted:false 也折叠不再打扰, 见 ADR-0002)
  const granted = !!(await store.getSubscribe(meal._id, openid))

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
    granted,
    dropped,
    copied,
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

// 昨日定位: 日期字符串向前偏移(本地时区语义, 与 deadlineOf/localDateOf 同源) —— copyLastSelection 用
function yesterdayOf(date) {
  return localDateOf(new Date(`${date}T00:00:00`).getTime() - 86400000)
}

function domainError(code, message) {
  const err = new Error(message)
  err.code = code
  return err
}

module.exports = { createMealEngine }