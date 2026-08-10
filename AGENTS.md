# 家庭厨房 (Family Kitchen)

让家庭成员之间共享菜单、协作点餐、汇总备餐的微信小程序。核心解决「今天吃什么」和「谁想吃什么」的信息同步。

技术栈：原生小程序 + 微信云开发（CloudBase）+ Vant Weapp。域逻辑在云函数 lib 层，见 `docs/design/architecture.md`。

## Agent skills

### Issue tracker

议题与 PRD 存于 GitHub Issues，全部操作走 `gh` CLI（仓库尚未推送 GitHub，先 `git init` + 关联 remote 后生效）。详见 `docs/agents/issue-tracker.md`。

### Triage labels

五个默认标签即五个净化角色名：`needs-triage` / `needs-info` / `ready-for-agent` / `ready-for-human` / `wontfix`。详见 `docs/agents/triage-labels.md`。

### Domain docs

单一上下文：根目录 `CONTEXT.md`（术语与不变量）+ `docs/adr/`（3 篇决策）+ `docs/design/`（实现蓝图）。详见 `docs/agents/domain.md`。