import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { mkdir } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { build } from 'esbuild';

// All filesystem/process/Obsidian operations in the tested backend are stubs.
// The harness only writes its generated bundle under the project work folder.
const project = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const temporary = path.join(project, 'work', 'tests');
await mkdir(temporary, { recursive: true });
const test = globalThis.__deliveryBackendTest = { files: new Map(), children: [], notices: [] };
test.spawn = (_command, args, options) => {
  const child = new EventEmitter(); child.stdout = new EventEmitter(); child.stderr = new EventEmitter();
  child.request = JSON.parse(test.files.get(args.at(-1)));
  child.environment = options.env;
  test.children.push(child); return child;
};
const output = path.join(temporary, 'delivery-backend.cjs');
await build({ entryPoints: [path.join(project, 'src', 'backend.ts')], outfile: output,
  bundle: true, platform: 'node', format: 'cjs', logLevel: 'silent', plugins: [{
    name: 'offline-backend', setup(builder) {
      builder.onResolve({ filter: /^(obsidian|child_process|fs)$/ }, args => ({ path: args.path, namespace: 'offline' }));
      builder.onLoad({ filter: /.*/, namespace: 'offline' }, args => ({ loader: 'js', contents: args.path === 'obsidian' ? `
        export class Notice { constructor(text) { globalThis.__deliveryBackendTest.notices.push(text); } }
        export class TFile { constructor(path) { this.path=path;this.extension='md'; } }
        export class MarkdownView { constructor(file,text){this.file=file;this.editor={getValue:()=>text};}getMode(){return 'source';} }
        export class FileSystemAdapter { getBasePath(){return '/offline-vault';} }
        export class App {}
        globalThis.__deliveryBackendTest.Adapter=FileSystemAdapter;
        globalThis.__deliveryBackendTest.File=TFile;
        globalThis.__deliveryBackendTest.Markdown=MarkdownView;
      ` : args.path === 'child_process' ? `export function spawn(...args){return globalThis.__deliveryBackendTest.spawn(...args);}` : `
        export function mkdirSync() {}
        export function writeFileSync(path,text) { globalThis.__deliveryBackendTest.files.set(path,text); }
        export function readFileSync(path) { if(!globalThis.__deliveryBackendTest.files.has(path))throw Error('回执不存在');return globalThis.__deliveryBackendTest.files.get(path); }
        export function renameSync(from,to) { const files=globalThis.__deliveryBackendTest.files;files.set(to,files.get(from));files.delete(from); }
        export function existsSync(path) { return path.endsWith('delivery_runner.py') || globalThis.__deliveryBackendTest.files.has(path); }
        export function unlinkSync(path) { globalThis.__deliveryBackendTest.files.delete(path); }
      ` }));
    },
  }] });
const { default: module } = await import(pathToFileURL(output).href);
const { Backend, backendEnvironment } = module;
const loginPath = process.env.PATH;
try {
  process.env.PATH = '/usr/bin:/bin';
  assert.equal(backendEnvironment().PATH.split(':')[0], path.join(os.homedir(), '.local/node/bin'));
} finally { process.env.PATH = loginPath; }
const markdown = '---\ndelivery_ready: true\n---\n## 正文\n离线稿件';
const settle = async () => { for (let count = 0; count < 4; count++) await new Promise(resolve => setImmediate(resolve)); };
const options = () => ({ action: 'publish', expectedMarkdown: markdown, confirmed: true });
function fixture(read = async () => markdown, leaves = [], renameError) {
  const file = new test.File('推特创作/03创作中/离线稿件.md');
  const app = { vault: { adapter: new test.Adapter(), read,
    getAbstractFileByPath: value => value === '推特创作/04已发布' ? {children:[]} : value === file.path ? file : null,
    createFolder: async () => {},
  }, workspace: { getLeavesOfType: () => leaves }, fileManager: { renameFile: async (target, nextPath) => {
    if(renameError)throw Error(renameError);target.path=nextPath;
  } } };
  return { file, backend: new Backend(app) };
}
function finish(result, code = 0, child = test.children.at(-1)) {
  if (result !== undefined) child.stdout.emit('data', Buffer.from(JSON.stringify(result) + '\n'));
  child.emit('close', code);
}

let fixtureValue = fixture(), count = test.children.length;
let result = await fixtureValue.backend.deliver(fixtureValue.file, () => {}, 'post', { ...options(), confirmed: false });
assert.equal(result.verified, false);
assert.equal(test.children.length, count, '未确认绝不启动发布程序');
result = await fixtureValue.backend.deliver(fixtureValue.file, () => {}, 'post', { ...options(), expectedMarkdown: '另一个版本' });
assert.equal(result.verified, false);
assert.equal(test.children.length, count, '确认快照不匹配时绝不启动');

let releaseRead;
function deferFirstRead() { let first=true;return () => { if(!first)return Promise.resolve(markdown);first=false;return new Promise(resolve=>{releaseRead=resolve;}); }; }
fixtureValue = fixture(deferFirstRead());
const frozen = options();
let pending = fixtureValue.backend.deliver(fixtureValue.file, () => {}, 'post', frozen);
assert.equal(fixtureValue.backend.busy, true, '共享忙态在第一次await之前获得');
frozen.action = 'schedule'; frozen.expectedMarkdown = '异步期间替换的正文';
frozen.scheduledFor = '2030-10-01T12:00:00Z'; frozen.timeZone = 'Asia/Shanghai';
releaseRead(markdown); await settle();
assert.equal(test.children.at(-1).request.action, 'publish', 'Backend冻结确认时的操作');
assert.equal(test.children.at(-1).request.markdown, markdown, 'Backend冻结确认时的正文');
assert.equal(test.children.at(-1).environment.PATH.split(':')[0], path.join(os.homedir(), '.local/node/bin'), '真实子进程配置包含本机Node目录');
finish({ verified: true, state: 'published', commit_sent: true }); await pending;
assert.ok(fixtureValue.backend.hasDeliveryAttempt(fixtureValue.file.path, markdown));
assert.equal(fixtureValue.file.path, '推特创作/04已发布/离线稿件.md');
assert.equal(fixtureValue.backend.archivedDelivery(fixtureValue.file, markdown).state, 'published');

count = test.children.length;
fixtureValue = fixture(deferFirstRead());
pending = fixtureValue.backend.deliver(fixtureValue.file, () => {}, 'post', options());
fixtureValue.file.path = '推特创作/03创作中/改名后的稿件.md'; releaseRead(markdown);
result = await pending;
assert.ok(result.error.includes('路径已变化'));
assert.equal(test.children.length, count, '异步读取期间路径变化不能错发另一稿件');

fixtureValue = fixture();
const busy = [];
fixtureValue.backend.onBusyChange(() => busy.push(fixtureValue.backend.busy));
pending = fixtureValue.backend.deliver(fixtureValue.file, () => {}, 'post', options()); await settle();
count = test.children.length;
result = await fixtureValue.backend.deliver(fixtureValue.file, () => {}, 'post', options());
assert.equal(test.children.length, count, '另一个视图的双击请求不能产生第二个进程');
assert.ok(result.error.includes('正在执行'));
finish({ verified: true, state: 'published', commit_sent: true }); await pending;
assert.deepEqual(busy, [true, false]);
assert.equal(fixtureValue.backend.busy, false);

fixtureValue = fixture();
pending = fixtureValue.backend.deliver(fixtureValue.file, () => {}, 'post', options()); await settle();
finish({ verified: false, state: 'failed', commit_sent: true, error: '响应未核验' }, 1);
result = await pending;
assert.equal(result.uncertain, true, '已发送但未核验不能提示安全重试');
assert.equal(fixtureValue.file.path, '推特创作/03创作中/离线稿件.md', '未核验不归档');
assert.ok(fixtureValue.backend.hasDeliveryAttempt(fixtureValue.file.path, markdown));
count = test.children.length;
result = await fixtureValue.backend.deliver(fixtureValue.file, () => {}, 'post', options());
assert.equal(result.uncertain, true);
assert.equal(test.children.length, count, '未知版本跨视图共享锁阻止二次启动');

fixtureValue = fixture();
pending = fixtureValue.backend.deliver(fixtureValue.file, () => {}, 'post', options()); await settle();
finish({ verified: false, state: 'unsupported', commit_sent: false, retry_allowed: true, error: 'X未支持' }, 1);
result = await pending;
assert.notEqual(result.uncertain, true, '明确未发送的拒绝可安全重试');
assert.equal(fixtureValue.backend.hasDeliveryAttempt(fixtureValue.file.path, markdown), false);
count = test.children.length;
pending = fixtureValue.backend.deliver(fixtureValue.file, () => {}, 'post', options()); await settle();
assert.equal(test.children.length, count + 1);
finish({ verified: true, state: 'published', commit_sent: true }); await pending;

fixtureValue = fixture();
pending = fixtureValue.backend.deliver(fixtureValue.file, () => {}, 'post', options()); await settle();
finish(undefined, 1);
result = await pending;
assert.equal(result.uncertain, true, '进程丢失回执按未知处理');
assert.ok(fixtureValue.backend.hasDeliveryAttempt(fixtureValue.file.path, markdown));

fixtureValue = fixture();
pending = fixtureValue.backend.deliver(fixtureValue.file, () => {}, 'post', options()); await settle();
finish({ verified: false, state: 'failed', error: '这条正文已按另一个时间定时，请先在 X 修改或取消原定时，避免重复发送' }, 1);
result = await pending;
assert.equal(result.uncertain, true, '已存在另一时间排期不能重新开启发布按钮');

fixtureValue = fixture(async () => markdown, [], '模拟移动失败');
pending = fixtureValue.backend.deliver(fixtureValue.file, () => {}, 'post', options()); await settle();
finish({verified:true,state:'published',commit_sent:true,url:'https://x.com/zwzw3888/status/123'});
result = await pending;
assert.equal(result.verified,true,'归档失败保留远程发布成功');
assert.equal(result.uncertain,undefined,'本地移动失败不能变成远程结果未知');
assert.equal(result.archive_error,'模拟移动失败');
assert.equal(fixtureValue.file.path,'推特创作/03创作中/离线稿件.md');
count=test.children.length;
await fixtureValue.backend.deliver(fixtureValue.file,()=>{},'post',options());
assert.equal(test.children.length,count,'归档失败的已发布版本不能重新提交');

fixtureValue = fixture();
const due=new Date(Date.now()+3600000).toISOString();
pending = fixtureValue.backend.deliver(fixtureValue.file,()=>{},'post',{...options(),action:'schedule',scheduledFor:due,timeZone:'Asia/Shanghai'});await settle();
finish({verified:true,state:'scheduled',commit_sent:true,scheduled_for:due});
result=await pending;
assert.equal(result.archived_path,'推特创作/04已发布/离线稿件.md');
assert.equal(result.time_zone,'Asia/Shanghai');
assert.equal(fixtureValue.backend.archivedDelivery(fixtureValue.file,markdown).scheduled_for,due);
assert.equal(fixtureValue.backend.archivedDelivery(fixtureValue.file,markdown+'修改'),undefined,'不同内容不能冒用归档回执');

console.log('通过：Backend提交保护，已发布/已排期自动归档，未知不移动，移动失败保留成功且禁止重发，归档回执持久恢复');
