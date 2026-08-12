'use strict'

/**
 * IdentityEngine：登录与身份层。零 SDK、零 I/O，Store port 注入。
 * 契约见 docs/design/identity.md。
 * @param {{getUser: Function, createUser: Function, updateUser: Function, listFamilyMembers: Function}} store
 */
function createIdentityEngine(store) {
  return { login, saveProfile, startup }

  async function login(openid, { now = Date.now() } = {}) {
    const existing = await store.getUser(openid)
    if (existing) return { openid, isNew: false, user: existing }

    const user = { _id: openid, openid, nickname: '', avatar: '', created_at: now }
    try {
      await store.createUser(user)
      return { openid, isNew: true, user }
    } catch (err) {
      if (err && err.code === 'DUPLICATE_KEY') {
        const raced = await store.getUser(openid)
        if (raced) return { openid, isNew: false, user: raced }
      }
      throw err
    }
  }

  async function saveProfile(openid, { nickname, avatar }) {
    const trimmed = String(nickname == null ? '' : nickname).trim()
    if (!trimmed) throw domainError('NICKNAME_REQUIRED', '昵称不能为空')
    if (trimmed.length > 20) throw domainError('NICKNAME_TOO_LONG', '昵称最长 20 个字符')

    const normalizedAvatar = avatar == null ? '' : String(avatar)
    if (normalizedAvatar && !normalizedAvatar.startsWith('cloud://')) {
      throw domainError('AVATAR_INVALID', '头像必须为云存储 fileID')
    }

    let user
    try {
      user = await store.updateUser(openid, {
        nickname: trimmed,
        avatar: normalizedAvatar,
      })
    } catch (err) {
      if (err && err.code === 'NOT_FOUND') {
        throw domainError('USER_NOT_FOUND', '用户不存在，登录态已失效')
      }
      throw err
    }
    return { user }
  }

  async function startup(openid) {
    const user = await store.getUser(openid)
    if (!user) throw domainError('USER_NOT_FOUND', '用户不存在，登录态已失效')
    const families = await store.listFamilyMembers(openid)
    const result = { route: families.length > 0 ? 'home' : 'onboarding', user }
    if (families.length > 0) result.families = families
    return result
  }
}

function domainError(code, message) {
  const err = new Error(message)
  err.code = code
  return err
}

module.exports = { createIdentityEngine }