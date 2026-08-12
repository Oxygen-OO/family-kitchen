'use strict'

const { initCloud, api } = require('./utils/api.js')
const { createSession } = require('./utils/session.js')

const storage = {
  get: (key) => {
    const v = wx.getStorageSync(key)
    return v === '' || v == null ? null : v
  },
  set: (key, value) => wx.setStorageSync(key, value),
  remove: (key) => wx.removeStorageSync(key),
}

App({
  onLaunch() {
    initCloud()
    const session = createSession({ storage, api })
    this.session = session
    this.sessionReady = null
  },

  // 冷启动登录(缓存优先, 一次执行): 页面首次 onShow 经此取 {openid, route, user, isNew}
  ensureSession() {
    if (!this.sessionReady) {
      this.sessionReady = this.session
        .coldStart()
        .catch((err) => {
          this.sessionReady = null
          throw err
        })
    }
    return this.sessionReady
  },

  // onShow 兜底: 缓存丢失时静默重登
  async guardSession() {
    try {
      const fresh = await this.session.onShowGuard()
      if (!fresh) return null
      this.sessionReady = Promise.resolve(fresh)
      return fresh
    } catch (err) {
      return null
    }
  },

  // 页面统一启动序列: 兜底重登 → 冷启动会话, 页面只按 route 分流
  async boot() {
    await this.guardSession()
    return this.ensureSession()
  },
})