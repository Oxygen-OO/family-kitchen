'use strict'

// 内存双胞胎: 忠实复刻 wx-server-sdk 集合语义 ——
// getUser 未命中返回 null; createUser 撞 _id 抛 {code:'DUPLICATE_KEY'};
// updateUser 未命中抛 {code:'NOT_FOUND'}; listFamilyMembers 按 joined_at 降序。

function createMemStore() {
  const collections = new Map()
  const col = (name) => {
    if (!collections.has(name)) collections.set(name, new Map())
    return collections.get(name)
  }

  return {
    async getUser(openid) {
      const doc = col('users').get(openid)
      return doc ? { ...doc } : null
    },
    async createUser(doc) {
      const users = col('users')
      if (users.has(doc._id)) return Promise.reject(dupError(doc._id))
      users.set(doc._id, { ...doc })
      return { ...doc }
    },
    async updateUser(openid, patch) {
      const users = col('users')
      if (!users.has(openid)) return Promise.reject(nfError('users', openid))
      const merged = { ...users.get(openid), ...patch }
      users.set(openid, merged)
      return { ...merged }
    },
    async listFamilyMembers(openid) {
      return [...col('family_members').values()]
        .filter((row) => row.user_openid === openid)
        .sort((a, b) => b.joined_at - a.joined_at)
        .map((row) => ({ ...row }))
    },
    _seedFamilyMember(row) {
      col('family_members').set(row.family_id + ':' + row.user_openid, { ...row })
    },
  }
}

function dupError(id) {
  const err = new Error(`duplicate key: ${id}`)
  err.code = 'DUPLICATE_KEY'
  return err
}

function nfError(coll, id) {
  const err = new Error(`${coll} ${id} not found`)
  err.code = 'NOT_FOUND'
  return err
}

module.exports = { createMemStore }