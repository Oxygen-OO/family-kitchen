'use strict'

// ⚠️ 上线前必读(issue #9 外部依赖): 订阅消息使用「一次性订阅」模板,
// 模板 ID 需先在 mp.weixin.qq.com 小程序后台「订阅消息」申请(个人主体可申请一次性订阅)。
// 申请到的模板须含三个字段, 与消息数据契约一一对应:
//   字段1(thing 类) ← 家庭名称(thing1)
//   字段2(thing 类) ← 餐次文案+截止状态, 如「早餐已截止」(thing2)
//   字段3(thing 类) ← 备餐清单摘要, 如「番茄炒蛋 ×2、韭菜炒蛋 ×1」(thing3)
// 页面路径直达餐次页 pages/meal/meal?mealId=...
// 未配置(留空)时关闭管线照常截止, 仅跳过发送并记日志(宁丢勿重, ADR-0002)。
// ⚠️ 注意: 未配置期间的授权记录在截止时仍会被抢占 consumed(发送权失效, 失败不重试),
// 事后补配模板不会补发 —— 请务必在正式启用前申请好模板 ID 填入此处, 以免误烧授权配额。
// 服务端模板 ID: 优先读云函数环境变量 SUBSCRIBE_TEMPLATE_ID(控制台「云函数 → 配置」),
// 亦可直接在此填入常量。注意与 miniprogram/config.js 的 SUBSCRIBE_TEMPLATE_ID
// 保持同 ID —— 前者用于发送, 后者用于前端申请授权, 两处必须一致。
const SUBSCRIBE_TEMPLATE_ID = process.env.SUBSCRIBE_TEMPLATE_ID || ''

module.exports = { SUBSCRIBE_TEMPLATE_ID }