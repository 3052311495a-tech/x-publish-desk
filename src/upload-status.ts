import { Notice, TFile } from 'obsidian';
import { accountLabel } from './config';
import { Backend, UploadKind, UploadResult } from './backend';
import { quoteLink } from './model';
import { resolveEvidence } from './receipt';

export interface UploadContext {
  file: TFile | null;
  kind: UploadKind;
  /** Account handle without the leading @; only ordinary posts can quote. */
  quote: string | null;
  fingerprint?: string;
}

type UploadState = 'idle' | 'busy' | 'done' | 'failed';

export function uploadButtonLabel(kind: UploadKind, quote: string | null): string {
  if (kind === 'article') return '存到 X Articles 草稿';
  return quote ? `引用 @${quote} · 存到草稿箱` : '存到草稿箱';
}

/** The four post labels are the labels in States.dc.html. */
export function uploadStepLabels(context: UploadContext): string[] {
  if (context.kind === 'article') return [
    '检查长文、图片和表格', '写入长文、图片和表格', '存草稿并回读核对',
  ];
  return [
    'Codex 检查正文',
    ...(context.quote ? [`打开 @${context.quote} 那条，点「引用」`] : []),
    '写入正文、加粗', '存草稿并在新窗口读回核对',
  ];
}

function sameContext(left: UploadContext, right: UploadContext): boolean {
  return left.file?.path === right.file?.path && left.kind === right.kind
    && left.quote === right.quote && left.fingerprint === right.fingerprint;
}

/** Each callback reports the latest known operation, never an invented completion. */
export function uploadStageIndex(stage: string, context: UploadContext): number {
  const last = uploadStepLabels(context).length - 1;
  if (/检查|预检查/.test(stage)) return 0;
  if (/引用原帖|点[「“]?引用|打开.*那条/.test(stage)) return context.quote ? 1 : 0;
  if (/写入|加粗|填入/.test(stage)) return context.kind === 'article' ? 1 : context.quote ? 2 : 1;
  // These existing runner messages cover several operations at once. Their
  // granularity does not prove the quote/write steps have already completed.
  if (/正在保存并核对 X 草稿/.test(stage)) return 1;
  if (/正在保存 X 长文草稿并回读核对/.test(stage)) return 1;
  if (/回读|新窗口|保存|核对|存草稿/.test(stage)) return last;
  return -1;
}

export function uploadErrorCopy(error: string): { reason: string; next: string } {
  const clean = error.replace(/^未完成：/, '').trim();
  if (/账号|account/i.test(clean)) return {
    reason: 'X 登录账号需要核对', next: `请在 X 确认登录的是 ${accountLabel()}，再点「重试」。`,
  };
  if (/Codex.*(?:登录|额度|检查失败)|quota|rate.?limit/i.test(clean)) return {
    reason: 'Codex 检查没有完成', next: '检查 Codex 的登录和额度后再点「重试」。',
  };
  if (/登录|cookie|login|unauthoriz/i.test(clean)) return {
    reason: 'X 登录过期了', next: '草稿没存。重新登录 X 以后点「重试」，已经做完的步骤不会重复。',
  };
  if (/未保存|尚未保存|已变化|已经变化|已修改|尚未保存/.test(clean)) return {
    reason: '笔记还没保存，或检查时又改了内容', next: '等 Obsidian 保存完成后再点「重试」。',
  };
  if (/核验.*过期/.test(clean)) return {
    reason: '核验已过期，先重新核实再上传', next: '重新核实内容并更新有效期后，再点「重试」。',
  };
  if (/已有上传尝试|避免重复|勿重复上传/.test(clean)) return {
    reason: '这个版本已有上传尝试，请先核对草稿箱', next: '先到 X 草稿箱核对，确认需要重做后再继续，避免存出重复稿。',
  };
  if (/已有上传正在执行/.test(clean)) return {
    reason: '已有上传正在执行', next: '等上一条完成后，再点「重试」。',
  };
  if (/network|timeout|timed out|网络|连接|超时/i.test(clean)) return {
    reason: 'X 暂时没有连上', next: '检查网络和 X 登录后，再点「重试」。',
  };
  // Show the runner's useful first sentence, without filesystem paths or logs.
  const reason = clean.split(/\r?\n/)[0].replace(/(?:详情|请检查运行记录)[：:].*$/, '')
    .replace(/\s*\/[^\s]+/g, '').trim().slice(0, 120) || '草稿没有存成';
  return { reason, next: '按上面的提示处理后再点「重试」，详细日志在运行记录里。' };
}

/** Build only the icons supplied by the confirmed design; no inline layout. */
function buttonIcon(button: HTMLButtonElement, state: 'arrow' | 'busy' | 'done'): void {
  const document = button.ownerDocument;
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.setAttribute('viewBox', '0 0 24 24'); svg.setAttribute('fill', 'none');
  svg.setAttribute('stroke', 'currentColor'); svg.setAttribute('stroke-width', '2.4');
  svg.setAttribute('stroke-linecap', 'round'); svg.setAttribute('stroke-linejoin', 'round');
  svg.setAttribute('aria-hidden', 'true');
  const path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
  path.setAttribute('d', state === 'busy' ? 'M12 3a9 9 0 1 1-9 9'
    : state === 'done' ? 'M5 12l5 5L20 7' : 'M7 17 17 7M7 7h10v10');
  svg.append(path); button.append(svg);
}

export class UploadStatus {
  private state: UploadState = 'idle';
  private context: UploadContext;
  private step = 0;
  private disposed = false;
  private retryKind?: UploadKind;
  private result?: UploadResult;
  private completedAt = '';

  constructor(
    readonly button: HTMLButtonElement,
    readonly host: HTMLElement,
    readonly backend: Backend,
    private readonly getContext: () => UploadContext,
    private readonly onChange: () => void = () => {},
  ) {
    this.context = getContext();
    this.button.type = 'button';
    this.button.onclick = () => this.run(this.retryKind);
    this.renderButton();
  }

  setContext(context: UploadContext): void {
    const changed = !sameContext(this.context, context);
    this.context = context;
    if (changed && this.state !== 'busy') {
      this.state = 'idle'; this.retryKind = undefined; this.result = undefined; this.host.empty(); this.host.hidden = true;
    }
    this.renderButton();
  }

  syncBusy(): void { this.renderButton(); }

  async run(kindOverride?: UploadKind): Promise<UploadResult | undefined> {
    if (this.disposed || this.state === 'busy') return;
    if (this.backend.busy) { new Notice('已有上传正在执行'); this.renderButton(); return; }
    const current = this.getContext();
    this.setContext(current);
    const running = { ...current, kind: kindOverride || current.kind };
    if (running.kind === 'article') running.quote = null;
    this.state = 'busy'; this.step = 0; this.retryKind = running.kind;
    this.host.empty(); this.renderProgress(running); this.renderButton(); this.onChange();
    let result: UploadResult | undefined;
    try {
      const pending = this.backend.upload(running.file, stage => {
        if (this.disposed || this.state !== 'busy') return;
        const next = uploadStageIndex(stage, running);
        if (next >= 0) this.step = Math.max(this.step, next);
        this.renderProgress(running);
      }, running.kind);
      // Backend.upload sets its shared lock before its first await. Refresh
      // every other toolbar/inline button after that lock has been acquired.
      this.onChange();
      result = await pending;
    } catch (error) {
      result = { verified: false, error: error instanceof Error ? error.message : String(error) };
    }
    if (this.disposed) { this.onChange(); return result; }
    if (!sameContext(this.context, current)) {
      this.state = 'idle'; this.retryKind = undefined; this.host.empty();
    } else if (result?.verified === true) {
      this.state = 'done'; this.result = result;
      this.retryKind = undefined;
      const now = new Date();
      this.completedAt = String(now.getHours()).padStart(2, '0') + ':' + String(now.getMinutes()).padStart(2, '0');
      this.renderResult(result, running);
    } else {
      this.state = 'failed'; this.result = result;
      this.renderError(result?.error || '请打开一篇待发布推文');
    }
    this.renderButton(); this.onChange();
    return result;
  }

  dispose(): void { this.disposed = true; this.button.onclick = null; this.host.empty(); }

  private renderButton(): void {
    if (this.disposed) return;
    this.button.className = 'xpd-btn-primary clickable-icon' + (this.state === 'idle' ? '' : ' is-' + this.state);
    this.button.disabled = this.state === 'busy' || this.backend.busy;
    this.button.empty();
    if (this.state === 'busy') { buttonIcon(this.button, 'busy'); this.button.appendText('正在存草稿…'); }
    else if (this.state === 'done') { buttonIcon(this.button, 'done'); this.button.appendText('已存草稿 · ' + this.completedAt); }
    else if (this.state === 'failed') this.button.appendText('重试');
    else {
      if (this.context.kind === 'post' && this.context.quote) buttonIcon(this.button, 'arrow');
      this.button.appendText(uploadButtonLabel(this.context.kind, this.context.quote));
    }
  }

  private renderProgress(context: UploadContext): void {
    this.host.hidden = false; this.host.empty();
    const progress = this.host.createDiv({ cls: 'xpd-progress', attr: { role: 'status', 'aria-live': 'polite' } });
    uploadStepLabels(context).forEach((text, index) => progress.createDiv({
      cls: 'xpd-step ' + (index < this.step ? 'is-done' : index === this.step ? 'is-current' : 'is-todo'), text,
    }));
    this.host.createDiv({ cls: 'xpd-hint', text: '一次只能跑一条，按钮在跑完之前不能再点' });
  }

  private renderResult(result: UploadResult, context: UploadContext): void {
    this.host.hidden = false; this.host.empty();
    const card = this.host.createDiv({ cls: 'xpd-result', attr: { role: 'status', 'aria-live': 'polite' } });
    const row = (label: string, value: string): void => {
      const element = card.createDiv({ cls: 'xpd-result-row' });
      element.createSpan({ text: label }); element.createSpan({ text: value });
    };
    const account = typeof result.account === 'string' ? result.account : accountLabel();
    row('账号', account.startsWith('@') ? account : '@' + account);
    const quote = quoteLink(result.quote)?.author || (context.quote ? '@' + context.quote : null);
    row('引用', quote ? quote + (result.quote_verified === true ? ' ✓' : '（回执未单独核验）') : '没有');
    row(context.kind === 'article' ? '长文正文' : '正文和加粗', result.bold_verified === false ? '正文回读一致，未核验加粗' : '回读一致 ✓');
    row('公开发布', result.publicly_posted === true ? '回执异常，请到 X 核对' : '没有，去 X 草稿箱自己发');
    const evidence = resolveEvidence(result);
    if (evidence) {
      const link = this.host.createEl('a', { text: '看草稿箱截图', href: '#', cls: 'xpd-link' });
      link.onclick = event => {
        event.preventDefault();
        try {
          const electron = require('electron') as { shell: { openPath(path: string): Promise<string> } };
          void electron.shell.openPath(evidence).then(error => {
            if (error) new Notice('截图暂时打不开，请检查运行记录');
          }).catch(() => new Notice('截图暂时打不开，请检查运行记录'));
        } catch { new Notice('截图暂时打不开，请检查运行记录'); }
      };
    } else if (context.kind === 'article') {
      this.host.createDiv({ cls: 'xpd-hint', text: '截图未找到，可查看运行记录' });
    }
  }

  private renderError(error: string): void {
    this.host.empty();
    const copy = uploadErrorCopy(error);
    const card = this.host.createDiv({ cls: 'xpd-error', attr: { role: 'alert' } });
    card.createEl('b', { text: copy.reason }); card.createSpan({ text: copy.next });
    this.host.createDiv({ cls: 'xpd-hint', text: '报错只写一句人话，详细日志放在运行记录里' });
  }
}
