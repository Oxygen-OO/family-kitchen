# 议题入口：GitHub

本仓库的议题与 PRD 以 GitHub issues 形式存放，全部操作使用 `gh` CLI。

> 注意：本仓库尚未初始化 git remote。先用 `git init` 并推送 GitHub 后再执行下列命令；远程就绪后，`gh` 会在仓库内自动推断目标仓库（`git remote -v`）。

## 约定

- **创建议题**：`gh issue create --title "..." --body "..."`。多行正文用 heredoc。
- **读取议题**：`gh issue view <number> --comments`，用 `jq` 过滤评论并同时取标签。
- **列出议题**：`gh issue list --state open --json number,title,body,labels,comments --jq '[.[] | {number, title, body, labels: [.labels[].name], comments: [.comments[].body]}]'`，配合 `--label` 与 `--state` 过滤。
- **评论议题**：`gh issue comment <number> --body "..."`
- **加 / 移除标签**：`gh issue edit <number> --add-label "..."` / `--remove-label "..."`
- **关闭**：`gh issue close <number> --comment "..."`

## Pull requests 作为需求请求面

**PRs as a request surface: no.** （若本仓库把外部 PR 当作功能请求，改为 `yes`；`/triage` 读取此标记。）

为 `yes` 时，PR 与议题共用同一套标签与状态，使用 `gh pr` 等价命令：

- **读 PR**：`gh pr view <number> --comments` 与 `gh pr diff <number>` 取 diff。
- **列出待净化外部 PR**：`gh pr list --state open --json number,title,body,labels,author,authorAssociation,comments`，只保留 `authorAssociation` 为 `CONTRIBUTOR` / `FIRST_TIME_CONTRIBUTOR` / `NONE`（剔除 `OWNER`/`MEMBER`/`COLLABORATOR`）。
- **评论 / 加标签 / 关闭**：`gh pr comment`、`gh pr edit --add-label`/`--remove-label`、`gh pr close`。

GitHub 的 issue 与 PR 共享同一编号空间，裸 `#42` 可能是任一者——先试 `gh pr view 42`，失败再回退 `gh issue view 42`。

## 当技能说「发布到议题入口」

创建一条 GitHub issue。

## 当技能说「取相关工单」

执行 `gh issue view <number> --comments`。

## Wayfinding 操作

供 `/wayfinder` 使用。**地图**是一条 issue，**子工单**是其中的子议题。

- **地图**：单条 issue，标签 `wayfinder:map`，正文承载 Notes / Decisions-so-far / Fog。`gh issue create --label wayfinder:map`。
- **子工单**：以 GitHub sub-issue 关联到地图（`gh api` sub-issues 端点）；不可用时，把子项写进地图正文的任务列表，并在子工单顶部放 `Part of #<map>`。标签：`wayfinder:<type>`（`research`/`prototype`/`grilling`/`task`）。被认领后 assign 给执行的开发者。
- **阻塞**：GitHub 原生 issue dependencies——`gh api --method POST repos/<owner>/<repo>/issues/<child>/dependencies/blocked_by -F issue_id=<blocker-db-id>`，其中 `<blocker-db-id>` 是阻塞者的数字**数据库 id**（`gh api repos/<owner>/<repo>/issues/<n> --jq .id`，不是 `#number` 也不是 `node_id`）。GitHub 通过 `issue_dependencies_summary.blocked_by` 报告（仅计开着的阻塞者）。依赖不可用时，回退为子工单顶部的 `Blocked by: #<n>, #<n>` 行。所有阻塞者关闭即解除。
- **前沿查询**：列出地图的开着的子项（`gh issue list --state open` 限定在地图的 sub-issues / 任务清单），剔除有未关阻塞者（`issue_dependencies_summary.blocked_by > 0`，或 `Blocked by` 行中有开着的 issue）或已有 assignee 的；地图顺序中第一个胜出。
- **认领**：`gh issue edit <n> --add-assignee @me`——会话的第一次写入。
- **解决**：`gh issue comment <n> --body "<答案>"`，然后 `gh issue close <n>`，再把上下文指针（gist + 链接）追加到地图的 Decisions-so-far。