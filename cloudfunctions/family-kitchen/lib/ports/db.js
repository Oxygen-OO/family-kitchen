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

// meals/orders 集合由 T6 MealEngine 独占写入; 本 Store 只读做删除前置引用保护。
// 集合尚不存在时 get() 抛「集合不存在」——折叠为空数组返回, 绝不因缺集合报错(见 dishes.md)。
async function collectionOrEmpty(query) {
  try {
    const res = await query.get()
    return res.data || []
  } catch (err) {
    if (isNotFound(err)) return []
    throw err
  }
}

function createDishStore(db) {
  const dishes = db.collection('dishes')
  const meals = db.collection('meals')
  const orders = db.collection('orders')
  const _ = db.command

  return {
    getDish: async (dishId) => {
      try {
        return unpack(await dishes.doc(dishId).get())
      } catch (err) {
        if (isNotFound(err)) return null
        throw err
      }
    },
    createDish: async (doc) => {
      const res = await dishes.add({ data: doc })
      return { ...doc, _id: res._id }
    },
    updateDish: async (dishId, patch) => {
      try {
        await dishes.doc(dishId).update({ data: patch })
        return unpack(await dishes.doc(dishId).get())
      } catch (err) {
        if (isNotFound(err)) {
          const nf = new Error(`dishes ${dishId} not found`)
          nf.code = 'NOT_FOUND'
          throw nf
        }
        throw err
      }
    },
    listDishes: async (familyId, isDeleted) => {
      const rows = await collectionOrEmpty(
        dishes.where({ family_id: familyId, is_deleted: isDeleted })
          .orderBy('created_at', 'desc')
          .limit(1000)
      )
      return rows.map((row) => ({ ...row }))
    },
    findOrderRefs: async ({ familyId, dishId, date }) => {
      const mealRows = await collectionOrEmpty(
        meals.where({ family_id: familyId, date, status: _.in(['ongoing', 'closed']) }).field({ _id: true }).limit(1000)
      )
      const mealIds = mealRows.map((row) => row._id)
      if (mealIds.length === 0) return []
      return collectionOrEmpty(
        orders.where({ meal_id: _.in(mealIds), 'dishes.dish_id': dishId }).limit(1)
      )
    },
  }
}

module.exports = { createIdentityStore, createFamilyStore, createDishStore }