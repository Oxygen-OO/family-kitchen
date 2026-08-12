'use strict'

Page({
  data: {
    nickname: '',
    defaultFamilyId: '',
  },

  async onShow() {
    const app = getApp()
    try {
      const boot = await app.boot()
      if (boot.route !== 'home') {
        wx.reLaunch({ url: '/pages/onboarding/onboarding' })
        return
      }
      const families = boot.families || []
      this.setData({
        nickname: boot.user.nickname,
        defaultFamilyId: families.length > 0 ? families[0].family_id : '',
      })
    } catch (err) {
      // 网络异常: 静默, 下次 onShow 兜底重试
    }
  },
})