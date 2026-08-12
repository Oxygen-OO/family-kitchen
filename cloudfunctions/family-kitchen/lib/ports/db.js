'use strict'

// ports：云数据库适配器 —— 全仓库唯一 import wx-server-sdk 的地方。
// IdentityStore 契约见 docs/design/identity.md，FamilyStore 契约见 docs/design/family-engine.md，
// DishStore 契约见 docs/design/dishes.md，MealStore 契约见 docs/design/meal-engine.md。

// 共享助手：各 Store 共用的解包、错误折叠与跨集合读取（不重复造轮子）。
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

function duplicateKeyError(id) {
  const dup = new Error(`duplicate key: ${id}`)
  dup.code = 'DUPLICATE_KEY'
  return dup
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

async function getFamily(db, familyId) {
  try {
    return unpack(await db.collection('families').doc(familyId).get())
  } catch (err) {
    if (isNotFound(err)) return null
    throw err
  }
}

async function getDish(db, dishId) {
  try {
    return unpack(await db.collection('dishes').doc(dishId).get())
  } catch (err) {
    if (isNotFound(err)) return null
    throw err
  }
}

async function listDishes(db, familyId, isDeleted) {
  const rows = await collectionOrEmpty(
    db.collection('dishes')
      .where({ family_id: familyId, is_deleted: isDeleted })
      .orderBy('created_at', 'desc')
      .limit(1000)
  )
  return rows.map((row) => ({ ...row }))
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
        if (isDuplicate(err)) throw duplicateKeyError(doc._id)
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
    getFamily: (familyId) => getFamily(db, familyId),
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

function createDishStore(db) {
  const dishes = db.collection('dishes')
  const meals = db.collection('meals')
  const orders = db.collection('orders')
  const _ = db.command

  return {
    getDish: (dishId) => getDish(db, dishId),
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
    listDishes: (familyId, isDeleted) => listDishes(db, familyId, isDeleted),
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

// MealStore：meals/orders 集合归本引擎独占写入。派生 _id 语义:
// meals._id = familyId:date:slot(日期×slot 唯一由 ID 空间天然保证, add 撞键即 MEAL_EXISTS 素材);
// orders._id = mealId:openid(每人每餐一单的原子 upsert, doc().set 建/替同语义)。
// families/family_members/dishes 只读(家庭守卫与菜品校验)。
// 关闭管线靠 claimClose 条件更新的原子性裁决胜负: where {_id, status:'ongoing', [+deadline<=now]}
// → update {status:'closed'}, stats.updated===1 才执行后续物化(不用中间态, 无双写窗口)。
function createMealStore(db) {
  const meals = db.collection('meals')
  const orders = db.collection('orders')
  const _ = db.command

  return {
    getFamily: (familyId) => getFamily(db, familyId),
    listFamilyMembers: (openid) => listFamilyMembers(db, openid),
    getDish: (dishId) => getDish(db, dishId),
    listDishes: (familyId, isDeleted) => listDishes(db, familyId, isDeleted),
    getMeal: async (mealId) => {
      try {
        return unpack(await meals.doc(mealId).get())
      } catch (err) {
        if (isNotFound(err)) return null
        throw err
      }
    },
    createMeal: async (doc) => {
      try {
        await meals.add({ data: doc })
      } catch (err) {
        if (isDuplicate(err)) throw duplicateKeyError(doc._id)
        throw err
      }
      return doc
    },
    updateMeal: async (mealId, patch) => {
      const res = await meals.doc(mealId).update({ data: patch })
      const updated = res && res.stats && res.stats.updated
      if (!updated) {
        const nf = new Error(`meals ${mealId} not found`)
        nf.code = 'NOT_FOUND'
        throw nf
      }
      return unpack(await meals.doc(mealId).get())
    },
    // 原子抢占(胜负唯一裁决点): 未命中/非 ongoing/(requireDue 时)未到期 → stats.updated=0, 不抛错
    claimClose: async (mealId, { now, requireDue }) => {
      const cond = { _id: mealId, status: 'ongoing' }
      if (requireDue) cond.deadline = _.lte(now)
      const res = await meals.where(cond).update({ data: { status: 'closed', closed_at: now } })
      return { updated: (res && res.stats && res.stats.updated) || 0 }
    },
    findDueMeals: async (now) => {
      const rows = await collectionOrEmpty(
        meals.where({ status: 'ongoing', deadline: _.lte(now) }).limit(1000)
      )
      return rows.map((row) => ({ ...row }))
    },
    getOrder: async (mealId, openid) => {
      try {
        return unpack(await orders.doc(`${mealId}:${openid}`).get())
      } catch (err) {
        if (isNotFound(err)) return null
        throw err
      }
    },
    upsertOrder: async (order) => {
      await orders.doc(order._id).set({ data: order })
      return order
    },
    deleteOrder: async (mealId, openid) => {
      try {
        await orders.doc(`${mealId}:${openid}`).remove()
      } catch (err) {
        // 取消幂等: 目标不存在时折叠, 不报错
        if (isNotFound(err)) return
        throw err
      }
    },
    listOrders: async (mealId) => {
      const rows = await collectionOrEmpty(
        orders.where({ meal_id: mealId }).limit(1000)
      )
      return rows.map((row) => ({ ...row }))
    },
  }
}

module.exports = { createIdentityStore, createFamilyStore, createDishStore, createMealStore }