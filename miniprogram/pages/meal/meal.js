'use strict'

const { api } = require('../../utils/api.js')

const SLOT_LABELS = { breakfast: '早餐', lunch: '午餐', dinner: '晚餐' }

Page({
  data: {
    mealId: '',
    loading: false,
    submitting: false,
    meal: null,
    slotLabel: '',
    status: '',
    deadline: 0,
    canOrder: false,
    viewMode: 'card',
    menu: [],
    cart: [],
    myOrder: null,
    live: null,
    dropped: [],
    cartCount: 0,
    cartTotal: 0,
    note: '',
    panelOpen: false,
    countdown: '',
  },

  onLoad(options) {
    const mealId = options && options.mealId
    if (!mealId) {
      wx.showToast({ title: '缺少餐次参数', icon: 'none' })
      wx.navigateBack()
      return
    }
    this.mealId = mealId
    this.setData({ mealId })
  },

  onUnload() {
    this.clearCountdown()
  },

  async onShow() {
    const app = getApp()
    try {
      const boot = await app.boot()
      if (boot.route !== 'home') {
        wx.reLaunch({ url: '/pages/onboarding/onboarding' })
        return
      }
      await this.load()
    } catch (err) {
      wx.showToast({ title: err.message || '加载失败', icon: 'none' })
    }
  },

  async load() {
    if (this.data.loading) return
    this.setData({ loading: true })
    try {
      const view = await api.viewMeal(this.mealId)
      this.applyView(view)
    } catch (err) {
      wx.showToast({ title: err.message || '加载失败', icon: 'none' })
    } finally {
      this.setData({ loading: false })
    }
  },

  applyView(view) {
    const cart = view.menu.map((dish) => {
      const mine = (view.myOrder && view.myOrder.dishes.find((m) => m.dishId === dish.dishId)) || null
      return {
        dishId: dish.dishId,
        name: dish.name,
        ingredients: dish.ingredients,
        quantity: mine ? mine.quantity : 0,
      }
    })
    const note = (view.myOrder && view.myOrder.note) || ''
    this.setData({
      meal: view.meal,
      status: view.meal.status,
      deadline: view.meal.deadline,
      canOrder: view.canOrder,
      menu: view.menu,
      cart,
      myOrder: view.myOrder,
      live: view.live,
      dropped: view.dropped || [],
      note,
      slotLabel: SLOT_LABELS[view.meal.slot] || view.meal.slot,
    })
    wx.setNavigationBarTitle({ title: `${this.data.slotLabel} · ${view.meal.date}` })
    this.syncCounts()
    this.setupCountdown()
  },

  syncCounts() {
    const rows = this.data.cart.filter((c) => c.quantity > 0)
    const total = rows.reduce((sum, c) => sum + c.quantity, 0)
    this.setData({ cartCount: rows.length, cartTotal: total })
  },

  // 视图切换: 复用 T4 菜单页的大图/小图/极简三档交互
  onViewMode(e) {
    this.setData({ viewMode: e.currentTarget.dataset.mode })
  },

  setQuantity(dishId, quantity) {
    const cart = this.data.cart.map((c) => (c.dishId === dishId ? { ...c, quantity } : c))
    this.setData({ cart })
    this.syncCounts()
  },

  onPlus(e) {
    const dishId = e.currentTarget.dataset.dishid
    const row = this.data.cart.find((c) => c.dishId === dishId)
    if (row) this.setQuantity(dishId, Math.min(row.quantity + 1, 99))
  },

  onMinus(e) {
    const dishId = e.currentTarget.dataset.dishid
    const row = this.data.cart.find((c) => c.dishId === dishId)
    if (row) this.setQuantity(dishId, Math.max(row.quantity - 1, 0))
  },

  // ── 倒计时: 前端 setInterval 渲染, 截止瞬间刷新页面(服务端以 deadline 为准) ──
  setupCountdown() {
    this.clearCountdown()
    if (this.data.status !== 'ongoing' || !this.data.canOrder || !this.data.deadline) {
      this.setData({ countdown: '' })
      return
    }
    this.tick()
    this.timer = setInterval(() => this.tick(), 1000)
  },

  tick() {
    const remain = this.data.deadline - Date.now()
    if (remain <= 0) {
      this.setData({ countdown: '00:00:00' })
      this.clearCountdown()
      this.load() // 截止瞬间刷新页面
      return
    }
    const s = Math.floor(remain / 1000)
    const pad = (n) => String(n).padStart(2, '0')
    this.setData({
      countdown: `${pad(Math.floor(s / 3600))}:${pad(Math.floor((s % 3600) / 60))}:${pad(s % 60)}`,
    })
  },

  clearCountdown() {
    if (this.timer) {
      clearInterval(this.timer)
      this.timer = null
    }
  },

  // ── 确认面板 ──
  onOpenPanel() {
    if (!this.data.canOrder || this.data.cartCount === 0) return
    this.setData({ panelOpen: true })
  },

  onClosePanel() {
    this.setData({ panelOpen: false })
  },

  onPanelMinus(e) {
    const dishId = e.currentTarget.dataset.dishid
    const row = this.data.cart.find((c) => c.dishId === dishId)
    if (row) this.setQuantity(dishId, Math.max(row.quantity - 1, 0))
  },

  onPanelPlus(e) {
    const dishId = e.currentTarget.dataset.dishid
    const row = this.data.cart.find((c) => c.dishId === dishId)
    if (row) this.setQuantity(dishId, Math.min(row.quantity + 1, 99))
  },

  onNoteInput(e) {
    this.setData({ note: e.detail.value })
  },

  async onConfirm() {
    if (this.data.submitting) return
    const dishes = this.data.cart
      .filter((c) => c.quantity > 0)
      .map((c) => ({ dishId: c.dishId, quantity: c.quantity }))
    if (dishes.length === 0) return
    this.setData({ submitting: true })
    try {
      const view = await api.placeOrder(this.mealId, dishes, this.data.note)
      this.applyView(view)
      this.setData({ panelOpen: false })
      wx.showToast({ title: '点选已提交', icon: 'success' })
      if (view.dropped && view.dropped.length > 0) {
        this.notifyDropped(view.dropped)
      }
    } catch (err) {
      if (err.code === 'PAST_CUTOFF' || err.code === 'MEAL_LOCKED') {
        // 提交瞬间到点(代截止)/已锁: 刷新按只读展示
        this.setData({ panelOpen: false })
        await this.load()
      }
      wx.showToast({ title: err.message || '提交失败', icon: 'none' })
    } finally {
      this.setData({ submitting: false })
    }
  },

  // ── 手动提前截止: 任何成员可触发, 服务端校验家庭成员; 走与自动截止相同的关闭管线 ──
  onCloseEarly() {
    const success = async (res) => {
      if (!res.confirm) return
      try {
        const view = await api.closeEarly(this.mealId)
        this.applyView(view)
        wx.showToast({ title: '已截止，点选锁定', icon: 'success' })
      } catch (err) {
        if (err.code === 'NOT_ONGOING') {
          // 已被截止(自己这单赢 或 他人抢先): 刷新按只读展示
          await this.load()
        }
        wx.showToast({ title: err.message || '操作失败', icon: 'none' })
      }
    }
    wx.showModal({
      title: '提前截止',
      content: '截止后所有成员的点选将锁定，且不可重新开启。确定提前截止吗？',
      confirmColor: '#fa5151',
      success,
    })
  },

  notifyDropped(dropped) {
    const names = dropped.map((d) => d.dishName).join('、')
    wx.showModal({
      title: '部分菜品不可选',
      content: `以下菜品已下架或删除，未计入本次点选：${names}`,
      showCancel: false,
      confirmText: '知道了',
    })
  },

  cancelOrder() {
    if (!this.data.canOrder || !this.data.myOrder) return
    const success = async (res) => {
      if (!res.confirm) return
      try {
        const view = await api.placeOrder(this.mealId, [], '')
        this.applyView(view)
        wx.showToast({ title: '已取消点选', icon: 'success' })
      } catch (err) {
        wx.showToast({ title: err.message || '取消失败', icon: 'none' })
      }
    }
    wx.showModal({
      title: '取消点选',
      content: '将清空你本次的全部点选',
      confirmColor: '#fa5151',
      success,
    })
  },

  ingredientsText(ingredients) {
    return (ingredients || []).map((i) => `${i.name} ${i.amount}`).join('、')
  },

  orderedByText(orderedBy) {
    return (orderedBy || []).map((o) => `${o.nickname || o.openid}${o.quantity > 1 ? ` ×${o.quantity}` : ''}`).join('、')
  },
})