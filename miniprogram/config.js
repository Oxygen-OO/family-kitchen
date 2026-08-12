'use strict'

// 云环境 ID：'' 表示使用账号默认环境，部署时按需填写。
const CLOUD_ENV = ''

// ⚠️ 上线前必读(issue #9 外部依赖): 点餐授权弹窗用的一次性订阅模板 ID。
// 需先在 mp.weixin.qq.com 小程序后台「订阅消息」申请(个人主体可申请一次性订阅),
// 模板须含「家庭名称 / 餐次+截止状态 / 备餐清单摘要」三个字段, 见
// cloudfunctions/family-kitchen/config.js 的字段对照表。此 ID 与服务端
// SUBSCRIBE_TEMPLATE_ID 必须一致(前者申请授权, 后者发送)。留空 = 不弹授权窗。
const SUBSCRIBE_TEMPLATE_ID = ''

module.exports = { CLOUD_ENV, SUBSCRIBE_TEMPLATE_ID }