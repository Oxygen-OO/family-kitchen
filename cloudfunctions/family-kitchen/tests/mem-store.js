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
// 成员行(T3): getFamilyMember 未命中返回 null; updateFamilyMember 未命中抛 NOT_FOUND;
// deleteFamilyMember 未命中静默折叠(生产 where().remove 对空集 removed=0 不报错);
// listMembersByFamily 按 family_id 过滤 + joined_at 升序(立家者在前, 成员管理页数据源)。
// 餐次关闭: claimClose 忠实复刻「条件更新」语义 —— 仅当文档存在 ∧ status='ongoing' ∧
// (requireDue 时 deadline<=now) 才置 closed+closed_at 返回 {updated:1}, 任一条件不满足返回
// {updated:0}(生产端 where().update 的 stats.updated, 不抛错), 故「同一餐次重复抢占一定是 stale」;
// findDueMeals 按 status='ongoing' ∧ deadline<=now 过滤; updateMeal 未命中抛 NOT_FOUND(同 users/families)。

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
    async getFamilyMember(familyId, openid) {
      const row = col('family_members').get(familyId + ':' + openid)
      return row ? { ...row } : null
    },
    async updateFamilyMember(familyId, openid, patch) {
      const members = col('family_members')
      const key = familyId + ':' + openid
      if (!members.has(key)) return Promise.reject(nfError('family_members', key))
      const merged = { ...members.get(key), ...patch }
      members.set(key, merged)
      return { ...merged }
    },
    async deleteFamilyMember(familyId, openid) {
      // 生产端 where().remove() 对不存在行返回 removed=0 不报错 —— 双胞胎同语义(幂等)
      col('family_members').delete(familyId + ':' + openid)
    },
    async listMembersByFamily(familyId) {
      return [...col('family_members').values()]
        .filter((row) => row.family_id === familyId)
        .sort((a, b) => a.joined_at - b.joined_at)
        .map((row) => ({ ...row }))
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
    // 餐次: getMeal 未命中返回 null; createMeal 撞派生 _id(familyId:date:slot) 抛 DUPLICATE_KEY
    // (生产端 add 带显式 _id 撞键报重复, 双胞胎同语义);
    // getOrder 按派生 _id=mealId:openid 读取(每人每餐一单), 未命中返回 null;
    // listOrders 按 meal_id 过滤。
    async getMeal(mealId) {
      const doc = col('meals').get(mealId)
      return doc ? { ...doc } : null
    },
    async createMeal(doc) {
      const meals = col('meals')
      if (meals.has(doc._id)) return Promise.reject(dupError(doc._id))
      meals.set(doc._id, { ...doc })
      return { ...meals.get(doc._id) }
    },
    async updateMeal(mealId, patch) {
      const meals = col('meals')
      if (!meals.has(mealId)) return Promise.reject(nfError('meals', mealId))
      const merged = { ...meals.get(mealId), ...patch }
      meals.set(mealId, merged)
      return { ...merged }
    },
    // claimClose: 条件更新语义(见文件头注释) —— stale/不满足条件一律 {updated:0}
    async claimClose(mealId, { now, requireDue } = {}) {
      const meals = col('meals')
      const doc = meals.get(mealId)
      if (!doc || doc.status !== 'ongoing') return { updated: 0 }
      if (requireDue && !(doc.deadline <= now)) return { updated: 0 }
      meals.set(mealId, { ...doc, status: 'closed', closed_at: now })
      return { updated: 1 }
    },
    async findDueMeals(now) {
      return [...col('meals').values()]
        .filter((m) => m.status === 'ongoing' && m.deadline <= now)
        .map((m) => ({ ...m }))
    },
    async getOrder(mealId, openid) {
      const doc = col('orders').get(`${mealId}:${openid}`)
      return doc ? { ...doc } : null
    },
    async listOrders(mealId) {
      return [...col('orders').values()]
        .filter((o) => o.meal_id === mealId)
        .map((o) => ({ ...o }))
    },
    // 订单: 派生 _id=mealId:openid(每人每餐一单), upsertOrder 建/替同语义(生产 doc().set);
    // deleteOrder 未命中不报错(生产 doc().remove 幂等)。
    async upsertOrder(order) {
      col('orders').set(order._id, { ...order })
      return { ...col('orders').get(order._id) }
    },
    async deleteOrder(mealId, openid) {
      col('orders').delete(`${mealId}:${openid}`)
    },
    // 订阅记账(T9): 派生 _id=mealId:openid(每人每餐一条, 授权折叠的原子素材 ——
    // 撞 _id 重复插入抛 DUPLICATE_KEY, 生产端 add 带显式 _id 同语义);
    // claimGrant 忠实复刻「条件更新」: 仅当存在 ∧ consumed=false 才置 consumed+consumed_at
    // 返回 {updated:1}, 任一条件不满足返回 {updated:0}(并发下重复抢占恒 stale);
    // listSubscribes 按 granted/consumed 过滤 + granted_at 升序(先授权先发)。
    async getSubscribe(mealId, openid) {
      const doc = col('subscribes').get(`${mealId}:${openid}`)
      return doc ? { ...doc } : null
    },
    async addSubscribe(doc) {
      const subs = col('subscribes')
      if (subs.has(doc._id)) return Promise.reject(dupError(doc._id))
      subs.set(doc._id, { ...doc })
      return { ...doc }
    },
    async updateSubscribe(mealId, openid, patch) {
      const subs = col('subscribes')
      const key = `${mealId}:${openid}`
      if (!subs.has(key)) return Promise.reject(nfError('subscribes', key))
      const merged = { ...subs.get(key), ...patch }
      subs.set(key, merged)
      return { ...merged }
    },
    async claimGrant(mealId, openid, now) {
      const subs = col('subscribes')
      const key = `${mealId}:${openid}`
      const doc = subs.get(key)
      if (!doc || doc.consumed) return { updated: 0 }
      subs.set(key, { ...doc, consumed: true, consumed_at: now })
      return { updated: 1 }
    },
    async listSubscribes(mealId, { granted, consumed } = {}) {
      return [...col('subscribes').values()]
        .filter((r) => r.meal_id === mealId && r.granted === granted && r.consumed === consumed)
        .sort((a, b) => a.granted_at - b.granted_at)
        .map((row) => ({ ...row }))
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
    _seedSubscribe(doc) {
      col('subscribes').set(doc._id, { ...doc })
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