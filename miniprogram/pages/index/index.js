'use strict'

const { api } = require('../../utils/api.js')

Page({
  data: {
    nickname: '',
    families: [],
    currentFamilyId: '',
    currentFamilyName: '',
    inviting: false,
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