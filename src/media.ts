import { App, Notice, TFile } from 'obsidian';

import { config } from './config';

const attachmentFolder = (): string => config.attachments.replace(/^\/+|\/+$/g, '');
export interface MediaCheck { text: string; warning: boolean; }
export type MediaKind = 'image' | 'gif' | 'video' | 'unsupported';
export interface PostMedia {
  reference: string; name: string; file: TFile | null; kind: MediaKind; size: number; resourceUrl: string | null;
}
export interface MediaCallbacks {
  onChange?: (references: string[], items: PostMedia[], checks: MediaCheck[]) => void;
  onError?: (message: string) => void;
}
export interface MediaMount {
  host: HTMLElement; dropHost: HTMLElement; addButton?: HTMLButtonElement; caption?: HTMLElement;
}

export function mediaKind(filename: string): MediaKind {
  const extension = filename.split('.').pop()?.toLowerCase();
  if (['jpg', 'jpeg', 'png', 'webp'].includes(extension || '')) return 'image';
  if (extension === 'gif') return 'gif';
  if (['mp4', 'mov'].includes(extension || '')) return 'video';
  return 'unsupported';
}

/** Only standalone embeds are media. Other note bytes are never handled here. */
export function splitPostMedia(body: string): { text: string; references: string[] } {
  const references: string[] = [];
  const lines = body.replace(/\r\n/g, '\n').split('\n');
  const text = lines.filter(line => {
    const match = /^\s*!\[\[([^\]\r\n]+)\]\]\s*$/.exec(line);
    if (!match) return true;
    references.push(match[1]); return false;
  }).join('\n');
  return { text: references.length ? text.replace(/\n+$/, '') : text, references };
}

export function joinPostMedia(text: string, references: readonly string[]): string {
  if (!references.length) return text.replace(/\r\n/g, '\n');
  const clean = text.replace(/\r\n/g, '\n').replace(/\n+$/, '');
  return clean + (references.length ? (clean ? '\n\n' : '') + references.map(reference => `![[${reference}]]`).join('\n') : '');
}

export function mediaChecks(items: readonly PostMedia[]): MediaCheck[] {
  const warnings: MediaCheck[] = [];
  if (items.length > 4) warnings.push({ warning: true, text: `配图 ${items.length} / 4，推文最多放 4 张图片` });
  if (items.some(item => item.kind === 'gif' || item.kind === 'video') && items.length !== 1) {
    warnings.push({ warning: true, text: 'GIF／视频只能放 1 个，不能和其他配图混用' });
  }
  for (const item of items) {
    if (!item.file) warnings.push({ warning: true, text: `配图找不到：${item.name}` });
    if (item.kind === 'unsupported') warnings.push({ warning: true, text: `${item.name} 格式不支持；图片用 jpg、png 或 webp` });
    if (item.kind === 'image' && item.size > 5 * 1024 * 1024) warnings.push({ warning: true, text: `${item.name} 超过 5MB` });
    if (item.kind === 'gif' && item.size > 15 * 1024 * 1024) warnings.push({ warning: true, text: `${item.name} 超过 15MB` });
  }
  return [...warnings, ...(warnings.length ? [] : [{ warning: false, text: `配图 ${items.length} / 4` }, ...(items.length ? [{ warning: false, text: '配图格式、大小符合要求' }] : [])])];
}

export function resolvePostMedia(app: App, source: TFile, references: readonly string[]): PostMedia[] {
  return references.map(reference => {
    const target = reference.split('|')[0].split('#')[0].trim();
    const found = app.metadataCache.getFirstLinkpathDest(target, source.path) || app.vault.getAbstractFileByPath(target) || app.vault.getAbstractFileByPath(`${attachmentFolder()}/${target}`);
    const file = found instanceof TFile ? found : null;
    const name = file?.name || target.split('/').pop() || target;
    return { reference, name, file, kind: mediaKind(name), size: file?.stat.size || 0, resourceUrl: file ? app.vault.getResourcePath(file) : null };
  });
}

function safeFilename(name: string): string {
  const cleaned = name.split(/[\\/]/).pop()?.replace(/[\\/:*?"<>|\[\]#^]/g, '-').trim() || '';
  if (!cleaned || cleaned === '.' || cleaned === '..') throw new Error('文件名不正确，请重新选择图片');
  return cleaned;
}

/** Copy user-selected files only. The pure editor does not call any uploader. */
export async function copyAttachments(app: App, files: Iterable<File>): Promise<TFile[]> {
  const selected = [...files];
  const previous = attachmentQueues.get(app) || Promise.resolve();
  const current = previous.catch(() => {}).then(() => copySelectedAttachments(app, selected));
  attachmentQueues.set(app, current.then(() => {}, () => {}));
  return current;
}
const attachmentQueues = new WeakMap<App, Promise<void>>();

async function copySelectedAttachments(app: App, selected: File[]): Promise<TFile[]> {
  for (const file of selected) {
    if (mediaKind(safeFilename(file.name)) === 'unsupported') throw new Error('只支持 jpg、png、webp、GIF 或视频');
  }
  if (!selected.length) return [];
  if (!app.vault.getAbstractFileByPath(attachmentFolder())) await app.vault.createFolder(attachmentFolder());
  const copied: TFile[] = [];
  for (const source of selected) {
    const name = safeFilename(source.name);
    const dot = name.lastIndexOf('.');
    const stem = dot > 0 ? name.slice(0, dot) : name, extension = dot > 0 ? name.slice(dot) : '';
    let filename = name, index = 2;
    // A basename embed must resolve unambiguously even when other folders use
    // the original filename. Never replace an existing attachment.
    const existingNames = new Set(app.vault.getFiles().map(file => file.name.toLowerCase()));
    while (existingNames.has(filename.toLowerCase()) || app.vault.getAbstractFileByPath(`${attachmentFolder()}/${filename}`)) filename = `${stem}-${index++}${extension}`;
    copied.push(await app.vault.createBinary(`${attachmentFolder()}/${filename}`, await source.arrayBuffer()));
  }
  return copied;
}

export class MediaManager {
  private references: string[];
  private elements?: MediaMount;
  private cleanups: Array<() => void> = [];
  private input?: HTMLInputElement;
  private disposed = false;
  private readonly dragId = String(Date.now()) + '-' + String(Math.random());
  constructor(readonly app: App, readonly file: TFile, references: readonly string[], private callbacks: MediaCallbacks = {}) {
    this.references = [...references];
  }
  getReferences(): string[] { return [...this.references]; }
  getItems(): PostMedia[] { return resolvePostMedia(this.app, this.file, this.references); }
  checks(): MediaCheck[] { return mediaChecks(this.getItems()); }
  setReferences(references: readonly string[]): void { this.references = [...references]; this.render(); }

  mount(elements: MediaMount): void {
    this.unbind(); this.elements = elements;
    const { dropHost, addButton } = elements;
    const document = dropHost.ownerDocument;
    this.input = document.createElement('input');
    this.input.type = 'file'; this.input.multiple = true;
    this.input.accept = '.jpg,.jpeg,.png,.webp,.gif,.mp4,.mov'; this.input.hidden = true;
    elements.host.parentElement?.append(this.input);
    const choose = () => this.input?.click();
    const changed = () => { if (this.input?.files) void this.addFiles(this.input.files).catch(error => this.error(error)); if (this.input) this.input.value = ''; };
    addButton?.addEventListener('click', choose); this.input.addEventListener('change', changed);
    const over = (event: DragEvent) => {
      if (!event.dataTransfer || ![...event.dataTransfer.types].some(type => type === 'Files' || type === 'application/x-xpd-media')) return;
      event.preventDefault(); dropHost.addClass('is-dragover');
    };
    const leave = (event: DragEvent) => { if (!(event.relatedTarget instanceof Node) || !dropHost.contains(event.relatedTarget)) dropHost.removeClass('is-dragover'); };
    const drop = (event: DragEvent) => {
      if (!event.dataTransfer) return;
      dropHost.removeClass('is-dragover');
      if (event.dataTransfer.files.length) { event.preventDefault(); void this.addFiles(event.dataTransfer.files).catch(error => this.error(error)); }
    };
    dropHost.addEventListener('dragover', over); dropHost.addEventListener('dragleave', leave); dropHost.addEventListener('drop', drop);
    this.cleanups.push(() => addButton?.removeEventListener('click', choose), () => this.input?.removeEventListener('change', changed),
      () => dropHost.removeEventListener('dragover', over), () => dropHost.removeEventListener('dragleave', leave), () => dropHost.removeEventListener('drop', drop));
    this.render();
  }

  async addFiles(files: Iterable<File>): Promise<string[]> {
    const copied = await copyAttachments(this.app, files);
    const added = copied.map(file => file.name);
    if (this.disposed) return added;
    this.references.push(...added); this.changed(); return added;
  }
  remove(index: number): void { if (index < 0 || index >= this.references.length) return; this.references.splice(index, 1); this.changed(); }
  move(from: number, to: number): void {
    if (from === to || from < 0 || to < 0 || from >= this.references.length || to >= this.references.length) return;
    const [reference] = this.references.splice(from, 1); this.references.splice(to, 0, reference); this.changed();
  }
  dispose(): void { this.disposed = true; this.unbind(); this.elements?.host.empty(); }
  private unbind(): void { for (const cleanup of this.cleanups.splice(0)) cleanup(); this.input?.remove(); this.input = undefined; }
  private error(error: unknown): void { const message = error instanceof Error ? error.message : String(error); if (this.callbacks.onError) this.callbacks.onError(message); else new Notice(message); }
  private changed(): void { this.render(); const items = this.getItems(); this.callbacks.onChange?.(this.getReferences(), items, mediaChecks(items)); }
  private render(): void {
    const elements = this.elements; if (!elements) return;
    const items = this.getItems(); elements.host.empty(); elements.host.className = items.length ? `xpd-media n${Math.max(1, Math.min(4, items.length))}` : ''; elements.host.hidden = !items.length;
    if (elements.caption) { elements.caption.hidden = !items.length; elements.caption.setText(`配图 ${items.length} / 4 · 拖到帖子上也能加，拖动换顺序`); }
    items.forEach((item, index) => {
      const node = elements.host.createDiv({ cls: 'xpd-media-item' }); node.draggable = true;
      if (item.resourceUrl && (item.kind === 'image' || item.kind === 'gif')) node.createEl('img', { attr: { src: item.resourceUrl, alt: item.name, draggable: 'false' } });
      else if (item.resourceUrl && item.kind === 'video') node.createEl('video', { attr: { src: item.resourceUrl, controls: '', preload: 'metadata' } });
      else node.createSpan({ text: item.name });
      const remove = node.createEl('button', { text: '×', cls: 'xpd-media-remove clickable-icon', attr: { 'aria-label': '删掉这张图', type: 'button' } });
      remove.onclick = event => { event.stopPropagation(); this.remove(index); };
      node.ondragstart = event => { event.dataTransfer?.setData('application/x-xpd-media', JSON.stringify({ owner: this.dragId, index })); };
      node.ondragover = event => { if (event.dataTransfer?.types.includes('application/x-xpd-media')) { event.preventDefault(); event.stopPropagation(); } };
      node.ondrop = event => {
        try { const drag = JSON.parse(event.dataTransfer?.getData('application/x-xpd-media') || '{}') as { owner?: string; index?: number };
          if (drag.owner === this.dragId && typeof drag.index === 'number') { event.preventDefault(); event.stopPropagation(); elements.dropHost.removeClass('is-dragover'); this.move(drag.index, index); }
        } catch { /* External drops are handled by the card. */ }
      };
    });
  }
}
