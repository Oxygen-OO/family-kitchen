'use strict'

const { api } = require('../../utils/api.js')

// 解散双击确认的待确认窗口: 首击后 5 秒未再击自动复位
const DISSOLVE_ARMLOCK_MS = 5000

Page({
  data: {
    familyId: '',
    familyName: '',
    members: [],
    isCreator: false,
    busy: false,
    dissolving: false,
    dissolvingArmed: false,
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
      const [families, rows] = await Promise.all([
        api.myFamilies(),
        api.listMembers(familyId),
      ])
      const family = families.find((f) => f.family_id === familyId)
      // 冻结家庭不可进入(切换器已置灰): 防御兜底 + 全局提示(AC: 成员进入时提示「该家庭已冻结」)
      if (!family || family.status !== 'active') {
        wx.showToast({ title: '该家庭已冻结', icon: 'none' })
        wx.reLaunch({ url: '/pages/index/index' })
        return
      }
      this.setData({
        familyId,
        familyName: family.name,
        members: decorate(rows, boot.openid),
        isCreator: rows.some((row) => row.user_openid === boot.openid && row.role === 'creator'),
      })
    } catch (err) {
      wx.showToast({ title: err.message || '加载失败', icon: 'none' })
      wx.navigateBack()
    }
  },

  async reload() {
    try {
      const [boot, rows] = await Promise.all([getApp().boot(), api.listMembers(this.data.familyId)])
      this.setData({
        members: decorate(rows, boot.openid),
        isCreator: rows.some((row) => row.user_openid === boot.openid && row.role === 'creator'),
      })
    } catch (err) {
      wx.showToast({ title: err.message || '刷新失败', icon: 'none' })
    }
  },

  // 转让: 立家者专属; 目标选单只列他人(自己转让给本人是空操作, 无意义)
  onTransfer() {
    const candidates = this.data.members.filter((row) => !row.isMe)
    if (candidates.length === 0) return
    wx.showActionSheet({
      itemList: candidates.map((row) => row.display),
      success: (res) => {
        const target = candidates[res.tapIndex]
        if (!target) return
        wx.showModal({
          title: '转让所有权',
          content: `确定将立家者身份转让给 ${target.display}？转让后你将成为普通成员。`,
          confirmText: '转让',
          success: async (modal) => {
            if (!modal.confirm) return
            try {
              await api.transferOwnership(this.data.familyId, target.user_openid)
              wx.showToast({ title: '已转让', icon: 'success' })
              this.reload()
            } catch (err) {
              wx.showToast({ title: err.message || '转让失败', icon: 'none' })
            }
          },
        })
      },
    })
  },

  // 解散(双击确认): 首击进入待确认态(按钮变红+5 秒自动复位), 再击才真正执行 ——
  // 误触不至于不可逆(冻结即终态, MVP 不解冻)
  onDissolve() {
    if (this.data.dissolving) return
    if (!this.data.dissolvingArmed) {
      this.setData({ dissolvingArmed: true })
      if (this.dissolveTimer) clearTimeout(this.dissolveTimer)
      this.dissolveTimer = setTimeout(() => this.setData({ dissolvingArmed: false }), DISSOLVE_ARMLOCK_MS)
      return
    }
    clearTimeout(this.dissolveTimer)
    this.setData({ dissolving: true })
    api.dissolveFamily(this.data.familyId)
      .then(() => {
        const app = getApp()
        app.setCurrentFamily('')
        wx.showToast({ title: '家庭已解散', icon: 'success' })
        // 冻结家庭仍在会话家庭列表里(数据不删): 回到主页即见置灰不可进入
        setTimeout(() => wx.reLaunch({ url: '/pages/index/index' }), 600)
      })
      .catch((err) => {
        this.setData({ dissolving: false, dissolvingArmed: false })
        wx.showToast({ title: err.message || '解散失败', icon: 'none' })
      })
  },

  // 退出: 普通成员专属(立家者只能先转让或解散, 服务端 CREATOR_LEAVE_FORBIDDEN 兜底);
  // 退出后路由交给 T1 startup 判定: 无任何家庭 → 主页 onShow 自动转 onboarding
  onLeave() {
    if (this.data.busy) return
    wx.showModal({
      title: '退出家庭',
      content: `确定退出「${this.data.familyName}」？退出后需凭邀请码重新加入。`,
      confirmText: '退出',
      confirmColor: '#fa5151',
      success: async (res) => {
        if (!res.confirm) return
        this.setData({ busy: true })
        try {
          await api.leaveFamily(this.data.familyId)
          const app = getApp()
          await app.refreshSession()
          wx.showToast({ title: '已退出', icon: 'success' })
          setTimeout(() => wx.reLaunch({ url: '/pages/index/index' }), 600)
        } catch (err) {
          this.setData({ busy: false })
          wx.showToast({ title: err.message || '退出失败', icon: 'none' })
        }
      },
    })
  },
})

// family_members 无昵称列(见 family-engine.md nickname 注记): 展示用掩码 openid,
// 自己显示「我」; joined_at 渲染为日期
function decorate(rows, myOpenid) {
  return rows.map((row) => ({
    ...row,
    isMe: row.user_openid === myOpenid,
    display: row.user_openid === myOpenid ? '我' : maskOpenid(row.user_openid),
    joinedText: formatDate(row.joined_at),
  }))
}

function maskOpenid(openid) {
  const tail = String(openid || '').slice(-4)
  return `o***${tail}`
}

function formatDate(ts) {
  if (!ts) return ''
  const d = new Date(ts)
  const m = String(d.getMonth() + 1).padStart(2, '0')
  const day = String(d.getDate()).padStart(2, '0')
  return `${d.getFullYear()}-${m}-${day}`
}