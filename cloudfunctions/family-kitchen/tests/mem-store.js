'use strict'

// 内存双胞胎: 忠实复刻 wx-server-sdk 集合语义 ——
// getUser 未命中返回 null; createUser 撞 _id 抛 {code:'DUPLICATE_KEY'};
// updateUser 未命中抛 {code:'NOT_FOUND'}; listFamilyMembers 按 joined_at 降序;
// createFamily 自动分配 _id(add 语义); getFamily/findFamilyByInvite 未命中返回 null;
// updateFamily 未命中抛 NOT_FOUND; addFamilyMember 为纯插入(family_members 无唯一索引,
// 生产中 add 对随机 _id 永不抛重复错误, 双胞胎不得比生产更严)。
// 菜品: getDish 未命中返回 null; createDish 自动分配 _id; updateDish 未命中抛 NOT_FOUND;
// listDishes 按 family_id+is_deleted 过滤、created_at 降序;
// findOrderRefs 扫描 meals(同家庭+同日期+ongoing/closed) 与 orders(dishes.dish_id 命中),
// meals/orders 为空或不存在即返回空数组(生产端对缺失集合同样折叠为空, 双胞胎天然空)。

function createMemStore() {
  const collections = new Map()
  let familySeq = 0
  let dishSeq = 0
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
    async createFamily(doc) {
      const families = col('families')
      const _id = 'family-' + (++familySeq)
      families.set(_id, { ...doc, _id })
      return { ...families.get(_id) }
    },
    async getFamily(familyId) {
      const doc = col('families').get(familyId)
      return doc ? { ...doc } : null
    },
    async updateFamily(familyId, patch) {
      const families = col('families')
      if (!families.has(familyId)) return Promise.reject(nfError('families', familyId))
      const merged = { ...families.get(familyId), ...patch }
      families.set(familyId, merged)
      return { ...merged }
    },
    async findFamilyByInvite(code) {
      for (const doc of col('families').values()) {
        if (doc.invite_code === code) return { ...doc }
      }
      return null
    },
    async addFamilyMember(row) {
      const members = col('family_members')
      const key = row.family_id + ':' + row.user_openid
      members.set(key, { ...row })
      return { ...row }
    },
    async getDish(dishId) {
      const doc = col('dishes').get(dishId)
      return doc ? { ...doc } : null
    },
    async createDish(doc) {
      const dishes = col('dishes')
      const _id = 'dish-' + (++dishSeq)
      dishes.set(_id, { ...doc, _id })
      return { ...dishes.get(_id) }
    },
    async updateDish(dishId, patch) {
      const dishes = col('dishes')
      if (!dishes.has(dishId)) return Promise.reject(nfError('dishes', dishId))
      const merged = { ...dishes.get(dishId), ...patch }
      dishes.set(dishId, merged)
      return { ...merged }
    },
    async listDishes(familyId, isDeleted) {
      return [...col('dishes').values()]
        .filter((doc) => doc.family_id === familyId && doc.is_deleted === isDeleted)
        .sort((a, b) => b.created_at - a.created_at)
        .map((doc) => ({ ...doc }))
    },
    async findOrderRefs({ familyId, dishId, date }) {
      const mealIds = [...col('meals').values()]
        .filter((m) => m.family_id === familyId && m.date === date && (m.status === 'ongoing' || m.status === 'closed'))
        .map((m) => m._id)
      if (mealIds.length === 0) return []
      return [...col('orders').values()]
        .filter((o) => mealIds.includes(o.meal_id) && (o.dishes || []).some((d) => d.dish_id === dishId))
        .map((o) => ({ ...o }))
    },
    _seedFamily(doc) {
      if (!doc._id) doc._id = 'family-' + (++familySeq)
      col('families').set(doc._id, { ...doc })
    },
    _seedFamilyMember(row) {
      col('family_members').set(row.family_id + ':' + row.user_openid, { ...row })
    },
    _seedDish(doc) {
      if (!doc._id) doc._id = 'dish-' + (++dishSeq)
      col('dishes').set(doc._id, { ...doc })
    },
    _seedMeal(doc) {
      col('meals').set(doc._id, { ...doc })
    },
    _seedOrder(doc) {
      col('orders').set(doc._id, { ...doc })
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