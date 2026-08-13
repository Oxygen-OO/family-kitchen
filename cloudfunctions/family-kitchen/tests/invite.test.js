'use strict'

const { test } = require('node:test')
const assert = require('node:assert/strict')

const {
  parseInviteScene,
  resolveInviteCode,
  pickValidInviteCode,
  createInviteFlow,
  isTerminalFailure,
  showInviteResult,
} = require('../../../miniprogram/utils/invite.js')

// ── 冷启动 scene 解析 ──

test('parseInviteScene: 标准 invite_ABC123 解析出邀请码', () => {
  assert.equal(parseInviteScene('invite_ABC123'), 'ABC123')
})

test('parseInviteScene: URL 编码场景先解码再解析', () => {
  assert.equal(parseInviteScene('invite%5FABC123'), 'ABC123')
})

test('parseInviteScene: 小写邀请码归一为大写', () => {
  assert.equal(parseInviteScene('invite_abc123'), 'ABC123')
})

test('parseInviteScene: 空值/非邀请格式返回 null', () => {
  assert.equal(parseInviteScene(null), null)
  assert.equal(parseInviteScene(''), null)
  assert.equal(parseInviteScene('join_ABC123'), null)
  assert.equal(parseInviteScene('invite_ABC12'), null)
  assert.equal(parseInviteScene('invite_ABC1234'), null)
  assert.equal(parseInviteScene('invite_AB!123'), null)
})

test('parseInviteScene: 解码失败的乱码场景不抛异常, 返回 null', () => {
  assert.equal(parseInviteScene('invite_%ZZ%'), null)
})

// ── scene 与 query 双通道 ──

test('resolveInviteCode: scene 通道优先解析', () => {
  assert.equal(resolveInviteCode({ scene: 'invite_ABC123' }), 'ABC123')
})

test('resolveInviteCode: scene 缺失/无效时降级 query 通道(?invite_code=)', () => {
  assert.equal(resolveInviteCode({ invite_code: 'abc123' }), 'ABC123')
  assert.equal(resolveInviteCode({ scene: 'garbage', invite_code: 'XYZ789' }), 'XYZ789')
})

test('resolveInviteCode: 双通道都携带时 scene 胜出', () => {
  assert.equal(resolveInviteCode({ scene: 'invite_ABC123', invite_code: 'XYZ789' }), 'ABC123')
})

test('resolveInviteCode: 无通道/畸形值返回 null', () => {
  assert.equal(resolveInviteCode({}), null)
  assert.equal(resolveInviteCode(null), null)
  assert.equal(resolveInviteCode({ scene: 'invite_AB' }), null)
  assert.equal(resolveInviteCode({ invite_code: '12345' }), null)
  assert.equal(resolveInviteCode({ invite_code: 'ABCDEF1' }), null)
})

// ── 分享卡片取码: 缓存有效码优先, 无则重新生成 ──

const FAMILY = {
  family_id: 'fam-1',
  name: '老王家',
  status: 'active',
  invite_code: 'ABC123',
  expires_at: 2000,
}

test('pickValidInviteCode: 命中当前活跃家庭的未过期邀请码', () => {
  assert.equal(pickValidInviteCode([FAMILY], 'fam-1', 1000), 'ABC123')
})

test('pickValidInviteCode: 邀请码已过期 → null(需重新生成)', () => {
  assert.equal(pickValidInviteCode([{ ...FAMILY, expires_at: 500 }], 'fam-1', 1000), null)
})

test('pickValidInviteCode: 冻结家庭/非当前家庭/无该家庭 → null', () => {
  assert.equal(pickValidInviteCode([{ ...FAMILY, status: 'frozen' }], 'fam-1', 1000), null)
  assert.equal(pickValidInviteCode([FAMILY], 'fam-2', 1000), null)
  assert.equal(pickValidInviteCode([], 'fam-1', 1000), null)
  assert.equal(pickValidInviteCode(null, 'fam-1', 1000), null)
})

test('pickValidInviteCode: 畸形邀请码 → null', () => {
  assert.equal(pickValidInviteCode([{ ...FAMILY, invite_code: '' }], 'fam-1', 1000), null)
  assert.equal(pickValidInviteCode([{ ...FAMILY, invite_code: 'abc' }], 'fam-1', 1000), null)
})

// ── 入伙分流: 登录 → joinByCode → 分流结果 ──

function flowHarness({ joinImpl, bootImpl } = {}) {
  const calls = []
  const api = {
    async joinByCode(code) {
      calls.push(`join:${code}`)
      if (joinImpl) return joinImpl()
      return { family_id: 'fam-9', name: '老王家', status: 'active' }
    },
  }
  const boot = async () => {
    calls.push('boot')
    if (bootImpl) return bootImpl()
    return { route: 'home' }
  }
  const setCurrentFamily = (id) => calls.push(`setCurrent:${id}`)
  const refreshSession = async () => calls.push('refresh')
  const flow = createInviteFlow({ api, boot, setCurrentFamily, refreshSession })
  return { flow, calls }
}

test('分流-joined: 登录(boot) → joinByCode → 切换当前家庭 → 刷新会话缓存', async () => {
  const { flow, calls } = flowHarness()
  const result = await flow.joinFromInvite('ABC123')

  assert.equal(result.status, 'joined')
  assert.equal(result.family.name, '老王家')
  assert.deepEqual(calls, ['boot', 'join:ABC123', 'setCurrent:fam-9', 'refresh'])
})

test('分流-already: ALREADY_MEMBER 不切换不刷新, 直接回 already', async () => {
  const { flow, calls } = flowHarness({
    joinImpl: () => {
      const err = new Error('你已在该家庭中')
      err.code = 'ALREADY_MEMBER'
      throw err
    },
  })
  const result = await flow.joinFromInvite('ABC123')

  assert.equal(result.status, 'already')
  assert.deepEqual(calls, ['boot', 'join:ABC123'])
})

for (const [code, message] of [
  ['INVITE_EXPIRED', '邀请码已过期，请让家人重新生成'],
  ['FAMILY_FULL', '家庭已满 5 人'],
  ['USER_FAMILY_CAP', '每人最多加入 3 个家庭'],
  ['INVITE_NOT_FOUND', '邀请码不存在或已失效'],
]) {
  test(`分流-failed(${code}): 失败原因透传, 不切换不刷新`, async () => {
    const { flow, calls } = flowHarness({
      joinImpl: () => {
        const err = new Error(message)
        err.code = code
        throw err
      },
    })
    const result = await flow.joinFromInvite('ABC123')

    assert.equal(result.status, 'failed')
    assert.equal(result.code, code)
    assert.equal(result.message, message)
    assert.deepEqual(calls, ['boot', 'join:ABC123'])
  })
}

test('分流-failed(无错误码): 归一 INTERNAL, 保留原因文案', async () => {
  const { flow, calls } = flowHarness({
    joinImpl: () => {
      throw new Error('network down')
    },
  })
  const result = await flow.joinFromInvite('ABC123')

  assert.equal(result.status, 'failed')
  assert.equal(result.code, 'INTERNAL')
  assert.equal(result.message, 'network down')
  assert.deepEqual(calls, ['boot', 'join:ABC123'])
})

test('分流-未登录(boot 失败): 登录失败即止, 不调 joinByCode', async () => {
  const { flow, calls } = flowHarness({
    bootImpl: () => {
      const err = new Error('登录失败')
      err.code = 'AUTH_FAILED'
      throw err
    },
  })
  const result = await flow.joinFromInvite('ABC123')

  assert.equal(result.status, 'failed')
  assert.equal(result.code, 'AUTH_FAILED')
  assert.equal(result.message, '登录失败')
  assert.deepEqual(calls, ['boot'])
})

// ── 分流 UI 映射(两页共用) ──

function uiHarness({ alreadyAtHome = false } = {}) {
  const calls = []
  const ui = {
    toast: (title) => calls.push(`toast:${title}`),
    modal: (title, content) => calls.push(`modal:${title}:${content}`),
    go: (url) => calls.push(`go:${url}`),
    alreadyAtHome,
  }
  return { ui, calls }
}

test('showInviteResult-joined: toast 家庭名 + 进入菜品页', () => {
  const { ui, calls } = uiHarness()
  showInviteResult({ status: 'joined', family: { name: '老王家' } }, ui)
  assert.deepEqual(calls, ['toast:你已成为 老王家 的成员', 'go:/pages/dishes/dishes'])
})

test('showInviteResult-already: toast + 回首页; alreadyAtHome 时不跳转', () => {
  const away = uiHarness()
  showInviteResult({ status: 'already' }, away.ui)
  assert.deepEqual(away.calls, ['toast:你已在该家庭中', 'go:/pages/index/index'])

  const home = uiHarness({ alreadyAtHome: true })
  showInviteResult({ status: 'already' }, home.ui)
  assert.deepEqual(home.calls, ['toast:你已在该家庭中'])
})

test('showInviteResult-failed: 弹窗透传具体原因, 不跳转', () => {
  const { ui, calls } = uiHarness()
  showInviteResult({ status: 'failed', code: 'INVITE_EXPIRED', message: '邀请码已过期，请让家人重新生成' }, ui)
  assert.deepEqual(calls, ['modal:无法加入:邀请码已过期，请让家人重新生成'])
})

test('isTerminalFailure: 域错误码确定失败, 网络/内部错误可重试', () => {
  for (const code of ['INVITE_EXPIRED', 'FAMILY_FULL', 'USER_FAMILY_CAP', 'INVITE_NOT_FOUND']) {
    assert.equal(isTerminalFailure({ status: 'failed', code }), true, code)
  }
  assert.equal(isTerminalFailure({ status: 'failed', code: 'INTERNAL' }), false)
  assert.equal(isTerminalFailure({ status: 'failed', code: 'AUTH_FAILED' }), false)
  assert.equal(isTerminalFailure({ status: 'joined' }), false)
  assert.equal(isTerminalFailure({ status: 'already' }), false)
})
