'use strict'

// ports：云数据库适配器 —— 全仓库唯一 import wx-server-sdk 的地方。
// IdentityStore 契约见 docs/design/identity.md，FamilyStore 契约见 docs/design/family-engine.md。

// 共享助手：两个 Store 共用的解包与错误折叠语义（不重复造轮子）。
// family_members 无唯一索引（唯一性经查询+业务校验保证，见 architecture.md），
// 故 addFamilyMember 无撞键翻译——生产中 add 对随机 _id 永不抛重复错误。
function unpack(doc) {
  return doc && doc.data ? doc.data : doc
}

function isNotFound(err) {
  const msg = err && (err.errMsg || '')
  return err && (err.errCode === -1 || /not exist/i.test(msg))
}

function isDuplicate(err) {
  const msg = err && (err.errMsg || '')
  return err && (err.errCode === -502001 || /duplicate|duplicated|已经存在/i.test(msg))
}

async function listFamilyMembers(db, openid) {
  const res = await db
    .collection('family_members')
    .where({ user_openid: openid })
    .orderBy('joined_at', 'desc')
    .limit(100)
    .get()
  return (res.data || []).map((row) => ({ ...row }))
}

function createIdentityStore(db) {
  const users = db.collection('users')

  return {
    async getUser(openid) {
      try {
        const res = await users.doc(openid).get()
        return unpack(res)
      } catch (err) {
        if (isNotFound(err)) return null
        throw err
      }
    },
    async createUser(doc) {
      try {
        await users.add({ data: doc })
      } catch (err) {
        if (isDuplicate(err)) {
          const dup = new Error(`duplicate key: ${doc._id}`)
          dup.code = 'DUPLICATE_KEY'
          throw dup
        }
        throw err
      }
      return doc
    },
    async updateUser(openid, patch) {
      try {
        await users.doc(openid).update({ data: patch })
        return unpack(await users.doc(openid).get())
      } catch (err) {
        if (isNotFound(err)) {
          const nf = new Error(`users ${openid} not found`)
          nf.code = 'NOT_FOUND'
          throw nf
        }
        throw err
      }
    },
    listFamilyMembers: (openid) => listFamilyMembers(db, openid),
  }
}

function createFamilyStore(db) {
  const families = db.collection('families')
  const familyMembers = db.collection('family_members')

  return {
    getFamily: async (familyId) => {
      try {
        return unpack(await families.doc(familyId).get())
      } catch (err) {
        if (isNotFound(err)) return null
        throw err
      }
    },
    createFamily: async (doc) => {
      const res = await families.add({ data: doc })
      return { ...doc, _id: res._id }
    },
    updateFamily: async (familyId, patch) => {
      try {
        await families.doc(familyId).update({ data: patch })
        return unpack(await families.doc(familyId).get())
      } catch (err) {
        if (isNotFound(err)) {
          const nf = new Error(`families ${familyId} not found`)
          nf.code = 'NOT_FOUND'
          throw nf
        }
        throw err
      }
    },
    findFamilyByInvite: async (code) => {
      const res = await families.where({ invite_code: code }).limit(1).get()
      const doc = res.data && res.data[0]
      return doc ? unpack(doc) : null
    },
    addFamilyMember: async (row) => {
      await familyMembers.add({ data: row })
      return row
    },
    listFamilyMembers: (openid) => listFamilyMembers(db, openid),
  }
}

module.exports = { createIdentityStore, createFamilyStore }