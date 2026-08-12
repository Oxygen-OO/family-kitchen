'use strict'

const { api } = require('../../utils/api.js')

const PRESET_TAGS = ['家常菜', '快手菜', '汤', '硬菜', '素菜', '早餐']

Page({
  data: {
    familyId: '',
    dishes: [],
    filtered: [],
    search: '',
    activeTag: '',
    tags: PRESET_TAGS,
    viewMode: 'card',
    removedCount: 0,
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
      const [dishes, removed] = await Promise.all([
        api.listDishes(this.data.familyId),
        api.listRemovedDishes(this.data.familyId),
      ])
      this.setData({ dishes, removedCount: removed.length })
      this.applyFilter()
    } catch (err) {
      wx.showToast({ title: err.message || '加载失败', icon: 'none' })
    } finally {
      this.setData({ loading: false })
    }
  },

  applyFilter() {
    const q = (this.data.search || '').trim().toLowerCase()
    const tag = this.data.activeTag
    const filtered = this.data.dishes.filter((d) => {
      if (q && !d.name.toLowerCase().includes(q)) return false
      if (tag && !(d.tags || []).includes(tag)) return false
      return true
    })
    const tags = [...PRESET_TAGS]
    for (const d of this.data.dishes) {
      for (const t of d.tags || []) {
        if (!tags.includes(t)) tags.push(t)
      }
    }
    this.setData({ filtered, tags })
  },

  onSearchInput(e) {
    this.setData({ search: e.detail.value })
    this.applyFilter()
  },

  onTagTap(e) {
    const tag = e.currentTarget.dataset.tag
    this.setData({ activeTag: this.data.activeTag === tag ? '' : tag })
    this.applyFilter()
  },

  onViewMode(e) {
    this.setData({ viewMode: e.currentTarget.dataset.mode })
  },

  onAddDish() {
    wx.navigateTo({ url: '/pages/dish-edit/dish-edit' })
  },

  onEditDish(e) {
    wx.navigateTo({ url: `/pages/dish-edit/dish-edit?id=${e.currentTarget.dataset.id}` })
  },

  onOpenRemoved() {
    wx.navigateTo({ url: '/pages/dishes-removed/dishes-removed' })
  },

  ingredientsText(ingredients) {
    return (ingredients || []).map((i) => `${i.name} ${i.amount}`).join('、')
  },

  tagsText(tags) {
    return (tags || []).join(' · ')
  },

  onToggleAvailable(e) {
    const dishId = e.currentTarget.dataset.id
    const isAvailable = e.detail.value
    api
      .setDishAvailable(this.data.familyId, dishId, isAvailable)
      .then(() => {
        const dishes = this.data.dishes.map((d) => (d.dish_id === dishId ? { ...d, is_available: isAvailable } : d))
        this.setData({ dishes })
        this.applyFilter()
        wx.showToast({ title: isAvailable ? '已上架' : '已下架', icon: 'none' })
      })
      .catch((err) => {
        wx.showToast({ title: err.message || '操作失败', icon: 'none' })
        this.load()
      })
  },

  onDeleteDish(e) {
    const dishId = e.currentTarget.dataset.id
    const dish = this.data.dishes.find((d) => d.dish_id === dishId)
    wx.showModal({
      title: '删除菜品',
      content: `删除「${dish ? dish.name : ''}」后从菜单隐藏，可从已下架列表恢复`,
      confirmColor: '#fa5151',
      success: async (res) => {
        if (!res.confirm) return
        try {
          await api.deleteDish(this.data.familyId, dishId)
          wx.showToast({ title: '已删除', icon: 'success' })
          await this.load()
        } catch (err) {
          wx.showToast({ title: err.message || '删除失败', icon: 'none' })
        }
      },
    })
  },
})