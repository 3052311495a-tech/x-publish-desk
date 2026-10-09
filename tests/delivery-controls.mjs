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
    this.disabled = false; this.hidden = false; this.value = ''; this.style = {}; this.attributes = { ...options.attr }; this.scrollTop = 0;
  }
  get id() { return this.attributes.id || ''; }
  setAttribute(name, value) { this.attributes[name] = String(value); }
  getAttribute(name) { return this.attributes[name] ?? null; }
  focus() { this.focused = true; }
  scrollTo({ top }) { this.scrollTop = top; }
  get textContent() { return this._text + this.children.map(child => child.textContent).join(''); }
  set textContent(value) { this._text = value || ''; this.children = []; }
  setText(text) { this.textContent = text; }
  empty() { this.children = []; this._text = ''; }
  createEl(tag, options) { const element = new TestElement(tag, options); this.children.push(element); element.parent = this; return element; }
  createDiv(options) { return this.createEl('div', options); }
  createSpan(options) { return this.createEl('span', options); }
  remove() { if (this.parent) this.parent.children = this.parent.children.filter(child => child !== this); }
  querySelectorAll(tag) { return this.children.flatMap(child => [...(child.tag === tag ? [child] : []), ...child.querySelectorAll(tag)]); }
}
globalThis.__deliveryTest = { element: () => new TestElement(), modals: [], notices: [] };
const stub = `
const test = globalThis.__deliveryTest;
export class TFile {}
export class Notice { constructor(text) { test.notices.push(text); } }
export class Modal {
  constructor(app) { this.app=app;this.contentEl=test.element();this.titleEl=test.element(); }
  open() { test.modals.push(this);this.onOpen(); }
  close() { this.onClose(); }
}
export class Setting {
  constructor(host) { this.host=host;this.settingEl=host.createDiv(); }
  setName(text) { this.settingEl.createSpan({text});return this; }
  setDesc(text) { this.settingEl.createSpan({text});return this; }
  addButton(cb) {
    const buttonEl=this.settingEl.createEl('button');
    const component={buttonEl,setCta(){return this;},setButtonText(text){buttonEl.setText(text);return this;},onClick(fn){buttonEl.onclick=fn;return this;}};
    cb(component);return this;
  }
  addText(cb) {
    const inputEl=this.settingEl.createEl('input');
    const component={inputEl,setValue(value){inputEl.value=value;return this;},onChange(fn){inputEl.onchange=fn;return this;}};
    cb(component);return this;
  }
  addDropdown(cb) {
    const inputEl=this.settingEl.createEl('select');
    const component={inputEl,addOption(){return this;},setValue(value){inputEl.value=value;return this;},onChange(fn){inputEl.onchange=fn;return this;}};
    cb(component);return this;
  }
}`;
const output = path.join(temporary, 'delivery-controls.cjs');
await build({ entryPoints: [path.join(project, 'src', 'delivery-controls.ts')], outfile: output,
  bundle: true, platform: 'node', format: 'cjs', logLevel: 'silent', plugins: [{
    name: 'offline-obsidian', setup(build) {
      build.onResolve({ filter: /^obsidian$/ }, () => ({ path: 'obsidian', namespace: 'offline' }));
      build.onLoad({ filter: /.*/, namespace: 'offline' }, () => ({ contents: stub, loader: 'js' }));
    },
  }] });
const { default: module } = await import(pathToFileURL(output).href);
const settle = async () => { for (let count = 0; count < 4; count++) await new Promise(resolve => setImmediate(resolve)); };
const markdown = text => `---\ntitle: 确认测试\ndelivery_ready: true\n---\n## 正文\n${text}\n\n## 备选\n不发布这段`;

function mount(text = '**确认内容**', kind = 'post', response = { verified: true, url: 'https://x.com/zwzw3888/status/123' }, extra = {}) {
  let current = markdown(text);
  const calls = [], busy = [];
  const bar = new TestElement(), host = new TestElement();
  const file = extra.file || { path: '推特创作/03创作中/测试.md', basename: '测试' };
  const app = { vault: { read: async () => current }, metadataCache: {} };
  const attempts = new Set();
  const backend = extra.backend || { busy: false,
    hasDeliveryAttempt: (path, markdown) => attempts.has(path + '\0' + markdown),
    deliver: async (...args) => {
      calls.push(args); args[1]('回读核对中');
      if (response?.verified || response?.uncertain || response?.commit_sent === true) attempts.add(args[0].path + '\0' + args[3].expectedMarkdown);
      return response;
    },
  };
  const handle = module.mountDeliveryControls({ app, bar, host, file, kind, flush: extra.flush || (async () => {}),
    snapshotFingerprint: () => current, onBusyChange: value => busy.push(value), backend,onComplete:extra.onComplete,
  });
  return { handle, bar, host, calls, busy, backend, file, setMarkdown(value) { current = markdown(value); }, getMarkdown: () => current };
}

const timeWheels = modal => modal.contentEl.querySelectorAll('div').filter(element => element.getAttribute('role') === 'listbox');
const timeWheel = (modal, label) => timeWheels(modal).find(element => element.getAttribute('aria-label') === label);
const selectedTime = modal => timeWheels(modal).map(wheel => wheel.children.find(item => item.getAttribute('aria-selected') === 'true').textContent);
function chooseTime(modal, label, value) {
  const option = timeWheel(modal, label).children.find(item => Number(item.textContent) === value);
  assert.ok(option, `${label}列应可选择 ${value}`);
  option.onclick();
}
function scrollTime(modal, label, value, dispatch = true) {
  const wheel = timeWheel(modal, label);
  const index = wheel.children.findIndex(item => Number(item.textContent) === value);
  assert.ok(index >= 0, `${label}列应可滚动到 ${value}`);
  wheel.scrollTop = index * 36;
  if (dispatch) wheel.onscroll();
}
function chooseDate(modal, year, month, day) {
  chooseTime(modal, '年', year); chooseTime(modal, '月', month); chooseTime(modal, '日', day);
}
const scheduleConfirm = modal => modal.contentEl.querySelectorAll('button').find(button => button.textContent === '确认定时发布');
const dueSummary = modal => modal.contentEl.querySelectorAll('p').find(element => element.className === 'xpd-time-summary').textContent;

const unopened = mount();
assert.equal(unopened.calls.length, 0, '挂载组件不发帖');
assert.equal(unopened.bar.querySelectorAll('button').map(button => button.textContent).join('|'), '直接发布|定时发布');
await unopened.bar.querySelectorAll('button')[0].onclick(); await settle();
assert.equal(unopened.calls.length, 0, '打开确认 Modal 不发帖');
let modal = globalThis.__deliveryTest.modals.at(-1);
assert.ok(modal.contentEl.textContent.includes('未设置账号'));
assert.equal(modal.contentEl.querySelectorAll('textarea')[0].value, '**确认内容**');
assert.ok(!modal.contentEl.querySelectorAll('textarea')[0].value.includes('不发布这段'));
modal.contentEl.querySelectorAll('button').find(button => button.textContent === '确认公开发布').onclick(); await settle();
assert.equal(unopened.calls.length, 1);
assert.equal(unopened.calls[0][3].confirmed, true);
assert.equal(unopened.calls[0][3].expectedMarkdown, unopened.getMarkdown());
assert.equal(unopened.calls[0][3].action, 'publish');
assert.deepEqual(unopened.busy, [true, false]);
assert.ok(unopened.host.textContent.includes('已公开发布'));
assert.ok(unopened.bar.querySelectorAll('button').every(button => button.disabled), '已完成版本避免重复点发');

const changed = mount('确认前版本');
changed.bar.querySelectorAll('button')[0].onclick(); await settle();
modal = globalThis.__deliveryTest.modals.at(-1);
changed.setMarkdown('确认期间已改');
modal.contentEl.querySelectorAll('button').find(button => button.textContent === '确认公开发布').onclick(); await settle();
assert.equal(changed.calls.length, 0, '确认期间修改正文，不能发布未review的新版本');
assert.ok(modal.contentEl.textContent.includes('正文已变化'));
assert.ok(modal.contentEl.querySelectorAll('button').find(button => button.textContent === '确认公开发布').disabled);
modal.close();
changed.bar.querySelectorAll('button')[0].onclick(); await settle();
modal = globalThis.__deliveryTest.modals.at(-1);
assert.equal(modal.contentEl.querySelectorAll('textarea')[0].value, '确认期间已改');
modal.close();

const uncertain = mount('回执不明', 'post', { verified: false, uncertain: true, error: '提交后结果尚未确认' });
uncertain.bar.querySelectorAll('button')[0].onclick(); await settle();
modal = globalThis.__deliveryTest.modals.at(-1);
modal.contentEl.querySelectorAll('button').find(button => button.textContent === '确认公开发布').onclick(); await settle();
assert.equal(uncertain.calls.length, 1);
assert.ok(uncertain.host.textContent.includes('避免重复发布'));
assert.ok(!uncertain.host.textContent.includes('重试'));
assert.ok(uncertain.bar.querySelectorAll('button').every(button => button.disabled));
uncertain.handle.dispose();
const uncertainRemount = mount('回执不明', 'post', undefined, { backend: uncertain.backend });
assert.ok(uncertainRemount.bar.querySelectorAll('button').every(button => button.disabled), '未知版本跨标签重建和视图继续锁住');
uncertainRemount.bar.querySelectorAll('button')[0].onclick(); await settle();
assert.equal(uncertain.calls.length, 1, '重新挂载也不会重新提交未知版本');

const sentUnknown = mount('已经发送但没核验', 'post', { verified: false, state: 'failed', commit_sent: true });
sentUnknown.bar.querySelectorAll('button')[0].onclick(); await settle();
modal = globalThis.__deliveryTest.modals.at(-1);
modal.contentEl.querySelectorAll('button').find(button => button.textContent === '确认公开发布').onclick(); await settle();
assert.ok(sentUnknown.host.textContent.includes('避免重复发布'), 'commit_sent=true 单独就足以阻止重试');
assert.ok(sentUnknown.bar.querySelectorAll('button').every(button => button.disabled));

const double = mount('双击确认');
double.bar.querySelectorAll('button')[0].onclick(); await settle();
modal = globalThis.__deliveryTest.modals.at(-1);
const confirmTwice = modal.contentEl.querySelectorAll('button').find(button => button.textContent === '确认公开发布').onclick;
confirmTwice(); confirmTwice(); await settle();
assert.equal(double.calls.length, 1, '同一确认按钮连续双击只提交一次');

let releaseSwitch, switchFlushCount = 0;
const switched = mount('切换前稿件', 'post', undefined, { flush: async () => {
  if (++switchFlushCount === 2) await new Promise(resolve => { releaseSwitch = resolve; });
} });
switched.bar.querySelectorAll('button')[0].onclick(); await settle();
modal = globalThis.__deliveryTest.modals.at(-1);
modal.contentEl.querySelectorAll('button').find(button => button.textContent === '确认公开发布').onclick(); await settle();
switched.handle.dispose(); releaseSwitch(); await settle();
assert.equal(switched.calls.length, 0, '异步保存期间切换或关闭视图，旧确认不得继续发布');

let releaseBusy, busyFlushCount = 0;
const busyDuringConfirm = mount('另一视图先开始', 'post', undefined, { flush: async () => {
  if (++busyFlushCount === 2) await new Promise(resolve => { releaseBusy = resolve; });
} });
busyDuringConfirm.bar.querySelectorAll('button')[0].onclick(); await settle();
modal = globalThis.__deliveryTest.modals.at(-1);
modal.contentEl.querySelectorAll('button').find(button => button.textContent === '确认公开发布').onclick(); await settle();
busyDuringConfirm.backend.busy = true; releaseBusy(); await settle();
assert.equal(busyDuringConfirm.calls.length, 0, '异步保存后必须再次检查跨视图忙态');
assert.ok(modal.contentEl.textContent.includes('已有操作正在执行'));
modal.close();

const scheduled = mount('普通长推'.repeat(60), 'post', { verified: true, mode: 'native', dueAt: '2028-09-30T01:30:00Z' });
assert.ok(scheduled.bar.querySelectorAll('button').every(button => !button.disabled), '超过280加权字符也可直接发布或定时');
scheduled.bar.querySelectorAll('button')[1].onclick(); await settle();
modal = globalThis.__deliveryTest.modals.at(-1);
const zone = modal.contentEl.querySelectorAll('select')[0];
assert.equal(zone.value, 'America/Los_Angeles');
assert.deepEqual(timeWheels(modal).map(wheel => wheel.getAttribute('aria-label')), ['年', '月', '日', '时', '分']);
assert.equal(timeWheel(modal, '年').children.length, 50, '年份只展示从今年起的 50 年');
assert.equal(Number(timeWheel(modal, '年').children[0].textContent), new Date().getFullYear());
assert.equal(Number(timeWheel(modal, '年').children.at(-1).textContent), new Date().getFullYear() + 49);
assert.equal(modal.contentEl.querySelectorAll('input').length, 0, '定时时间使用滚轮选择');
chooseDate(modal, 2028, 9, 30); scrollTime(modal, '时', 9); scrollTime(modal, '分', 30);
assert.equal(dueSummary(modal), '2028-09-30 09:30 · America/Los_Angeles');
const wallTimeBeforeZoneChange = selectedTime(modal);
zone.onchange('Asia/Shanghai');
assert.deepEqual(selectedTime(modal), wallTimeBeforeZoneChange, '切换时区保留滚轮上的日期时间');
assert.equal(dueSummary(modal), '2028-09-30 09:30 · Asia/Shanghai');
scheduleConfirm(modal).onclick(); await settle();
assert.equal(scheduled.calls[0][3].scheduledFor, '2028-09-30T01:30:00.000Z');
assert.equal(scheduled.calls[0][3].timeZone, 'Asia/Shanghai');
assert.equal(scheduled.calls[0][3].action, 'schedule');
assert.ok(scheduled.host.textContent.includes('X 原生定时'));

const scrolling = mount('刚滚动完立即确认', 'post', { verified: true, action: 'schedule', mode: 'native' });
scrolling.bar.querySelectorAll('button')[1].onclick(); await settle();
modal = globalThis.__deliveryTest.modals.at(-1);
modal.contentEl.querySelectorAll('select')[0].onchange('Asia/Shanghai');
chooseDate(modal, 2028, 9, 30); chooseTime(modal, '时', 9); chooseTime(modal, '分', 10);
// Browser scroll events may arrive after the user clicks confirm. Read the actual
// scroll positions again before submitting, including both hour and minute.
scrollTime(modal, '时', 16, false); scrollTime(modal, '分', 45, false);
scheduleConfirm(modal).onclick(); await settle();
assert.equal(scrolling.calls.length, 1);
assert.equal(scrolling.calls[0][3].scheduledFor, '2028-09-30T08:45:00.000Z', '确认前须收敛尚未触发 scroll 事件的滚轮值');

const monthEnd = mount('月底日期选择');
monthEnd.bar.querySelectorAll('button')[1].onclick(); await settle();
modal = globalThis.__deliveryTest.modals.at(-1);
chooseDate(modal, 2028, 1, 31); chooseTime(modal, '月', 2);
assert.equal(timeWheel(modal, '日').children.length, 29, '闰年二月包含 29 日');
assert.equal(selectedTime(modal)[2], '29', '31 日切换到闰年二月自动收敛为 29 日');
chooseTime(modal, '年', 2029);
assert.equal(timeWheel(modal, '日').children.length, 28, '平年二月只包含 28 日');
assert.equal(selectedTime(modal)[2], '28', '闰年切换到平年自动收敛为 28 日');
chooseDate(modal, 2029, 3, 31); scrollTime(modal, '月', 4);
assert.equal(timeWheel(modal, '日').children.length, 30);
assert.equal(selectedTime(modal)[2], '30', '大月切换到小月自动收敛为 30 日');
assert.equal(scheduleConfirm(modal).disabled, false);
assert.equal(monthEnd.calls.length, 0, '选择时间不会自动提交');
modal.close();

const pastTime = mount('过去时间不可提交');
pastTime.bar.querySelectorAll('button')[1].onclick(); await settle();
modal = globalThis.__deliveryTest.modals.at(-1);
chooseDate(modal, new Date().getFullYear(), 1, 1); chooseTime(modal, '时', 0); chooseTime(modal, '分', 0);
modal.contentEl.querySelectorAll('select')[0].onchange('Asia/Shanghai');
assert.ok(modal.contentEl.textContent.includes('发布时间必须晚于现在'));
assert.equal(dueSummary(modal), '', '无效时间不能继续显示上一次有效预览');
assert.equal(scheduleConfirm(modal).disabled, true, '滚轮选择过去日期时禁用确认');
scheduleConfirm(modal).onclick(); await settle();
assert.equal(pastTime.calls.length, 0, '即使触发确认回调也不能提交过去日期');
modal.close();

const article = mount('长文', 'article');
assert.equal(article.bar.querySelectorAll('button').length, 0);
const archived = mount('归档稿', 'post', undefined, { file: { path: '推特创作/04已发布/归档稿.md', basename: '归档稿' } });
assert.equal(archived.bar.querySelectorAll('button').length, 0, '归档笔记不挂发布或定时操作');

let moved, callbackCount = 0;
moved = mount('移动后仍成功', 'post', { verified: true, action: 'publish', archived_path: '推特创作/04已发布/移动后仍成功.md' }, {
  onComplete: result => {
    callbackCount++;
    assert.equal(moved.busy.at(-1), false, '归档回调必须在恢复忙态后运行');
    assert.ok(moved.host.textContent.includes('已公开发布'));
    assert.equal(result.archived_path, '推特创作/04已发布/移动后仍成功.md');
  },
});
moved.bar.querySelectorAll('button')[0].onclick(); await settle();
modal = globalThis.__deliveryTest.modals.at(-1);
modal.contentEl.querySelectorAll('button').find(button => button.textContent === '确认公开发布').onclick(); await settle();
assert.equal(callbackCount, 1);
assert.ok(moved.host.textContent.includes('笔记已归档'));

const archiveFailed = mount('提交成功归档失败', 'post', { verified: true, action: 'publish', archive_error: '同名笔记已存在' }, {
  onComplete: () => { throw Error('离线模拟页面刷新失败'); },
});
archiveFailed.bar.querySelectorAll('button')[0].onclick(); await settle();
modal = globalThis.__deliveryTest.modals.at(-1);
modal.contentEl.querySelectorAll('button').find(button => button.textContent === '确认公开发布').onclick(); await settle();
assert.ok(archiveFailed.host.textContent.includes('已公开发布'));
assert.ok(archiveFailed.host.textContent.includes('提交已成功，笔记归档未完成'));
assert.ok(!archiveFailed.host.textContent.includes('结果尚未确认'), '本地归档或重绘失败不会降级公开成功');
assert.ok(archiveFailed.bar.querySelectorAll('button').every(button => button.disabled));
assert.ok(globalThis.__deliveryTest.notices.some(text=>text.includes('发布回执已保留')));

const archivedScheduleHost = new TestElement();
module.renderDeliveryResult(archivedScheduleHost, { verified:true,state:'scheduled',action:'schedule',account:'zwzw3888',mode:'native',scheduled_for:'2026-01-01T01:30:00Z',time_zone:'Asia/Shanghai',archived_path:'推特创作/04已发布/排期.md' });
assert.ok(archivedScheduleHost.textContent.includes('已排期待发布'), '到期时刻不能自行冒充公开成功');
assert.ok(archivedScheduleHost.textContent.includes('2026-01-01 09:30 · Asia/Shanghai'));
assert.ok(!archivedScheduleHost.textContent.includes('已公开发布'));
assert.equal(module.deliveryStateLabel(), '已归档');
assert.equal(module.deliveryStateLabel({verified:false,state:'scheduled'}), '已归档');
assert.equal(module.deliveryStateLabel({verified:true,state:'scheduled'}), '已排期待发布');
assert.equal(module.deliveryStateLabel({verified:true,state:'published',action:'schedule'}), '已公开发布');
assert.equal(module.deliveryStateLabel({verified:true,state:'published',format_differences:['加粗被 X 丢了，线上是普通字']}), '已公开发布 · 加粗被 X 丢了，线上是普通字');
const limit = mount('A'.repeat(25_001));
assert.ok(limit.bar.querySelectorAll('button').every(button => button.disabled));
assert.ok(limit.bar.textContent.includes('25,000'));
const disposed = mount(); disposed.handle.dispose();
assert.equal(disposed.bar.querySelectorAll('button').length, 0);
console.log('通过：离线 Modal 确认、快照变化阻断、双击防重、保存期间切换/跨视图忙态、未知回执跨视图锁、公开结果、定时滚轮及时区、月末/闰年日期、滚动立即确认、过去时间阻断和长推支持');
