'use strict'

const cloud = require('wx-server-sdk')

cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV })

const { createIdentityEngine } = require('./lib/identity/index.js')
const { createIdentityStore } = require('./lib/ports/db.js')

const identity = createIdentityEngine(createIdentityStore(cloud.database()))

// action 路由表：入口壳只做白名单校验 + openid 解析 + 路由 + 错误翻译，不承载规则。
const actions = {
  login: (event) => identity.login(event.__openid, { now: Date.now() }),
  saveProfile: (event) => identity.saveProfile(event.__openid, {
    nickname: event.nickname,
    avatar: event.avatar,
  }),
  startup: (event) => identity.startup(event.__openid),
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