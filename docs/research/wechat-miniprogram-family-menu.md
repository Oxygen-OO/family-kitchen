# 微信小程序「家庭共享菜单」前期技术调研

## 概览

目标产品：家庭协作类微信小程序（邀请好友组成"家庭"，在共享菜单/菜谱上点餐、下单后为家人生成食材提醒清单）。
本次调研覆盖 7 个关键技术问题：开发方式选型、邀请组家庭、订阅消息、后端（云开发 CloudBase）、UI 组件库、个人主体合规与上线门槛，以及关键限制汇总。
所有结论均来自官方一手文档（微信开放文档、腾讯云开发文档、Taro/uni-app/Vant/TDesign 官网）；官方未明确说明的点已逐条标注"未在官方文档找到明确说明"，不猜测。
总体结论：**纯个人主体、无支付场景下，用"原生小程序 + 微信云开发 + 成熟组件库"即可完成全部核心功能**；最大的现实门槛是备案与类目合规，而非技术能力。

---

## 1. 开发方式选型（原生 / Taro / uni-app）

### 结论

| 方案 | 定位 | 适用场景 |
|---|---|---|
| 原生小程序 | WXML/WXSS/JS，逻辑层（App Service）+ 视图层（View）组成 | 只做微信端，文档最全、示例最多、组件库兼容性最好 |
| Taro | 开放式跨端跨框架方案，React/Vue/Nerv 语法，一套代码编译到微信/京东/百度/支付宝/字节/QQ/飞书/快手小程序 + H5/RN | 需要多端发布、团队熟悉 React/Vue |
| uni-app | DCloud 出品，Vue 语法，编译到微信等多端 | 需要多端发布、团队熟悉 Vue |

本项目为家庭内使用、仅微信端，**推荐原生小程序**（上手成本最低、无框架升级风险、官方文档与组件库全部可直接使用）。
业务逻辑简单、页面数量少，跨端收益低，引入 Taro/uni-app 反而不必要。

### 来源链接

- 原生框架（逻辑层 App Service）：https://developers.weixin.qq.com/miniprogram/dev/framework/app-service/
- 原生框架（视图层 View / WXML / WXSS）：https://developers.weixin.qq.com/miniprogram/dev/framework/view/
- 页面生命周期（框架导航中确认存在该章节）：https://developers.weixin.qq.com/miniprogram/dev/framework/app-service/page-life-cycle.html
- Taro 官网：https://docs.taro.zone/docs
- uni-app 官网：https://uniapp.dcloud.net.cn/resource.html

注意：Taro/uni-app 与原生小程序组件库（Vant Weapp/TDesign 等）的集成细节在其文档中未展开说明，属选型风险点（未在官方文档找到明确说明）。

---

## 2. 邀请好友组建"家庭"

### 结论

官方目前可用的"组队/建群"链路为**转发卡片 + shareTicket/openGId**：

1. **发起转发**：在页面放 `<button open-type="share">`（基础库 1.2.0+），触发 `Page.onShareAppMessage` 生成转发卡片。
2. **获取群标识**：调用 `wx.showShareMenu({ withShareTicket: true })` 后，转发到**群聊**的卡片被群内其他用户打开时，可在 `App.onLaunch` / `App.onShow` 拿到 `shareTicket`，再调用 `wx.getShareInfo` 解出群里的小程序专属群标识（群 ID）。**单聊转发拿不到 shareTicket**；shareTicket 仅在当前小程序生命周期内有效。
3. **官方提示**："由于策略变动，小程序群相关能力进行调整，开发者可先使用 wx.getShareInfo 接口中的群 ID 进行功能开发"——即当前阶段建议**以群 ID（openGId）作为家庭标识**。
4. **展示群名称**：`<open-data type="groupName" open-gid="xxx">` 组件可拉取群名称（基础库 1.4.0+），但**只有当前用户在该群内才能拉取到**。
5. **成员登录与身份**：用户身份走小程序登录（`wx.login` → 服务端 code2Session 得 openid），群成员与家庭绑定关系存后端。

设计建议：以"群 ID 即家庭 ID"为默认形态（一人转发建家庭群，家人进群即入伙）；若产品允许"不在同一群也能一起用"，仍可用微信登录 + 邀请链接（scene 参数）组合实现，但**群内身份核实能力依赖 open-data（仅群成员可拉群名）与 openGId**。

### 来源链接

- 转发文档（open-type="share" / onShareAppMessage）：https://developers.weixin.qq.com/miniprogram/dev/framework/open-ability/share.html
- 转发文档（shareTicket / wx.getShareInfo 群 ID）：同上 https://developers.weixin.qq.com/miniprogram/dev/framework/open-ability/share.html
- open-data 组件（type="groupName"+open-gid、仅群成员可拉取）：https://developers.weixin.qq.com/miniprogram/dev/component/open-data.html
- 小程序登录（wx.login / code2Session）：https://developers.weixin.qq.com/miniprogram/dev/framework/open-ability/login.html

未确认事项：
- 群成员人数上限、群规模限制：未在官方文档找到明确说明。
- 个人主体小程序绑定微信开放平台获取 unionid 的条件：未在官方单页找到明确说明（unionid 需绑定开放平台，个人主体能否绑定需在注册流程中确认）。

---

## 3. 订阅消息（下单后"食材提醒"）

### 结论

- **一次性订阅消息**：用户每次授权（`wx.requestSubscribeMessage`，基础库 2.4.4+，单次最多携带 5 个模板 ID，2.8.2 起必须由用户点击行为触发）对应**一次下发额度**（订阅一次发一条，消息下发时间不受限制）；服务端用接口下发到小程序后台配置好的一批模板。
- **长期订阅消息**："目前长期性订阅消息**仅向政务民生、医疗、交通、金融、教育等线下公共服务开放**"——家庭场景**不可申请长期订阅**，只能用一次性订阅。
- **合规红线**：运营规范 5.21 明确禁止诱导订阅/诱导点击（如"订阅后才可继续/订阅得奖励"），违者删模板乃至永久封禁订阅消息接口。
- 结论：**"下单后提醒家人准备食材"用一次性订阅即可**——在关键操作（点餐/下单）时弹出订阅授权弹窗，授权一次触发一次提醒；产品上不要做任何强制/利诱订阅的设计。

### 来源链接

- 订阅消息概述（一次性 vs 长期、长期仅限线下公共服务）：https://developers.weixin.qq.com/miniprogram/dev/framework/open-ability/subscribe-message-overview.html
- wx.requestSubscribeMessage API：https://developers.weixin.qq.com/miniprogram/dev/api/open-api/subscribe-message/wx.requestSubscribeMessage.html
- 运营规范 5.21 滥用订阅消息：https://developers.weixin.qq.com/miniprogram/product/

---

## 4. 后端：微信云开发（CloudBase）

### 结论

- 云开发提供云函数、云数据库、云存储、定时触发器，无需自建服务器；对个人开发者和小团队而言是**最省事的后端形态**（免运维、免域名备案门槛更低）。
- **定时触发器**：在 `cloudbaserc.json` 中给云函数配置 `triggers`（`type: timer` + 7 字段 cron）即可定时执行，官方明确适用于"每日报告、定时清理"类任务；**不能用于秒级调度**。本项目适合：每晚自动汇总"今天谁点了什么、明天要买什么"给全家。
- **微信支付与个人主体**：官方 FAQ 明确"**个人认证主体不能申请微信支付**，需个体工商户、企业、机关事业单位或社会团体等"。本项目若只做点餐/清单/提醒（无资金流）可完全绕开支付；一旦涉及付费（如 AA 记账、代买菜付费）需企业/个体工商户主体。

### 来源链接

- 定时触发云函数（cron）：https://docs.cloudbase.net/recipes/schedule-cloud-function-cron-job
- 微信支付主体限制 FAQ：https://docs.cloudbase.net/faq/knowledge/wechat-pay-restriction

未确认事项：
- 个人主体小程序能否开通云开发、免费额度具体数字：未在官方文档找到明确说明（建议以注册后后台实际可选套餐为准）。

---

## 5. UI 组件库

### 结论

| 组件库 | 状态 | 特点 |
|---|---|---|
| Vant Weapp | 当前版本 1.11.7 | "轻量、可靠的小程序 UI 组件库"，2017 年开源，社区成熟、组件全（表单/弹层/导航/日历等），适合本项目的菜单、点餐、清单界面 |
| TDesign（小程序版） | 微信小程序 Stable 1.15.2；另有 UniApp 版（alpha） | 腾讯官方设计体系，风格统一，含基础+业务组件 |

两者均可直接用于原生小程序；本项目界面元素（菜品卡片、数量选择、家庭成员列表、提醒清单）两类组件库均覆盖。个人项目建议选 Vant Weapp（长期维护、示例多）。

### 来源链接

- Vant Weapp 官网：https://vant-ui.github.io/vant-weapp/
- TDesign 小程序版：http://tdesign.tencent.com/miniprogram/overview
- TDesign 小程序 GitHub：https://github.com/Tencent/tdesign-miniprogram

---

## 6. 合规与上线门槛（个人主体）

### 结论

1. **类目范围**：运营规范 5.7.1"主体未开放类目"——**个人主体提供的服务超出个人主体小程序开放的类目范围即违规**（如刷量、多级分销等红线行为也必须规避）。"家庭共享菜单"属于个人生活工具类，正常情况下在个人类目范围内（具体需在注册/配置服务类目时核对开放的服务类目表）。
2. **组队分享合规（重点）**：运营规范 5.1.8 明确"**组队组团类分享活动，分享者的参与总人数未限制在 5 人内**"属于滥用分享。本项目"邀请好友组家庭"若被判定为组队组团活动，需把每个家庭的成员规模控制在 5 人内、且不得利益诱导（5.1 各项）。
3. **支付红线**：个人主体不可申请微信支付（见第 4 节）；虚拟商品交易（5.13）等同样受限——本项目保持无支付形态最稳妥。
4. **订阅消息合规**：不得诱导订阅/点击（见第 3 节）。
5. **ICP 备案（2023 新政）**：2023-09-04 起小程序平台开放备案入口，**未完成备案的小程序不得上线发布**，新注册小程序提审前须完成备案。个人主体同样适用。
6. **隐私合规**：涉及用户手机号、位置等信息须按《小程序用户隐私保护指引》申报；建议首版仅用微信登录（openid）+ 云端数据，最小化收集。

### 来源链接

- 微信小程序平台运营规范（5.7.1 类目 / 5.1.8 组队分享 / 5.21 订阅消息等）：https://developers.weixin.qq.com/miniprogram/product/
- 微信小程序备案指引：https://developers.weixin.qq.com/miniprogram/product/record_guidelines.html

未确认事项：
- 个人主体可选的完整类目清单：官方指向"开放的服务类目"页面，具体条目需注册小程序后按主体类型核对。

---

## 7. 关键限制汇总表

| 能力 | 个人主体/默认状态下是否可用 | 关键限制 | 官方来源 |
|---|---|---|---|
| 转发/分享组家庭 | 可用 | 组队组团分享参与人数须 ≤5 人（5.1.8）；群 ID 依赖 shareTicket，仅当前生命周期有效 | share.html、运营规范 |
| 群 ID（openGId） | 可用 | 仅转发到群并被打开才可获取；单聊无 shareTicket | share.html |
| 群名称展示 | 可用 | 仅当前用户在群内时可拉取 | open-data.html |
| 长期订阅消息 | **不可用** | 仅政务民生/医疗/交通/金融/教育等线下公共服务 | subscribe-message-overview.html |
| 一次性订阅消息 | 可用 | 订一次发一条；需用户点击触发；不得诱导订阅 | wx.requestSubscribeMessage、运营规范 5.21 |
| 微信支付 | **个人主体不可申请** | 需个体工商户/企业等主体 | docs.cloudbase.net FAQ |
| 云开发（函数/数据库/定时器） | 未确认（大概率可用） | 定时器不可秒级调度 | docs.cloudbase.net |
| ICP 备案 | 全部主体必须 | 未备案不得上线（2023-09-04 起） | record_guidelines.html |
| 服务类目 | 个人仅限个人类目 | 超出即违规（5.7.1） | 运营规范 |

---

## 8. 开发建议（下一步路线）

1. **技术栈**：原生小程序（WXML/WXSS/JS）+ 微信云开发（云函数/云数据库/定时触发器）+ Vant Weapp。
2. **家庭模型**：以"群 ID=家庭 ID"为主（转发建群，家人进群即绑定）；用户身份用 wx.login/openid；备选邀请链接（scene 参数）供非群场景。
3. **提醒方案**：一次性订阅消息，在"点餐/下单"等自然操作时请求授权，一次授权一次提醒；定时触发器做每日食材清单汇总。
4. **合规**：家庭人数上限设 5 人；无支付、无诱导分享/订阅；先完成 ICP 备案再提审；按官方指引填写用户隐私保护指引并申报。
5. **下一步待办**：注册小程序 → 确认个人主体可用类目与云开发套餐 → 完成备案 → 搭原型验证分享-进群-组家庭链路。