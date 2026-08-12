'use strict'

const { CLOUD_ENV } = require('../config.js')

// seam 1 客户端薄壳：只学 action 名与载荷，统一 {ok, data} | {ok:false, error:{code,message}} 解包。
function call(action, payload = {}) {
  return wx.cloud
    .callFunction({ name: 'family-kitchen', data: { action, ...payload } })
    .then((res) => {
      const result = res && res.result
      if (!result) {
        const err = new Error('云函数无返回')
        err.code = 'INTERNAL'
        throw err
      }
      if (!result.ok) {
        const err = new Error(result.error ? result.error.message : '调用失败')
        err.code = result.error ? result.error.code : 'INTERNAL'
        throw err
      }
      return result.data
    })
}

function getCode() {
  return new Promise((resolve, reject) => {
    wx.login({
      success: (res) => resolve(res.code),
      fail: reject,
    })
  })
}

const api = {
  getCode,
  loginByCode: (code) => call('login', { code }),
  startup: () => call('startup'),
  saveProfile: (profile) => call('saveProfile', profile),
  createFamily: (name) => call('createFamily', { name }),
  joinByCode: (code) => call('joinByCode', { code }),
  myFamilies: () => call('myFamilies'),
  generateInviteCode: (familyId) => call('generateInviteCode', { familyId }),
  listDishes: (familyId) => call('listDishes', { familyId }),
  listRemovedDishes: (familyId) => call('listRemovedDishes', { familyId }),
  createDish: (familyId, dish) => call('createDish', { familyId, ...dish }),
  updateDish: (familyId, dishId, dish) => call('updateDish', { familyId, dishId, ...dish }),
  setDishAvailable: (familyId, dishId, isAvailable) => call('setDishAvailable', { familyId, dishId, isAvailable }),
  deleteDish: (familyId, dishId) => call('deleteDish', { familyId, dishId }),
  restoreDish: (familyId, dishId) => call('restoreDish', { familyId, dishId }),
  initiate: (familyId, slot, { date, deadline } = {}) => call('initiate', { familyId, slot, date, deadline }),
  viewMeal: (mealId) => call('viewMeal', { mealId }),
  placeOrder: (mealId, dishes, note) => call('placeOrder', { mealId, dishes, note }),
  closeEarly: (mealId) => call('closeEarly', { mealId }),
}

function initCloud() {
  wx.cloud.init({ env: CLOUD_ENV || undefined, traceUser: true })
}

module.exports = { api, call, initCloud }