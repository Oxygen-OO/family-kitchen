'use strict'

const STORAGE_KEY = 'fk_openid'

/**
 * 客户端会话模块：冷启动缓存优先 + onShow 兜底静默重登。零 wx API，依赖注入。
 * 契约见 docs/design/identity.md「客户端会话」。
 * @param {{get: Function, set: Function, remove: Function}} storage wx.getStorageSync 族
 * @param {{getCode: Function, loginByCode: Function, startup: Function}} api
 *   getCode: 微信 wx.login 取 code;
 *   loginByCode(code): 云函数 login action → {openid, isNew, user};
 *   startup(): 云函数 startup action → {route, user, families?}
 */
function createSession({ storage, api }) {
  return { coldStart, onShowGuard }

  async function coldStart() {
    const cached = storage.get(STORAGE_KEY)
    if (cached) {
      try {
        const res = await api.startup()
        return { openid: cached, route: res.route, user: res.user, families: res.families, isNew: false }
      } catch (err) {
        if (!err || err.code !== 'USER_NOT_FOUND') throw err
      }
    }
    return silentRelogin()
  }

  async function onShowGuard() {
    if (storage.get(STORAGE_KEY)) return null
    return silentRelogin()
  }

  async function silentRelogin() {
    const code = await api.getCode()
    const { openid, isNew } = await api.loginByCode(code)
    storage.set(STORAGE_KEY, openid)
    const { route, user, families } = await api.startup()
    return { openid, route, user, families, isNew }
  }
}

module.exports = { createSession, STORAGE_KEY }