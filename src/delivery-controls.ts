import { Modal, Notice, Setting, type App, type TFile } from 'obsidian';
import { accountLabel } from './config';
import type { UploadKind, UploadResult } from './backend';
import { isArchivedPost, linkWarnings, metadata, postBody, postStats, quoteLink } from './model';
import { resolvePostMedia, splitPostMedia } from './media';
import { defaultDeliveryTime, deliveryResultUrl, DELIVERY_TIME_ZONES, formatDeliveryTime, parseDeliveryTime, type DeliveryTimeZone } from './delivery-time';
import { deliveryReceiptUncertain } from './delivery-receipt';
import { mountDeliveryTimePicker, type DeliveryTimePicker } from './delivery-time-picker';

export interface DeliveryOptions {
  action: 'publish' | 'schedule';
  scheduledFor?: string;
  timeZone?: string;
  expectedMarkdown: string;
  confirmed: true;
}

export interface DeliveryBackend {
  busy?: boolean;
  hasDeliveryAttempt?(notePath: string, markdown: string): boolean;
  deliver(file: TFile, onStatus: (status: string) => void, kind: UploadKind, options: DeliveryOptions): Promise<UploadResult | undefined>;
}

export interface DeliveryControlsOptions {
  app: App;
  bar: HTMLElement;
  host: HTMLElement;
  file: TFile;
  kind: UploadKind;
  flush: () => Promise<unknown>;
  /** The current complete note, updated after flushing either editor. */
  snapshotFingerprint: () => string;
  backend: DeliveryBackend;
  onBusyChange?: (busy: boolean) => void;
  /** Called after the backend returned and the local/shared busy flags settled.
   * A view may now follow a moved note without losing its successful receipt. */
  onComplete?: (result: UploadResult) => void | Promise<void>;
}

export interface DeliveryControlsHandle {
  dispose(): void;
  refresh(): void;
  setBusy(busy: boolean): void;
}

/** Differences between the public post and the note, e.g. bold dropped by X. */
export function formatDifferences(result: UploadResult): string[] {
  return Array.isArray(result.format_differences) ? result.format_differences.filter((item): item is string => typeof item === 'string') : [];
}

export function deliveryStateLabel(result?: UploadResult): string {
  if (!result || result.verified !== true || deliveryReceiptUncertain(result)) return '已归档';
  // A native schedule stays "scheduled" until the follow-up check finds the public post.
  const base = result.state === 'scheduled' ? '已排期待发布' : '已公开发布';
  const differences = formatDifferences(result);
  return differences.length ? base + ' · ' + differences[0] : base;
}

/** Also used when a receipt is restored from the archived note's local record. */
export function renderDeliveryResult(host: HTMLElement, result: UploadResult, fallback: {
  action?: DeliveryOptions['action']; scheduledFor?: string; timeZone?: string;
} = {}): void {
  host.hidden = false; host.empty();
  const card = host.createDiv({ cls: 'xpd-result', attr: { role: 'status', 'aria-live': 'polite' } });
  const row = (label: string, text: string): void => {
    const line = card.createDiv({ cls: 'xpd-result-row' });
    line.createSpan({ text: label }); line.createSpan({ text });
  };
  const account = typeof result.account === 'string' ? result.account : accountLabel();
  row('账号', account.startsWith('@') ? account : '@' + account);
  if (result.verified !== true || deliveryReceiptUncertain(result)) {
    row('结果', '发布结果待核对'); return;
  }
  const action = result.action === 'schedule' || result.state === 'scheduled' ? 'schedule' : fallback.action || 'publish';
  const pending = result.state === 'scheduled';
  row('结果', pending ? '已排期待发布' : '已公开发布');
  if (action === 'schedule') {
    const dueAt = [result.dueAt, result.due_at, result.scheduled_for, result.scheduledFor, fallback.scheduledFor].find(value => typeof value === 'string') as string | undefined;
    const zone = [result.time_zone, result.timeZone, fallback.timeZone].find(value => typeof value === 'string') as string | undefined;
    row(pending ? '发布时间' : '定时时间', dueAt ? formatDeliveryTime(dueAt, zone || 'America/Los_Angeles') : '请到 X 核对定时时间');
    if (!pending && typeof result.published_at === 'string') row('实际发出', formatDeliveryTime(result.published_at, zone || 'America/Los_Angeles'));
    row('方式', result.mode === 'native' || result.mode === 'x-native' ? 'X 原生定时' : '请到 X 核对定时记录');
    if (pending && typeof result.follow_up_error === 'string') row('到点核对', result.follow_up_error);
  }
  const differences = formatDifferences(result);
  if (differences.length) {
    const warning = host.createDiv({ cls: 'xpd-error', attr: { role: 'alert' } });
    warning.createEl('b', { text: '已发出，但和稿件不完全一样' }); warning.createSpan({ text: differences.join('；') });
  }
  if (typeof result.archived_path === 'string') row('笔记已归档', result.archived_path);
  if (typeof result.archive_error === 'string') {
    const warning = host.createDiv({ cls: 'xpd-error', attr: { role: 'alert' } });
    warning.createEl('b', { text: '提交已成功，笔记归档未完成' }); warning.createSpan({ text: result.archive_error });
  }
  const url = deliveryResultUrl(result.url || result.post_url || result.tweet_url);
  if (url) host.createEl('a', { cls: 'xpd-link', href: url, text: '打开已发布推文', attr: { target: '_blank', rel: 'noopener noreferrer' } });
}

/** Draft upload remains a separate control. No action runs before this modal's
 * explicit confirmation of the frozen body, account and (if any) UTC time. */
export function mountDeliveryControls(options: DeliveryControlsOptions): DeliveryControlsHandle {
  if (options.kind !== 'post' || isArchivedPost(options.file.path)) return { dispose() {}, refresh() {}, setBusy() {} };
  const { app, bar, host, file, backend } = options;
  const publish = bar.createEl('button', { cls: 'xpd-btn clickable-icon', text: '直接发布', attr: { type: 'button' } });
  const schedule = bar.createEl('button', { cls: 'xpd-btn clickable-icon', text: '定时发布', attr: { type: 'button' } });
  const limitHint = bar.createSpan({ cls: 'xpd-caption' });
  let disposed = false, preparing = false, running = false, externalBusy = false;
  let modal: DeliveryReviewModal | undefined;
  let completedFingerprint: string | undefined, uncertainFingerprint: string | undefined;

  function refresh(): void {
    if (disposed) return;
    const fingerprint = options.snapshotFingerprint();
    const content = splitPostMedia(postBody(fingerprint));
    const length = postStats(content.text).weightedLength;
    const tooLong = length > 25_000;
    const settled = completedFingerprint === fingerprint || uncertainFingerprint === fingerprint || !!backend.hasDeliveryAttempt?.(file.path, fingerprint);
    publish.disabled = schedule.disabled = preparing || running || externalBusy || !!backend.busy || tooLong || !content.text.trim() || settled || isArchivedPost(file.path);
    limitHint.textContent = tooLong ? '正文超过 25,000 加权字符' : '';
    limitHint.hidden = !tooLong;
    publish.title = schedule.title = tooLong ? `当前 ${length} / 25,000 加权字符` : '';
  }

  function renderError(message: string, uncertain = false): void {
    if (disposed) return;
    host.hidden = false; host.empty();
    const card = host.createDiv({ cls: 'xpd-error', attr: { role: 'alert' } });
    card.createEl('b', { text: uncertain ? '结果尚未确认' : '发布未完成' });
    card.createSpan({ text: message });
    if (uncertain) host.createDiv({ cls: 'xpd-hint', text: '请先在 X 核对结果，避免重复发布。' });
  }

  async function execute(markdown: string, action: DeliveryOptions['action'], scheduledFor?: string, timeZone?: string): Promise<void> {
    if (isArchivedPost(file.path)) throw new Error('归档笔记只能查看，请在创作区准备新稿');
    if (disposed || running || externalBusy || backend.busy) throw new Error('已有操作正在执行，请等完成后再确认');
    const reviewedModal = modal;
    // Flush immediately before sending. Comparing both saved and editor state
    // rejects edits made while the human was reviewing this snapshot.
    await options.flush();
    const latest = await app.vault.read(file);
    if (disposed || !reviewedModal || modal !== reviewedModal || file.path !== reviewedModal.notePath
      || latest !== markdown || options.snapshotFingerprint() !== markdown) {
      throw new Error('正文已变化，请关闭后重新打开发布确认');
    }
    if (running || externalBusy || backend.busy) throw new Error('已有操作正在执行，请等完成后再确认');
    if (backend.hasDeliveryAttempt?.(file.path, markdown)) throw new Error('这一版已有提交记录，请先到 X 核对');
    if (scheduledFor && Date.parse(scheduledFor) <= Date.now()) throw new Error('选定的发布时间已过，请重新选择');
    if (postStats(splitPostMedia(postBody(markdown)).text).weightedLength > 25_000) throw new Error('正文超过 25,000 加权字符');
    running = true; preparing = false; options.onBusyChange?.(true); refresh();
    modal?.close(); modal = undefined;
    host.hidden = false; host.empty();
    const progress = host.createDiv({ cls: 'xpd-progress', attr: { role: 'status', 'aria-live': 'polite' } });
    const stage = progress.createDiv({ cls: 'xpd-step is-current', text: '正在核对账号、正文和加粗…' });
    let outcome: UploadResult | undefined;
    try {
      const result = outcome = await backend.deliver(file, message => { if (!disposed) stage.textContent = message; }, 'post', {
        action, scheduledFor, timeZone, expectedMarkdown: markdown, confirmed: true,
      });
      if (!result) {
        uncertainFingerprint = markdown;
        renderError('没有收到完整回执，请先到 X 核对。', true);
      } else if (deliveryReceiptUncertain(result)) {
        uncertainFingerprint = markdown;
        renderError(typeof result.error === 'string' ? result.error : '提交后未能确认最终结果，请先到 X 核对。', true);
      } else if (result.verified !== true) {
        renderError(typeof result.error === 'string' ? result.error : '没有收到已核验的发布结果，请到 X 核对。');
      } else {
        completedFingerprint = markdown;
        if (!disposed) renderDeliveryResult(host, result, { action, scheduledFor, timeZone });
      }
    } catch (error) {
      // A transport exception cannot prove that a public submit did not happen.
      uncertainFingerprint = markdown;
      renderError(error instanceof Error ? error.message : String(error), true);
    } finally {
      running = false; options.onBusyChange?.(false); refresh();
    }
    // UI refresh/rename errors cannot turn an already verified public result
    // into an unknown submit or invite another attempt.
    if (outcome && !disposed) {
      try { await options.onComplete?.(outcome); }
      catch (error) { new Notice('发布回执已保留；页面暂未更新：' + (error instanceof Error ? error.message : String(error)), 10000); }
    }
  }

  async function open(action: DeliveryOptions['action']): Promise<void> {
    if (disposed || isArchivedPost(file.path) || preparing || running || externalBusy || backend.busy || modal) return;
    preparing = true; refresh();
    try {
      await options.flush();
      const markdown = await app.vault.read(file);
      if (disposed) return;
      if (externalBusy || backend.busy) throw new Error('已有操作正在执行，请等完成后再打开确认');
      if (options.snapshotFingerprint() !== markdown) throw new Error('笔记还在保存，请稍后再打开确认');
      const content = splitPostMedia(postBody(markdown));
      if (!content.text.trim()) throw new Error('正文为空，请先写好推文');
      if (postStats(content.text).weightedLength > 25_000) throw new Error('正文超过 25,000 加权字符');
      if (completedFingerprint === markdown || uncertainFingerprint === markdown || backend.hasDeliveryAttempt?.(file.path, markdown)) throw new Error('这一版已有提交记录，请先到 X 核对');
      const review = new DeliveryReviewModal(app, file, markdown, action, (dueAt, zone) => execute(markdown, action, dueAt, zone), () => {
        if (modal === review) modal = undefined;
        preparing = false; refresh();
      });
      modal = review; review.open();
    } catch (error) {
      preparing = false; refresh(); new Notice(error instanceof Error ? error.message : String(error));
    }
  }

  publish.onclick = () => { void open('publish'); };
  schedule.onclick = () => { void open('schedule'); };
  refresh();
  return {
    refresh,
    setBusy(busy: boolean) { externalBusy = busy; refresh(); },
    dispose() { disposed = true; modal?.close(); modal = undefined; publish.onclick = schedule.onclick = null; publish.remove(); schedule.remove(); limitHint.remove(); },
  };
}

class DeliveryReviewModal extends Modal {
  readonly notePath: string;
  private zone: DeliveryTimeZone = 'America/Los_Angeles';
  private when = defaultDeliveryTime(this.zone);
  private submitting = false;
  private confirm?: HTMLButtonElement;
  private feedback?: HTMLElement;
  private dueLabel?: HTMLElement;
  private timePicker?: DeliveryTimePicker;

  constructor(app: App, private file: TFile, private markdown: string, private action: DeliveryOptions['action'],
    private submit: (dueAt?: string, zone?: string) => Promise<void>, private closed: () => void) {
    super(app); this.notePath = file.path;
  }

  onOpen(): void {
    this.titleEl.setText(this.action === 'publish' ? '确认直接发布' : '确认定时发布');
    const content = this.contentEl; content.empty();
    new Setting(content).setName('发布账号').setDesc(accountLabel());
    new Setting(content).setName('当前稿件').setDesc(this.file.basename);
    const frontmatter = metadata(this.markdown), quote = quoteLink(frontmatter.quote);
    if (quote) new Setting(content).setName('引用原帖').setDesc(quote.url);
    const body = splitPostMedia(postBody(this.markdown)), stats = postStats(body.text);
    content.createEl('h3', { text: `即将发布的正文 · ${stats.weightedLength} / 25,000` });
    // A read-only multiline field preserves line breaks and is keyboard-readable.
    const preview = content.createEl('textarea', { attr: { readonly: '', rows: String(Math.min(14, Math.max(4, stats.plain.split('\n').length))), 'aria-label': '即将发布的正文' } });
    preview.style.width = '100%'; preview.style.boxSizing = 'border-box';
    preview.value = body.text;
    if (stats.runs.some(run => run.bold)) content.createEl('p', { text: '正文中的 **…** 会保留为 X 加粗；若 X 不支持此功能，会停止并提示。' });
    for (const text of linkWarnings(stats.plain, stats.runs.some(run => run.bold))) content.createEl('p', { cls: 'xpd-warn', text: '! ' + text });
    if (body.references.length) {
      const media = resolvePostMedia(this.app, this.file, body.references);
      new Setting(content).setName(`配图 ${media.length} 张`).setDesc(media.map(item => item.name).join('、'));
    }
    if (this.action === 'schedule') {
      new Setting(content).setName('发布时间的时区').addDropdown(dropdown => {
        for (const zone of DELIVERY_TIME_ZONES) dropdown.addOption(zone, zone === 'Asia/Shanghai' ? '北京时间 · Asia/Shanghai' : '美国洛杉矶 · America/Los_Angeles');
        dropdown.setValue(this.zone).onChange(value => { this.zone = value as DeliveryTimeZone; this.validate(); });
      });
      this.timePicker = mountDeliveryTimePicker(content, this.when, value => {
        this.when = value; this.validate();
      });
      this.dueLabel = content.createEl('p', { cls: 'xpd-time-summary', attr: { 'aria-live': 'polite' } });
      content.createEl('p', { text: '保存后由 X 按时发送，可在 X 的定时推文中核对。' });
    } else content.createEl('p', { text: '确认后会立即公开发布到这个账号。' });
    this.feedback = content.createDiv({ attr: { role: 'alert', 'aria-live': 'polite' } });
    new Setting(content)
      .addButton(button => button.setButtonText('取消').onClick(() => this.close()))
      .addButton(button => {
        this.confirm = button.buttonEl;
        button.setCta().setButtonText(this.action === 'publish' ? '确认公开发布' : '确认定时发布').onClick(() => { void this.confirmAction(); });
      });
    this.validate();
  }

  private validate(): string | undefined {
    if (!this.confirm || !this.feedback) return;
    if (this.submitting) { this.confirm.disabled = true; return; }
    try {
      const dueAt = this.action === 'schedule' ? parseDeliveryTime(this.when, this.zone) : undefined;
      if (this.dueLabel && dueAt) this.dueLabel.textContent = formatDeliveryTime(dueAt, this.zone);
      this.feedback.textContent = ''; this.confirm.disabled = false; return dueAt;
    } catch (error) {
      if (this.dueLabel) this.dueLabel.textContent = '';
      this.feedback.textContent = error instanceof Error ? error.message : String(error);
      this.confirm.disabled = true; return;
    }
  }

  private async confirmAction(): Promise<void> {
    if (this.submitting) return;
    this.timePicker?.settle();
    const dueAt = this.validate();
    if (this.confirm?.disabled) return;
    this.submitting = true; if (this.confirm) this.confirm.disabled = true;
    try { await this.submit(dueAt, this.action === 'schedule' ? this.zone : undefined); }
    catch (error) {
      if (this.feedback) this.feedback.textContent = error instanceof Error ? error.message : String(error);
      // Snapshot changes require reopening and reviewing the new body.
      if (error instanceof Error && /正文已变化/.test(error.message)) return;
      this.submitting = false; if (this.confirm) this.confirm.disabled = false;
    }
  }

  onClose(): void { this.timePicker?.dispose(); this.timePicker = undefined; this.contentEl.empty(); this.closed(); }
}
