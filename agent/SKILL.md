---
name: x-publish
description: Publish or schedule an X post from an Obsidian note through the local X Publish Desk backend, with a human confirmation step. Use when the user asks to publish/schedule a note to X, or to check whether scheduled posts went out. Works with any coding agent that can run shell commands (Claude Code, Codex, etc.).
---

# X 发布（给 AI 助手用的说明）

把下面的 `<BACKEND>` 换成你 clone 仓库的绝对路径。所有命令都这样运行：

```
<BACKEND>/.venv/bin/python <BACKEND>/publish.py ...
```

## 三步，不能跳

1. **预览，什么都不会发出去**
   - 立即发：`publish.py preview --note "标题关键词" --action publish`
   - 定时发：`publish.py preview --note "标题关键词" --action schedule --at "2026-10-10 09:00" --zone Asia/Shanghai`
2. **把确认单给用户看**：执行方式、账号、完整正文、引用、配图、字数，「检查未通过」和「提醒」的每一条都要列出来，然后问用户确认不确认。「检查未通过」不为空就停下，等用户改稿。
3. **用户明确说确认后才发送**：`publish.py send <和预览完全相同的参数> --confirm <预览给的确认码>`。报「确认码不对」就回到第 1 步，不要自己改确认码。

## 发送结果

- `核对通过: true`：告诉用户已发出或已排期，附上链接；有「格式差异」也要说。
- 结果待核对或没有完整回执：告诉用户**可能已经发出**，先去 X 上看，**不要重发**。
- `publish.py follow-up`：核对到点的定时推文，只读不发。

## 不要做

- 不要直接调用 `delivery_runner.py`，也不要自己打开浏览器发帖
- 不要改笔记，也不要改 `state/` 里的文件
- 用户只说一句「发吧」但没看过确认单，不算确认
