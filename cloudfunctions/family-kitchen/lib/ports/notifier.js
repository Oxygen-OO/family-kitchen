'use strict'

// ports: 订阅消息发送适配器 —— 全仓库唯一触碰微信订阅消息 API 的地方。
// 依赖注入(不 import wx-server-sdk, db.js 仍是唯一 SDK 触点): 入口壳接
// createSubscribeNotifier({ send: cloud.openapi.subscribeMessage.send, log: console.log })。
// 契约(引擎调用方见 docs/design/meal-engine.md「关闭管线」消费段):
//   await notifier.send({openid, templateId, page, data})
//     → 恒不抛: {ok:true} | {ok:false, skipped:'not_configured'} | {ok:false, code, message}
// 外部依赖(issue #9 备注): 一次性订阅模板 ID 需在 mp.weixin.qq.com 后台申请
// (个人主体可申请一次性订阅); 未配置 → 跳过不发送并留日志, 绝不触碰真接口。
// 配额约束(ADR-0002): 授权一次 = 下发一条, 「宁丢勿重」——失败不重试, 由引擎层处理。

function createSubscribeNotifier({ send, log }) {
  if (typeof send !== 'function') throw new Error('createSubscribeNotifier 需要注入 send')
  const logger = typeof log === 'function' ? log : () => {}

  return {
    // templateId 为空(= 服务端 config SUBSCRIBE_TEMPLATE_ID 未配置) → 未配置跳过 + 日志
    async send({ openid, templateId, page, data }) {
      if (!templateId) {
        logger('[subscribe-notifier] 模板 ID 未配置(SUBSCRIBE_TEMPLATE_ID), 跳过订阅发送', {
          openid,
          page,
        })
        return { ok: false, skipped: 'not_configured' }
      }
      try {
        await send({
          touser: openid,
          templateId,
          page,
          data,
          miniprogramState: 'formal',
        })
        return { ok: true }
      } catch (err) {
        // 失败不自动重试(宁丢勿重): 原样折叠 + 日志, 引擎侧已 consumed 的记录不再回滚
        logger('[subscribe-notifier] 订阅消息发送失败, 不重试', {
          openid,
          templateId,
          error: err && (err.errMsg || err.message || String(err)),
          errcode: err && (err.errcode || err.errCode),
        })
        return { ok: false, code: err && (err.errcode || err.errCode), message: err && err.message }
      }
    },
  }
}

module.exports = { createSubscribeNotifier }