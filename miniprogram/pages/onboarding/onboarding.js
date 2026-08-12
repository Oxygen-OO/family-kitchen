'use strict'

const { api } = require('../../utils/api.js')

Page({
  data: {
    nickname: '',
    avatarUrl: '',
    saving: false,
  },

  async onShow() {
    const app = getApp()
    try {
      const boot = await app.boot()
      if (boot.route === 'home') {
        wx.reLaunch({ url: '/pages/index/index' })
        return
      }
      const cached = this.data.nickname
      if (boot.user.nickname) {
        this.setData({ nickname: boot.user.nickname, avatarUrl: boot.user.avatar || '' })
      } else {
        this.setData({ nickname: cached })
      }
    } catch (err) {
      // 网络异常: 静默, 下次 onShow 兜底重试
    }
  },

  onChooseAvatar(e) {
    this.setData({ avatarUrl: e.detail.avatarUrl })
  },

  onNicknameInput(e) {
    this.setData({ nickname: e.detail.value })
  },

  async onSaveProfile() {
    const nickname = (this.data.nickname || '').trim()
    if (!nickname) {
      wx.showToast({ title: '请输入昵称', icon: 'none' })
      return
    }
    this.setData({ saving: true })
    try {
      const avatar = await this.uploadAvatarOrEmpty(this.data.avatarUrl)
      const { user } = await api.saveProfile({ nickname, avatar })
      this.setData({ nickname: user.nickname, avatarUrl: user.avatar || '', saving: false })
      wx.showToast({ title: '已保存', icon: 'success' })
    } catch (err) {
      this.setData({ saving: false })
      wx.showToast({ title: err.message || '保存失败', icon: 'none' })
    }
  },

  uploadAvatarOrEmpty(avatarUrl) {
    if (!avatarUrl) return Promise.resolve('')
    if (avatarUrl.startsWith('cloud://')) return Promise.resolve(avatarUrl)
    const ext = (avatarUrl.split('.').pop() || 'png').toLowerCase()
    return wx.cloud.uploadFile({
      cloudPath: `avatars/${Date.now()}.${ext}`,
      filePath: avatarUrl,
    }).then((res) => res.fileID)
  },
})