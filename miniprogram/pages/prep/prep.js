'use strict'

const { api } = require('../../utils/api.js')
const { SLOTS, SLOT_LABELS } = require('../../utils/slots.js')

// 备餐清单页(T10): 厨师主场 —— 日期选择器默认今天(未来日期灰置/不可选),
// 按 (date, slot) 派生 mealId 三连 viewMeal「先读后发」(不存在即无餐次卡, 引擎侧无「按日列表」);
// 三态卡片: ongoing → 实时预览(只算不物化); closed/prepared → meals.summary 快照,
// summary 缺失(T8 崩溃窗口) → 空清单 + 显式空态提示, 后端零改动;
// 双视图: 按菜品(谁点了/共几份/软删菜 removed 标注) / 按食材(精确去重采购清单, 长按复制文本);
// 「标记已备餐」仅 closed 可见, 标记后刷新(服务端 claimPrepared 原子裁决, 不可撤销)。

Page({
  data: {
    date: '',
    today: '',
    loading: false,
    viewMode: 'dish',
    slots: [],
    allMissed: false,
    markingMealId: '',
  },

  async onShow() {
    const app = getApp()
    try {
      const boot = await app.boot()
      if (boot.route !== 'home') {
        wx.reLaunch({ url: '/pages/onboarding/onboarding' })
        return
      }
      if (!app.globalData.currentFamilyId) {
        wx.navigateBack()
        return
      }
      if (!this.data.date) {
        const today = localDate()
        this.setData({ date: today, today })
      }
      await this.load()
    } catch (err) {
      wx.showToast({ title: err.message || '加载失败', icon: 'none' })
    }
  },

  async load() {
    if (this.data.loading) return
    this.setData({ loading: true })
    const app = getApp()
    const familyId = app.globalData.currentFamilyId
    const date = this.data.date
    try {
      // 三连先读后发: 存在即展示, MEAL_NOT_FOUND 即无餐次卡(不发明按日列表引擎方法)
      const rows = await Promise.all(SLOTS.map(async (slot) => {
        const mealId = `${familyId}:${date}:${slot}`
        try {
          return decorateSlot({ slot, label: SLOT_LABELS[slot], mealId, view: await api.viewMeal(mealId) })
        } catch (err) {
          if (err.code === 'MEAL_NOT_FOUND') return { slot, label: SLOT_LABELS[slot], mealId, view: null }
          throw err
        }
      }))
      this.setData({ slots: rows, allMissed: rows.every((r) => !r.view) })
    } catch (err) {
      wx.showToast({ title: err.message || '加载失败', icon: 'none' })
    } finally {
      this.setData({ loading: false })
    }
  },

  onDateChange(e) {
    if (!e.detail.value) return
    this.setData({ date: e.detail.value })
    this.load()
  },

  onPrevDay() {
    this.shiftDay(-1)
  },

  onNextDay() {
    if (this.data.date === this.data.today) return // 未来日期灰置
    this.shiftDay(1)
  },

  shiftDay(delta) {
    this.setData({ date: addDays(this.data.date, delta) })
    this.load()
  },

  onSwitchView(e) {
    this.setData({ viewMode: e.currentTarget.dataset.mode })
  },

  // 长按复制食材文本(采购清单): 整卡食材区一键复制, 单行也在复制串内
  onCopyIngredients(e) {
    const row = this.data.slots[e.currentTarget.dataset.index]
    if (!row || !row.copyText) return
    wx.setClipboardData({ data: row.copyText })
  },

  // 标记已备餐: 仅 closed 卡片可见; 服务端仅 closed → prepared(原子抢占), 不可撤销
  onMarkPrepared(e) {
    const mealId = e.currentTarget.dataset.mealid
    if (!mealId || this.data.markingMealId) return
    wx.showModal({
      title: '标记已备餐',
      content: '标记后本餐次显示「已备餐」且不可撤销。确认已按清单完成备餐？',
      confirmText: '标记',
      success: async (res) => {
        if (!res.confirm) return
        this.setData({ markingMealId: mealId })
        try {
          await api.markPrepared(mealId)
          wx.showToast({ title: '已标记备餐', icon: 'success' })
          await this.load()
        } catch (err) {
          if (err.code === 'NOT_ONGOING') {
            // 并发下他人先手已标记/状态已变: 刷新按真实状态展示
            await this.load()
            wx.showToast({ title: '该餐次已被标记', icon: 'none' })
          } else {
            wx.showToast({ title: err.message || '操作失败', icon: 'none' })
          }
        } finally {
          this.setData({ markingMealId: '' })
        }
      },
    })
  },
})

// ── 纯装饰: 把视图整理成 WXML 直取形状, 双视图渲染字段全部在这一个函数里 ──
function decorateSlot(row) {
  if (!row.view) return row
  const meal = row.view.meal
  const live = row.view.live
  return {
    ...row,
    // 三态: ongoing 实时预览; closed/prepared 读快照; 快照缺失(崩溃窗口) → 显式空态
    summaryMissing: meal.status !== 'ongoing' && !live,
    isEmpty: !!(live && live.byDish.length === 0),
    dishRows: (live && live.byDish || []).map((d) => ({
      dishId: d.dishId,
      dishName: d.dishName,
      totalQuantity: d.totalQuantity,
      removed: d.removed,
      peopleText: (d.orderedBy || [])
        .map((o) => `${o.nickname || maskOpenid(o.openid)}${o.quantity > 1 ? ` ×${o.quantity}` : ''}`)
        .join('、'),
    })),
    ingredientRows: (live && live.ingredients || []).map((i) => ({
      name: i.name,
      amountText: i.amountText,
      dishCount: i.dishCount,
    })),
    // 长按复制: 「食材 用量、食材 用量」单行文本(采购备忘可直接粘贴)
    copyText: (live && live.ingredients || [])
      .map((i) => `${i.name} ${i.amountText}`)
      .join('、'),
    preparedAtText: meal.status === 'prepared' ? formatPreparedAt(meal.prepared_at, meal.date) : '',
  }
}

function maskOpenid(openid) {
  const tail = String(openid || '').slice(-4)
  return `o***${tail}`
}

function formatPreparedAt(ts, mealDate) {
  if (!ts) return ''
  const d = new Date(ts)
  const hh = String(d.getHours()).padStart(2, '0')
  const mm = String(d.getMinutes()).padStart(2, '0')
  const dateText = localDate(d.getTime()) === mealDate
    ? '今天'
    : `${d.getMonth() + 1}月${d.getDate()}日`
  return `${dateText} ${hh}:${mm} 标记`
}

function localDate(ts = Date.now()) {
  const d = new Date(ts)
  const m = String(d.getMonth() + 1).padStart(2, '0')
  const day = String(d.getDate()).padStart(2, '0')
  return `${d.getFullYear()}-${m}-${day}`
}

function addDays(date, delta) {
  const d = new Date(`${date}T00:00:00`)
  d.setDate(d.getDate() + delta)
  return localDate(d.getTime())
}