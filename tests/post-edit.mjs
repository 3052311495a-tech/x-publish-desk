import assert from 'node:assert/strict';
import vm from 'node:vm';
import { createRequire } from 'node:module';
import { build } from 'esbuild';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const require = createRequire(import.meta.url);
class TFile {
  constructor(path, size = 0) { this.path = path; this.name = path.split('/').pop(); this.extension = this.name.split('.').pop(); this.stat = { size }; }
}
const obsidian = { TFile, Notice: class {} };
async function load(entry) {
  const output = await build({ entryPoints: [path.join(root, entry)], bundle: true, platform: 'node', format: 'cjs', write: false, external: ['obsidian'], logLevel: 'silent' });
  const context = { module: { exports: {} }, require: name => name === 'obsidian' ? obsidian : require(name), setTimeout, clearTimeout, console, URL };
  context.exports = context.module.exports;
  vm.runInNewContext(output.outputFiles[0].text, context);
  return context.module.exports;
}
const edit = await load('src/post-edit.ts'), media = await load('src/media.ts');
let passed = 0;
async function test(name, callback) { await callback(); passed++; console.log('通过 ' + name); }
const original = '---\r\ntitle: fixture\r\ndelivery_ready: true\r\n---\r\n\r\n## 正文\r\n\r\n第一行\r\n\r\n**第二行**\r\n\r\n## 备选版本\r\n> B\r\n\r\n%%\r\n## 素材话题\r\n话题不变\r\n## 来源素材\r\n来源不变\r\n## 验收记录\r\n原样保存\r\n%%\r\n';

await test('只替换正文，frontmatter/备选/%%每个字节及CRLF均不变', () => {
  const range = edit.findPostBodyRange(original), changed = edit.replacePostBody(original, '第一字改了\n\n**第二行**');
  assert.equal(changed.slice(0, range.start), original.slice(0, range.start));
  assert.equal(changed.slice(changed.length - (original.length - range.end)), original.slice(range.end));
  assert.equal(edit.findPostBodyRange(changed).body, '第一字改了\n\n**第二行**');
});

await test('正文外的隐藏同名标题不计；重复正文或新章节文字拒绝', () => {
  const source = '---\ntitle: test\n---\n\n## 正文\n\n正文\n\n%%\n## 正文\n过程记录\n%%';
  assert.equal(edit.findPostBodyRange(source).body, '正文');
  assert.throws(() => edit.findPostBodyRange('## 正文\nA\n## 正文\nB'), /只能有一个/);
  assert.throws(() => edit.replacePostBody(original, '## 偷换章节'), /章节标题/);
});

function text(value) { return { nodeType: 3, nodeValue: value }; }
function element(tag, ...children) { return { nodeType: 1, tagName: tag.toUpperCase(), dataset: {}, style: { fontWeight: '' }, childNodes: children }; }
await test('DOM加粗和空行写回Markdown；只读折叠线不混入正文', () => {
  const fold = element('div', text('时间线在这里折叠 · 280')); fold.dataset.xpdDecoration = 'true';
  const root = element('div', element('div', text('第一行')), element('div', element('br')), fold, element('div', element('b', text('第二行')), text('结束')));
  assert.equal(edit.editableToMarkdown(root), '第一行\n\n**第二行**结束');
  const unbold = element('div', element('div', text('第一行')), element('div', element('br')), element('div', text('第二行结束')));
  assert.equal(edit.editableToMarkdown(unbold), '第一行\n\n第二行结束');
});

await test('跨行加粗逐行闭合，图片节点不会变成编辑正文', () => {
  const root = element('div', element('div', element('b', text('一\n二')), element('img')));
  assert.equal(edit.editableToMarkdown(root), '**一**\n**二**');
});

await test('ShadowRoot焦点/选区优先于宿主document，普通DOM仍可回退', () => {
  const node = text('选中文字'), editable = element('div', node), host = {};
  const inside = { rangeCount: 1, anchorNode: node, focusNode: node }, outside = { rangeCount: 0, anchorNode: host, focusNode: host };
  let documentReads = 0;
  const document = { activeElement: host, getSelection: () => { documentReads++; return outside; } };
  const shadow = { activeElement: editable, getSelection() { assert.equal(this, shadow); return inside; } };
  editable.ownerDocument = document; editable.getRootNode = () => shadow; editable.contains = candidate => candidate === editable || candidate === node;
  const editor = new edit.PostEditor({ metadataCache: { getFirstLinkpathDest: () => null } }, new TFile('fixture.md'), original);
  editor.elements = { editable };
  assert.equal(editor.isFocused, true); assert.equal(edit.editableSelection(editable), inside); assert.equal(documentReads, 0);
  shadow.activeElement = null; assert.equal(editor.isFocused, false);
  editable.getRootNode = () => document; document.activeElement = editable;
  assert.equal(editor.isFocused, true); assert.equal(edit.editableSelection(editable), outside); assert.equal(documentReads, 1);
  editor.dispose();
});

await test('ShadowRoot内B按钮恢复内部选区后只调用ownerDocument命令，失效选区不改外部文字', () => {
  const node = text('原文'), editable = element('div', node), outside = {}, calls = [];
  const range = { startContainer: node, endContainer: node };
  const selection = { rangeCount: 1, anchorNode: outside, focusNode: outside,
    removeAllRanges() { calls.push('clear'); this.rangeCount = 0; },
    addRange(value) { calls.push('restore'); assert.equal(value, range); this.rangeCount = 1; this.anchorNode = node; this.focusNode = node; },
  };
  const shadow = { activeElement: null, getSelection: () => selection };
  editable.ownerDocument = { activeElement: {}, getSelection: () => { throw new Error('不能误读document选区'); }, execCommand: (...args) => { calls.push(args); return true; } };
  editable.getRootNode = () => shadow; editable.contains = candidate => candidate === editable || candidate === node;
  editable.focus = () => { calls.push('focus'); shadow.activeElement = editable; };
  const editor = new edit.PostEditor({ metadataCache: { getFirstLinkpathDest: () => null } }, new TFile('fixture.md'), original);
  editor.elements = { editable }; editor.lastRange = range; editor.refreshFold = () => {};
  editor.toggleBold();
  assert.deepEqual(calls, ['focus', 'clear', 'restore', ['styleWithCSS', false, 'false'], ['bold', false]]);
  selection.anchorNode = outside; selection.focusNode = outside; editor.lastRange = { startContainer: outside, endContainer: outside }; calls.length = 0;
  editor.toggleBold(); assert.deepEqual(calls, ['focus']);
  editor.changed = false; editor.dispose();
});

await test('flush同时调用只写一次；外部改属性而正文没变时保留最新属性', async () => {
  let stored = original, processes = 0;
  const app = { vault: { process: async (_file, action) => { processes++; stored = action(stored); } }, metadataCache: { getFirstLinkpathDest: () => null } };
  const editor = new edit.PostEditor(app, new TFile('fixture.md'), original);
  editor.localText = '第一字改了\n\n**第二行**'; editor.touch();
  stored = stored.replace('title: fixture', 'title: 外部属性变化');
  await Promise.all([editor.flush(), editor.flush()]);
  assert.equal(processes, 1); assert.ok(stored.includes('title: 外部属性变化'));
  assert.equal(edit.findPostBodyRange(stored).body, '第一字改了\n\n**第二行**');
  assert.ok(stored.endsWith(original.slice(edit.findPostBodyRange(original).sectionEnd))); editor.dispose();
});

await test('外部正文变化时停止保存，文件不被覆盖，本地修改仍在', async () => {
  let stored = original;
  const app = { vault: { process: async (_file, action) => { stored = action(stored); } }, metadataCache: { getFirstLinkpathDest: () => null } };
  const editor = new edit.PostEditor(app, new TFile('fixture.md'), original);
  editor.localText = '本地还没存'; editor.touch();
  stored = edit.replacePostBody(stored, '别人改了正文'); const external = stored;
  await assert.rejects(editor.flush(), /原始笔记的正文也改了/);
  assert.equal(stored, external); assert.equal(editor.dirty, true); assert.equal(editor.getBody(), '本地还没存'); editor.dispose();
});

await test('媒体嵌入拆合，保留正文空行和引用尺寸参数', () => {
  const parsed = media.splitPostMedia('正文\n\n![[A.jpg]]\n![[B.png|300]]');
  assert.equal(parsed.text, '正文'); assert.deepEqual(Array.from(parsed.references), ['A.jpg', 'B.png|300']);
  assert.equal(media.joinPostMedia(parsed.text, parsed.references), '正文\n\n![[A.jpg]]\n![[B.png|300]]');
  assert.equal(media.joinPostMedia('保留\n\n空行\n', []), '保留\n\n空行\n');
});

const valid = (name, size = 1) => ({ name, reference: name, file: new TFile(name, size), kind: media.mediaKind(name), size, resourceUrl: 'local' });
await test('数量、5MB/15MB、GIF视频不可混与格式限制均为提醒', () => {
  assert.ok(media.mediaChecks([valid('A.jpg', 6 * 1024 * 1024)]).some(item => item.warning && item.text.includes('5MB')));
  assert.ok(media.mediaChecks([valid('A.gif', 16 * 1024 * 1024)]).some(item => item.warning && item.text.includes('15MB')));
  assert.ok(media.mediaChecks([valid('A.gif'), valid('B.png')]).some(item => item.warning && item.text.includes('不能')));
  assert.ok(media.mediaChecks(Array.from({ length: 5 }, (_, i) => valid(i + '.jpg'))).some(item => item.warning && item.text.includes('4')));
  assert.equal(media.mediaKind('video.mp4'), 'video'); assert.equal(media.mediaKind('video.mov'), 'video');
  assert.equal(media.mediaKind('video.webm'), 'unsupported'); assert.equal(media.mediaKind('video.m4v'), 'unsupported');
});

await test('附件只复制到固定目录，重名不覆盖；删图/排序只改refs', async () => {
  const files = new Map([['elsewhere/same.jpg', new TFile('elsewhere/same.jpg')]]), copied = [];
  const app = { vault: {
    getAbstractFileByPath: value => files.get(value) || null,
    getFiles: () => [...files.values()].filter(file => file instanceof TFile),
    createFolder: async value => files.set(value, {}),
    createBinary: async (value, data) => { const file = new TFile(value, data.byteLength); files.set(value, file); copied.push(value); return file; },
    getResourcePath: file => 'app://fixture/' + file.path,
  }, metadataCache: { getFirstLinkpathDest: value => [...files.values()].find(file => file instanceof TFile && file.name === value) || null } };
  const manager = new media.MediaManager(app, new TFile('fixture.md'), []);
  const fresh = await manager.addFiles([{ name: 'same.jpg', arrayBuffer: async () => new Uint8Array([1, 2, 3]).buffer }, { name: 'B.png', arrayBuffer: async () => new Uint8Array([4]).buffer }]);
  assert.deepEqual(Array.from(fresh), ['same-2.jpg', 'B.png']); assert.deepEqual(copied, ['推特创作/附件/same-2.jpg', '推特创作/附件/B.png']);
  manager.move(0, 1); assert.deepEqual(Array.from(manager.getReferences()), ['B.png', 'same-2.jpg']);
  manager.remove(0); assert.deepEqual(Array.from(manager.getReferences()), ['same-2.jpg']);
  assert.ok(files.has('推特创作/附件/B.png')); manager.dispose();
  const source = { name: 'same.jpg', arrayBuffer: async () => new Uint8Array([5]).buffer };
  const simultaneous = await Promise.all([media.copyAttachments(app, [source]), media.copyAttachments(app, [source])]);
  assert.deepEqual(simultaneous.map(result => result[0].name), ['same-3.jpg', 'same-4.jpg']);
});

console.log(`正文编辑/媒体：${passed} 项通过；全部使用离线内存 fixture，未改真实笔记或附件。`);
