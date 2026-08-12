'use strict'

const { test } = require('node:test')
const assert = require('node:assert/strict')

const { createSubscribeNotifier } = require('../lib/ports/notifier.js')

// T9 订阅发送适配器(生产 port, 唯一触碰微信订阅消息 API 的地方)。
// 依赖注入 send/log: 生产接 cloud.openapi.subscribeMessage.send + console.log,
// 测试用假 send + 记录日志 —— 单测永不触真微信接口(架构: lib/ports 是唯一外部 seam)。
// 契约: 未配置模板 ID → 跳过+日志不发送; 失败 → 折叠 {ok:false} 记日志不抛(宁丢勿重)。

function makeSpy({ failWith } = {}) {
  const calls = []
  const logs = []
  const send = async (payload) => {
    calls.push(payload)
    if (failWith) throw failWith
  }
  return { calls, logs, send, log: (msg, extra) => logs.push({ msg, extra }) }
}

test('notifier: 未配置模板 ID(空/缺省) → 跳过, 不触发送, 记日志, 返回 {ok:false, skipped}', async () => {
  const spy = makeSpy()
  const notifier = createSubscribeNotifier({ send: spy.send, log: spy.log })

  const result = await notifier.send({ openid: 'openid-mama', templateId: '', page: 'pages/meal/meal', data: {} })

  assert.deepEqual(result, { ok: false, skipped: 'not_configured' })
  assert.equal(spy.calls.length, 0, '空模板 ID 绝不调用微信发送接口')
  assert.ok(spy.logs.length >= 1, '跳过必须留日志(部署排查依据)')
  assert.match(spy.logs[0].msg, /未配置|模板/, '日志点名原因')
})

test('notifier: 配置了模板 ID → 原样透传 touser/templateId/page/data, 附加 miniprogramState 正式版', async () => {
  const spy = makeSpy()
  const notifier = createSubscribeNotifier({ send: spy.send, log: spy.log })

  const result = await notifier.send({
    openid: 'openid-baba',
    templateId: 'TPL-ABC123',
    page: 'pages/meal/meal?mealId=m1',
    data: { thing1: '快乐一家', thing2: '早餐已截止', thing3: '番茄炒蛋 ×2' },
  })

  assert.deepEqual(result, { ok: true })
  assert.equal(spy.calls.length, 1)
  assert.deepEqual(spy.calls[0], {
    touser: 'openid-baba',
    templateId: 'TPL-ABC123',
    page: 'pages/meal/meal?mealId=m1',
    data: { thing1: '快乐一家', thing2: '早餐已截止', thing3: '番茄炒蛋 ×2' },
    miniprogramState: 'formal',
  })
})

test('notifier: 发送抛错(真接口失败/网络异常) → 折叠 {ok:false} 记日志, 不向上抛(截止管线不阻塞)', async () => {
  const err = new Error('43101 用户拒收订阅消息')
  err.errcode = 43101
  const spy = makeSpy({ failWith: err })
  const notifier = createSubscribeNotifier({ send: spy.send, log: spy.log })

  const result = await notifier.send({ openid: 'openid-mama', templateId: 'TPL-1', page: 'x', data: {} })

  assert.equal(result.ok, false, '失败折叠而非抛出')
  assert.equal(result.code, 43101, '透传微信 errcode 供日志/分析')
  assert.ok(spy.logs.length >= 1, '失败必须记日志')
  assert.equal(spy.calls.length, 1)
})

test('notifier: 发送成功 → {ok:true}, 不记失败日志', async () => {
  const spy = makeSpy()
  const notifier = createSubscribeNotifier({ send: spy.send, log: spy.log })

  const result = await notifier.send({ openid: 'openid-mama', templateId: 'TPL-1', page: 'x', data: {} })

  assert.deepEqual(result, { ok: true })
  assert.equal(spy.logs.length, 0)
})