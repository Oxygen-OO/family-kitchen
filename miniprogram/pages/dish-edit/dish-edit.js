'use strict'

const { api } = require('../../utils/api.js')

const PRESET_TAGS = ['家常菜', '快手菜', '汤', '硬菜', '素菜', '早餐']
const MAX_TAGS = 6

Page({
  data: {
    familyId: '',
    dishId: '',
    name: '',
    image: '',
    description: '',
    ingredients: [],
    tags: [],
    presetTags: PRESET_TAGS,
    customTag: '',
    saving: false,
  },

  async onLoad(options) {
    const app = getApp()
    this.setData({ familyId: app.globalData.currentFamilyId, dishId: options.id || '' })
    if (options.id) {
      try {
        const boot = await app.boot()
        if (boot.route !== 'home') {
          wx.reLaunch({ url: '/pages/onboarding/onboarding' })
          return
        }
        const dishes = await api.listDishes(this.data.familyId)
        const dish = dishes.find((d) => d.dish_id === options.id)
        if (!dish) {
          wx.showToast({ title: '菜品不存在', icon: 'none' })
          setTimeout(() => wx.navigateBack(), 600)
          return
        }
        this.setData({
          name: dish.name,
          image: dish.image || '',
          description: dish.description || '',
          ingredients: (dish.ingredients || []).map((i) => ({ name: i.name, amount: i.amount })),
          tags: dish.tags || [],
        })
      } catch (err) {
        wx.showToast({ title: err.message || '加载失败', icon: 'none' })
      }
    }
  },

  onNameInput(e) {
    this.setData({ name: e.detail.value })
  },

  onDescriptionInput(e) {
    this.setData({ description: e.detail.value })
  },

  async onChooseImage() {
    try {
      const res = await wx.chooseMedia({ count: 1, mediaType: ['image'], sizeType: ['compressed'] })
      const file = res.tempFiles && res.tempFiles[0]
      if (!file || !file.tempFilePath) return
      this.setData({ uploading: true })
      const ext = (file.tempFilePath.split('.').pop() || 'jpg').toLowerCase()
      const uploaded = await wx.cloud.uploadFile({
        cloudPath: `dishes/${Date.now()}.${ext}`,
        filePath: file.tempFilePath,
      })
      this.setData({ image: uploaded.fileID, uploading: false })
    } catch (err) {
      this.setData({ uploading: false })
      wx.showToast({ title: '图片上传失败', icon: 'none' })
    }
  },

  onRemoveImage() {
    this.setData({ image: '' })
  },

  onIngredientNameInput(e) {
    const index = e.currentTarget.dataset.index
    this.setData({ [`ingredients[${index}].name`]: e.detail.value })
  },

  onIngredientAmountInput(e) {
    const index = e.currentTarget.dataset.index
    this.setData({ [`ingredients[${index}].amount`]: e.detail.value })
  },

  onAddIngredient() {
    const ingredients = [...this.data.ingredients, { name: '', amount: '' }]
    this.setData({ ingredients })
  },

  onRemoveIngredient(e) {
    const index = e.currentTarget.dataset.index
    const ingredients = this.data.ingredients.filter((_, i) => i !== index)
    this.setData({ ingredients })
  },

  onPresetTagTap(e) {
    const tag = e.currentTarget.dataset.tag
    const tags = [...this.data.tags]
    const idx = tags.indexOf(tag)
    if (idx >= 0) {
      tags.splice(idx, 1)
    } else {
      if (tags.length >= MAX_TAGS) {
        wx.showToast({ title: `最多 ${MAX_TAGS} 个标签`, icon: 'none' })
        return
      }
      tags.push(tag)
    }
    this.setData({ tags })
  },

  onCustomTagInput(e) {
    this.setData({ customTag: e.detail.value })
  },

  onAddCustomTag() {
    const tag = (this.data.customTag || '').trim()
    if (!tag) return
    if (this.data.tags.includes(tag)) {
      this.setData({ customTag: '' })
      return
    }
    if (this.data.tags.length >= MAX_TAGS) {
      wx.showToast({ title: `最多 ${MAX_TAGS} 个标签`, icon: 'none' })
      return
    }
    this.setData({ tags: [...this.data.tags, tag], customTag: '' })
  },

  onRemoveTag(e) {
    const tag = e.currentTarget.dataset.tag
    this.setData({ tags: this.data.tags.filter((t) => t !== tag) })
  },

  async onSave() {
    if (this.data.saving) return
    const name = (this.data.name || '').trim()
    if (!name) {
      wx.showToast({ title: '请输入菜品名称', icon: 'none' })
      return
    }
    const ingredients = []
    const rows = this.data.ingredients
    for (let i = 0; i < rows.length; i++) {
      const namePart = (rows[i].name || '').trim()
      const amount = (rows[i].amount || '').trim()
      if (!namePart && !amount) continue
      if (!namePart || !amount) {
        wx.showToast({ title: `第 ${i + 1} 项食材需填写名称和用量`, icon: 'none' })
        return
      }
      ingredients.push({ name: namePart, amount })
    }

    this.setData({ saving: true })
    const payload = {
      name,
      image: this.data.image,
      description: (this.data.description || '').trim(),
      ingredients,
      tags: this.data.tags,
    }
    try {
      if (this.data.dishId) {
        await api.updateDish(this.data.familyId, this.data.dishId, payload)
      } else {
        await api.createDish(this.data.familyId, payload)
      }
      wx.showToast({ title: '已保存', icon: 'success' })
      setTimeout(() => wx.navigateBack(), 500)
    } catch (err) {
      this.setData({ saving: false })
      wx.showToast({ title: err.message || '保存失败', icon: 'none' })
    }
  },
})