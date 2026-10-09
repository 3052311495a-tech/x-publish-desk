# 第三方许可

## Icy-Cat X Article

本插件保留并改编以下 MIT 代码：

- 共享 Markdown 预览逻辑：`vendor/icy-cat/markdown.ts`。
  来源：[Icy-Cat/x-article-workspace](https://github.com/Icy-Cat/x-article-workspace)，commit `e2cf726488f662bd041eb1193f95a9a48d90925d`，原文件 `packages/core/src/markdown.ts`。

共享 Markdown 的本地类型定义去掉 monorepo 依赖，frontmatter 匹配兼容文件结尾。当前 workspace 的共享包不包含 Obsidian DOM renderer；宿主仍按同作者官方 [x-article-in-obsidian](https://github.com/Icy-Cat/x-article-in-obsidian) commit `50ae8f1a2fc7d2e13148fd03b4878a2f8c1eaaff` 的预览方式调用 Obsidian `MarkdownRenderer`，逐块保留同步滚动所需源行范围。外层 DOM 和全部视觉为本项目自己的设计（`设计稿/styles.css`），未带入上游外壳、Draft.js DOM mapper 或 CSS。X 富预览使用插件自己的 oEmbed 服务，未引入上游 `widgets.js`、Playwright MCP 或上传实现。

### MIT License

Copyright (c) 2026 Icy-Cat

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.

## twitter-text

普通推文字符计数使用 [twitter/twitter-text](https://github.com/twitter/twitter-text) 的 `twitter-text` npm 包（版本见 `package-lock.json`），许可为 Apache License 2.0。版权和完整许可保留在该依赖的 `LICENSE` 文件中。


## 打包依赖完整许可

运行包另附 `licenses/`，保留以下依赖的完整许可及版权声明：twitter-text 3.1.0（Apache-2.0）、yaml 2.8.1（ISC）、core-js 2.6.12（MIT）、twemoji-parser 11.0.2（MIT）、punycode 1.4.1（MIT）、@babel/runtime 7.29.7（MIT）。版本固定在 package-lock.json。

## 未附带：x-article-draft-uploader

长文上传使用的 [x-article-draft-uploader](https://github.com/mcncarl/yichen-skills/tree/x-article-draft-uploader-v1.0.1/yichen-x-article-draft-uploader)（Copyright (c) 2026 Yichen）许可证不允许公开再分发，本仓库不包含它的任何代码。插件只在用户自己安装并在设置里填写路径后才调用它。
