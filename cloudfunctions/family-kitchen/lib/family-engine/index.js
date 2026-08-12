'use strict'

const crypto = require('node:crypto')

/**
 * FamilyEngine：立家 / 凭码加入 / 我的家庭 / 生成邀请码。零 SDK、零 I/O，Store port + Clock 注入。
 * 契约见 docs/design/family-engine.md。families / family_members 集合归本引擎独占写入。
 * @param {{
 *   getFamily: Function, createFamily: Function, updateFamily: Function,
 *   findFamilyByInvite: Function, addFamilyMember: Function, listFamilyMembers: Function,
 * }} store
 * @param {{now: Function}} clock 固定时钟注入点（生产 = Date.now）
 */
function createFamilyEngine(store, clock = { now: () => Date.now() }) {
  return { createFamily, joinByCode, myFamilies, generateInviteCode }

  async function createFamily({ openid, nickname, name }) {
    const trimmed = String(name == null ? '' : name).trim()
    if (trimmed.length < 2 || trimmed.length > 12) {
      throw domainError('FAMILY_NAME_INVALID', '家庭名称需 2–12 个字符')
    }

    const memberships = await store.listFamilyMembers(openid)
    if (memberships.length >= 3) throw domainError('USER_FAMILY_CAP', '每人最多加入 3 个家庭')

    const now = clock.now()
    const family = await store.createFamily({
      name: trimmed,
      creator_openid: openid,
      invite_code: generateCode(),
      expires_at: now + WEEK,
      member_count: 1,
      status: 'active',
      created_at: now,
    })
    await store.addFamilyMember({
      family_id: family._id,
      user_openid: openid,
      role: 'creator',
      joined_at: now,
    })
    return { ...family, family_id: family._id, my_role: 'creator' }
  }

  async function joinByCode({ code }, openid, { nickname, now } = {}) {
    const normalized = String(code == null ? '' : code).trim().toUpperCase()
    const family = await store.findFamilyByInvite(normalized)
    if (!family) throw domainError('INVITE_NOT_FOUND', '邀请码不存在或已失效')
    if (family.status !== 'active') throw domainError('FAMILY_FROZEN', '家庭已冻结')
    const at = now == null ? clock.now() : now
    if (family.expires_at <= at) throw domainError('INVITE_EXPIRED', '邀请码已过期，请让家人重新生成')
    if (family.member_count >= 5) throw domainError('FAMILY_FULL', '家庭已满 5 人')
    const memberships = await store.listFamilyMembers(openid)
    if (memberships.length >= 3) throw domainError('USER_FAMILY_CAP', '每人最多加入 3 个家庭')
    if (memberships.some((row) => row.family_id === family._id)) {
      throw domainError('ALREADY_MEMBER', '你已在该家庭中')
    }
    await store.addFamilyMember({
      family_id: family._id,
      user_openid: openid,
      role: 'member',
      joined_at: at,
    })
    const updated = await store.updateFamily(family._id, { member_count: family.member_count + 1 })
    return { ...updated, family_id: updated._id, my_role: 'member' }
  }

  async function myFamilies(openid) {
    const memberships = await store.listFamilyMembers(openid)
    const families = []
    for (const row of memberships) {
      const doc = await store.getFamily(row.family_id)
      if (!doc) continue
      families.push({ ...doc, family_id: doc._id, my_role: row.role })
    }
    return families
  }

  async function generateInviteCode({ familyId }, openid, { now } = {}) {
    const family = await store.getFamily(familyId)
    const memberships = await store.listFamilyMembers(openid)
    if (!family || !memberships.some((row) => row.family_id === familyId)) {
      throw domainError('NOT_MEMBER', '你不是该家庭成员')
    }
    if (family.status !== 'active') throw domainError('FAMILY_FROZEN', '家庭已冻结')
    if (family.member_count >= 5) throw domainError('FAMILY_FULL', '家庭已满 5 人，邀请功能已禁用')
    const at = now == null ? clock.now() : now
    const code = generateCode()
    const updated = await store.updateFamily(familyId, {
      invite_code: code,
      expires_at: at + WEEK,
    })
    return { code: updated.invite_code, expiresAt: updated.expires_at }
  }
}

function generateCode() {
  const ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789'
  let code = ''
  for (let i = 0; i < 6; i++) code += ALPHABET[crypto.randomInt(ALPHABET.length)]
  return code
}

function domainError(code, message) {
  const err = new Error(message)
  err.code = code
  return err
}

const WEEK = 7 * 24 * 3600 * 1000

module.exports = { createFamilyEngine }