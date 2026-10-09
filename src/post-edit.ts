import { App, Notice, TFile } from 'obsidian';
import { postStats, textRuns, type TextRun } from './model';
import { MediaManager, joinPostMedia, splitPostMedia, type MediaCheck, type PostMedia } from './media';

export interface PostBodyRange {
  sectionStart: number; sectionEnd: number; start: number; end: number;
  raw: string; body: string; leading: string; trailing: string; newline: string;
}
export class PostEditConflictError extends Error {
  constructor() { super('原始笔记的正文也改了，已停止自动保存；这边的修改还留着，请先核对两边。'); this.name = 'PostEditConflictError'; }
}

/** Byte ranges are measured in the unmodified source, including CRLF and comments. */
export function findPostBodyRange(markdown: string): PostBodyRange {
  const masked = markdown.replace(/%%[\s\S]*?(?:%%|$)/g, value => value.replace(/[^\r\n]/g, ' '));
  const lines = [...masked.matchAll(/[^\n]*(?:\n|$)/g)].filter(match => match[0].length);
  let fence = '', sectionStart = -1, sectionEnd = markdown.length, bodies = 0;
  for (const line of lines) {
    const value = line[0].replace(/\r?\n$/, '');
    const code = /^\s*(`{3,}|~{3,})/.exec(value);
    if (code) { if (!fence) fence = code[1][0]; else if (fence === code[1][0]) fence = ''; continue; }
    if (fence) continue;
    if (/^##[ \t]+正文[ \t]*$/.test(value)) { bodies++; if (sectionStart < 0) sectionStart = line.index! + line[0].length; continue; }
    if (sectionStart >= 0 && sectionEnd === markdown.length && /^#{1,2}[ \t]+|^---[ \t]*$/.test(value)) sectionEnd = line.index!;
  }
  if (bodies !== 1 || sectionStart < 0) throw new Error('需要且只能有一个「## 正文」区块，请在原始笔记里调整');
  // Process records may follow the body without an alternatives section.
  const comment = /^[ \t]*%%/m.exec(markdown.slice(sectionStart, sectionEnd));
  if (comment) sectionEnd = sectionStart + comment.index;
  const raw = markdown.slice(sectionStart, sectionEnd);
  if (raw.includes('%%')) throw new Error('正文里夹着隐藏记录，请先在原始笔记里调整；这些记录不会被自动覆盖');
  const newline = markdown.includes('\r\n') ? '\r\n' : '\n';
  let leading = /^(?:[ \t]*\r?\n)*/.exec(raw)?.[0] || '';
  let trailing = /(?:\r?\n[ \t]*)*$/.exec(raw)?.[0] || '';
  if (leading.length + trailing.length > raw.length) { leading = raw.slice(0, Math.min(newline.length, raw.length)); trailing = raw.slice(leading.length); }
  const start = sectionStart + leading.length, end = sectionEnd - trailing.length;
  return { sectionStart, sectionEnd, start, end, raw, body: markdown.slice(start, end).replace(/\r\n/g, '\n'), leading, trailing, newline };
}

/** Preserve all bytes outside the body, including its original blank-line padding. */
export function replacePostBody(markdown: string, body: string, padding?: { leading: string; trailing: string }): string {
  if (/^#{1,2}[ \t]+|^[ \t]*%%|^---[ \t]*$/m.test(body)) throw new Error('正文里不能加入章节标题、隐藏记录或分隔线，请用普通文字');
  const range = findPostBodyRange(markdown);
  const leading = padding?.leading ?? range.leading, trailing = padding?.trailing ?? range.trailing;
  const content = body.replace(/\r\n/g, '\n').replace(/\n/g, range.newline);
  const suffix = markdown.slice(range.sectionEnd);
  const separator = !trailing && content && suffix && !content.endsWith(range.newline) ? range.newline + range.newline : '';
  return markdown.slice(0, range.sectionStart) + leading + content + trailing + separator + suffix;
}

function isDecoration(node: Node): boolean {
  return node.nodeType === 1 && (node as HTMLElement).dataset.xpdDecoration === 'true';
}
function isBlock(node: Node): boolean { return node.nodeType === 1 && /^(DIV|P|LI|H[1-6]|BLOCKQUOTE)$/.test((node as Element).tagName); }
function appendRun(runs: TextRun[], text: string, bold: boolean): void {
  if (!text) return;
  const last = runs.at(-1); if (last?.bold === bold) last.text += text; else runs.push({ text, bold });
}

/** Read only text, line breaks and bold; images and fold markers are not editable text. */
export function editableRuns(root: HTMLElement): TextRun[] {
  const visit = (node: Node, bold: boolean): TextRun[] => {
    if (node.nodeType === 3) return [{ text: (node.nodeValue || '').replace(/\u00a0/g, ' '), bold }];
    if (node.nodeType !== 1 || isDecoration(node)) return [];
    const element = node as HTMLElement;
    if (element.tagName === 'BR') return [{ text: '\n', bold: false }];
    if (['IMG', 'VIDEO', 'AUDIO', 'SCRIPT', 'STYLE'].includes(element.tagName)) return [];
    const weight = element.style.fontWeight;
    const strong = bold || ['B', 'STRONG'].includes(element.tagName) || weight === 'bold' || Number(weight) >= 600;
    const children = [...node.childNodes].filter(child => !isDecoration(child));
    const runs: TextRun[] = [];
    let previousBlock = false;
    children.forEach((child, index) => {
      const block = isBlock(child);
      if (index > 0 && (block || previousBlock)) appendRun(runs, '\n', false);
      const trailingPlaceholder = child.nodeType === 1 && (child as Element).tagName === 'BR'
        && index === children.length - 1 && (children.length === 1 || children[index - 1].nodeType === 1 && (children[index - 1] as Element).tagName === 'BR');
      if (!trailingPlaceholder) for (const run of visit(child, strong)) appendRun(runs, run.text, run.bold);
      previousBlock = block;
    });
    return runs;
  };
  return visit(root, false);
}

export function editableToMarkdown(root: HTMLElement): string {
  let value = '', bold = false;
  for (const run of editableRuns(root)) {
    for (const piece of run.text.split(/(\n)/)) {
      if (!piece) continue;
      if (piece === '\n') { if (bold) { value += '**'; bold = false; } value += '\n'; }
      else { if (run.bold !== bold) { value += '**'; bold = run.bold; } value += piece; }
    }
  }
  return value + (bold ? '**' : '');
}

export function renderEditableMarkdown(root: HTMLElement, body: string): void {
  root.empty();
  for (const line of body.replace(/\r\n/g, '\n').split('\n')) {
    const element = root.createDiv(); element.dataset.xpdLine = 'true';
    for (const run of textRuns(line)) { if (run.bold) element.createEl('b', { text: run.text }); else element.appendText(run.text); }
    if (!line) element.createEl('br');
  }
}

type EditorRoot = Node & { activeElement?: Element | null; getSelection?: () => Selection | null };

/** Chromium exposes a shadow-local selection; other DOMs use the owner document. */
export function editableSelection(editable: HTMLElement): Selection | null {
  const scope = editable.getRootNode?.() as EditorRoot | undefined;
  return scope?.getSelection?.() ?? editable.ownerDocument.getSelection();
}

function selectionInside(editable: HTMLElement, selection: Selection | null): selection is Selection {
  return Boolean(selection?.rangeCount && editable.contains(selection.anchorNode) && editable.contains(selection.focusNode));
}

export interface PostEditorCallbacks {
  onChange?: (body: string) => void;
  onSaved?: (markdown: string) => void;
  onError?: (message: string) => void;
  onMediaChanged?: (items: PostMedia[], checks: MediaCheck[]) => void;
}
export interface PostEditorMount {
  editable: HTMLElement; card: HTMLElement; boldButton?: HTMLButtonElement; addButton?: HTMLButtonElement;
  mediaHost?: HTMLElement; saved?: HTMLElement; mediaCaption?: HTMLElement;
}

export class PostEditor {
  readonly media: MediaManager;
  private elements?: PostEditorMount;
  private markdown: string;
  private expectedRaw: string;
  private padding: { leading: string; trailing: string };
  private localText: string;
  private changed = false;
  private conflict = false;
  private composing = false;
  private timer?: ReturnType<typeof setTimeout>;
  private revision = 0;
  private saving = Promise.resolve('');
  private queuedRevision = -1;
  private cleanups: Array<() => void> = [];
  private disposed = false;
  private lastRange?: Range;

  constructor(readonly app: App, readonly file: TFile, markdown: string, private callbacks: PostEditorCallbacks = {}) {
    const range = findPostBodyRange(markdown), body = splitPostMedia(range.body);
    this.markdown = markdown; this.expectedRaw = range.raw; this.padding = { leading: range.leading, trailing: range.trailing }; this.localText = body.text;
    this.media = new MediaManager(app, file, body.references, {
      onChange: (_references, items, checks) => { this.touch(); this.callbacks.onMediaChanged?.(items, checks); },
      onError: message => this.error(message),
    });
  }
  get dirty(): boolean { return this.changed; }
  get isFocused(): boolean {
    const editable = this.elements?.editable;
    if (!editable) return false;
    const scope = editable.getRootNode?.() as EditorRoot | undefined;
    return editable.contains(scope?.activeElement || editable.ownerDocument.activeElement);
  }
  getBody(): string { return joinPostMedia(this.elements ? editableToMarkdown(this.elements.editable) : this.localText, this.media.getReferences()); }
  getMedia(): PostMedia[] { return this.media.getItems(); }

  mount(elements: PostEditorMount): void {
    this.unbind(); this.elements = elements;
    const { editable, card, boldButton } = elements;
    editable.contentEditable = 'true'; editable.setAttribute('spellcheck', 'false'); editable.setAttribute('role', 'textbox'); editable.setAttribute('aria-multiline', 'true');
    renderEditableMarkdown(editable, this.localText);
    const input = () => { this.localText = editableToMarkdown(editable); this.touch(); if (!this.composing) this.refreshFold(); };
    const focus = () => card.addClass('is-editing');
    const blur = () => { card.removeClass('is-editing'); this.refreshFold(); };
    const start = () => { this.composing = true; if (this.timer) clearTimeout(this.timer); };
    const end = () => { this.composing = false; input(); };
    const bold = () => this.toggleBold();
    const preserve = (event: Event) => event.preventDefault();
    const key = (event: KeyboardEvent) => { if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'b') { event.preventDefault(); bold(); } };
    const paste = (event: ClipboardEvent) => { if (event.clipboardData) { event.preventDefault(); this.insertText(event.clipboardData.getData('text/plain')); } };
    const drop = (event: DragEvent) => {
      if (event.dataTransfer && !event.dataTransfer.files.length && !event.dataTransfer.types.includes('application/x-xpd-media')) {
        event.preventDefault(); this.insertText(event.dataTransfer.getData('text/plain'));
      }
    };
    const selection = () => { const selected = editableSelection(editable); if (selectionInside(editable, selected)) this.lastRange = selected.getRangeAt(0).cloneRange(); };
    const selectionRoot = editable.getRootNode?.();
    editable.addEventListener('input', input); editable.addEventListener('focus', focus); editable.addEventListener('blur', blur);
    editable.addEventListener('compositionstart', start); editable.addEventListener('compositionend', end); editable.addEventListener('keydown', key);
    editable.addEventListener('paste', paste); editable.addEventListener('drop', drop); editable.ownerDocument.addEventListener('selectionchange', selection);
    if (selectionRoot && selectionRoot !== editable.ownerDocument) selectionRoot.addEventListener('selectionchange', selection);
    boldButton?.addEventListener('mousedown', preserve); boldButton?.addEventListener('click', bold);
    this.cleanups.push(() => editable.removeEventListener('input', input), () => editable.removeEventListener('focus', focus), () => editable.removeEventListener('blur', blur),
      () => editable.removeEventListener('compositionstart', start), () => editable.removeEventListener('compositionend', end), () => editable.removeEventListener('keydown', key),
      () => editable.removeEventListener('paste', paste), () => editable.removeEventListener('drop', drop), () => editable.ownerDocument.removeEventListener('selectionchange', selection),
      () => boldButton?.removeEventListener('mousedown', preserve), () => boldButton?.removeEventListener('click', bold));
    if (selectionRoot && selectionRoot !== editable.ownerDocument) this.cleanups.push(() => selectionRoot.removeEventListener('selectionchange', selection));
    if (elements.mediaHost) this.media.mount({ host: elements.mediaHost, dropHost: card, addButton: elements.addButton, caption: elements.mediaCaption });
    this.refreshFold(); this.callbacks.onChange?.(this.getBody()); this.callbacks.onMediaChanged?.(this.media.getItems(), this.media.checks());
  }

  /** Never rerender a user's cursor or replace unsaved local text. */
  update(markdown: string): boolean {
    if (this.dirty || this.isFocused) return false;
    const range = findPostBodyRange(markdown), body = splitPostMedia(range.body);
    this.markdown = markdown; this.expectedRaw = range.raw; this.padding = { leading: range.leading, trailing: range.trailing }; this.localText = body.text; this.conflict = false;
    this.media.setReferences(body.references);
    if (this.elements) renderEditableMarkdown(this.elements.editable, body.text);
    this.refreshFold(); this.callbacks.onChange?.(this.getBody()); this.callbacks.onMediaChanged?.(this.media.getItems(), this.media.checks()); return true;
  }

  toggleBold(): void {
    const editable = this.elements?.editable; if (!editable) return;
    const document = editable.ownerDocument;
    let selection = editableSelection(editable);
    if (!selectionInside(editable, selection)) {
      editable.focus(); selection = editableSelection(editable);
      if (this.lastRange && editable.contains(this.lastRange.startContainer) && editable.contains(this.lastRange.endContainer)) {
        selection?.removeAllRanges(); selection?.addRange(this.lastRange);
      }
    }
    if (!selectionInside(editable, selection)) return;
    document.execCommand('styleWithCSS', false, 'false'); document.execCommand('bold', false);
    this.localText = editableToMarkdown(editable); this.touch(); this.refreshFold();
  }

  async flush(): Promise<string> {
    if (this.timer) { clearTimeout(this.timer); this.timer = undefined; }
    if (!this.changed) return this.saving.then(() => this.markdown);
    if (this.queuedRevision === this.revision) return this.saving;
    const body = this.getBody(), revision = this.revision;
    this.queuedRevision = revision;
    const job = this.saving.catch(() => '').then(async () => {
      let written = '';
      await this.app.vault.process(this.file, latest => {
        if (findPostBodyRange(latest).raw !== this.expectedRaw) throw new PostEditConflictError();
        written = replacePostBody(latest, body, this.padding); return written;
      });
      this.markdown = written; this.expectedRaw = findPostBodyRange(written).raw; this.conflict = false;
      if (revision === this.revision) this.changed = false;
      if (this.queuedRevision === revision) this.queuedRevision = -1;
      if (!this.disposed) {
        const saved = this.elements?.saved;
        if (saved) { saved.className = this.changed ? 'xpd-saving' : 'xpd-saved'; saved.setText(this.changed ? '正在保存…' : '✓ 已存进笔记 · 刚刚'); }
        this.callbacks.onSaved?.(written);
      }
      return written;
    });
    this.saving = job;
    try { return await job; } catch (error) {
      if (this.queuedRevision === revision) this.queuedRevision = -1;
      this.conflict = error instanceof PostEditConflictError;
      if (!this.disposed) { this.elements?.saved?.setText(this.conflict ? '正文有冲突，修改还留在这里' : '保存未完成'); this.error(error instanceof Error ? error.message : String(error)); }
      throw error;
    }
  }

  dispose(): void {
    if (this.timer) { clearTimeout(this.timer); this.timer = undefined; }
    const pending = this.dirty && !this.conflict ? this.flush().catch(() => {}) : undefined;
    this.disposed = true; this.unbind(); this.media.dispose(); void pending;
  }
  private unbind(): void { for (const cleanup of this.cleanups.splice(0)) cleanup(); }
  private error(message: string): void { if (this.callbacks.onError) this.callbacks.onError(message); else new Notice(message, 10000); }
  private touch(): void {
    this.changed = true; this.revision++;
    if (this.elements?.saved) { this.elements.saved.className = 'xpd-saving'; this.elements.saved.setText('正在保存…'); }
    this.callbacks.onChange?.(this.getBody());
    if (this.timer) clearTimeout(this.timer);
    if (!this.composing && !this.conflict) this.timer = setTimeout(() => { this.timer = undefined; void this.flush().catch(() => {}); }, 1000);
  }
  private insertText(text: string): void {
    const editable = this.elements?.editable; if (!editable) return;
    editable.ownerDocument.execCommand('insertText', false, text.replace(/\r\n/g, '\n'));
    this.localText = editableToMarkdown(editable); this.touch(); this.refreshFold();
  }
  private refreshFold(): void {
    const editable = this.elements?.editable; if (!editable || this.composing) return;
    for (const marker of [...editable.querySelectorAll<HTMLElement>('[data-xpd-decoration="true"]')]) marker.remove();
    const stats = postStats(editableToMarkdown(editable));
    let position = 0, inserted = false;
    for (const child of [...editable.childNodes]) {
      const serialized = child.nodeType === 1 ? editableToMarkdown(child as HTMLElement) : child.nodeValue || '';
      const line = textRuns(serialized).map(run => run.text).join('');
      const folded = stats.weightedLength > 280 && position >= stats.foldIndex;
      if (child.nodeType === 1) (child as HTMLElement).toggleClass('xpd-folded', folded);
      if (folded && !inserted) {
        const marker = editable.ownerDocument.createElement('div'); marker.className = 'xpd-fold'; marker.dataset.xpdDecoration = 'true'; marker.contentEditable = 'false';
        marker.createSpan({ text: '时间线在这里折叠 · 280' }); editable.insertBefore(marker, child); inserted = true;
      }
      position += line.length + 1;
    }
  }
}
