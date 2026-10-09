#!/usr/bin/env bash
# Install the local backend: Python venv with Playwright + Chromium, and twitter-text for X's character count.
set -euo pipefail
cd "$(dirname "$0")"
command -v node >/dev/null || { echo "需要 Node.js 18+：https://nodejs.org"; exit 1; }
if command -v uv >/dev/null; then uv venv --python 3.12 .venv && uv pip install --python .venv/bin/python -r requirements.txt
else python3 -m venv .venv && .venv/bin/pip install -r requirements.txt; fi
.venv/bin/python -m playwright install chromium
npm ci
[ -f config.json ] || { cp config.example.json config.json; chmod 600 config.json; }
echo
echo "后端装好了：$(pwd)"
echo "下一步：在 Obsidian 的 X 发布台设置里，把「后端文件夹」填成上面这个路径，再填账号和 cookie 文件。"
