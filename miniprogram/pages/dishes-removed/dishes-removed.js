'use strict'

const { api } = require('../../utils/api.js')

Page({
  data: {
    familyId: '',
    dishes: [],
    loading: false,
  },

  async onShow() {
    const app = getApp()
    try {
      const boot = await app.boot()
      if (boot.route !== 'home') {
        wx.reLaunch({ url: '/pages/onboarding/onboarding' })
        return
      }
      const familyId = app.globalData.currentFamilyId
      if (!familyId) {
        wx.navigateBack()
        return
      }
      this.setData({ familyId })
      await this.load()
    } catch (err) {
      wx.showToast({ title: err.message || '加载失败', icon: 'none' })
    }
  },

  async load() {
    if (this.data.loading) return
    this.setData({ loading: true })
    try {
      const dishes = await api.listRemovedDishes(this.data.familyId)
      this.setData({ dishes })
    } catch (err) {
      wx.showToast({ title: err.message || '加载失败', icon: 'none' })
    } finally {
      this.setData({ loading: false })
    }
  },

  ingredientsText(ingredients) {
    return (ingredients || []).map((i) => `${i.name} ${i.amount}`).join('、')
  },

  onRestore(e) {
    const dishId = e.currentTarget.dataset.id
    api
      .restoreDish(this.data.familyId, dishId)
      .then(() => {
        wx.showToast({ title: '已恢复', icon: 'success' })
        this.load()
      })
      .catch((err) => {
        wx.showToast({ title: err.message || '恢复失败', icon: 'none' })
      })
  },
})