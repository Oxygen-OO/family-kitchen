'use strict'

const { api } = require('../../utils/api.js')
const { SLOTS: MEAL_SLOTS } = require('../../utils/slots.js')

Page({
  data: {
    nickname: '',
    families: [],
    currentFamilyId: '',
    currentFamilyName: '',
    inviting: false,
    mealSlots: MEAL_SLOTS,
    enteringMeal: '',
  },

  async onShow() {
    const app = getApp()
    try {
      const boot = await app.boot()
      if (boot.route !== 'home') {
        wx.reLaunch({ url: '/pages/onboarding/onboarding' })
        return
      }
      const families = await api.myFamilies()
      const storedId = app.globalData.currentFamilyId
      const remembered = families.find(
        (f) => f.family_id === storedId && f.status === 'active'
      )
      const fallback = families.find((f) => f.status === 'active')
      const current = remembered || fallback
      // AC(T3): 成员进入时全局提示「该家庭已冻结」(上次停留的是冻结家庭, 切换器已置灰不可进入)
      const storedFamily = families.find((f) => f.family_id === storedId)
      if (storedFamily && storedFamily.status !== 'active') {
        wx.showToast({ title: '该家庭已冻结', icon: 'none' })
      }
      this.setData({
        nickname: boot.user.nickname,
        families,
        currentFamilyId: current ? current.family_id : '',
        currentFamilyName: current ? current.name : '',
      })
    } catch (err) {
      // 网络异常: 静默, 下次 onShow 兜底重试
    }
  },

  onSwitchFamily(e) {
    const familyId = e.currentTarget.dataset.id
    const family = this.data.families.find((f) => f.family_id === familyId)
    if (!family || family.status !== 'active') return
    const app = getApp()
    app.setCurrentFamily(familyId)
    this.setData({ currentFamilyId: familyId, currentFamilyName: family.name })
    wx.showToast({ title: `已切换到「${family.name}」`, icon: 'none' })
  },

  onOpenMenu() {
    if (!this.data.currentFamilyId) return
    wx.navigateTo({ url: '/pages/dishes/dishes' })
  },

  onOpenMembers() {
    if (!this.data.currentFamilyId) return
    wx.navigateTo({ url: '/pages/members/members' })
  },

  // 备餐清单页(T10): 厨师主场, 无家庭上下文不进
  onOpenPrep() {
    if (!this.data.currentFamilyId) return
    wx.navigateTo({ url: '/pages/prep/prep' })
  },

  // 今日餐次入口: 先读(已有餐次任何状态均可进入只读/点餐), 未发起才写(发起失败如已过
  // 默认截止 → 提示不留死角); 派生 mealId familyId:date:slot 是架构锁定的 ID 契约
  async onEnterMeal(e) {
    const slot = e.currentTarget.dataset.slot
    const familyId = this.data.currentFamilyId
    if (!familyId || this.data.enteringMeal) return
    const date = this.localDate()
    const mealId = `${familyId}:${date}:${slot}`
    this.setData({ enteringMeal: slot })
    try {
      try {
        await api.viewMeal(mealId)
      } catch (err) {
        if (err.code === 'MEAL_NOT_FOUND') {
          try {
            await api.initiate(familyId, slot, { date })
          } catch (initErr) {
            if (initErr.code !== 'MEAL_EXISTS') throw initErr
          }
        } else {
          throw err
        }
      }
      wx.navigateTo({ url: `/pages/meal/meal?mealId=${mealId}` })
    } catch (err) {
      wx.showToast({ title: err.message || '进入失败', icon: 'none' })
    } finally {
      this.setData({ enteringMeal: '' })
    }
  },

  localDate() {
    const d = new Date()
    const m = String(d.getMonth() + 1).padStart(2, '0')
    const day = String(d.getDate()).padStart(2, '0')
    return `${d.getFullYear()}-${m}-${day}`
  },

  async onInvite() {
    if (this.data.inviting) return
    this.setData({ inviting: true })
    try {
      const { code, expiresAt } = await api.generateInviteCode(this.data.currentFamilyId)
      const date = new Date(expiresAt)
      const text = `邀请码：${code}\n有效期至 ${date.getMonth() + 1}月${date.getDate()}日\n分享给家人，凭码加入即可`
      wx.showModal({
        title: '邀请家人',
        content: text,
        confirmText: '复制',
        success: (res) => {
          if (res.confirm) {
            wx.setClipboardData({ data: code })
          }
        },
      })
      this.setData({ inviting: false })
    } catch (err) {
      this.setData({ inviting: false })
      wx.showToast({ title: err.message || '生成失败', icon: 'none' })
    }
  },
})