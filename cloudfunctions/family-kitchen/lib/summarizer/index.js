'use strict'

/**
 * @typedef {Object} OrderDoc
 * @property {string} _id
 * @property {string} user_openid
 * @property {string} user_nickname
 * @property {{dish_id: string, name: string, quantity: number}[]} dishes
 */

/**
 * @typedef {Object} DishDoc
 * @property {string} _id
 * @property {string} name
 * @property {{name: string, amount: string}[]} ingredients
 * @property {boolean} is_deleted
 */

/**
 * @typedef {Object} PrepSummary
 * @property {{dishId: string, dishName: string, totalQuantity: number,
 *   orderedBy: {openid: string, nickname: string, quantity: number}[],
 *   removed: boolean}[]} byDish
 * @property {{name: string, amountText: string, dishCount: number}[]} ingredients
 * @property {number} generatedAt
 */

/**
 * 备餐汇总：按菜聚合 + 按食材精确去重合并。纯函数，零 I/O。
 * @param {OrderDoc[]} orders
 * @param {DishDoc[]} dishes
 * @param {number} [now] 生成时间戳，可注入以保确定性；缺省取 Date.now()
 * @returns {PrepSummary}
 */
function buildSummary(orders, dishes, now = Date.now()) {
  const dishById = new Map()
  for (const dish of dishes) dishById.set(dish._id, dish)

  const byDishMap = new Map()
  const ingredientsMap = new Map()

  for (const order of orders) {
    for (const item of order.dishes) {
      mergeByDish(byDishMap, dishById, order, item)
      mergeIngredients(ingredientsMap, dishById, item)
    }
  }

  return {
    byDish: [...byDishMap.values()].map(finalizeByDish),
    ingredients: [...ingredientsMap.values()].map(finalizeIngredients),
    generatedAt: now,
  }
}

function getOrCreate(map, key, create) {
  let value = map.get(key)
  if (!value) {
    value = create()
    map.set(key, value)
  }
  return value
}

function mergeByDish(byDishMap, dishById, order, item) {
  const entry = getOrCreate(byDishMap, item.dish_id, () => {
    const dish = dishById.get(item.dish_id)
    return {
      dishId: item.dish_id,
      dishName: item.name,
      totalQuantity: 0,
      orderedBy: new Map(),
      removed: Boolean(dish && dish.is_deleted),
    }
  })
  entry.totalQuantity += item.quantity
  const ordered = getOrCreate(entry.orderedBy, order.user_openid, () => ({
    openid: order.user_openid,
    nickname: order.user_nickname,
    quantity: 0,
  }))
  ordered.quantity += item.quantity
}

function finalizeByDish(entry) {
  return {
    dishId: entry.dishId,
    dishName: entry.dishName,
    totalQuantity: entry.totalQuantity,
    orderedBy: [...entry.orderedBy.values()],
    removed: entry.removed,
  }
}

function mergeIngredients(ingredientsMap, dishById, item) {
  const dish = dishById.get(item.dish_id)
  if (!dish || !Array.isArray(dish.ingredients)) return
  for (const ingredient of dish.ingredients) {
    const entry = getOrCreate(ingredientsMap, ingredient.name, () => ({
      name: ingredient.name,
      perDish: new Map(),
    }))
    const line = getOrCreate(entry.perDish, item.dish_id, () => ({
      amount: ingredient.amount,
      quantity: 0,
    }))
    line.quantity += item.quantity
  }
}

function finalizeIngredients(entry) {
  const parts = []
  for (const line of entry.perDish.values()) {
    parts.push(line.quantity > 1 ? `${line.amount} ×${line.quantity}` : line.amount)
  }
  return {
    name: entry.name,
    amountText: parts.join(' + '),
    dishCount: entry.perDish.size,
  }
}

module.exports = { buildSummary }