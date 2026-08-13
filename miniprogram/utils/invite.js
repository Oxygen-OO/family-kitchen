'use strict'

/**
 * 邀请分享纯模块：scene/query 双通道解析 + 分享取码 + 入伙分流。零 wx API。
 * 先例见 utils/session.js（storage+api 注入纯模块）；契约见 issue #11。
 * 分流结果: {status:'joined', family} | {status:'already'} | {status:'failed', code, message}
 */

const CODE_RE = /^[A-Z0-9]{6}$/
const SCENE_RE = /^invite_([A-Z0-9]{6})$/i

// 分享卡片 scene 字符串 URL 解码 → 提取邀请码（invite_ABC123 格式）; 非该格式返回 null
function parseInviteScene(rawScene) {
  if (rawScene == null) return null
  const text = String(rawScene).trim()
  if (!text) return null
  let decoded = text
  try {
    decoded = decodeURIComponent(text)
  } catch (err) {
    // 非 URL 编码的乱码: 原样交给格式校验
  }
  const m = SCENE_RE.exec(decoded)
  return m ? m[1].toUpperCase() : null
}

// 双通道: scene 优先（obsolete 时降级 ?invite_code=ABC123）, 均未命中返回 null
function resolveInviteCode(options) {
  const opts = options || {}
  const fromScene = parseInviteScene(opts.scene)
  if (fromScene) return fromScene
  const fromQuery = String(opts.invite_code == null ? '' : opts.invite_code).trim().toUpperCase()
  return CODE_RE.test(fromQuery) ? fromQuery : null
}

// 分享卡片取码: 当前家庭的未过期邀请码优先, 无有效码返回 null(调用方再经 generateInviteCode 取/生成)
function pickValidInviteCode(families, familyId, now) {
  const family = (families || []).find((f) => f.family_id === familyId && f.status === 'active')
  if (!family) return null
  const code = String(family.invite_code == null ? '' : family.invite_code).trim().toUpperCase()
  if (!CODE_RE.test(code)) return null
  if (typeof family.expires_at !== 'number' || family.expires_at <= now) return null
  return code
}

/**
 * 入伙分流编排: 已登录直接 joinByCode; 未登录先走 T1 登录流程(boot)再自动 joinByCode。
 * @param {{joinByCode: Function}} api
 * @param {Function} boot 登录流程(app.boot, 已登录时为缓存直取)
 * @param {Function} setCurrentFamily 切换当前家庭(fk_family_id 唯一写入点)
 * @param {Function} refreshSession 加入后刷新会话缓存的 families
 */
function createInviteFlow({ api, boot, setCurrentFamily, refreshSession }) {
  return { joinFromInvite }

  async function joinFromInvite(code) {
    try {
      await boot()
    } catch (err) {
      return failed(err)
    }
    try {
      const family = await api.joinByCode(code)
      setCurrentFamily(family.family_id)
      await refreshSession()
      return { status: 'joined', family }
    } catch (err) {
      if (err && err.code === 'ALREADY_MEMBER') return { status: 'already' }
      return failed(err)
    }
  }
}

function failed(err) {
  return {
    status: 'failed',
    code: (err && err.code) || 'INTERNAL',
    message: (err && err.message) || '加入失败，请稍后重试',
  }
}

// 域错误码 = 确定失败, 重试无意义(邀请码状态不会自行恢复); 网络/内部错误保留待重试
const TERMINAL_FAILURE_CODES = new Set(['INVITE_EXPIRED', 'FAMILY_FULL', 'USER_FAMILY_CAP', 'INVITE_NOT_FOUND'])

function isTerminalFailure(result) {
  return result.status === 'failed' && TERMINAL_FAILURE_CODES.has(result.code)
}

/**
 * 分流结果 UI 映射: 页面薄壳只出注入的 ui 原语, 分流规则收在此处(两页共用, 测试钉死)。
 * @param {object} ui {toast(title), modal(title, content), go(url), alreadyAtHome?}
 *   成功 → 进入该家庭菜品页; 已加入 → 回首页(已在该页则不跳, 防无谓重载); 失败 → 弹窗原因留在原页
 */
function showInviteResult(result, ui) {
  if (result.status === 'joined') {
    ui.toast(`你已成为 ${result.family.name} 的成员`)
    ui.go('/pages/dishes/dishes')
    return
  }
  if (result.status === 'already') {
    ui.toast('你已在该家庭中')
    if (!ui.alreadyAtHome) ui.go('/pages/index/index')
    return
  }
  ui.modal('无法加入', result.message)
}

module.exports = {
  parseInviteScene,
  resolveInviteCode,
  pickValidInviteCode,
  createInviteFlow,
  isTerminalFailure,
  showInviteResult,
}
