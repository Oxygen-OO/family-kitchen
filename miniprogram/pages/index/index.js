'use strict'

const { api } = require('../../utils/api.js')
const { SLOTS: MEAL_SLOTS } = require('../../utils/slots.js')
const {
  resolveInviteCode,
  pickValidInviteCode,
  createInviteFlow,
  isTerminalFailure,
  showInviteResult,
} = require('../../utils/invite.js')

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

  // T11: 冷启动分享卡片解析(双通道: scene 优先, 无则 query 降级); 页面实例级, onShow 消费
  onLoad(options) {
    this.inviteCode = resolveInviteCode(options || {})
    const app = getApp()
    this.inviteFlow = createInviteFlow({
      api,
      boot: () => app.boot(),
      setCurrentFamily: (id) => app.setCurrentFamily(id),
      refreshSession: () => app.refreshSession(),
    })
    // 分流 UI 原语: 已在首页, already 分流不重载自身
    this.inviteUi = {
      toast: (title) => wx.showToast({ title, icon: 'none' }),
      modal: (title, content) => wx.showModal({ title, content, showCancel: false }),
      go: (url) => setTimeout(() => wx.reLaunch({ url }), 600),
      alreadyAtHome: true,
    }
  },

  async onShow() {
    const app = getApp()
    try {
      const boot = await app.boot()
      if (this.inviteCode) {
        await this.handleInvite(boot.route)
        return
      }
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

  // T11 分享卡片直达: 未登录(route=onboarding)先走 T1 登录流程, 登录后 onboarding 页自动加入;
  // 已登录直接 joinByCode。确定失败(域错误码)清邀请码, 网络错误保留下次 onShow 重试
  async handleInvite(route) {
    const app = getApp()
    const code = this.inviteCode
    if (route === 'onboarding') {
      app.globalData.pendingInviteCode = code
      this.inviteCode = null
      wx.reLaunch({ url: '/pages/onboarding/onboarding' })
      return
    }
    const result = await this.inviteFlow.joinFromInvite(code)
    if (result.status !== 'failed' || isTerminalFailure(result)) this.inviteCode = null
    showInviteResult(result, this.inviteUi)
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
      // 回写缓存: 分享卡片取码与弹码入口同源(单码覆盖模型, 见 family-engine.md)
      this.setData({
        families: this.data.families.map((f) =>
          f.family_id === this.data.currentFamilyId
            ? { ...f, invite_code: code, expires_at: expiresAt }
            : f
        ),
      })
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

  // T11 分享卡片: 取当前家庭有效邀请码(缓存过期则经 generateInviteCode 重新生成并回写缓存),
  // scene 参数 invite_ABC123 甩进群里, 家人点开直达入伙(零复制粘贴)
  async onShareAppMessage() {
    const { currentFamilyId, currentFamilyName, families } = this.data
    if (!currentFamilyId) return {}
    let code = pickValidInviteCode(families, currentFamilyId, Date.now())
    if (!code) {
      try {
        const res = await api.generateInviteCode(currentFamilyId)
        code = res.code
        this.setData({
          families: families.map((f) =>
            f.family_id === currentFamilyId ? { ...f, invite_code: res.code, expires_at: res.expiresAt } : f
          ),
        })
      } catch (err) {
        return {}
      }
    }
    return {
      title: `邀请你加入 ${currentFamilyName} 厨房`,
      path: `/pages/index/index?scene=invite_${code}`,
      imageUrl: '/images/avatar.png',
    }
  },
})