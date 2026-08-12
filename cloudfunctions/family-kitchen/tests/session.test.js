'use strict'

const { test } = require('node:test')
const assert = require('node:assert/strict')

const { createSession, STORAGE_KEY } = require('../../../miniprogram/utils/session.js')

const OPENID = 'openid-mama'

function memoryStorage(initial = {}) {
  const data = { ...initial }
  return {
    get: (key) => (key in data ? data[key] : null),
    set: (key, value) => {
      data[key] = value
    },
    remove: (key) => {
      delete data[key]
    },
    dump: () => ({ ...data }),
  }
}

function fakeApi({ userExists = true, route = 'onboarding', startupImpl, startupResult } = {}) {
  const calls = []
  return {
    calls,
    async getCode() {
      calls.push('getCode')
      return 'wx-code-1'
    },
    async loginByCode(code) {
      calls.push(`loginByCode:${code}`)
      if (!userExists) {
        const err = new Error('user missing')
        err.code = 'USER_NOT_FOUND'
        throw err
      }
      return { openid: OPENID, isNew: true, user: { nickname: '', avatar: '', created_at: 1000 } }
    },
    async startup() {
      calls.push('startup')
      if (startupImpl) return startupImpl()
      if (startupResult) return startupResult
      return { route, user: { nickname: '', avatar: '', created_at: 1000 } }
    },
  }
}

test('冷启动无缓存: wx.login 取 code → loginByCode → 写缓存 → startup, 返回会话', async () => {
  const storage = memoryStorage()
  const api = fakeApi()
  const session = createSession({ storage, api })

  const result = await session.coldStart()

  assert.deepEqual(api.calls, ['getCode', 'loginByCode:wx-code-1', 'startup'])
  assert.equal(storage.get(STORAGE_KEY), OPENID)
  assert.equal(result.openid, OPENID)
  assert.equal(result.route, 'onboarding')
  assert.equal(result.isNew, true)
})

test('冷启动有缓存: 优先读缓存再校验, 不重新 login, startup 判定路由', async () => {
  const storage = memoryStorage({ [STORAGE_KEY]: OPENID })
  const api = fakeApi({ route: 'home', startupResult: { user: { nickname: '', avatar: '', created_at: 1000 }, route: 'home', families: [{ family_id: 'fam-1', role: 'member', joined_at: 2000 }] } })
  const session = createSession({ storage, api })

  const result = await session.coldStart()

  assert.deepEqual(api.calls, ['startup'])
  assert.equal(result.route, 'home')
  assert.equal(result.isNew, false)
  assert.equal(storage.get(STORAGE_KEY), OPENID)
  assert.equal(result.families[0].family_id, 'fam-1')
})

test('冷启动缓存失效(USER_NOT_FOUND): 静默重登并覆盖缓存, 不向用户报错', async () => {
  const storage = memoryStorage({ [STORAGE_KEY]: OPENID })
  let failOnce = true
  const api = fakeApi({
    startupImpl: () => {
      if (failOnce) {
        failOnce = false
        const err = new Error('stale')
        err.code = 'USER_NOT_FOUND'
        throw err
      }
      return { route: 'onboarding', user: { nickname: '', avatar: '', created_at: 1000 } }
    },
  })
  const session = createSession({ storage, api })

  const result = await session.coldStart()

  assert.deepEqual(api.calls, ['startup', 'getCode', 'loginByCode:wx-code-1', 'startup'])
  assert.equal(storage.get(STORAGE_KEY), OPENID)
  assert.equal(result.isNew, true)
})

test('冷启动有缓存但 startup 网络错误: 错误透传, 不写缓存, 不重登', async () => {
  const storage = memoryStorage({ [STORAGE_KEY]: OPENID })
  const api = fakeApi({
    startupImpl: () => {
      const err = new Error('network down')
      err.code = 'NETWORK'
      throw err
    },
  })
  const session = createSession({ storage, api })

  await assert.rejects(() => session.coldStart(), (err) => err.code === 'NETWORK')
  assert.deepEqual(api.calls, ['startup'])
})

test('onShow 兜底: 缓存完好时不发任何请求', async () => {
  const storage = memoryStorage({ [STORAGE_KEY]: OPENID })
  const api = fakeApi()
  const session = createSession({ storage, api })

  const result = await session.onShowGuard()

  assert.deepEqual(api.calls, [])
  assert.equal(result, null)
})

test('onShow 兜底: 缓存丢失时静默重登(login+startup+写缓存)', async () => {
  const storage = memoryStorage()
  const api = fakeApi()
  const session = createSession({ storage, api })

  const result = await session.onShowGuard()

  assert.deepEqual(api.calls, ['getCode', 'loginByCode:wx-code-1', 'startup'])
  assert.equal(storage.get(STORAGE_KEY), OPENID)
  assert.equal(result.openid, OPENID)
})

test('loginByCode 失败: 错误原样透传(客户端决定提示), 缓存保持未写入', async () => {
  const storage = memoryStorage()
  const api = fakeApi()
  api.loginByCode = async () => {
    const err = new Error('tenant mismatch')
    err.code = 'AUTH_FAILED'
    throw err
  }
  const session = createSession({ storage, api })

  await assert.rejects(() => session.coldStart(), (err) => err.code === 'AUTH_FAILED')
  assert.equal(storage.get(STORAGE_KEY), null)
})