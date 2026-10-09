import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { build } from 'esbuild';

const project = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const temporary = path.join(project, 'work', 'tests');
await mkdir(temporary, { recursive: true });
const moduleFile = path.join(temporary, 'model.cjs');
await build({ entryPoints: [path.join(project, 'src', 'model.ts')], outfile: moduleFile, bundle: true, platform: 'node', format: 'cjs', logLevel: 'silent' });
const { default: model } = await import(pathToFileURL(moduleFile).href);
const { noteMode, metadata, postBody, textRuns, postStats, postWarnings, quoteLink, linkWarnings } = model;

class TestElement {
  constructor(options = {}) {
    if (typeof options === 'string') options = { cls: options };
    this.children = []; this._text = options.text || ''; this.className = options.cls || '';
    this.isConnected = true; this.style = {}; this.dataset = {}; this.attributes = {}; this.disabled = false;
    this.classList = {
      contains: name => this.className.split(/\s+/).includes(name),
      add: (...names) => { this.className = [...new Set([...this.className.split(/\s+/).filter(Boolean), ...names])].join(' '); },
      remove: (...names) => { this.className = this.className.split(/\s+/).filter(name => !names.includes(name)).join(' '); },
      toggle: (name, force) => { const add = force ?? !this.classList.contains(name); this.classList[add ? 'add' : 'remove'](name); return add; },
    };
    for (const [name, value] of Object.entries(options.attr || {})) this.setAttribute(name, value);
  }
  get textContent() { return this._text + this.children.map(child => child.textContent).join(''); }
  get ownerDocument() { return globalThis.document; }
  set textContent(value) { this._text = value || ''; this.children = []; }
  set innerHTML(value) { this.textContent = value; }
  createEl(tag, options = {}) { const child = new TestElement(options); child.tag = tag; this.appendChild(child); return child; }
  createDiv(options) { return this.createEl('div', options); }
  createSpan(options) { return this.createEl('span', options); }
  setText(text) { this.textContent = text; }
  appendChild(child) { child.parentElement = this; this.children.push(child); return child; }
  append(...children) { for (const child of children) typeof child === 'string' ? this.appendText(child) : this.appendChild(child); }
  appendText(text) { return this.appendChild(new TestElement({ text })); }
  empty() { for (const child of this.children) child.isConnected = false; this.children = []; this._text = ''; }
  remove() { this.isConnected = false; if (this.parentElement) this.parentElement.children = this.parentElement.children.filter(child => child !== this); }
  setAttribute(name, value) { this.attributes[name] = String(value); if (name === 'class') this.className = String(value); if (name === 'href') this.href = String(value); }
  getAttribute(name) { return this.attributes[name] ?? null; }
  addClass(...names) { this.classList.add(...names); }
  removeClass(...names) { this.classList.remove(...names); }
  toggleClass(name, force) { return this.classList.toggle(name, force); }
  matches(selector) {
    if (selector.startsWith('.')) return selector.split('.').filter(Boolean).every(name => this.classList.contains(name));
    return this.tag === selector;
  }
  querySelectorAll(selector) { return this.children.flatMap(child => [...(child.matches(selector) ? [child] : []), ...child.querySelectorAll(selector)]); }
  querySelector(selector) { return this.querySelectorAll(selector)[0] || null; }
}
globalThis.document = {
  createElement: tag => { const element = new TestElement(); element.tag = tag; return element; },
  createElementNS: (_namespace, tag) => { const element = new TestElement(); element.tag = tag; return element; },
};

let passed = 0, failed = 0;
async function test(name, callback) {
  try { await callback(); passed++; console.log(`通过 ${name}`); }
  catch (error) { failed++; console.error(`失败 ${name}\n${error.stack || error}`); }
}
const vault = '/tmp/x-publish-desk-test-vault';
const note05 = '推特创作/03创作中/2026-09-30-05 用AI最猛的是小老板.md';
const note06 = '推特创作/03创作中/2026-09-30-06 技能从高频场景来.md';
const fixtures = path.join(project, 'tests', 'fixtures');
const markdown05 = await readFile(path.join(fixtures, '05-初始引用稿.md'), 'utf8');
const markdown06 = await readFile(path.join(fixtures, '06-初始引用稿.md'), 'utf8');

await test('创作、归档和长文可预览，评论和素材排除', () => {
  assert.equal(noteMode(note05), 'post');
  assert.equal(noteMode('推特创作/04已发布/归档.md'), 'post');
  assert.equal(noteMode('推特创作/05长文/长文.md'), 'article');
  for (const file of ['推特创作/03创作中/评论/评论.md', '推特创作/02素材/素材.md', '推特创作/X发布入口.md', '其他/03创作中/稿件.md', '推特创作/03创作中其他/稿件.md']) assert.equal(noteMode(file), null, file);
});

await test('Frontmatter 按 YAML 读取布尔值、中文标题及引号链接', () => {
  assert.equal(metadata(markdown05).delivery_ready, true);
  assert.equal(metadata(markdown05).title, '用AI最猛的是小老板');
  assert.equal(metadata(markdown05).quote, 'https://x.com/AYi_AInotes/status/2104973448665870604');
  assert.deepEqual(metadata('---\nbad: [unfinished\n---\n正文'), {});
  assert.deepEqual(metadata('没有属性'), {});
  assert.equal(metadata('\uFEFF---\r\ndelivery_ready: true\r\n---\r\n').delivery_ready, true);
});

await test('05 固定样例只提取正文，保留换行和粗体，排除备选与记录', () => {
  const body = postBody(markdown05);
  assert.ok(body.startsWith('Meta 发现，很多人拿 Muse 打理自己的小生意\n修水管的'));
  assert.ok(body.includes('餐馆的\n\n这个比什么跑分都有说服力'));
  assert.ok(body.endsWith('所以说，**能帮人把手上的事做完，比模型强不强重要得多**'));
  for (const internal of ['版本 B', '素材话题', '选择理由', '验收记录', '%%']) assert.ok(!body.includes(internal), internal);
  const runs = textRuns(body);
  assert.deepEqual(runs.filter(run => run.bold).map(run => run.text), ['能帮人把手上的事做完，比模型强不强重要得多']);
  assert.equal(runs.map(run => run.text).join(''), body.replace(/\*\*/g, ''));
});

await test('正文忽略 Obsidian 注释，空稿不混入备选', () => {
  assert.equal(postBody('## 正文\r\n\r\n第一段\r\n\r\n%%内部。。。%%第二段\r\n\r\n## 备选版本\r\n不要上传'), '第一段\n\n第二段');
  assert.equal(postBody('## 正文\n\n正文\n\n%%\n内部记录未闭合'), '正文');
  assert.equal(postBody('## 备选版本\n只有备选'), '');
  assert.equal(postBody('## 正文\n\n## 备选版本\n只有备选'), '');
});

await test('X 加权计数：中日韩 2，ASCII 1，链接 23，完整 emoji 2，粗体符号不计', () => {
  assert.equal(postStats('中日한A').weightedLength, 7);
  assert.equal(postStats('https://example.com/very/long/path?query=12345').weightedLength, 23);
  assert.equal(postStats('👨‍👩‍👧‍👦').weightedLength, 2);
  assert.equal(postStats('👍🏽').weightedLength, 2);
  assert.equal(postStats('**重点**').weightedLength, 4);
  assert.equal(postStats('e\u0301').weightedLength, 1);
  assert.equal(postStats('').weightedLength, 0);
  assert.equal(postStats('A'.repeat(25001)).limit, 25000);
});

await test('280 加权字符折叠位置：恰好 280 不折叠，中文按 2 算', () => {
  assert.equal(postStats('中'.repeat(140)).foldIndex, 140);
  const chinese = postStats('中'.repeat(141));
  assert.equal(chinese.weightedLength, 282);
  assert.equal(chinese.rawFoldIndex, 140);
  assert.equal(chinese.foldIndex, 0, '超过 280 的单行完整放在线下');
  assert.equal(postStats('A'.repeat(281)).rawFoldIndex, 280);
  assert.equal(postStats('A'.repeat(281)).foldIndex, 0);
});

await test('折叠线不会截断长链接，超过 280 的链接整条留在线下', () => {
  const url = 'https://example.com/very/long/path?query=12345';
  const body = 'A'.repeat(270) + ' ' + url + ' END';
  const stats = postStats(body);
  assert.equal(stats.weightedLength, 298);
  assert.equal(stats.rawFoldIndex, 271);
  assert.equal(stats.plain.slice(stats.rawFoldIndex), url + ' END');
  assert.equal(stats.foldIndex, 0);
});

await test('折叠线不会截断 emoji 或粗体文本中的代理对', () => {
  const emoji = '👨‍👩‍👧‍👦';
  const stats = postStats('A'.repeat(279) + '**' + emoji + '** END');
  assert.equal(stats.rawFoldIndex, 279);
  assert.ok(stats.plain.slice(stats.rawFoldIndex).startsWith(emoji));
  assert.equal(stats.foldIndex, 0);
  const exact = postStats('A'.repeat(278) + emoji + 'Z');
  assert.equal(exact.rawFoldIndex, 278 + emoji.length);
  assert.equal(exact.foldIndex, 0);
});

await test('设计稿折叠显示按整行：切在行中移到该行开头，恰好行末保留完整行', () => {
  const midline = postStats('A'.repeat(200) + '\n' + 'B'.repeat(90));
  assert.equal(midline.weightedLength, 291);
  assert.equal(midline.rawFoldIndex, 280);
  assert.equal(midline.foldIndex, 201);
  assert.equal(midline.plain.slice(midline.foldIndex), 'B'.repeat(90));
  const atEnd = postStats('A'.repeat(280) + '\n下一行');
  assert.equal(atEnd.rawFoldIndex, 280);
  assert.equal(atEnd.foldIndex, 280);
});

await test('句号提示只看正文；。。。不提示，新增。提示，撤销后恢复', () => {
  const body = postBody(markdown05), properties = metadata(markdown05), now = Date.parse('2026-09-30T07:00:00Z');
  assert.deepEqual(linkWarnings('没有链接，版本号 2.1.5', true), []);
  assert.equal(linkWarnings('在 claude.ai 的设置', false).length, 1);
  assert.ok(linkWarnings('在 claude.ai 的设置', false)[0].includes('claude.ai'));
  assert.equal(linkWarnings('看 https://x.com/a 和 claude.ai', true).length, 2);
  assert.deepEqual(postWarnings(body, properties, now), []);
  assert.deepEqual(postWarnings(body + '。。。', properties, now), []);
  assert.ok(postWarnings(body + '。', properties, now).some(value => value.includes('句号')));
  assert.ok(postWarnings(body + '。。。还有。', properties, now).some(value => value.includes('句号')));
  assert.deepEqual(postWarnings(body, properties, now), []);
});

await test('交付状态、过期及空正文显示各自提示', () => {
  const warnings = postWarnings('', { delivery_ready: false, expires_at: '2026-01-01T00:00:00Z' }, Date.parse('2026-09-30T07:00:00Z'));
  assert.equal(warnings.length, 3);
  assert.ok(warnings.some(value => /就绪|验收/.test(value)));
  assert.ok(warnings.some(value => value.includes('过有效期')));
  assert.ok(warnings.some(value => value.includes('正文为空')));
  assert.ok(postWarnings('内容', { delivery_ready: 'true' }).some(value => /就绪|验收/.test(value)));
});

await test('引用链接规范化和账号提取，仅接受 HTTPS X 单帖', () => {
  assert.deepEqual(quoteLink(metadata(markdown05).quote), { url: 'https://x.com/AYi_AInotes/status/2104973448665870604', author: '@AYi_AInotes' });
  assert.deepEqual(quoteLink('https://twitter.com/fankaishuoai/status/2104922292841222523?utm_source=test'), { url: 'https://x.com/fankaishuoai/status/2104922292841222523', author: '@fankaishuoai' });
  for (const value of [null, 123, 'http://x.com/a/status/123', 'https://example.com/a/status/123', 'https://x.com/a', 'https://x.com/a/status/not-a-number', 'https://x.com/abcdefghijklmnop/status/123', 'https://x.com.evil.test/a/status/123']) assert.equal(quoteLink(value), null);
});

await test('06 初始固定样例与历史草稿回执一致，不对用户当前稿件作断言', async () => {
  const receipt = JSON.parse(await readFile(path.join(fixtures, '06-历史草稿回执.json'), 'utf8'));
  assert.equal(createHash('sha256').update(postBody(markdown06)).digest('hex'), receipt.body_sha256);
  assert.equal(metadata(markdown06).quote, receipt.quote);
  assert.equal(receipt.verified, true);
  assert.equal(receipt.already_exists, true);
  assert.equal(receipt.publicly_posted, false);
});

await test('改稿学习保持原版本；配图改动前的普通上传后端备份可恢复', async () => {
  // Author-machine audits; the public repo has neither file.
  const learning = path.join(process.env.HOME || '', 'AI/claude/agents/x-publisher/revision_learning.py');
  if (existsSync(learning)) assert.equal(createHash('sha256').update(await readFile(learning)).digest('hex'), '58534ed41bb86995327a26df0e5f3c912b0fbf630359d3dd1e7f9bb0033b9fea');
  const backup = path.join(project, 'work/第二版后端备份/runner.py');
  if (existsSync(backup)) assert.equal(createHash('sha256').update(await readFile(backup)).digest('hex'), 'bc2a25daa77e032179047c5d844da6cf82135be05cc015f034a26411488215fb');
  const runner = await readFile(path.join(project, 'runner.py'), 'utf8');
  assert.match(runner, /fcntl\.flock\(lock,fcntl\.LOCK_EX\|fcntl\.LOCK_NB\)/);
  assert.match(runner, /if p\.read_text\(\)!=req\['markdown'\]:raise ValueError\('检查期间正文已修改，已停止；请重新点击'\)/);
  assert.match(runner, /problems=body_problems\(module\.parse_bold\(body\)\[0\]\)/);
  assert.doesNotMatch(runner, /codex/);
});

await test('预览源码不读 cookie/秘密、不包含公开发帖接口', async () => {
  const files = (await readdir(path.join(project, 'src'))).filter(file => file.endsWith('.ts'));
  const sources = await Promise.all(files.map(file => readFile(path.join(project, 'src', file), 'utf8')));
  const code = sources.join('\n');
  assert.doesNotMatch(code, /(?:\.ailu\/secrets|storage_state|cookies\.json|auth_token|ct0|api\.(?:x|twitter)\.com\/.*tweets|statuses\/update)/i);
  const embeds = await readFile(path.join(project, 'src', 'embeds.ts'), 'utf8');
  assert.match(embeds, /https:\/\/publish\.twitter\.com\/oembed\?url=/);
  assert.doesNotMatch(embeds, /headers:\s*\{[^}]*Cookie\s*:/i);
});

await test('插件保留定稿视觉，构建包含实际运行的布局修复', async () => {
  const design = await readFile(path.join(project, '设计稿/styles.css'), 'utf8');
  const layout = await readFile(path.join(project, 'src/layout.css'), 'utf8');
  const plugin = await readFile(path.join(project, 'styles.css'), 'utf8');
  assert.equal(plugin, design + '\n' + layout, '构建必须保留定稿并包含布局修复');
});

// These stubs cannot call the real Python runner or write vault/config files.
// They make command compatibility and unsaved-editor guards independently testable.
const adaptersEntry = path.join(temporary, 'adapters-entry.ts');
await writeFile(adaptersEntry, [
  `export { Toolbar, parseVersions, quoteAccount } from ${JSON.stringify(path.join(project, 'src', 'toolbar.ts'))};`,
  `export { Backend, isEligibleFile } from ${JSON.stringify(path.join(project, 'src', 'backend.ts'))};`,
  `export { UploadStatus } from ${JSON.stringify(path.join(project, 'src', 'upload-status.ts'))};`,
  `export { renderPost, postChecks, renderChecks } from ${JSON.stringify(path.join(project, 'src', 'post.ts'))};`,
  `export * from ${JSON.stringify(path.join(project, 'src', 'desk-panels.ts'))};`,
  "export { MarkdownView, TFile, FileSystemAdapter, noticeMessages } from 'obsidian';",
].join('\n'));
const adaptersFile = path.join(temporary, 'adapters.cjs');
await build({
  entryPoints: [adaptersEntry], outfile: adaptersFile, bundle: true, platform: 'node', format: 'cjs', logLevel: 'silent',
  plugins: [{
    name: 'safe-obsidian-test-environment',
    setup(builder) {
      builder.onResolve({ filter: /^(obsidian|child_process|fs|electron)$/ }, args => ({ path: args.path, namespace: 'safe-test' }));
      builder.onLoad({ filter: /.*/, namespace: 'safe-test' }, args => {
        if (args.path === 'obsidian') return { contents: `
          export { parse as parseYaml } from 'yaml';
          export const noticeMessages = [];
          export class Notice { constructor(message) { noticeMessages.push(message); } }
          export class TFile { constructor(path) { this.path = path; this.extension = path.split('.').pop(); } }
          export class MarkdownView { constructor(file, text) { this.file=file; this.editor={getValue:()=>text}; } getMode() { return 'source'; } }
          export class FileSystemAdapter { getBasePath() { throw Error('Forbidden real vault access in unit tests'); } }
          export class App {}
          export class Plugin {}
          export function setIcon(element, icon) { element.dataset.icon = icon; }
        `, loader: 'js', resolveDir: project };
        if (args.path === 'child_process') return { contents: "export function spawn() { throw Error('Forbidden real spawn in unit tests'); }", loader: 'js' };
        if (args.path === 'electron') return { contents: "export const shell = { openPath: async path => { globalThis.__openedEvidence = path; return ''; } };", loader: 'js' };
        return { contents: "export function mkdirSync() { throw Error('Forbidden real write in unit tests'); } export function writeFileSync() { throw Error('Forbidden real write in unit tests'); } export function existsSync() { return false; } export function unlinkSync() { throw Error('Forbidden real delete in unit tests'); }", loader: 'js' };
      });
    },
  }],
});
const { default: adapters } = await import(pathToFileURL(adaptersFile).href);
const { Toolbar, Backend, UploadStatus, renderPost, postChecks, renderChecks, parseVersions, quoteAccount, isEligibleFile, MarkdownView, TFile, noticeMessages } = adapters;
const { buildPublishingChecks, renderPublishingChecks, detailSections, renderDetails, versionCards, swapVersion, renderVersions, parseWritingStyleOutput } = adapters;

await test('第二版发布检查提醒在前，并核实第一行、图片数量格式大小和文风明确命中', () => {
  const checks = buildPublishingChecks({
    markdown: markdown05, mode: 'post', quoteState: 'loaded', now: Date.parse('2026-09-30T07:00:00Z'),
    media: { images: [{ name: '大图.png', extension: 'png', size: 6 * 1024 * 1024, resolved: true }, { name: '动图.gif', extension: 'gif', size: 16 * 1024 * 1024, resolved: true }] },
    style: { status: 'failed', findings: [{ name: '企业黑话', line: 1, hit: '赋能', advice: '换成具体动作。' }] },
  });
  const firstPassed = checks.findIndex(check => !check.warning);
  assert.ok(firstPassed > 0);
  assert.ok(checks.slice(firstPassed).every(check => !check.warning));
  assert.ok(checks.some(check => check.text.includes('第一行') && check.text.includes('加权字符')));
  assert.ok(checks.some(check => check.text.includes('不能与其他配图混用') && check.warning));
  assert.ok(checks.some(check => check.text.includes('大图.png') && check.text.includes('太大')));
  assert.ok(checks.some(check => check.text.includes('GIF 不超过 15 MB')));
  assert.ok(checks.some(check => check.text.includes('第 1 行「赋能」') && check.text.includes('换成具体动作')));
  assert.ok(checks.some(check => check.text.includes('原帖还在，卡片内容已取到')));
  const host = new TestElement(); host.createDiv({ cls: 'xpd-result', text: '保留上传回执' });
  renderPublishingChecks(host, checks);
  assert.ok(host.querySelector('.xpd-result'));
  assert.equal(host.querySelector('.xpd-list-head').textContent, '点「存到草稿箱」之前自动再查一遍；有「!」的不拦，但建议先处理');
  assert.equal(host.querySelectorAll('.xpd-row.is-warn').length, checks.filter(check => check.warning).length);
});

await test('第二版详情只读注释区，完整保留多行和折叠顺序；两个底部链接可调用', () => {
  const markdown = markdown05 + '\n## 来源素材\n正文外的同名标题不能混进详情\n\n%%\n## 来源素材\n第一条\n第二条\n\n## 核实记录\n核实项\n\n## 我的切入点\n本人判断\n%%';
  const sections = detailSections(markdown);
  assert.deepEqual(sections.map(section => section.title), ['笔记属性', '素材话题', '来源素材', '核实记录', '我的切入点', '验收记录']);
  assert.equal(sections.find(section => section.title === '来源素材').content, '第一条\n第二条');
  assert.ok(sections.slice(0, 2).every(section => section.open));
  assert.ok(sections.slice(2).every(section => !section.open));
  let source = 0, compare = 0;
  const host = new TestElement(); host.createDiv({ cls: 'xpd-result', text: '保留上传回执' });
  renderDetails(host, markdown, () => source++, () => compare++);
  assert.ok(host.querySelector('.xpd-result'));
  assert.equal(host.querySelectorAll('details').length, 6);
  const links = host.querySelectorAll('.xpd-link');
  assert.equal(links.length, 2);
  for (const link of links) link.onclick({ preventDefault() {} });
  assert.equal(source, 1); assert.equal(compare, 1);
});

await test('第二版版本卡与纯切换：往返正文完全一致，frontmatter其他字段和全部注释字节不变', async () => {
  const originalBody = postBody(markdown05), originalComments = markdown05.slice(markdown05.indexOf('%%'));
  const before = versionCards(markdown05);
  assert.equal(before.current.current, true); assert.equal(before.alternatives.length, 1);
  assert.ok(before.alternatives[0].reason.includes('正文先用 Meta'));
  const selected = swapVersion(markdown05, before.alternatives[0].label);
  assert.equal(postBody(selected), before.alternatives[0].text);
  assert.equal(selected.slice(selected.indexOf('%%')), originalComments);
  const beforeMetadata = metadata(markdown05), selectedMetadata = metadata(selected); delete selectedMetadata.selected_version;
  assert.deepEqual(selectedMetadata, beforeMetadata);
  const after = versionCards(selected);
  const restored = swapVersion(selected, after.alternatives[0].label);
  assert.equal(postBody(restored), originalBody);
  assert.equal(restored.slice(restored.indexOf('%%')), originalComments);
  // Old behavior deliberately changes selected_version, the exchanged Callout,
  // and its choice explanation; the full restored Markdown is not claimed equal.
  assert.ok(restored.includes('已手动选择版本 A｜原推荐稿；原正文保留为备选。'));
  let choice;
  const host = new TestElement(); host.createDiv({ cls: 'xpd-result', text: '保留上传回执' });
  renderVersions(host, markdown05, async label => { choice = label; });
  assert.ok(host.querySelector('.xpd-result'));
  assert.equal(host.querySelectorAll('.xpd-version-card').length, 2);
  assert.equal(host.querySelectorAll('.xpd-version-card.is-current').length, 1);
  assert.equal(host.querySelector('.xpd-version-tag').textContent, '正在用这版');
  await host.querySelector('.xpd-version-use').onclick();
  assert.equal(choice, '版本 B｜从老师切入');
});

await test('文风输出解析只采用脚本明确规则，退出码或结果不完整不会冒称通过', () => {
  assert.equal(parseWritingStyleOutput('自动检查汇总：ERROR×0\n自动检查通过。', 0).status, 'passed');
  const failure = parseWritingStyleOutput('[ERROR] 第 6 条｜企业黑话｜第 2 行\n命中：赋能\n原文：赋能老师\n建议：换成具体动作。\n自动检查汇总：ERROR×1', 1);
  assert.equal(failure.status, 'failed');
  assert.deepEqual(failure.findings, [{ name: '企业黑话', line: 2, hit: '赋能', advice: '换成具体动作。' }]);
  assert.equal(parseWritingStyleOutput('任意输出', 0).status, 'unavailable');
  assert.equal(parseWritingStyleOutput('自动检查汇总：ERROR×0', 2).status, 'unavailable');
});

await test('定稿推文 DOM：粗体、整行折叠、五个操作图标、字数条和引用失败降级', async () => {
  const host = new TestElement(); let latestChecks;
  await renderPost(host, markdown05, metadata(markdown05), async url => ({ author: '@AYi_AInotes', text: '', url }), items => { latestChecks = items; });
  assert.ok(host.querySelector('.xpd-post'));
  assert.ok(host.querySelector('.xpd-fold'));
  assert.ok(host.querySelector('.xpd-folded').textContent.includes('所以说，能帮人'));
  assert.equal(host.querySelector('.xpd-post').querySelectorAll('b').filter(element => element.textContent === '能帮人把手上的事做完，比模型强不强重要得多').length, 1);
  assert.deepEqual(host.querySelector('.xpd-actions').children.map(element => element.dataset.icon), ['message-circle', 'repeat-2', 'heart', 'bar-chart-2', 'bookmark']);
  assert.match(host.querySelector('.xpd-meter').textContent, /25,000/);
  assert.equal(host.querySelector('.xpd-quote').classList.contains('is-missing'), true);
  assert.equal(host.querySelector('.xpd-quote-text').textContent, '原帖内容取不到，上传时照样会引用');
  assert.ok(latestChecks.some(item => item.text === '没有句号' && !item.warning));
  assert.ok(latestChecks.some(item => item.text.startsWith('结尾那句判断在折叠线下面')));
  assert.equal(host.querySelector('.xpd-checks').children[0].className, 'xpd-alert');
});

await test('引用内容成功后更新卡片与通过项；检查提醒使用定稿文字和真实行号', async () => {
  const host = new TestElement(); let latestChecks;
  await renderPost(host, markdown05, metadata(markdown05), async url => ({ author: '@AYi_AInotes', name: 'AYi', text: '测试原帖开头', url }), items => { latestChecks = items; });
  assert.equal(host.querySelector('.xpd-quote').classList.contains('is-missing'), false);
  assert.equal(host.querySelector('.xpd-quote-text').textContent, '测试原帖开头');
  assert.ok(latestChecks.some(item => item.text === '引用卡片已取到 · 加粗 1 处' && !item.warning));
  const items = postChecks('第一行\n第二行。\n。。。', { delivery_ready: false, expires_at: '2020-01-01T00:00:00Z' });
  assert.deepEqual(items.filter(item => item.warning).map(item => item.text), ['第 2 行有句号，推特不用句号，改成换行。', '还没验收', '核验已过期，先重新核实再上传']);
  const checks = new TestElement(); renderChecks(checks, items);
  assert.equal(checks.querySelectorAll('.xpd-alert').length, 3);
  assert.equal(checks.querySelector('.xpd-alert').children[0].tag, 'b');
});

await test('工具栏识别固定样例的备选 Callout，正文和版本边界准确', () => {
  const { body, versions } = parseVersions(markdown05);
  assert.ok(body[1].includes('所以说，**能帮人'));
  assert.equal(versions.length, 1);
  assert.equal(versions[0].label, '版本 B｜从老师切入');
  assert.ok(versions[0].text.startsWith('我教老师用 AI，从来不讲哪个模型强'));
  assert.ok(!versions[0].text.includes('选择理由'));
  assert.ok(markdown05.slice(versions[0].start, versions[0].end).startsWith('> **版本 B'));
  assert.equal(quoteAccount(markdown05), 'AYi_AInotes');
});

await test('上传及改稿范围拒绝评论、素材、非 Markdown 文件', () => {
  assert.equal(isEligibleFile(new TFile(note05)), true);
  assert.equal(isEligibleFile(new TFile('推特创作/05长文/长文.md')), true);
  for (const file of [null, new TFile('推特创作/03创作中/评论/评论.md'), new TFile('推特创作/02素材/素材.md'), new TFile('推特创作/03创作中/图片.png')]) assert.equal(isEligibleFile(file), false);
});

await test('任一打开编辑页未保存时，上传和改稿都在调用 Python 前拒绝', async () => {
  const file = new TFile(note05);
  const app = {
    vault: { read: async () => markdown05 },
    workspace: { getLeavesOfType: () => [{ view: new MarkdownView(file, markdown05) }, { view: new MarkdownView(file, markdown05 + '未保存') }] },
  };
  const backend = new Backend(app);
  assert.equal((await backend.upload(file)).verified, false);
  assert.equal(backend.lastResult.error, '当前编辑尚未保存，请稍后再点');
  assert.equal(backend.busy, false);
  assert.equal((await backend.recordRevision(file)).error, '修改尚未保存，请稍后再点');
  assert.equal(backend.learningBusy, false);
});

await test('上传状态由后端回执驱动：忙时禁用、stage逐步更新、核对成功才显示结果和证据', async () => {
  const button = new TestElement({ cls: 'xpd-btn-primary' }), host = new TestElement();
  const context = { file: new TFile(note05), kind: 'post', quote: 'AYi_AInotes', fingerprint: 'original' };
  let sendStage, complete, calls = 0;
  const backend = {
    busy: false,
    upload: async (file, stage, kind) => {
      calls++; assert.equal(file.path, note05); assert.equal(kind, 'post'); backend.busy = true; sendStage = stage;
      return new Promise(resolve => { complete = result => { backend.busy = false; resolve(result); }; });
    },
  };
  const status = new UploadStatus(button, host, backend, () => context);
  assert.equal(button.textContent, '引用 @AYi_AInotes · 存到草稿箱');
  const running = status.run();
  assert.equal(button.disabled, true);
  assert.equal(button.classList.contains('is-busy'), true);
  assert.equal(button.textContent, '正在存草稿…');
  assert.equal(host.querySelectorAll('.xpd-step').length, 4);
  assert.equal(host.querySelector('.xpd-step.is-current').textContent, 'Codex 检查正文');
  await status.run(); assert.equal(calls, 1, '忙时不能重复启动后端');
  sendStage('正在保存并核对 X 草稿');
  assert.equal(host.querySelectorAll('.xpd-step.is-done').length, 1);
  assert.equal(host.querySelector('.xpd-step.is-current').textContent, '打开 @AYi_AInotes 那条，点「引用」');
  sendStage('写入正文、加粗');
  assert.equal(host.querySelectorAll('.xpd-step.is-done').length, 2);
  assert.equal(host.querySelector('.xpd-step.is-current').textContent, '写入正文、加粗');
  sendStage('在新窗口回读草稿');
  assert.equal(host.querySelectorAll('.xpd-step.is-done').length, 3);
  complete({ verified: true, already_exists: true, account: '@zwzw3888', quote: metadata(markdown05).quote, quote_verified: true, bold_verified: true, publicly_posted: false, evidence: '/tmp/X 草稿验收.png' });
  await running;
  assert.equal(button.disabled, false);
  assert.equal(button.classList.contains('is-done'), true);
  assert.match(button.textContent, /^已存草稿 · \d{2}:\d{2}$/);
  assert.equal(host.querySelector('.xpd-progress'), null);
  assert.match(host.querySelector('.xpd-result').textContent, /@zwzw3888/);
  assert.match(host.querySelector('.xpd-result').textContent, /@AYi_AInotes ✓/);
  assert.match(host.querySelector('.xpd-result').textContent, /回读一致 ✓/);
  assert.match(host.querySelector('.xpd-result').textContent, /没有，去 X 草稿箱自己发/);
  const evidence = host.querySelectorAll('a').find(element => element.textContent === '看草稿箱截图');
  assert.ok(evidence);
  let prevented = false;
  evidence.onclick({ preventDefault: () => { prevented = true; } });
  await Promise.resolve();
  assert.equal(prevented, true);
  assert.equal(globalThis.__openedEvidence, '/tmp/X 草稿验收.png', '只把回执证据路径交给mock本机打开器');
  status.dispose(); assert.equal(button.onclick, null);
});

await test('verified false 永远不显示成功；人话错误可重试，其他上传忙时禁用', async () => {
  const button = new TestElement(), host = new TestElement(); let calls = 0;
  const context = { file: new TFile(note06), kind: 'post', quote: 'fankaishuoai', fingerprint: 'same-body' };
  const backend = {
    busy: false,
    upload: async () => { calls++; return { verified: false, error: 'X 登录过期了\n/Users/Admin/private/full-log.txt' }; },
  };
  const status = new UploadStatus(button, host, backend, () => context);
  backend.busy = true; status.syncBusy();
  assert.equal(button.disabled, true);
  await status.run(); assert.equal(calls, 0);
  backend.busy = false; status.syncBusy();
  await status.run();
  assert.equal(button.textContent, '重试');
  assert.equal(button.disabled, false);
  assert.equal(button.classList.contains('is-failed'), true);
  assert.equal(button.classList.contains('is-done'), false);
  assert.equal(host.querySelector('.xpd-result'), null);
  assert.equal(host.querySelector('.xpd-error').querySelector('b').textContent, 'X 登录过期了');
  assert.match(host.querySelector('.xpd-error').textContent, /重新登录 X/);
  assert.ok(!host.textContent.includes('full-log'));
  await button.onclick();
  assert.equal(calls, 2, '重试只执行一次mock后端');
  status.setContext({ ...context, fingerprint: 'changed-body' });
  assert.equal(button.classList.contains('is-failed'), false);
  assert.equal(host.querySelector('.xpd-error'), null);
  status.dispose();
});

await test('三个新命令和旧完整命令均注册，插件前缀变异不影响旧别名', async () => {
  const commands = [], aliases = [], disposers = [], processors = new Map();
  const app = {
    commands: { addCommand: command => aliases.push(command), removeCommand: id => aliases.splice(aliases.findIndex(command => command.id === id), 1) },
    workspace: { getActiveFile: () => null, getActiveViewOfType: () => null, getLeavesOfType: () => [], onLayoutReady: () => {}, on: () => ({}) },
    vault: {
      on: () => ({}), getAbstractFileByPath: target => new TFile(target),
      cachedRead: async file => file.path === note05 ? markdown05 : file.path === note06 ? markdown06 : '---\ndelivery_ready: true\n---\n\n## 正文\n\n测试正文',
    },
    metadataCache: { on: () => ({}), getFileCache: () => ({}) },
  };
  const plugin = {
    app,
    addCommand: command => { command.id = 'x-publish-desk:' + command.id; commands.push(command); },
    register: callback => disposers.push(callback), registerEvent: () => {}, addRibbonIcon: () => {},
    registerMarkdownCodeBlockProcessor: (name, callback) => processors.set(name, callback),
  };
  const toolbar = new Toolbar(plugin, { upload: () => {}, recordRevision: () => {} });
  toolbar.register();
  const ids = ['record-current-revision', 'upload-current-to-x-draft', 'upload-current-to-x-article'];
  assert.deepEqual(commands.map(command => command.id), ids.map(id => 'x-publish-desk:' + id));
  assert.deepEqual(aliases.map(command => command.id), ids.map(id => 'x-post-draft-helper:' + id));
  assert.deepEqual([...processors.keys()], ['x-draft', 'x-publish']);
  toolbar.register();
  assert.equal(commands.length, 3);

  // The user's live entry grows with new batches; exercise the processor with
  // a frozen fixture instead of treating two historical blocks as a rule.
  const entry = await readFile(path.join(fixtures, '发布入口.md'), 'utf8');
  const blocks = [...entry.matchAll(/^```x-draft\n([\s\S]*?)^```/gm)];
  assert.equal(blocks.length, 2);
  const hosts = [];
  for (const block of blocks) {
    const host = new TestElement(); hosts.push(host);
    processors.get('x-draft')(block[1], host);
    assert.equal(host.children.length, 3, '代码块的每条路径必须有独立入口');
    for (const panel of host.children) {
      assert.ok(panel.className.includes('xpd'), '入口使用定稿 xpd 样式');
      assert.equal(panel.querySelectorAll('.xpd-btn-primary').length, 1, '每稿仅一个按类型选择的主按钮');
    }
  }
  // Wait for the labels' cachedRead promises without invoking any click handlers.
  await Promise.all([...entry.matchAll(/^推特创作\/.+\.md$/gm)].map(match => app.vault.cachedRead(new TFile(match[0]))));
  assert.equal(hosts.flatMap(host => host.children).length, 6);
  assert.match(hosts[1].children[1].querySelector('.xpd-btn-primary').textContent, /引用 @AYi_AInotes · 存到草稿箱/);
  assert.match(hosts[1].children[2].querySelector('.xpd-btn-primary').textContent, /引用 @fankaishuoai · 存到草稿箱/);
  const legacyHost = new TestElement();
  processors.get('x-publish')(note05, legacyHost);
  assert.equal(legacyHost.children.length, 1);
  for (const dispose of disposers.reverse()) dispose();
  assert.equal(aliases.length, 0);
  assert.ok(noticeMessages.every(message => !message.includes('已存入')));
});

console.log(`\n${passed} 项通过，${failed} 项失败`);
if (failed) process.exitCode = 1;
