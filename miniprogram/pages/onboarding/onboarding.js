'use strict'

const { api } = require('../../utils/api.js')
const { createInviteFlow, isTerminalFailure, showInviteResult } = require('../../utils/invite.js')

Page({
  data: {
    nickname: '',
    avatarUrl: '',
    saving: false,
    familyName: '',
    inviteCode: '',
    submitting: false,
  },

  onLoad() {
    const app = getApp()
    this.inviteFlow = createInviteFlow({
      api,
      boot: () => app.boot(),
      setCurrentFamily: (id) => app.setCurrentFamily(id),
      refreshSession: () => app.refreshSession(),
    })
    this.inviteUi = {
      toast: (title) => wx.showToast({ title, icon: 'none' }),
      modal: (title, content) => wx.showModal({ title, content, showCancel: false }),
      go: (url) => setTimeout(() => wx.reLaunch({ url }), 600),
      alreadyAtHome: false,
    }
  },

  async onShow() {
    const app = getApp()
    try {
      const boot = await app.boot()
      if (boot.route === 'home') {
        wx.reLaunch({ url: '/pages/index/index' })
        return
      }
      // T11: 分享卡片冷启动 → 登录成功后自动 joinByCode; 首登无档案者先完成自填昵称
      // (identity.md 首登引导), onSaveProfile 成功后自动加入
      const pending = app.globalData.pendingInviteCode
      if (pending && boot.user.nickname) {
        await this.joinPending(app)
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

  // T11: 待处理邀请入伙; 确定失败(域错误码)清邀请码, 网络错误保留下次重试
  async joinPending(app) {
    const result = await this.inviteFlow.joinFromInvite(app.globalData.pendingInviteCode)
    if (result.status !== 'failed' || isTerminalFailure(result)) {
      app.globalData.pendingInviteCode = ''
    }
    showInviteResult(result, this.inviteUi)
  },

  onChooseAvatar(e) {
    this.setData({ avatarUrl: e.detail.avatarUrl })
  },

  onNicknameInput(e) {
    this.setData({ nickname: e.detail.value })
  },

  onFamilyNameInput(e) {
    this.setData({ familyName: e.detail.value })
  },

  onInviteCodeInput(e) {
    this.setData({ inviteCode: e.detail.value })
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
      // T11: 首登自填昵称完成 → 自动加入分享卡片指向的家庭
      if (getApp().globalData.pendingInviteCode) {
        await this.joinPending(getApp())
        return
      }
      wx.showToast({ title: '已保存', icon: 'success' })
    } catch (err) {
      this.setData({ saving: false })
      wx.showToast({ title: err.message || '保存失败', icon: 'none' })
    }
  },

  async onCreateFamily() {
    const name = (this.data.familyName || '').trim()
    if (!name) {
      wx.showToast({ title: '请输入家庭名称', icon: 'none' })
      return
    }
    await this.submit(() => api.createFamily(name), '家庭已创建')
  },

  async onJoinFamily() {
    const code = (this.data.inviteCode || '').trim()
    if (!code) {
      wx.showToast({ title: '请输入邀请码', icon: 'none' })
      return
    }
    await this.submit(() => api.joinByCode(code), '已加入家庭')
  },

  async submit(runApi, successText) {
    if (this.data.submitting) return
    this.setData({ submitting: true })
    try {
      await runApi()
      const app = getApp()
      await app.refreshSession()
      // 手动建家/加入成功: 消费掉待处理邀请, 防残留后置重试
      app.globalData.pendingInviteCode = ''
      this.setData({ submitting: false, familyName: '', inviteCode: '' })
      wx.showToast({ title: successText, icon: 'success' })
      setTimeout(() => wx.reLaunch({ url: '/pages/index/index' }), 600)
    } catch (err) {
      this.setData({ submitting: false })
      wx.showToast({ title: err.message || '操作失败', icon: 'none' })
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