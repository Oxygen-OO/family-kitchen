# IdentityEngine · 登录与身份层接口 (锁定 v1)

**位置**：`cloudfunctions/family-kitchen/lib/identity/`。零 SDK、零 I/O 深模块，Store port 注入。调用方只有云函数入口壳 `index.js`（按 action 分派）。

## 职责边界

- **users 集合为辅助表**（`_id = openid`：openid, nickname, avatar, created_at），记录小程序用户的身份档案；**主权限链在 family_members**，本模块对 family_members 仅**只读**一次——启动路由判定。
- **openid 是全局唯一身份键**：引擎所有方法第一个参数都是 openid，绝不接受客户端自称的 openid（openid 由入口壳从微信调用上下文解析后传入，见「开放协议」）。
- **首登自填昵称**：2022 后 `wx.getUserProfile` 已废弃、微信不回传昵称头像，改由首登用户自填昵称 + `chooseAvatar` 头像选择器（客户端 `wx.cloud.uploadFile` 得 `cloud://` fileID 后经 saveProfile 写入）。
- 昵称、头像后续可改（`saveProfile` 幂等覆盖现值）；**不追溯更新历史订单/备餐快照中的 user_nickname**——快照随单固化（ADR-0003 保守主义），进行中视图用现名、已截止定案用快照名。
- 用户身份与家庭归属解耦：本工单不建家庭，`startup` 只读 family_members 判定路由，不写任何家庭数据（T2 起）。

## 接口

```ts
interface IdentityEngine {
  // 登录: get-or-create 用户档案。openid 由入口壳从 wx 调用上下文解析。
  login(openid: string, {now}): {openid, isNew: boolean, user: UserDoc}
    // users doc 存在(按 _id=openid) → isNew:false, 原样返回;
    // 不存在 → 创建 {_id: openid, openid, nickname: '', avatar: '', created_at: now} → isNew:true
    // 并发首登撞 _id 键 → 创建失败回退为读取, 按 isNew:false 返回(幂等)

  // 首登自填档案: 校验 + 覆盖写 nickname/avatar(只动这两个字段, created_at 永不触碰)
  saveProfile(openid, {nickname, avatar}): {user: UserDoc}
    // nickname 去首尾空白后非空(否则 NICKNAME_REQUIRED)且 ≤20 字符(NICKNAME_TOO_LONG);
    // avatar 可为空串或 cloud:// 路径(AVATAR_INVALID 拒绝其他形态);
    // user 不存在 → USER_NOT_FOUND

  // 启动路由判定: 只读 family_members, 无副作用
  startup(openid): {route: 'home'|'onboarding', user: UserDoc, families?: Membership[]}
    // 查 family_members where user_openid = openid, 按 joined_at 降序:
    // 有记录 → route:'home', families 随附(客户端默认展示第一条 = 最近加入;
    //   「最近访问」记忆属 T2 家庭切换器, T1 不新增字段);
    // 无记录 → route:'onboarding'(强制引导创建或加入); user 不存在 → USER_NOT_FOUND
}
```

```ts
interface UserDoc { _id: string, openid, nickname: string, avatar: string, created_at: number }
// family_members 只读行: {family_id, user_openid, role: 'creator'|'member', joined_at}
```

## 错误模式

`Err = USER_NOT_FOUND | NICKNAME_REQUIRED | NICKNAME_TOO_LONG | AVATAR_INVALID`

## Ports 与测试适配器

| Port | 分类 | 生产 adapter | 测试 adapter |
|---|---|---|---|
| IdentityStore（users 读写 + family_members 只读） | remote-but-owned | `lib/ports/db.js`（wx-server-sdk，唯一 import 点） | 内存 Map 双胞胎，**忠实复刻 add 撞 `_id` 抛错、get 未命中返回 null、update 未命中抛 NOT_FOUND** |
| Clock（created_at） | in-process 注入 | `now()` | Fixed(now) 冻结时间 |

openid 解析是入口壳经 `cloud.getWXContext().OPENID` 完成（云开发语义：调用上下文直接给 openid，`wx.login` 的 code 仅作协议对齐保留，不依赖 code2session）。

## 开放协议（seam 1，action 路由壳）

| action | payload | 成功 data |
|---|---|---|
| `login` | `{code}`（协议对齐） | `{openid, isNew, user}` |
| `saveProfile` | `{nickname, avatar}` | `{user}` |
| `startup` | `{}` | `{route, user, families?}` |

统一错误形状 `{ok: false, error: {code, message}}`。入口壳只做：action 白名单校验 + openid 解析 + 路由 + 错误翻译，**不承载规则**（对应架构「外部 seam 1 由集成冒烟覆盖，不进单测」）。

## 测试落点（跨 seam）

- **登录态**：`login` 首登/老用户/撞键回退，固定时钟断言 created_at；
- **路由判定**：`startup` 有家庭→home、无家庭→onboarding、user 缺失→USER_NOT_FOUND，内存双胞胎断言查询语义；
- **客户端缓存**：`miniprogram/utils/session.js` 纯模块注入 storage/api 双胞胎——冷启动优先读缓存、缓存失效静默重登、onShow 兜底无缓存时静默重登（接口约定见本文件「客户端会话」小节）。

## 客户端会话（session，纯模块，零 wx API）

`miniprogram/utils/session.js` 不直接 import wx，注入 `storage`（get/set/remove 双胞胎=wx.getStorageSync 族）与 `api`（login/startup 双胞胎=调 wx.cloud.callFunction）：

```ts
createSession({storage, api: {loginByCode(code), startup()}}): {
  coldStart(): Promise<{openid, route, user, isNew, families?}>   // 冷启动:
    // storage 命中 openid → api.startup() 校验: 成功沿用缓存(不重新 login, 满足 AC「优先读缓存再校验」),
    //   families 随附(首页默认展示第一条 = 最近加入); USER_NOT_FOUND(用户被删/缓存脏) → 静默重登
    //   (wx.login → api login → 覆盖缓存); storage 未命中 → 静默重登一次并写缓存;
  onShowGuard(): Promise<{openid, route, user, isNew, families?}|null>  // 所有页面 onShow 兜底:
    // 缓存丢失时静默重登(不弹窗), 有缓存则返回 null(不发任何请求)
}
```

storage 键约定：`fk_openid`（值 = openid 字符串）。首登 isNew 时客户端应引导自填昵称（onboarding 页表单，chooseAvatar + input type=nickname → saveProfile）。