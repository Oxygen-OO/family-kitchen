'use strict'

const cloud = require('wx-server-sdk')

cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV })

const { createIdentityEngine } = require('./lib/identity/index.js')
const { createFamilyEngine } = require('./lib/family-engine/index.js')
const { createDishEngine } = require('./lib/dish-engine/index.js')
const { createMealEngine } = require('./lib/meal-engine/index.js')
const { createIdentityStore, createFamilyStore, createDishStore, createMealStore } = require('./lib/ports/db.js')
const { createSubscribeNotifier } = require('./lib/ports/notifier.js')
const { SUBSCRIBE_TEMPLATE_ID } = require('./config.js')

const db = cloud.database()
const identityStore = createIdentityStore(db)
const identity = createIdentityEngine(identityStore)
const family = createFamilyEngine(createFamilyStore(db), { now: () => Date.now() })
const dish = createDishEngine(createDishStore(db), { now: () => Date.now() })
const meal = createMealEngine(
  createMealStore(db),
  { now: () => Date.now() },
  // 订阅消息适配器: 全仓库唯一触碰 cloud.openapi.subscribeMessage 的地方;
  // 模板 ID 走 config(未配置 → 跳过+日志, 见 config.js 部署说明)
  createSubscribeNotifier({ send: cloud.openapi.subscribeMessage.send, log: console.log })
)

// 昵称一律取 users 档案（T1 查询能力），不信任客户端自称；顺带校验登录态
async function userByOpenid(openid) {
  const user = await identityStore.getUser(openid)
  if (!user) {
    const err = new Error('用户不存在，登录态已失效')
    err.code = 'USER_NOT_FOUND'
    throw err
  }
  return user
}

// action 路由表：入口壳只做白名单校验 + openid 解析 + 路由 + 错误翻译，不承载规则。
const actions = {
  login: (event) => identity.login(event.__openid, { now: Date.now() }),
  saveProfile: (event) => identity.saveProfile(event.__openid, {
    nickname: event.nickname,
    avatar: event.avatar,
  }),
  startup: (event) => identity.startup(event.__openid),
  createFamily: async (event) => {
    const user = await userByOpenid(event.__openid)
    return family.createFamily({ openid: event.__openid, nickname: user.nickname, name: event.name })
  },
  joinByCode: async (event) => {
    const user = await userByOpenid(event.__openid)
    return family.joinByCode({ code: event.code }, event.__openid, {
      nickname: user.nickname,
      now: Date.now(),
    })
  },
  myFamilies: (event) => family.myFamilies(event.__openid),
  generateInviteCode: (event) => family.generateInviteCode(
    { familyId: event.familyId },
    event.__openid,
    { now: Date.now() }
  ),
  listMembers: (event) => family.listMembers({ familyId: event.familyId }, event.__openid),
  leaveFamily: (event) => family.leaveFamily({ familyId: event.familyId }, event.__openid),
  transferOwnership: (event) => family.transferOwnership(
    { familyId: event.familyId },
    event.__openid,
    event.toOpenid
  ),
  dissolveFamily: (event) => family.dissolveFamily({ familyId: event.familyId }, event.__openid),
  listDishes: (event) => dish.listDishes({ familyId: event.familyId }, event.__openid),
  listRemovedDishes: (event) => dish.listRemovedDishes({ familyId: event.familyId }, event.__openid),
  createDish: (event) => dish.createDish({
    familyId: event.familyId,
    name: event.name,
    image: event.image,
    description: event.description,
    ingredients: event.ingredients,
    tags: event.tags,
  }, event.__openid),
  updateDish: (event) => dish.updateDish({
    familyId: event.familyId,
    dishId: event.dishId,
    name: event.name,
    image: event.image,
    description: event.description,
    ingredients: event.ingredients,
    tags: event.tags,
  }, event.__openid),
  setDishAvailable: (event) => dish.setDishAvailable({
    familyId: event.familyId,
    dishId: event.dishId,
    isAvailable: event.isAvailable,
  }, event.__openid),
  deleteDish: (event) => dish.deleteDish({ familyId: event.familyId, dishId: event.dishId }, event.__openid),
  restoreDish: (event) => dish.restoreDish({ familyId: event.familyId, dishId: event.dishId }, event.__openid),
  initiate: (event) => meal.initiate({
    familyId: event.familyId,
    date: event.date,
    slot: event.slot,
  }, event.__openid, { deadline: event.deadline, now: Date.now() }),
  viewMeal: (event) => meal.viewMeal(event.mealId, event.__openid),
  placeOrder: async (event) => {
    const user = await userByOpenid(event.__openid)
    return meal.placeOrder(
      event.mealId,
      event.__openid,
      // subscribed: 前端授权弹窗结果(布尔), T9 授权记账入参
      { dishes: event.dishes, note: event.note, subscribed: event.subscribed },
      // templateId: 服务端配置注入(绝不信任客户端传值, 记账与发送同源)
      { nickname: user.nickname, now: Date.now(), templateId: SUBSCRIBE_TEMPLATE_ID }
    )
  },
  copyLastSelection: (event) => meal.copyLastSelection(event.mealId, event.__openid, { now: Date.now() }),
  closeEarly: (event) => meal.closeEarly(event.mealId, event.__openid, { now: Date.now() }),
  // cron 定时触发器 action(架构见 architecture.md 部署形态): event 仅含 action, 无 openid
  scanDue: () => meal.scanDue(),
}

function openidOf() {
  // openid 一律经 cloud.getWXContext() 取（云开发语义），绝不信任客户端自称的 openid
  const wxContext = cloud.getWXContext()
  const openid = wxContext && wxContext.OPENID
  if (!openid) {
    const err = new Error('无法解析调用者 openid')
    err.code = 'AUTH_FAILED'
    throw err
  }
  return openid
}

// 系统 action（cron 定时触发器）无用户上下文：getWXContext 的 OPENID 为空, 不能走 openidOf。
const SYSTEM_ACTIONS = ['scanDue']

exports.main = async (event) => {
  const action = event && event.action
  const fn = actions[action]
  if (!fn) return { ok: false, error: { code: 'ACTION_NOT_FOUND', message: `未知 action: ${action}` } }
  try {
    const data = await fn({ ...event, __openid: SYSTEM_ACTIONS.includes(action) ? null : openidOf() })
    return { ok: true, data }
  } catch (err) {
    const code = err && err.code ? err.code : 'INTERNAL'
    const message = err && err.message ? err.message : '内部错误'
    return { ok: false, error: { code, message } }
  }
}