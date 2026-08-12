'use strict'

// ports：云数据库适配器 —— 全仓库唯一 import wx-server-sdk 的地方。
// IdentityStore 契约见 docs/design/identity.md。

function createIdentityStore(db) {
  const users = db.collection('users')
  const familyMembers = db.collection('family_members')

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
    async listFamilyMembers(openid) {
      const res = await familyMembers
        .where({ user_openid: openid })
        .orderBy('joined_at', 'desc')
        .limit(100)
        .get()
      return (res.data || []).map((row) => ({ ...row }))
    },
  }
}

module.exports = { createIdentityStore }