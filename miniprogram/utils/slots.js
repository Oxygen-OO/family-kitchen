'use strict'

// 餐次常量(客户端共享): 三餐顺序与中文标签唯一来源, 服务端同名表在
// cloudfunctions lib/meal-engine(与客户端同源, 跨层无法 import 故各持一份)。
const SLOTS = [
  { slot: 'breakfast', label: '早餐' },
  { slot: 'lunch', label: '午餐' },
  { slot: 'dinner', label: '晚餐' },
]

const SLOT_LABELS = SLOTS.reduce((map, row) => {
  map[row.slot] = row.label
  return map
}, {})

module.exports = { SLOTS, SLOT_LABELS }