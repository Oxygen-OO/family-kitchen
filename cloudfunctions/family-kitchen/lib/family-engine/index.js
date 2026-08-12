'use strict'

const crypto = require('node:crypto')

/**
 * FamilyEngine：立家 / 凭码加入 / 我的家庭 / 生成邀请码 / 成员列表 / 退出 / 转让 / 解散。
 * 零 SDK、零 I/O，Store port + Clock 注入。
 * 契约见 docs/design/family-engine.md。families / family_members 集合归本引擎独占写入。
 * @param {{
 *   getFamily: Function, createFamily: Function, updateFamily: Function,
 *   findFamilyByInvite: Function, addFamilyMember: Function, listFamilyMembers: Function,
 *   getFamilyMember: Function, updateFamilyMember: Function, deleteFamilyMember: Function,
 *   listMembersByFamily: Function,
 * }} store
 * @param {{now: Function}} clock 固定时钟注入点（生产 = Date.now）
 */
function createFamilyEngine(store, clock = { now: () => Date.now() }) {
  return { createFamily, joinByCode, myFamilies, generateInviteCode, listMembers, leaveFamily, transferOwnership, dissolveFamily }

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

  // ── T3 成员生命周期: 列表 / 退出 / 转让所有权 / 解散(冻结, ADR-0003) ──
  // 守卫基调 NOT_MEMBER → FAMILY_FROZEN → 角色校验; 一个例外: dissolveFamily
  // 角色校验在前, 且对冻结幂等接受 —— 冻结后全库仅此接口接受 frozen 状态
  // (成员被困的冻结家庭由「成员不可退」保证数据只增不减, 见 family-engine.md 不变量 3)。

  // 成员列表(成员管理页数据源): 视图 {openid, role, joined_at}(family_members 无昵称列,
  // 昵称展示预留给后续成员展示链路, 见 family-engine.md nickname 注记)
  async function listMembers({ familyId }, openid) {
    const family = await store.getFamily(familyId)
    const memberships = await store.listFamilyMembers(openid)
    if (!family || !memberships.some((row) => row.family_id === familyId)) {
      throw domainError('NOT_MEMBER', '你不是该家庭成员')
    }
    if (family.status !== 'active') throw domainError('FAMILY_FROZEN', '家庭已冻结')
    return store.listMembersByFamily(familyId)
  }

  async function leaveFamily({ familyId }, openid) {
    const family = await store.getFamily(familyId)
    const row = await store.getFamilyMember(familyId, openid)
    if (!family || !row) throw domainError('NOT_MEMBER', '你不是该家庭成员')
    if (family.status !== 'active') throw domainError('FAMILY_FROZEN', '家庭已冻结')
    if (row.role === 'creator') {
      throw domainError('CREATOR_LEAVE_FORBIDDEN', '立家者需先转让所有权或解散家庭')
    }
    await store.deleteFamilyMember(familyId, openid)
    await store.updateFamily(familyId, { member_count: family.member_count - 1 })
  }

  async function transferOwnership({ familyId }, from, to) {
    const family = await store.getFamily(familyId)
    const myRow = await store.getFamilyMember(familyId, from)
    if (!family || !myRow) throw domainError('NOT_MEMBER', '你不是该家庭成员')
    if (family.status !== 'active') throw domainError('FAMILY_FROZEN', '家庭已冻结')
    if (myRow.role !== 'creator') throw domainError('TRANSFER_NOT_CREATOR', '仅立家者可转让所有权')
    const targetRow = await store.getFamilyMember(familyId, to)
    if (!targetRow) throw domainError('TRANSFER_TO_NON_MEMBER', '目标须为该家庭的现役成员')
    if (to === from) return // 转让给本人: 幂等空操作(角色与 creator_openid 原样保留)
    // 先升目标再降原立家者, 最后改 creator_openid —— 任一瞬间都至少存在一名立家者,
    // 无「无立家者」空窗(若先降后升, 两次写之间会出现零立家者的非法窗口)
    await store.updateFamilyMember(familyId, to, { role: 'creator' })
    await store.updateFamilyMember(familyId, from, { role: 'member' })
    await store.updateFamily(familyId, { creator_openid: to })
  }

  async function dissolveFamily({ familyId }, openid) {
    const family = await store.getFamily(familyId)
    const row = await store.getFamilyMember(familyId, openid)
    if (!family || !row) throw domainError('NOT_MEMBER', '你不是该家庭成员')
    if (row.role !== 'creator') throw domainError('DISSOLVE_NOT_CREATOR', '仅立家者可解散家庭')
    if (family.status !== 'active') return // 已冻结: 幂等, 不覆盖 dissolved_at(ADR-0003)
    await store.updateFamily(familyId, { status: 'frozen', dissolved_at: clock.now() })
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