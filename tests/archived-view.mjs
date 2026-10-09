import assert from 'node:assert/strict';
import { mkdir } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { build } from 'esbuild';

const project = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const temporary = path.join(project, 'work', 'tests');
await mkdir(temporary, { recursive: true });

class TestElement {
  constructor(tag = 'div', options = {}) {
    this.tag = tag; this.children = []; this._text = options.text || ''; this.className = options.cls || '';
    this.attributes = { ...options.attr }; this.style = {}; this.dataset = {}; this.disabled = false; this.inert = false;
  }
  get ownerDocument() { return globalThis.document; }
  get textContent() { return this._text + this.children.map(child => child.textContent).join(''); }
  set textContent(text) { this._text = text || ''; this.children = []; }
  setText(text) { this.textContent = text; }
  empty() { this.children = []; this._text = ''; }
  createEl(tag, options = {}) { const element = new TestElement(tag, options); this.append(element); return element; }
  createDiv(options) { return this.createEl('div', options); }
  createSpan(options) { return this.createEl('span', options); }
  append(...children) { for (const child of children) { child.parentElement = this; this.children.push(child); } }
  appendText(text) { this.append(new TestElement('text', { text })); }
  insertBefore(child, before) { const index = this.children.indexOf(before); child.parentElement = this; this.children.splice(index < 0 ? this.children.length : index, 0, child); }
  remove() { if (this.parentElement) this.parentElement.children = this.parentElement.children.filter(child => child !== this); }
  addClass(...names) { this.className = [...new Set([...this.className.split(/\s+/).filter(Boolean), ...names])].join(' '); }
  removeClass(...names) { this.className = this.className.split(/\s+/).filter(name => !names.includes(name)).join(' '); }
  hasClass(name) { return this.className.split(/\s+/).includes(name); }
  toggleClass(name, force) { if (force ?? !this.hasClass(name)) this.addClass(name); else this.removeClass(name); }
  attachShadow() { this.shadowRoot = new TestElement(); return this.shadowRoot; }
  setAttribute(name, value) { this.attributes[name] = String(value); }
  getAttribute(name) { return this.attributes[name] ?? null; }
  removeAttribute(name) { delete this.attributes[name]; }
  matches(part) {
    if (part.startsWith('[')) { const match = /^\[([^=]+)(?:="([^"]+)")?\]$/.exec(part); return !!match && (match[2] ? this.getAttribute(match[1]) === match[2] : this.getAttribute(match[1]) !== null); }
    const [tag, ...classes] = part.split('.');
    return (!tag || this.tag === tag) && classes.every(name => this.className.split(/\s+/).includes(name));
  }
  matchesSelector(selector) {
    const parts = selector.trim().split(/\s+/); if (!this.matches(parts.pop())) return false;
    let ancestor = this.parentElement;
    while (parts.length) { const part = parts.pop(); while (ancestor && !ancestor.matches(part)) ancestor = ancestor.parentElement; if (!ancestor) return false; ancestor = ancestor.parentElement; }
    return true;
  }
  querySelectorAll(selector) { return this.children.flatMap(child => [...(selector.split(',').some(part => child.matchesSelector(part)) ? [child] : []), ...child.querySelectorAll(selector)]); }
  querySelector(selector) { return this.querySelectorAll(selector)[0] || null; }
}
globalThis.document = { body: new TestElement('body'), createElement: tag => new TestElement(tag), createElementNS: (_namespace, tag) => new TestElement(tag) };
globalThis.MutationObserver = class { observe() {} disconnect() {} };
globalThis.__archivedViewTest = { element: () => new TestElement(), editorConstructions: 0, notices: [] };
const obsidian = `
const test=globalThis.__archivedViewTest;
export class TFile {constructor(path){this.path=path;this.stat={size:8};}get basename(){return this.name.replace(/\\.[^.]+$/,'');}get name(){return this.path.split('/').pop();}get extension(){return this.name.split('.').pop();}}
test.TFile=TFile;
export class FileView {constructor(leaf){this.leaf=leaf;this.app=leaf.app;this.contentEl=test.element();}register(){}registerEvent(){}}
export class Component {load(){}unload(){}registerDomEvent(){}}
export class MarkdownView {}
export class FileSystemAdapter {}
export class WorkspaceLeaf {}
export class Notice {constructor(message){test.notices.push(message);}}
export class Modal {}
export class Setting {}
export function setIcon(){}
`;
const doubles = {
  'post-edit': `export class PostEditor {constructor(){globalThis.__archivedViewTest.editorConstructions++;throw Error('归档预览不应创建编辑器');}}`,
  article: `export function renderArticle(){throw Error('归档普通推文不应进入Articles');}export function articleMediaInfo(){return {images:[],cover:null};}`,
  'desk-panels': `export function versionCards(){return {alternatives:[]};}export function renderDetails(host){host.createDiv({text:'原始笔记详情'});}export function renderVersions(){throw Error('归档不能选择版本');}export function buildPublishingChecks(){return [];}export function renderPublishingChecks(){}export function swapVersion(){throw Error('不允许改笔记');}export async function runWritingStyleCheck(){return {status:'passed',findings:[]};}`,
};
const output = path.join(temporary, 'archived-view.cjs');
await build({ entryPoints: [path.join(project, 'src', 'desk-view.ts')], outfile: output,
  bundle: true, platform: 'node', format: 'cjs', logLevel: 'silent', plugins: [{
    name: 'offline-view', setup(build) {
      build.onResolve({ filter: /^obsidian$/ }, () => ({ path: 'obsidian', namespace: 'offline' }));
      build.onResolve({ filter: /^\.\/(post-edit|article|desk-panels)$/ }, args => ({ path: args.path.slice(2), namespace: 'offline' }));
      build.onLoad({ filter: /.*/, namespace: 'offline' }, args => ({ contents: args.path === 'obsidian' ? obsidian : doubles[args.path], loader: 'js' }));
    },
  }] });
const { default: module } = await import(pathToFileURL(output).href);
const source = '---\ntitle: 归档测试\ndelivery_ready: true\n---\n## 正文\n第一段\n\n**重点完整保留**\n\n![[a.png]]\n\n## 备选版本\n不应显示';
function fixture(receipt) {
  const TFile = globalThis.__archivedViewTest.TFile;
  const file = new TFile('推特创作/04已发布/归档测试.md'), image = new TFile('推特创作/附件/a.png');
  const calls = { reads: 0, writes: 0, saves: 0, deliveries: 0 };
  const app = {
    vault: { on: () => undefined, read: async () => { calls.reads++; return source; }, getAbstractFileByPath: value => value === file.path ? file : value.endsWith('a.png') ? image : null,
      getResourcePath: file => 'app://local/' + file.path, modify: () => { calls.writes++; throw Error('不允许改笔记'); }, process: () => { calls.writes++; throw Error('不允许改笔记'); } },
    metadataCache: { getFirstLinkpathDest: () => image },
    workspace: { requestSaveLayout: () => calls.saves++, getLeavesOfType: () => [] },
  };
  const leaf = { app, identity: '原标签页' };
  let busy = false;
  const listeners = new Set();
  const backend = { get busy() { return busy; }, set busy(value) { busy = value; for (const callback of listeners) callback(); },
    learningBusy: false, onBusyChange(callback) { listeners.add(callback); return () => listeners.delete(callback); },
    archivedDelivery: () => receipt, deliver: () => { calls.deliveries++; throw Error('禁止真实提交'); } };
  const view = new module.DeskView(leaf, backend, { get: async () => ({}) }, '', async () => {});
  view.file = file; view.surface = new TestElement(); view.markdown = source;
  return { view, file, image, calls, backend, leaf };
}

const published = fixture({ verified: true, action: 'publish', state: 'published', account: '@zwzw3888', url: 'https://x.com/zwzw3888/status/123', archived_path: '推特创作/04已发布/归档测试.md' });
await published.view.render();
assert.equal(published.view.leaf, published.leaf);
assert.ok(published.view.surface.textContent.includes('已公开发布'));
assert.ok(!published.view.surface.textContent.includes('草稿'));
assert.ok(!published.view.surface.textContent.includes('不应显示'));
assert.equal(published.view.surface.querySelectorAll('img').length, 1, '归档保留真实配图预览');
assert.ok(published.view.surface.querySelector('.xpd-post-body').textContent.includes('第一段'));
assert.ok(published.view.surface.querySelector('.xpd-post-body').textContent.includes('重点完整保留'));
assert.equal(published.view.surface.querySelector('.xpd-post-body b').textContent, '重点完整保留');
assert.deepEqual(published.view.surface.querySelectorAll('button').map(button => button.textContent), ['预览', '详情']);
assert.equal(published.view.editor, undefined);
assert.equal(published.calls.writes, 0);
assert.equal(published.calls.deliveries, 0);

const scheduled = fixture({ verified: true, state: 'scheduled', action: 'schedule', account: '@zwzw3888', mode: 'native', scheduled_for: '2026-01-01T01:30:00Z', time_zone: 'Asia/Shanghai' });
await scheduled.view.render();
assert.ok(scheduled.view.surface.textContent.includes('已排期待发布'));
assert.ok(scheduled.view.surface.textContent.includes('2026-01-01 09:30 · Asia/Shanghai'));
assert.ok(!scheduled.view.surface.textContent.includes('已公开发布'));
assert.deepEqual(scheduled.view.surface.querySelectorAll('button').map(button => button.textContent), ['预览', '详情']);

const legacy = fixture(undefined);
legacy.view.completedDelivery = { file: legacy.file, result: { verified: true, action: 'publish', state: 'published' } };
await legacy.view.render();
assert.ok(legacy.view.surface.textContent.includes('已归档'));
assert.ok(legacy.view.surface.textContent.includes('未找到已核验的发布回执'));
assert.ok(!legacy.view.surface.textContent.includes('已公开发布'));
assert.ok(!legacy.view.surface.textContent.includes('已公开发布'), '当前归档正文未匹配持久回执时不能使用旧缓存成功');
assert.equal(globalThis.__archivedViewTest.editorConstructions, 0);

const settle = async () => { for (let count = 0; count < 4; count++) await new Promise(resolve => setImmediate(resolve)); };
const otherView = fixture({ verified: true, action: 'publish', state: 'published' });
await otherView.view.onOpen();
otherView.backend.busy = true;
await otherView.view.externalChange();
assert.equal(otherView.view.pendingExternal, true);
const beforeReleaseReads = otherView.calls.reads;
otherView.backend.busy = false; await settle();
assert.ok(otherView.calls.reads > beforeReleaseReads, '同文件其他发布台在共享busy释放后刷新归档');
assert.equal(otherView.view.pendingExternal, false);
assert.deepEqual(otherView.view.surface.querySelectorAll('button').map(button => button.textContent), ['预览', '详情']);

const originView = fixture({ verified: true, action: 'publish', state: 'published' });
await originView.view.onOpen();
originView.view.deliveryBusy = true; originView.backend.busy = true;
await originView.view.externalChange();
const originReads = originView.calls.reads;
originView.backend.busy = false; await settle();
assert.equal(originView.calls.reads, originReads, 'origin本地deliveryBusy未释放时共享busy回调不得抢先dispose');
originView.view.deliveryBusy = false;
await originView.view.deliveryCompleted(originView.file, { verified:true,action:'publish',state:'published',archived_path:originView.file.path });
assert.ok(originView.calls.reads > originReads);
assert.equal(originView.calls.saves, 1);
assert.ok(originView.view.surface.textContent.includes('已公开发布'));

const moved = fixture({ verified: true, action: 'publish', state: 'published' });
moved.file.path = '推特创作/03创作中/归档测试.md';
moved.view.deliveryBusy = true; moved.backend.busy = true;
moved.file.path = '推特创作/04已发布/归档测试.md';
await moved.view.externalChange();
assert.equal(moved.calls.reads, 0, '提交期间rename/modify不读取或重绘销毁控制器');
assert.equal(moved.view.pendingExternal, true);
moved.view.deliveryBusy = false; moved.backend.busy = false;
await moved.view.deliveryCompleted(moved.file, { verified: true, action: 'publish', state: 'published', archived_path: moved.file.path });
assert.equal(moved.view.leaf, moved.leaf, '移动后保留原标签页');
assert.equal(moved.view.file, moved.file, '跟随移动后的同一个文件');
assert.equal(moved.view.pendingExternal, false);
assert.equal(moved.calls.saves, 1, '归档回调保存新路径布局');
assert.ok(moved.view.surface.textContent.includes('已公开发布'));
assert.deepEqual(moved.view.surface.querySelectorAll('button').map(button => button.textContent), ['预览', '详情']);
assert.equal(moved.calls.writes, 0);

const lock = fixture(undefined);
const card = lock.view.surface.createDiv({ cls: 'xpd-post' }), editable = card.createDiv({ attr: { contenteditable: 'true' } });
const tools = lock.view.surface.createDiv({ cls: 'xpd-editbar' }), tool = tools.createEl('button');
lock.backend.busy = true; lock.view.syncActionBusy();
assert.equal(card.inert, true); assert.equal(tools.inert, true); assert.equal(tool.disabled, true); assert.equal(editable.getAttribute('contenteditable'), 'false');
lock.backend.busy = false; lock.view.syncActionBusy();
assert.equal(card.inert, false); assert.equal(tools.inert, false); assert.equal(tool.disabled, false); assert.equal(editable.getAttribute('contenteditable'), 'true');
assert.equal(globalThis.__archivedViewTest.editorConstructions, 0);
console.log('通过：归档只读完整正文/加粗/配图、持久回执恢复、旧归档中性状态、排期待发布、同标签跟随移动、忙时延后重绘与编辑锁恢复；无写笔记/提交。');
