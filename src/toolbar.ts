import { Command, MarkdownView, Notice, Plugin, TFile, setIcon } from 'obsidian';
import { Backend, isEligibleFile, UploadKind, UploadResult } from './backend';
import { metadata, noteMode, quoteLink } from './model';
import { UploadStatus, type UploadContext } from './upload-status';

interface Version { label: string; text: string; start: number; end: number; }

export function parseVersions(markdown: string): { body: RegExpExecArray | null; versions: Version[] } {
  const body = /^## 正文\s*\n([\s\S]*?)(?=^## |^---\s*$|(?![\s\S]))/m.exec(markdown);
  const section = /^## 备选版本\s*\n([\s\S]*?)(?=^%%|^## |(?![\s\S]))/m.exec(markdown);
  if (!body || !section) return { body, versions: [] };
  const versions: Version[] = [];
  const expression = /^> \*\*(版本 [A-Z]｜[^\n]+)\*\*\s*\n([\s\S]*?)(?=^> \*\*(?:版本 [A-Z]｜|选择理由)|^%%|(?![\s\S]))/gm;
  let match: RegExpExecArray | null;
  while ((match = expression.exec(section[0]))) {
    const text = match[2].split('\n').map(line => line.replace(/^> ?/, '')).join('\n').trim();
    if (text) versions.push({ label: match[1], text, start: section.index + match.index, end: section.index + match.index + match[0].length });
  }
  return { body, versions };
}

export function quoteAccount(markdown: string): string | null { return accountFromQuote(metadata(markdown).quote); }
function accountFromQuote(quote: unknown): string | null { const link = quoteLink(quote); return link ? link.author.slice(1) : null; }

/** Keep the date in expires_at's own timezone; do not shift it to local time. */
export function toolbarReviewChip(frontmatter: Record<string, unknown>, now = Date.now()): { text: string; cls: string } {
  const expires = typeof frontmatter.expires_at === 'string' ? frontmatter.expires_at : '';
  const expired = expires && Number.isFinite(Date.parse(expires)) && Date.parse(expires) < now;
  if (expired) return { text: '核验已过期', cls: 'is-warn' };
  if (frontmatter.delivery_ready !== true) return { text: '未验收', cls: 'is-warn' };
  const date = /^\d{4}-\d{2}-\d{2}/.test(expires) ? expires.slice(5, 10) : '';
  return { text: date ? '已验收 · 有效至 ' + date : '已验收', cls: 'is-ok' };
}

interface UploadControls {
  container: HTMLElement; bar: HTMLElement; chips?: HTMLElement; compare?: HTMLButtonElement;
  statusHost: HTMLElement; upload: UploadStatus; context: UploadContext; getFile: () => TFile | null;
  view?: MarkdownView; generation: number; lastVersionMarkdown?: string;
}

// The internal command registry retains old full IDs and existing keyboard shortcuts.
interface LegacyCommandRegistry { addCommand(command: Command): unknown; removeCommand(id: string): void; }

export class Toolbar {
  private readonly controls = new Set<UploadControls>();
  private readonly bars = new Map<MarkdownView, UploadControls>();
  private disposed = false;
  private registered = false;
  constructor(readonly plugin: Plugin, readonly backend: Backend, private hooks: {
    css?: string; open?: (file: TFile) => Promise<void>; currentFile?: () => TFile | null;
    upload?: (kind: UploadKind) => Promise<UploadResult | undefined>;
    beforeLearning?: () => Promise<void>;
  } = {}) {}

  register(): void {
    if (this.registered) return;
    this.registered = true;
    const app = this.plugin.app;
    const commandDefinitions: Command[] = [
      { id: 'record-current-revision', name: '改稿完成，供 AI 学习', callback: async () => { await this.hooks.beforeLearning?.(); return this.backend.recordRevision(this.hooks.currentFile?.() || app.workspace.getActiveFile()); } },
      { id: 'upload-current-to-x-draft', name: '普通推文：保存到 X 草稿箱', callback: () => this.uploadCurrent('post') },
      { id: 'upload-current-to-x-article', name: '长文：保存到 X Articles 草稿', callback: () => this.uploadCurrent('article') },
    ];
    const registry = (app as unknown as { commands?: LegacyCommandRegistry }).commands;
    for (const command of commandDefinitions) {
      this.plugin.addCommand({ ...command });
      if (registry) {
        const alias = { ...command, id: 'x-post-draft-helper:' + command.id };
        registry.addCommand(alias); this.plugin.register(() => registry.removeCommand(alias.id));
      }
    }
    this.plugin.addRibbonIcon('send', '普通推文：保存到 X 草稿箱', () => { void this.uploadCurrent('post'); });
    this.plugin.addRibbonIcon('file-text', '长文：保存到 X Articles 草稿', () => { void this.uploadCurrent('article'); });
    const panel = (source: string, element: HTMLElement): void => {
      const targets = source.split(/\r?\n/).map(line => line.trim()).filter(Boolean);
      if (!targets.length) targets.push('');
      for (const target of targets) {
        const outer = element.createDiv({ cls: 'xpd-root' });
        let root=outer;
        if(this.hooks.css) {
          const shadow=outer.attachShadow({mode:'open'}),style=document.createElement('style');style.textContent=this.hooks.css;shadow.append(style);
          const frame=document.createElement('div');frame.className=document.body.hasClass('theme-dark')?'theme-dark':'';shadow.append(frame);
          root=frame.createDiv({cls:'xpd-root'});
        }
        if (target) {
          const title = root.createEl('a', { text: target.split('/').pop()?.replace(/\.md$/, '') || target });
          title.onclick = () => { void app.workspace.openLinkText(target, '', false); };
        }
        const bar = root.createDiv({ cls: 'xpd-toolbar' });
        const control = this.createControls(root, bar, () => {
          const file = target ? app.vault.getAbstractFileByPath(target) : app.workspace.getActiveFile();
          return file instanceof TFile ? file : null;
        });
        this.updateControl(control);
      }
    };
    this.plugin.registerMarkdownCodeBlockProcessor('x-draft', panel);
    this.plugin.registerMarkdownCodeBlockProcessor('x-publish', panel);
    app.workspace.onLayoutReady(() => this.refresh());
    this.plugin.registerEvent(app.workspace.on('layout-change', () => this.refresh()));
    this.plugin.registerEvent(app.workspace.on('active-leaf-change', () => this.refresh()));
    this.plugin.registerEvent(app.workspace.on('file-open', () => this.refresh()));
    this.plugin.registerEvent(app.workspace.on('editor-change', (_editor, view) => {
      if (view instanceof MarkdownView) for (const control of this.controls) {
        if (control.getFile()?.path === view.file?.path) this.updateControl(control, view);
      }
    }));
    this.plugin.registerEvent(app.vault.on('modify', file => { if (file instanceof TFile && file.extension === 'md') this.refresh(); }));
    this.plugin.registerEvent(app.metadataCache.on('changed', () => this.updateControls()));
    if(typeof MutationObserver !== 'undefined') { const themes=new MutationObserver(()=>{for(const control of this.controls){const frame=control.container.parentElement;if(control.container.getRootNode() instanceof ShadowRoot)frame?.toggleClass('theme-dark',document.body.hasClass('theme-dark'));}});themes.observe(document.body,{attributes:true,attributeFilter:['class']});this.plugin.register(()=>themes.disconnect()); }
    this.plugin.register(() => this.dispose());
  }

  refresh(): void {
    if (this.disposed) return;
    const liveViews = new Set<MarkdownView>();
    for (const leaf of this.plugin.app.workspace.getLeavesOfType('markdown')) {
      const view = leaf.view;
      if (!(view instanceof MarkdownView)) continue;
      liveViews.add(view);
      const prior = view.containerEl.querySelector<HTMLElement>('[data-xpd-open]');
      if (!isEligibleFile(view.file)) { prior?.remove(); continue; }
      if (!prior) {
        const root = document.createElement('div'); root.className = 'xpd-root'; root.dataset.xpdOpen = 'true';
        const button = root.createEl('button', { text: '在 X 发布台打开', cls: 'xpd-btn clickable-icon' }); button.type = 'button';
        button.onclick = () => { if (view.file) void this.hooks.open?.(view.file); };
        view.contentEl.parentElement?.insertBefore(root, view.contentEl);
      }
    }
    this.updateControls();
  }

  dispose(): void {
    this.disposed = true;
    for (const control of this.controls) { control.upload.dispose(); control.container.remove(); }
    this.controls.clear(); this.bars.clear(); this.plugin.app.workspace.getLeavesOfType('markdown').forEach(leaf => leaf.view.containerEl.querySelector('[data-xpd-open]')?.remove());
  }

  private createControls(root: HTMLElement, bar: HTMLElement, getFile: () => TFile | null, view?: MarkdownView): UploadControls {
    const file = getFile();
    const context: UploadContext = { file, kind: file && noteMode(file.path) === 'article' ? 'article' : 'post', quote: null };
    const button = bar.createEl('button', { cls: 'xpd-btn-primary' });
    const statusHost = root.createDiv();
    let control: UploadControls | undefined;
    const upload = new UploadStatus(button, statusHost, this.backend, () => control?.context || context, () => this.syncBusy());
    control = { container: root, bar, statusHost, upload, context, getFile, view, generation: 0 };
    this.controls.add(control); return control;
  }
  private removeControl(control: UploadControls): void { control.upload.dispose(); control.container.remove(); this.controls.delete(control); }
  private syncBusy(): void { for (const control of this.controls) control.upload.syncBusy(); }
  private async uploadCurrent(kind: UploadKind): Promise<UploadResult | undefined> {
    if (this.hooks.upload && this.hooks.currentFile?.()) return this.hooks.upload(kind);
    const file = this.plugin.app.workspace.getActiveFile();
    const control = [...this.controls].find(item => item.getFile()?.path === file?.path && item.container.isConnected);
    if (control) { this.updateControl(control); return control.upload.run(kind); }
    const pending = this.backend.upload(file, undefined, kind);
    this.syncBusy();
    try { return await pending; } finally { this.syncBusy(); }
  }
  private updateControls(): void {
    for (const control of this.controls) {
      if (!control.container.isConnected) { control.upload.dispose(); this.controls.delete(control); continue; }
      this.updateControl(control);
    }
  }

  private updateControl(control: UploadControls, editingView?: MarkdownView): void {
    const file = control.getFile(), generation = ++control.generation, app = this.plugin.app;
    const setMarkdown = (markdown: string | undefined, frontmatter: Record<string, unknown>): void => {
      if (this.disposed || control.generation !== generation || control.getFile()?.path !== file?.path) return;
      const kind = file && noteMode(file.path) === 'article' ? 'article' : 'post';
      const quote = kind === 'post' ? accountFromQuote(frontmatter.quote) : null;
      control.context = { file, kind, quote, fingerprint: markdown ?? JSON.stringify(frontmatter) };
      control.upload.setContext(control.context);
      if (control.compare) control.compare.hidden = kind === 'article';
      if (control.chips) this.renderChips(control.chips, kind, quote, frontmatter);
      if (control.view && markdown !== undefined) this.renderVersions(control, control.view, markdown);
    };
    if (!file) { setMarkdown('', {}); return; }
    const candidate = editingView || control.view || app.workspace.getActiveViewOfType(MarkdownView);
    const view = candidate?.file?.path === file.path && candidate.getMode() === 'source' ? candidate
      : app.workspace.getLeavesOfType('markdown').map(leaf => leaf.view).find((item): item is MarkdownView => item instanceof MarkdownView && item.file?.path === file.path && item.getMode() === 'source');
    if (view) { const markdown = view.editor.getValue(); setMarkdown(markdown, metadata(markdown)); return; }
    if (control.context.file?.path !== file.path) setMarkdown(undefined, app.metadataCache.getFileCache(file)?.frontmatter || {});
    void app.vault.cachedRead(file).then(markdown => setMarkdown(markdown, metadata(markdown))).catch(() => {});
  }

  private renderChips(chips: HTMLElement, kind: UploadKind, quote: string | null, frontmatter: Record<string, unknown>): void {
    chips.empty(); chips.createSpan({ cls: 'xpd-chip is-kind', text: kind === 'article' ? '长文' : '推文' });
    const review = toolbarReviewChip(frontmatter); chips.createSpan({ cls: 'xpd-chip ' + review.cls, text: review.text });
    if (quote) { const chip = chips.createSpan({ cls: 'xpd-chip' }); setIcon(chip, 'arrow-up-right'); chip.appendText('引用 @' + quote); }
    const formatter = frontmatter.formatter && typeof frontmatter.formatter === 'object' ? frontmatter.formatter as Record<string, unknown> : {};
    const cover = frontmatter.cover || frontmatter.Cover || formatter.cover || formatter.Cover;
    if (kind === 'article' && !(typeof cover === 'string' && cover.trim())) chips.createSpan({ cls: 'xpd-chip is-warn', text: '没有封面图' });
  }

  private renderVersions(control: UploadControls, view: MarkdownView, markdown: string): void {
    if (control.lastVersionMarkdown === markdown) return;
    control.lastVersionMarkdown = markdown; control.container.querySelector('.xpd-version')?.remove();
    const { versions } = parseVersions(markdown); if (!versions.length) return;
    const box = document.createElement('div'); box.className = 'xpd-version'; control.container.insertBefore(box, control.statusHost);
    box.createSpan({ text: '上传用哪一版：' });
    const current = box.createEl('button', { text: '正文', cls: 'is-active' }); current.type = 'button';
    for (const version of versions) {
      const letter = /^版本 ([A-Z])/.exec(version.label)?.[1] || version.label;
      const button = box.createEl('button', { text: '备选 ' + letter }); button.type = 'button'; button.title = version.label;
      button.onclick = async () => {
        button.disabled = true;
        try { await this.selectVersion(view, version.label); }
        catch (error) { new Notice(error instanceof Error ? error.message : String(error)); }
        finally { button.disabled = false; }
      };
    }
  }

  private async selectVersion(view: MarkdownView, label: string): Promise<void> {
    if (this.backend.busy) throw new Error('请等待当前上传结束再切换');
    const file = view.file; if (!file) throw new Error('请重新打开这篇笔记');
    const markdown = await this.plugin.app.vault.read(file); if (view.file !== file) throw new Error('笔记已切换，请重新选择');
    for (const leaf of this.plugin.app.workspace.getLeavesOfType('markdown')) {
      const other = leaf.view;
      if (other instanceof MarkdownView && other.file?.path === file.path && other.getMode() === 'source' && other.editor.getValue() !== markdown) throw new Error('请等笔记保存后再切换');
    }
    const { body, versions } = parseVersions(markdown), selected = versions.find(version => version.label === label);
    if (!body || !selected) throw new Error('备选版本已变化，请重新选择');
    const current = /^selected_version: (.+)$/m.exec(markdown)?.[1] || '版本 A｜原推荐稿';
    const quoted = body[1].trim().split('\n').map(line => '> ' + line).join('\n');
    let next = markdown.slice(0, selected.start) + '> **' + current + '**\n>\n' + quoted + '\n>\n' + markdown.slice(selected.end);
    next = next.slice(0, body.index) + '## 正文\n\n' + selected.text + '\n\n' + next.slice(body.index + body[0].length);
    next = /^selected_version: /m.test(next) ? next.replace(/^selected_version: .+$/m, 'selected_version: ' + label) : next.replace(/^---\n/, '---\nselected_version: ' + label + '\n');
    next = next.replace(/^> \*\*选择理由：\*\*.*$/m, '> **选择理由：** 已手动选择' + label + '；原正文保留为备选。');
    await this.plugin.app.vault.process(file, latest => { if (latest !== markdown) throw new Error('笔记已变化，请重新选择'); return next; });
    new Notice('已将' + label.split('｜')[0] + '设为正文，上传按钮将使用这篇。'); this.refresh();
  }
}
