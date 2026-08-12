'use strict'

/**
 * DishEngine：菜品管理（增删改查 + 结构化食材 + 软删/恢复 + 上下架 + 当日引用保护）。
 * 零 SDK、零 I/O，Store port + Clock 注入。契约见 docs/design/dishes.md。
 * dishes 集合归本引擎独占写入；meals/orders 只读做删除前置校验（T6 前缺失视为空）。
 * @param {{
 *   getDish: Function, createDish: Function, updateDish: Function,
 *   listDishes: Function, findOrderRefs: Function,
 * }} store
 * @param {{now: Function}} clock 固定时钟注入点（生产 = Date.now）
 */
function createDishEngine(store, clock = { now: () => Date.now() }) {
  return {
    listDishes, listRemovedDishes, createDish, updateDish,
    setDishAvailable, deleteDish, restoreDish,
  }

  async function listDishes({ familyId }, openid) {
    await guard(store, familyId, openid)
    return withDishId(await store.listDishes(familyId, false))
  }

  async function listRemovedDishes({ familyId }, openid) {
    await guard(store, familyId, openid)
    return withDishId(await store.listDishes(familyId, true))
  }

  async function createDish({ familyId, name, image, description, ingredients, tags }, openid, { now } = {}) {
    await guard(store, familyId, openid)
    const doc = normalize({ name, image, description, ingredients, tags })
    const at = now == null ? clock.now() : now
    const created = await store.createDish({
      family_id: familyId,
      ...doc,
      is_available: true,
      is_deleted: false,
      created_by: openid,
      created_at: at,
    })
    return { ...created, dish_id: created._id }
  }

  async function updateDish({ familyId, dishId, name, image, description, ingredients, tags }, openid, { now } = {}) {
    await guard(store, familyId, openid)
    const dish = await familyDish(store, familyId, dishId)
    const doc = normalize({ name, image, description, ingredients, tags })
    const at = now == null ? clock.now() : now
    // 信任模型: 任何成员可改任何内容字段; 只动五个内容字段+updated_at, 不触碰可用/软删标志
    const updated = await store.updateDish(dishId, { ...doc, updated_at: at })
    return { ...updated, dish_id: updated._id }
  }

  async function setDishAvailable({ familyId, dishId, isAvailable }, openid) {
    await guard(store, familyId, openid)
    await familyDish(store, familyId, dishId)
    const updated = await store.updateDish(dishId, { is_available: isAvailable === true })
    return { ...updated, dish_id: updated._id }
  }

  async function deleteDish({ familyId, dishId }, openid, { now } = {}) {
    await guard(store, familyId, openid)
    const dish = await familyDish(store, familyId, dishId)
    const at = now == null ? clock.now() : now
    const refs = await store.findOrderRefs({
      familyId,
      dishId,
      date: localDateOf(at),
    })
    if (refs.length > 0) throw domainError('DISH_IN_USE', '该菜品今日已被点餐引用，无法删除')
    await store.updateDish(dishId, { is_deleted: true, updated_at: at })
  }

  async function restoreDish({ familyId, dishId }, openid) {
    await guard(store, familyId, openid)
    const dish = await familyDish(store, familyId, dishId)
    if (dish.is_deleted) {
      const updated = await store.updateDish(dishId, {
        is_deleted: false,
        updated_at: clock.now(),
      })
      return { ...updated, dish_id: updated._id }
    }
    return { ...dish, dish_id: dish._id }
  }
}

async function guard(store, familyId, openid) {
  const family = await store.getFamily(familyId)
  const memberships = await store.listFamilyMembers(openid)
  if (!family || !memberships.some((row) => row.family_id === familyId)) {
    throw domainError('NOT_MEMBER', '你不是该家庭成员')
  }
  if (family.status !== 'active') throw domainError('FAMILY_FROZEN', '家庭已冻结')
}

async function familyDish(store, familyId, dishId) {
  const dish = await store.getDish(dishId)
  if (!dish || dish.family_id !== familyId) {
    throw domainError('DISH_NOT_FOUND', '菜品不存在')
  }
  return dish
}

function normalize({ name, image, description, ingredients, tags }) {
  const trimmedName = String(name == null ? '' : name).trim()
  if (!trimmedName) throw domainError('DISH_NAME_REQUIRED', '菜品名称不能为空')
  if (trimmedName.length > 30) throw domainError('DISH_NAME_TOO_LONG', '菜品名称最长 30 个字符')

  const normalizedImage = image == null ? '' : String(image).trim()
  if (normalizedImage && !normalizedImage.startsWith('cloud://')) {
    throw domainError('IMAGE_INVALID', '图片必须为云存储 fileID')
  }

  if (!Array.isArray(ingredients)) throw domainError('INGREDIENTS_INVALID', '食材清单格式不正确')
  if (ingredients.length > 50) throw domainError('INGREDIENTS_INVALID', '食材清单最多 50 项')
  const normalizedIngredients = ingredients.map((row, i) => {
    const name = row && String(row.name).trim()
    const amount = row && String(row.amount).trim()
    if (!name || !amount) throw domainError('INGREDIENTS_INVALID', `第 ${i + 1} 项食材需填写名称和用量`)
    if (name.length > 20 || amount.length > 20) {
      throw domainError('INGREDIENTS_INVALID', `第 ${i + 1} 项食材名称与用量各限 20 字`)
    }
    return { name, amount }
  })

  const seen = new Set()
  const normalizedTags = []
  for (const raw of Array.isArray(tags) ? tags : []) {
    const tag = String(raw == null ? '' : raw).trim()
    if (!tag) continue
    if (tag.length > 10) throw domainError('TAGS_INVALID', '标签最长 10 个字符')
    if (seen.has(tag)) continue
    seen.add(tag)
    normalizedTags.push(tag)
  }
  if (normalizedTags.length > 6) throw domainError('TAGS_INVALID', '标签最多 6 个')

  const descriptionText = String(description == null ? '' : description).trim()
  return {
    name: trimmedName,
    image: normalizedImage,
    description: descriptionText,
    ingredients: normalizedIngredients,
    tags: normalizedTags,
  }
}

function localDateOf(ts) {
  const d = new Date(ts)
  const m = String(d.getMonth() + 1).padStart(2, '0')
  const day = String(d.getDate()).padStart(2, '0')
  return `${d.getFullYear()}-${m}-${day}`
}

function withDishId(rows) {
  return rows.map((row) => ({ ...row, dish_id: row._id }))
}

function domainError(code, message) {
  const err = new Error(message)
  err.code = code
  return err
}

module.exports = { createDishEngine }