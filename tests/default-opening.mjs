import assert from 'node:assert/strict';
import { mkdir } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { build } from 'esbuild';

const project = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const temporary = path.join(project, 'work', 'tests');
await mkdir(temporary, { recursive: true });
async function load(name) {
  const output = path.join(temporary, `${name}-opening.cjs`);
  await build({ entryPoints: [path.join(project, 'src', `${name}.ts`)], outfile: output, bundle: true, platform: 'node', format: 'cjs', logLevel: 'silent' });
  return (await import(pathToFileURL(output).href)).default;
}
const { DefaultOpening } = await load('default-opening');
const { noteMode } = await load('model');
const deskType = 'x-publish-desk';
const post = '推特创作/03创作中/测试推文.md';
const nextPost = '推特创作/03创作中/另一篇推文.md';
const article = '推特创作/05长文/测试长文.md';
const archived = '推特创作/04已发布/测试推文.md';
const comment = '推特创作/03创作中/评论/测试评论.md';
const normal = '普通目录/普通笔记.md';
const eligible = file => file.endsWith('.md') && Boolean(noteMode(file));
const markdown = (file, rest = {}) => ({ type: 'markdown', state: { file, ...rest } });
function deferred() {
  let resolve, reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
function fixture({ beforeChange, native } = {}) {
  const app = {}, calls = [], saves = [];
  class Leaf {
    constructor(owner = app) { this.view = { app: owner }; }
    async setViewState(state, ephemeral) {
      calls.push({ leaf: this, state, ephemeral });
      if (native) await native(this, state);
      this.view = { app: this.view.app, type: state.type, file: state.state?.file };
    }
  }
  const original = Leaf.prototype.setViewState;
  const opening = new DefaultOpening(Leaf.prototype, {
    owns: leaf => leaf.view.app === app,
    eligible,
    deskType,
    beforeChange: async leaf => { saves.push(leaf); if (beforeChange) await beforeChange(leaf); },
  });
  return { app, Leaf, calls, saves, opening, original };
}
let passed = 0;
async function test(name, callback) { await callback(); passed++; console.log('通过 ' + name); }

await test('创作区、归档推文与长文的 Markdown 打开为发布台，评论仍排除', async () => {
  const f = fixture(), leaf = new f.Leaf();
  try {
    for (const file of [post, archived, article]) {
      await leaf.setViewState(markdown(file, { mode: 'source' }));
      assert.deepEqual(f.calls.at(-1).state, { type: deskType, state: { file, tab: 'preview' } });
    }
    for (const state of [
      markdown(comment), markdown(normal), markdown('推特创作/02素材/测试.md'),
      markdown('推特创作/03创作中/图片.png'), markdown('推特创作/03创作中其他/测试.md'),
      markdown('推特创作/04已发布/评论/测试评论.md'), markdown('推特创作/04已发布其他/测试.md'),
      { type: 'image', state: { file: post } }, { type: deskType, state: { file: post, tab: 'details' } },
      { type: 'markdown' }, { type: 'markdown', state: { file: null } },
    ]) {
      await leaf.setViewState(state);
      assert.equal(f.calls.at(-1).state, state, JSON.stringify(state));
    }
  } finally { f.opening.dispose(); }
});

await test('保留同一个 leaf、this、eState、active、group 和 pinned，原入参不变', async () => {
  const f = fixture(), leaf = new f.Leaf();
  const body = Object.freeze({ file: post, mode: 'source' });
  const state = Object.freeze({ type: 'markdown', state: body, active: true, group: 'group-1', pinned: true, custom: '保留' });
  const ephemeral = { line: 12, focus: true };
  try {
    await leaf.setViewState(state, ephemeral);
    const call = f.calls[0];
    assert.equal(call.leaf, leaf); assert.equal(call.ephemeral, ephemeral);
    assert.deepEqual(call.state, { ...state, type: deskType, state: { file: post, tab: 'preview' } });
    assert.equal(state.type, 'markdown'); assert.equal(state.state, body); assert.equal(body.mode, 'source');
    assert.deepEqual(f.saves, [leaf]);
  } finally { f.opening.dispose(); }
});

await test('其他 vault/app 的 leaf 原样透传，不执行本插件保存步骤', async () => {
  const f = fixture(), otherLeaf = new f.Leaf({}), state = markdown(post), ephemeral = {};
  try {
    await otherLeaf.setViewState(state, ephemeral);
    assert.equal(f.calls[0].leaf, otherLeaf); assert.equal(f.calls[0].state, state);
    assert.equal(f.calls[0].ephemeral, ephemeral); assert.equal(f.saves.length, 0);
  } finally { f.opening.dispose(); }
});

await test('详情打开原文后可切阅读/编辑模式，豁免只属于该 leaf 与该文件', async () => {
  const f = fixture(), sourceLeaf = new f.Leaf(), otherLeaf = new f.Leaf();
  try {
    const initial = markdown(post, { mode: 'source' });
    await f.opening.openSource(sourceLeaf, post, () => sourceLeaf.setViewState(initial));
    assert.equal(f.calls.at(-1).state, initial);
    for (const mode of ['preview', 'source']) {
      const state = markdown(post, { mode });
      await sourceLeaf.setViewState(state);
      assert.equal(f.calls.at(-1).state, state);
    }
    await otherLeaf.setViewState(markdown(post));
    assert.equal(f.calls.at(-1).state.type, deskType);
    await sourceLeaf.setViewState(markdown(nextPost));
    assert.equal(f.calls.at(-1).state.type, deskType);
    await sourceLeaf.setViewState(markdown(post));
    assert.equal(f.calls.at(-1).state.type, deskType);
  } finally { f.opening.dispose(); }
});

await test('再次点击目录会清除当前 leaf 的原文豁免', async () => {
  const f = fixture(), leaf = new f.Leaf();
  try {
    await f.opening.openSource(leaf, post, () => leaf.setViewState(markdown(post)));
    assert.equal(f.calls.at(-1).state.type, 'markdown');
    f.opening.fromDirectory(leaf);
    await leaf.setViewState(markdown(post));
    assert.equal(f.calls.at(-1).state.type, deskType);
  } finally { f.opening.dispose(); }
});

await test('原文打开失败会清理豁免，下次正常打开仍进入发布台', async () => {
  const f = fixture(), leaf = new f.Leaf(), error = new Error('原文打开失败');
  try {
    await assert.rejects(f.opening.openSource(leaf, post, async () => { throw error; }), value => value === error);
    await leaf.setViewState(markdown(post));
    assert.equal(f.calls.at(-1).state.type, deskType);
  } finally { f.opening.dispose(); }
});

await test('快速连续打开按保存→切换顺序串行，最终文件为最后一次点击', async () => {
  const saveGate = deferred(), firstSave = deferred(), nativeGate = deferred(), firstNative = deferred();
  const events = []; let saves = 0;
  const f = fixture({
    beforeChange: async () => {
      const index = ++saves; events.push(`save${index}:start`);
      if (index === 1) { firstSave.resolve(); await saveGate.promise; }
      events.push(`save${index}:end`);
    },
    native: async (_leaf, state) => {
      const file = state.state.file; events.push(`open:${file}:start`);
      if (file === post) { firstNative.resolve(); await nativeGate.promise; }
      events.push(`open:${file}:end`);
    },
  });
  const leaf = new f.Leaf();
  try {
    const pending = [post, nextPost, article].map(file => leaf.setViewState(markdown(file)));
    await firstSave.promise;
    assert.equal(f.calls.length, 0); assert.equal(saves, 1);
    saveGate.resolve(); await firstNative.promise;
    assert.equal(f.calls.length, 1); assert.equal(saves, 1);
    nativeGate.resolve(); await Promise.all(pending);
    assert.deepEqual(f.calls.map(call => call.state.state.file), [post, nextPost, article]);
    assert.ok(f.calls.every(call => call.leaf === leaf));
    assert.equal(leaf.view.file, article);
    assert.deepEqual(events, [
      'save1:start', 'save1:end', `open:${post}:start`, `open:${post}:end`,
      'save2:start', 'save2:end', `open:${nextPost}:start`, `open:${nextPost}:end`,
      'save3:start', 'save3:end', `open:${article}:start`, `open:${article}:end`,
    ]);
  } finally { saveGate.resolve(); nativeGate.resolve(); f.opening.dispose(); }
});

await test('每个 leaf 独立排队，一个 tab 保存等待不阻塞其他 tab', async () => {
  const gate = deferred(), started = deferred(); let blocked;
  const f = fixture({ beforeChange: async leaf => { if (leaf === blocked) { started.resolve(); await gate.promise; } } });
  blocked = new f.Leaf(); const independent = new f.Leaf();
  try {
    const pending = blocked.setViewState(markdown(post)); await started.promise;
    await independent.setViewState(markdown(article));
    assert.equal(f.calls.length, 1); assert.equal(f.calls[0].leaf, independent);
    gate.resolve(); await pending;
    assert.equal(f.calls[1].leaf, blocked);
  } finally { gate.resolve(); f.opening.dispose(); }
});

await test('未保存稿切到普通笔记也先保存；冲突拒绝切换且保留原稿，队列可恢复', async () => {
  let conflict = true;
  const error = new Error('正文也被修改，停止保存');
  const f = fixture({ beforeChange: async leaf => {
    if (conflict) throw error;
    leaf.view.dirty = false;
  } });
  const leaf = new f.Leaf();
  leaf.view = { app: f.app, type: deskType, file: post, dirty: true, body: '未保存的新改动' };
  const originalView = leaf.view, state = markdown(normal);
  try {
    await assert.rejects(leaf.setViewState(state), value => value === error);
    assert.equal(f.calls.length, 0); assert.equal(leaf.view, originalView);
    assert.equal(leaf.view.body, '未保存的新改动'); assert.equal(leaf.view.dirty, true);
    conflict = false;
    await leaf.setViewState(state);
    assert.equal(originalView.dirty, false); assert.equal(f.calls[0].state, state);
    assert.equal(leaf.view.file, normal);
  } finally { f.opening.dispose(); }
});

await test('卸载恢复原方法，被持有的旧 wrapper 也原样透传', async () => {
  const f = fixture(), leaf = new f.Leaf(), oldWrapper = f.Leaf.prototype.setViewState;
  f.opening.dispose();
  assert.equal(f.Leaf.prototype.setViewState, f.original);
  const state = markdown(post), ephemeral = {};
  await leaf.setViewState(state, ephemeral);
  await oldWrapper.call(leaf, state, ephemeral);
  assert.equal(f.calls.length, 2); assert.ok(f.calls.every(call => call.state === state && call.ephemeral === ephemeral));
  assert.equal(f.saves.length, 0);
});

await test('卸载不覆盖后装插件 wrapper；后装 wrapper 内的本插件变为透传', async () => {
  const f = fixture(), leaf = new f.Leaf(), inner = f.Leaf.prototype.setViewState;
  let laterCalls = 0;
  function later(state, ephemeral) { laterCalls++; return inner.call(this, state, ephemeral); }
  f.Leaf.prototype.setViewState = later;
  f.opening.dispose();
  assert.equal(f.Leaf.prototype.setViewState, later);
  const state = markdown(post), ephemeral = {};
  await leaf.setViewState(state, ephemeral);
  assert.equal(laterCalls, 1); assert.equal(f.calls[0].state, state); assert.equal(f.calls[0].ephemeral, ephemeral);
  assert.equal(f.saves.length, 0);
});

await test('卸载时排队但尚未执行的打开直接透传，不继续保存或自动路由', async () => {
  const f = fixture(), leaf = new f.Leaf(), state = markdown(post);
  const pending = leaf.setViewState(state);
  f.opening.dispose();
  await pending;
  assert.equal(f.calls[0].state, state); assert.equal(f.saves.length, 0);
});

console.log(`自动打开离线测试通过：${passed} 项；未访问真实笔记、UI 或上传后端。`);
