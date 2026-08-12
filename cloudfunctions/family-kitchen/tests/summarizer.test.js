'use strict'

const { test } = require('node:test')
const assert = require('node:assert/strict')

const { buildSummary } = require('../lib/summarizer/index.js')

test('空订单：返回干净的空汇总，两个视图都是空数组', () => {
  const summary = buildSummary([], [])

  assert.equal(summary.byDish.length, 0)
  assert.equal(summary.ingredients.length, 0)
  assert.equal(typeof summary.generatedAt, 'number')
  assert.ok(summary.generatedAt > 0)
})

test('单成员点同一道菜 2 份：byDish 逐字段聚合，食材按份数 ×N 标注', () => {
  const orders = [
    {
      _id: 'order-1',
      user_openid: 'openid-baba',
      user_nickname: '爸爸',
      dishes: [{ dish_id: 'dish-tomato', name: '番茄炒蛋', quantity: 2 }],
    },
  ]
  const dishes = [
    {
      _id: 'dish-tomato',
      ingredients: [{ name: '鸡蛋', amount: '2 个' }, { name: '番茄', amount: '1 个' }],
      is_deleted: false,
    },
  ]

  const summary = buildSummary(orders, dishes)

  assert.equal(summary.byDish.length, 1)
  assert.deepEqual(summary.byDish[0], {
    dishId: 'dish-tomato',
    dishName: '番茄炒蛋',
    totalQuantity: 2,
    orderedBy: [{ openid: 'openid-baba', nickname: '爸爸', quantity: 2 }],
    removed: false,
  })
  assert.equal(summary.ingredients.length, 2)
  assert.deepEqual(summary.ingredients.find(i => i.name === '鸡蛋'), {
    name: '鸡蛋',
    amountText: '2 个 ×2',
    dishCount: 1,
  })
  assert.deepEqual(summary.ingredients.find(i => i.name === '番茄'), {
    name: '番茄',
    amountText: '1 个 ×2',
    dishCount: 1,
  })
})

test('多成员点同一道菜：totalQuantity 合计，orderedBy 逐人列份数、昵称随单快照', () => {
  const orders = [
    {
      _id: 'order-1',
      user_openid: 'openid-baba',
      user_nickname: '爸爸',
      dishes: [{ dish_id: 'dish-tomato', name: '番茄炒蛋', quantity: 2 }],
    },
    {
      _id: 'order-2',
      user_openid: 'openid-mama',
      user_nickname: '妈妈',
      dishes: [{ dish_id: 'dish-tomato', name: '番茄炒蛋', quantity: 1 }],
    },
  ]
  const dishes = [
    {
      _id: 'dish-tomato',
      ingredients: [{ name: '鸡蛋', amount: '2 个' }],
      is_deleted: false,
    },
  ]

  const summary = buildSummary(orders, dishes)

  assert.equal(summary.byDish.length, 1)
  assert.equal(summary.byDish[0].totalQuantity, 3)
  assert.deepEqual(summary.byDish[0].orderedBy, [
    { openid: 'openid-baba', nickname: '爸爸', quantity: 2 },
    { openid: 'openid-mama', nickname: '妈妈', quantity: 1 },
  ])
  assert.deepEqual(summary.ingredients, [
    { name: '鸡蛋', amountText: '2 个 ×3', dishCount: 1 },
  ])
})

test('同名食材跨不同菜合并为一行（文本拼接、dishCount 计菜数），不同名食材分条', () => {
  const orders = [
    {
      _id: 'order-1',
      user_openid: 'openid-baba',
      user_nickname: '爸爸',
      dishes: [
        { dish_id: 'dish-tomato', name: '番茄炒蛋', quantity: 1 },
        { dish_id: 'dish-cucumber', name: '黄瓜炒肉', quantity: 2 },
      ],
    },
  ]
  const dishes = [
    {
      _id: 'dish-tomato',
      ingredients: [
        { name: '鸡蛋', amount: '2 个' },
        { name: '番茄', amount: '1 个' },
      ],
      is_deleted: false,
    },
    {
      _id: 'dish-cucumber',
      ingredients: [
        { name: '鸡蛋', amount: '3 个' },
        { name: '黄瓜', amount: '2 根' },
      ],
      is_deleted: false,
    },
  ]

  const summary = buildSummary(orders, dishes)

  assert.equal(summary.byDish.length, 2)
  assert.equal(summary.ingredients.length, 3)
  assert.deepEqual(summary.ingredients.find(i => i.name === '鸡蛋'), {
    name: '鸡蛋',
    amountText: '2 个 + 3 个 ×2',
    dishCount: 2,
  })
  assert.deepEqual(summary.ingredients.find(i => i.name === '番茄'), {
    name: '番茄',
    amountText: '1 个',
    dishCount: 1,
  })
  assert.deepEqual(summary.ingredients.find(i => i.name === '黄瓜'), {
    name: '黄瓜',
    amountText: '2 根 ×2',
    dishCount: 1,
  })
})

test('软删菜品：按订单快照名回显，removed 标注为 true，食材照常合并', () => {
  const orders = [
    {
      _id: 'order-1',
      user_openid: 'openid-baba',
      user_nickname: '爸爸',
      dishes: [
        { dish_id: 'dish-pepper', name: '青椒肉丝', quantity: 1 },
        { dish_id: 'dish-tomato', name: '番茄炒蛋', quantity: 1 },
      ],
    },
  ]
  const dishes = [
    {
      _id: 'dish-pepper',
      ingredients: [{ name: '青椒', amount: '3 个' }],
      is_deleted: true,
    },
    {
      _id: 'dish-tomato',
      ingredients: [{ name: '鸡蛋', amount: '2 个' }],
      is_deleted: false,
    },
  ]

  const summary = buildSummary(orders, dishes)

  const pepper = summary.byDish.find(i => i.dishId === 'dish-pepper')
  assert.equal(pepper.dishName, '青椒肉丝')
  assert.equal(pepper.removed, true)
  assert.equal(pepper.totalQuantity, 1)
  const tomato = summary.byDish.find(i => i.dishId === 'dish-tomato')
  assert.equal(tomato.removed, false)
  assert.deepEqual(summary.ingredients.find(i => i.name === '青椒'), {
    name: '青椒',
    amountText: '3 个',
    dishCount: 1,
  })
})

test('同一订单内同菜重复条目：按成员合并份数，不产生重复行', () => {
  const orders = [
    {
      _id: 'order-1',
      user_openid: 'openid-baba',
      user_nickname: '爸爸',
      dishes: [
        { dish_id: 'dish-tomato', name: '番茄炒蛋', quantity: 2 },
        { dish_id: 'dish-tomato', name: '番茄炒蛋', quantity: 1 },
      ],
    },
  ]
  const dishes = [
    {
      _id: 'dish-tomato',
      ingredients: [{ name: '鸡蛋', amount: '2 个' }],
      is_deleted: false,
    },
  ]

  const summary = buildSummary(orders, dishes)

  assert.equal(summary.byDish.length, 1)
  assert.deepEqual(summary.byDish[0], {
    dishId: 'dish-tomato',
    dishName: '番茄炒蛋',
    totalQuantity: 3,
    orderedBy: [{ openid: 'openid-baba', nickname: '爸爸', quantity: 3 }],
    removed: false,
  })
  assert.deepEqual(summary.ingredients, [
    { name: '鸡蛋', amountText: '2 个 ×3', dishCount: 1 },
  ])
})

test('纯函数：同一输入（注入固定时间戳）产出完全一致的汇总', () => {
  const orders = [
    {
      _id: 'order-1',
      user_openid: 'openid-baba',
      user_nickname: '爸爸',
      dishes: [{ dish_id: 'dish-tomato', name: '番茄炒蛋', quantity: 1 }],
    },
  ]
  const dishes = [
    {
      _id: 'dish-tomato',
      ingredients: [{ name: '鸡蛋', amount: '2 个' }],
      is_deleted: false,
    },
  ]

  assert.deepEqual(buildSummary(orders, dishes, 1000), buildSummary(orders, dishes, 1000))
})