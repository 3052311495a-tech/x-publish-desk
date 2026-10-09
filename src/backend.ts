import { App, FileSystemAdapter, MarkdownView, Notice, TFile } from 'obsidian';
import { spawn } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import * as crypto from 'crypto';
import * as os from 'os';

/** Desktop launches lack the login shell's PATH. Use the installed local tools. */
export function backendEnvironment(): NodeJS.ProcessEnv {
  return { ...process.env, PATH: [path.join(os.homedir(), '.local/node/bin'),
    path.join(os.homedir(), '.local/bin'), '/opt/homebrew/bin', '/usr/local/bin',
    '/usr/bin', '/bin', process.env.PATH || ''].join(':') };
}
import { deliveryReceiptUncertain } from './delivery-receipt';
import { archiveVerifiedDelivery, readArchivedDelivery } from './delivery-archive';
import { archiveReceipts, config, folderName, folderPrefix, isExcluded, pythonPath } from './config';

/** Existing, independently maintained upload backend. Its protocol is unchanged. */
export type UploadKind = 'post' | 'article';
export type StatusCallback = (status: string) => void;

export interface DeliveryRequestOptions {
  action: 'publish' | 'schedule';
  scheduledFor?: string;
  timeZone?: string;
  expectedMarkdown: string;
  confirmed: true;
}

export interface UploadResult {
  verified: boolean;
  already_exists?: boolean;
  draft_url?: string;
  cover_missing?: boolean;
  error?: string;
  [key: string]: unknown;
}

export interface LearningResult {
  status?: string;
  kind?: string;
  error?: string;
  [key: string]: unknown;
}

export function isEligibleFile(file: TFile | null | undefined): file is TFile {
  return Boolean(file?.extension === 'md'
    && (file.path.startsWith(folderPrefix('drafts')) || file.path.startsWith(folderPrefix('articles')))
    && !isExcluded(file.path));
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export class Backend {
  private operationBusy = false;
  private deliveryAttempts = new Set<string>();
  /** This survives view replacement and is shared by all publishing views.
   * The durable Python ledger remains authoritative across plugin restarts. */
  hasDeliveryAttempt(notePath: string, markdown: string): boolean {
    return this.deliveryAttempts.has(notePath + '\0' + markdown);
  }
  private busyListeners = new Set<() => void>();
  get busy(): boolean { return this.operationBusy; }
  set busy(value: boolean) {
    if (this.operationBusy === value) return;
    this.operationBusy = value;
    for (const callback of this.busyListeners) { try { callback(); } catch { /* A closed view must not interrupt a delivery. */ } }
  }
  onBusyChange(callback: () => void): () => void {
    this.busyListeners.add(callback);
    return () => this.busyListeners.delete(callback);
  }
  learningBusy = false;
  lastStatus = '';
  lastResult: UploadResult | undefined;
  lastLearningResult: LearningResult | undefined;

  constructor(readonly app: App) {}

  archivedDelivery(file: TFile, markdown: string): UploadResult | undefined {
    return readArchivedDelivery(file, markdown);
  }

  private vaultRoot(): string {
    const adapter = this.app.vault.adapter;
    if (!(adapter instanceof FileSystemAdapter)) {
      throw new Error('X 草稿功能需要本机文件仓库');
    }
    return adapter.getBasePath();
  }

  private ensureSaved(file: TFile, markdown: string, message: string): void {
    for (const leaf of this.app.workspace.getLeavesOfType('markdown')) {
      const view = leaf.view;
      if (view instanceof MarkdownView && view.file?.path === file.path
        && view.getMode() === 'source' && view.editor.getValue() !== markdown) {
        throw new Error(message);
      }
    }
  }

  async recordRevision(file: TFile | null): Promise<LearningResult | undefined> {
    if (this.learningBusy) {
      new Notice('正在记录改稿，请稍候');
      return;
    }
    if (!isEligibleFile(file)) {
      new Notice('请打开一篇待发布推文，再记录你的改稿');
      return;
    }
    this.learningBusy = true;
    try {
      const markdown = await this.app.vault.read(file);
      this.ensureSaved(file, markdown, '修改尚未保存，请稍后再点');
      const base = this.vaultRoot();
      const digest = crypto.createHash('sha256').update(markdown, 'utf8').digest('hex');
      const result = await new Promise<LearningResult>((resolve, reject) => {
        const child = spawn(pythonPath(), [
          config.revision_learning, 'confirm', '--root', path.join(base, path.posix.dirname(config.drafts)),
          '--draft', path.join(base, file.path), '--expected-sha256', digest,
        ], { cwd: config.backendDir, shell: false });
        let output = '';
        child.stdout.on('data', (chunk: Buffer) => { output += chunk.toString(); });
        child.stderr.on('data', () => {});
        child.on('error', reject);
        child.on('close', code => {
          try {
            const value = JSON.parse(output.trim()) as LearningResult;
            if (code !== 0 || value.error) throw new Error(value.error || '记录未完成');
            resolve(value);
          } catch (error) {
            reject(new Error(error instanceof SyntaxError ? '记录未完成，请重试' : errorMessage(error)));
          }
        });
      });
      const message = result.status === 'unchanged'
        ? '正文与 AI 原稿相同，没有新增改稿样本。'
        : result.status === 'already_recorded'
          ? '这一版已记录；下次写稿会读取。'
          : '已记录' + (result.kind === 'version_selection' ? '你的版本选择' : '你的改稿')
            + '；下次写稿会先参考这次调整。';
      this.lastLearningResult = result;
      new Notice(message, 8000);
      return result;
    } catch (error) {
      const message = errorMessage(error);
      new Notice('改稿记录：' + message, 10000);
      this.lastLearningResult = { error: message };
      return this.lastLearningResult;
    } finally {
      this.learningBusy = false;
    }
  }

  async deliver(
    file: TFile | null,
    onStatus: StatusCallback,
    kind: UploadKind,
    options: DeliveryRequestOptions,
  ): Promise<UploadResult> {
    const status = (message: string): void => { this.lastStatus = message; onStatus(message); };
    const fail = (message: string): UploadResult => {
      const result: UploadResult = { verified: false, state: 'failed', error: message };
      this.lastResult = result; status('未提交：' + message); new Notice('X 发布：' + message, 10000); return result;
    };
    if (this.busy) return fail('已有草稿或发布操作正在执行，请等待完成');
    if (kind !== 'post' || !isEligibleFile(file) || !file.path.startsWith(folderPrefix('drafts'))) {
      return fail('请打开创作区的普通推文；Articles 由你在 X 处理');
    }
    if (options.confirmed !== true || !['publish', 'schedule'].includes(options.action)) return fail('请重新打开当前稿件的发布确认');
    const frozenOptions = Object.freeze({ ...options }), notePath = file.path;
    this.busy = true;
    let requestPath: string | undefined, runnerStarted = false;
    try {
      const markdown = await this.app.vault.read(file);
      if (file.path !== notePath) throw new Error('确认后稿件路径已变化，请重新打开发布确认');
      this.ensureSaved(file, markdown, '当前编辑尚未保存，请重新打开发布确认');
      if (typeof frozenOptions.expectedMarkdown !== 'string' || markdown !== frozenOptions.expectedMarkdown) throw new Error('确认后正文已变化，请重新打开发布确认');
      if (this.hasDeliveryAttempt(notePath, markdown)) {
        const result: UploadResult = { verified: false, state: 'uncertain', uncertain: true, retry_allowed: false,
          error: '这一版已有提交记录，请先到 X 核对，避免重复发布' };
        this.lastResult = result; status(result.error!); new Notice(result.error!, 12000); return result;
      }
      if (frozenOptions.action === 'schedule') {
        if (!frozenOptions.scheduledFor || !/(?:Z|[+-]\d{2}:\d{2})$/.test(frozenOptions.scheduledFor)
          || !Number.isFinite(Date.parse(frozenOptions.scheduledFor)) || Date.parse(frozenOptions.scheduledFor) <= Date.now()) throw new Error('请选择带时区且晚于现在的发布时间');
        if (!['America/Los_Angeles', 'Asia/Shanghai'].includes(frozenOptions.timeZone || '')) throw new Error('请选择明确的发布时区');
      }
      const runner = path.join(config.backendDir, 'delivery_runner.py');
      if (!fs.existsSync(runner)) throw new Error('发布程序暂时找不到，请检查 X 发布台安装');
      const directory = path.join(config.backendDir, '请求');
      fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
      requestPath = path.join(directory, crypto.randomUUID() + '.json');
      fs.writeFileSync(requestPath, JSON.stringify({
        note_path: path.join(this.vaultRoot(), notePath), markdown, kind: 'post',
        confirmed: true, action: frozenOptions.action, scheduledFor: frozenOptions.scheduledFor, timeZone: frozenOptions.timeZone,
      }), { mode: 0o600 });
      status(frozenOptions.action === 'schedule' ? '正在准备 X 定时发布…' : '正在准备直接发布…');
      const request = requestPath;
      let result = await new Promise<UploadResult>((resolve, reject) => {
        runnerStarted = true;
        const child = spawn(pythonPath(), [runner, '--request', request], {
          cwd: config.backendDir, shell: false,
          env: backendEnvironment(),
        });
        let buffer = '', last: UploadResult | undefined;
        const lineReceived = (line: string): void => {
          try {
            const value: unknown = JSON.parse(line);
            if (!value || typeof value !== 'object' || Array.isArray(value)) return;
            const receipt = value as UploadResult & { stage?: unknown };
            if (typeof receipt.stage === 'string') status(receipt.stage);
            else if (typeof receipt.verified === 'boolean') last = receipt;
          } catch { /* Diagnostic output is not a delivery receipt. */ }
        };
        child.stdout.on('data', (chunk: Buffer) => {
          buffer += chunk.toString();
          let index: number;
          while ((index = buffer.indexOf('\n')) >= 0) { lineReceived(buffer.slice(0, index)); buffer = buffer.slice(index + 1); }
        });
        child.stderr.on('data', () => {});
        child.on('error', reject);
        child.on('close', () => {
          if (buffer.trim()) lineReceived(buffer);
          // A nonzero exit can still carry the authoritative failed/uncertain
          // receipt. Never throw it away and accidentally imply safe retry.
          if (last) resolve(last);
          else reject(new Error('没有收到完整发布回执，请先到 X 核对结果'));
        });
      });
      if (deliveryReceiptUncertain(result)) {
        result.uncertain = true;
      }
      if (result.verified === true || result.uncertain === true) this.deliveryAttempts.add(notePath + '\0' + markdown);
      if (result.verified === true && result.uncertain !== true) {
        status(`X 已核验完成，正在移到“${folderName('published')}”…`);
        result = await archiveVerifiedDelivery(this.app, file, notePath, markdown, result, frozenOptions.action, frozenOptions.timeZone);
        if (typeof result.archived_path === 'string') this.deliveryAttempts.add(result.archived_path + '\0' + markdown);
      }
      const differences = Array.isArray(result.format_differences) ? result.format_differences.join('；') : '';
      const text = result.uncertain === true ? '结果待核对，请先到 X 查看，避免重复发布'
        : result.verified === true ? frozenOptions.action === 'schedule' ? '已存入 X 定时发布，核对通过'
          : differences ? '已公开发布，但' + differences : '已公开发布，核对通过'
          : '未提交：' + (result.error || '发布检查未通过');
      const archiveText = result.archived_path ? `；已移到“${folderName('published')}”` : result.archive_error ? '；归档未完成：' + result.archive_error : '';
      status(text + archiveText); new Notice('X 发布：' + text + archiveText, 12000);
      this.lastResult = result; return result;
    } catch (error) {
      const message = errorMessage(error);
      if (!runnerStarted) return fail(message);
      const result: UploadResult = { verified: false, state: 'uncertain', uncertain: true, error: message };
      this.deliveryAttempts.add(notePath + '\0' + frozenOptions.expectedMarkdown);
      this.lastResult = result; status('结果待核对：' + message);
      new Notice('X 发布结果待核对，请先到 X 查看，避免重复发布。', 15000); return result;
    } finally {
      this.busy = false;
      if (requestPath && fs.existsSync(requestPath)) fs.unlinkSync(requestPath);
    }
  }

  /** Archived native schedules whose time has passed and need a read-only check. */
  private dueFollowUps(now = Date.now()): boolean {
    let names: string[];
    try { names = fs.readdirSync(archiveReceipts()).filter(name => name.endsWith('.json')); } catch { return false; }
    return names.some(name => {
      try {
        const value = JSON.parse(fs.readFileSync(path.join(archiveReceipts(), name), 'utf8')) as UploadResult;
        if (value.state !== 'scheduled' || value.verified !== true || typeof value.scheduled_for !== 'string') return false;
        const checked = typeof value.follow_up_checked_at === 'string' ? Date.parse(value.follow_up_checked_at) : 0;
        return now >= Date.parse(value.scheduled_for) + 3 * 60_000 && now >= checked + 20 * 60_000;
      } catch { return false; }
    });
  }

  /** After a native schedule's time, find the public post and update the archived receipt.
   * Read-only on X; skipped while any upload or delivery is running. */
  async followUpScheduled(): Promise<UploadResult[]> {
    if (this.busy || !this.dueFollowUps()) return [];
    this.busy = true;
    try {
      return await new Promise<UploadResult[]>(resolve => {
        const child = spawn(pythonPath(), [path.join(config.backendDir, 'delivery_runner.py'), '--follow-up'], {
          cwd: config.backendDir, shell: false, env: backendEnvironment(),
        });
        let output = '';
        child.stdout.on('data', (chunk: Buffer) => { output += chunk.toString(); });
        child.stderr.on('data', () => {});
        child.on('error', () => resolve([]));
        child.on('close', () => {
          for (const line of output.trim().split('\n').reverse()) {
            try {
              const value = JSON.parse(line) as { follow_up?: UploadResult[] };
              if (Array.isArray(value.follow_up)) { resolve(value.follow_up); return; }
            } catch { /* Stage lines and diagnostics. */ }
          }
          resolve([]);
        });
      });
    } finally { this.busy = false; }
  }

  async upload(
    file: TFile | null,
    onStatus: StatusCallback = () => {},
    kind: UploadKind = 'post',
  ): Promise<UploadResult | undefined> {
    const status = (message: string): void => {
      onStatus(message);
      this.lastStatus = message;
    };
    if (this.busy) {
      new Notice('已有上传正在执行');
      return;
    }
    if (!isEligibleFile(file)) {
      new Notice('请打开一篇待发布推文');
      return;
    }
    this.busy = true;
    let requestPath: string | undefined;
    try {
      const markdown = await this.app.vault.read(file);
      this.ensureSaved(file, markdown, '当前编辑尚未保存，请稍后再点');
      const directory = path.join(config.backendDir, '请求');
      fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
      requestPath = path.join(directory, crypto.randomUUID() + '.json');
      fs.writeFileSync(requestPath, JSON.stringify({
        note_path: path.join(this.vaultRoot(), file.path), markdown,
      }), { mode: 0o600 });
      status(kind === 'article' ? '正在检查长文…' : '正在检查正文…');
      new Notice('正在准备 ' + (kind === 'article' ? 'X 长文' : '普通推文') + '草稿，完成后会提示结果。');
      const request = requestPath;
      const result = await new Promise<UploadResult>((resolve, reject) => {
        const child = spawn(pythonPath(), [
          path.join(config.backendDir, kind === 'article' ? 'article_runner.py' : 'runner.py'),
          '--request', request,
        ], {
          cwd: config.backendDir, shell: false,
          env: backendEnvironment(),
        });
        let buffer = '';
        let last: UploadResult | undefined;
        const lineReceived = (line: string): void => {
          try {
            const value = JSON.parse(line) as UploadResult & { stage?: string };
            if (value.stage) status(value.stage);
            else last = value;
          } catch { /* The runner may also write non-protocol diagnostic lines. */ }
        };
        child.stdout.on('data', (chunk: Buffer) => {
          buffer += chunk.toString();
          let index: number;
          while ((index = buffer.indexOf('\n')) >= 0) {
            lineReceived(buffer.slice(0, index));
            buffer = buffer.slice(index + 1);
          }
        });
        child.stderr.on('data', () => {});
        child.on('error', reject);
        child.on('close', code => {
          if (buffer.trim()) lineReceived(buffer);
          if (code === 0 && last?.verified === true) resolve(last);
          else reject(new Error(last?.error || '上传未完成，请检查运行记录后重试'));
        });
      });
      const text = kind === 'article'
        ? '已存入 X Articles 草稿，核对通过'
        : result.already_exists ? '已在 X 草稿箱，核对通过' : '已存入 X 草稿箱，核对通过';
      status(text);
      new Notice(text + '。正式发布请到 X 操作。', 10000);
      if (result.draft_url) new Notice('长文草稿：' + result.draft_url, 20000);
      if (result.cover_missing) new Notice('长文未带封面，发布前可补一张 5:2 封面。', 15000);
      this.lastResult = result;
      return result;
    } catch (error) {
      const message = errorMessage(error);
      status('未完成：' + message);
      new Notice('X 草稿：' + message, 15000);
      this.lastResult = { verified: false, error: message };
      return this.lastResult;
    } finally {
      this.busy = false;
      if (requestPath && fs.existsSync(requestPath)) fs.unlinkSync(requestPath);
    }
  }
}
