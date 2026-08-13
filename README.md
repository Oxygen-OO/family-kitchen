# 家庭厨房 (Family Kitchen)

让家庭成员之间共享菜单、协作点餐、汇总备餐的微信小程序。核心解决「今天吃什么」和「谁想吃什么」的信息同步。

**MVP 已交付**（2026-08，GitHub Issues T1–T11 全部关闭，199 条跨 seam 单测全绿）。

## 功能

- **家庭**：邀请好友组家庭（≤5 人，一人至多 3 个家庭）、7 天有效邀请码、分享卡片甩进群点开即入伙
- **菜单**：共享菜品池，结构化食材清单，软删/恢复/上下架，当日被点餐引用的菜不可删
- **点餐**：日期 × 餐次（早/午/晚），截止前随时改选，一键复制昨天，到点自动定案
- **备餐**：按菜聚合（谁点了什么）+ 按食材精确去重（要买什么），标记已备餐，历史可查
- **提醒**：点餐即授权的一次性订阅消息，截止时一人一条备餐提醒（at-most-once，宁丢勿重）

## 技术栈

原生小程序 + 微信云开发（CloudBase，单云函数）+ 纯 Node 域逻辑 + node:test 单测。

## 仓库结构

```
├── miniprogram/                小程序客户端（薄壳页面 + utils 纯模块）
├── cloudfunctions/family-kitchen/
│   ├── index.js                入口壳：action 路由（薄，零规则）
│   ├── config.js               服务端配置（订阅模板 ID 等）
│   ├── lib/                    域逻辑深模块（零 SDK import、零 I/O）
│   │   ├── identity/           登录与身份层
│   │   ├── family-engine/      家庭引擎（立家/邀请/转让/解散）
│   │   ├── dish-engine/        菜品引擎
│   │   ├── meal-engine/        餐次引擎（点餐/复制/截止管线）
│   │   ├── summarizer/         备餐汇总器（纯函数）
│   │   └── ports/              云数据库/订阅消息/时钟适配器（唯一 import wx-server-sdk 处）
│   └── tests/                  199 条跨 seam 单测（内存双胞胎 + Spy + 固定时钟）
├── cloudbaserc.json            云函数与定时触发器（meal-scan-due：0 */5 * * * * *）
├── CONTEXT.md                  领域词汇与不变量
└── docs/
    ├── adr/                    3 篇决策记录
    ├── agents/                 技能配置（议题入口/净化标签/域文档）
    ├── design/                 实现蓝图（architecture + 各引擎接口）
    └── research/               前期技术调研
```

## 本地开发

```bash
npm test          # 199 条单测全绿（零微信环境依赖）
```

## 上线部署清单

1. **注册小程序**：确认个人主体可用类目（生活工具类）
2. **ICP 备案**：2023-09 起未备案不得上线（个人主体同样适用）
3. **申请订阅消息模板**：mp.weixin.qq.com 后台申请「备餐提醒」类一次性订阅模板，将模板 ID 填入 `miniprogram/config.js`（前端弹窗）与 `cloudfunctions/family-kitchen/config.js`（服务端发送）；未配置时发送自动跳过并记日志，不影响其他功能
4. **云开发环境**：开通 CloudBase，创建环境后把环境 ID 填入 `miniprogram/config.js`（或 `project.config.json` 对应字段）
5. **部署云函数**：CloudBase CLI（`tcb fn deploy`，按 `cloudbaserc.json` 下发含定时触发器）或微信开发者工具「云函数 → 上传并部署」；定时触发器也可在控制台「云函数 → 定时触发」等效配置（两者择一，勿重复挂载）
6. **隐私指引**：按小程序后台《用户隐私保护指引》申报（首版仅 openid + 自填昵称，最小化收集）

## 领域文档

- `CONTEXT.md` — 术语与不变量（家庭/成员/立家者/邀请/菜品/菜单/餐次/点餐/备餐/食材）
- `docs/adr/` — 0001 家庭独立实体 / 0002 一次性订阅提醒 / 0003 数据保守主义
- `docs/design/` — architecture、meal-engine、family-engine、dishes、identity、prep-summarizer 锁定接口
