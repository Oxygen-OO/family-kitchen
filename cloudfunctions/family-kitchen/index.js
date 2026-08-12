'use strict'

const cloud = require('wx-server-sdk')

cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV })

const { createIdentityEngine } = require('./lib/identity/index.js')
const { createFamilyEngine } = require('./lib/family-engine/index.js')
const { createIdentityStore, createFamilyStore } = require('./lib/ports/db.js')

const db = cloud.database()
const identityStore = createIdentityStore(db)
const identity = createIdentityEngine(identityStore)
const family = createFamilyEngine(createFamilyStore(db), { now: () => Date.now() })

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

exports.main = async (event) => {
  const action = event && event.action
  const fn = actions[action]
  if (!fn) return { ok: false, error: { code: 'ACTION_NOT_FOUND', message: `未知 action: ${action}` } }
  try {
    const data = await fn({ ...event, __openid: openidOf() })
    return { ok: true, data }
  } catch (err) {
    const code = err && err.code ? err.code : 'INTERNAL'
    const message = err && err.message ? err.message : '内部错误'
    return { ok: false, error: { code, message } }
  }
}