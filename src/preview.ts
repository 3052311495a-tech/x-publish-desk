import { Component, ItemView, MarkdownView, TFile, WorkspaceLeaf } from 'obsidian';
import type { EditorView } from '@codemirror/view';
import { metadata, noteMode } from './model';
import { renderPost, renderChecks, type CheckItem } from './post';
import { renderArticle } from './article';
import type { Embeds } from './embeds';

export const PREVIEW_TYPE = 'x-publish-desk-preview';
export class DeskPreview extends ItemView {
  private renderComponent?: Component;
  private unlinkScroll?: () => void;
  private revision = 0;
  private activeTab: 'preview' | 'checks' = 'preview';
  constructor(leaf: WorkspaceLeaf, private embeds: Embeds) { super(leaf); }
  getViewType() { return PREVIEW_TYPE; }
  getDisplayText() { return 'X 预览'; }
  getIcon() { return 'file-text'; }
  async onOpen() { this.contentEl.removeClass('view-content'); this.contentEl.addClass('xpd-pane'); this.showEmpty(); }
  async onClose() { this.revision++; this.renderComponent?.unload(); this.unlinkScroll?.(); }
  showEmpty() {
    this.revision++; this.renderComponent?.unload(); this.unlinkScroll?.();
    this.contentEl.empty();
    this.contentEl.createDiv({ cls: 'xpd-pane-body' }).createDiv({ cls: 'xpd-caption', text: '打开创作中的推文或长文，即可实时预览' });
  }
  async render(file: TFile, markdown: string, source?: MarkdownView) {
    const token = ++this.revision;
    this.renderComponent?.unload(); this.unlinkScroll?.();
    const component = this.renderComponent = new Component(); component.load();
    this.contentEl.empty();
    const root = this.contentEl;
    root.dataset.notePath = file.path; root.dataset.mode = noteMode(file.path) || '';
    const tabs = root.createDiv({ cls: 'xpd-tabs', attr: { role: 'tablist', 'aria-label': 'X 预览' } });
    const previewTab = tabs.createEl('button', { cls: 'xpd-tab', text: '预览', attr: { role: 'tab', type: 'button' } });
    const checksTab = tabs.createEl('button', { cls: 'xpd-tab', text: '检查', attr: { role: 'tab', type: 'button' } });
    if (noteMode(file.path) === 'article') tabs.createSpan({ cls: 'xpd-sync', text: '跟随左侧滚动 ●' });
    const host = document.createElement('div'); host.className = 'xpd-pane-body';
    const checksHost = document.createElement('div'); checksHost.className = 'xpd-pane-body';
    const checksBox = checksHost.createDiv({ cls: 'xpd-checks' });
    let rendered = false;
    const bindScroll = () => {
      this.unlinkScroll?.();
      if (!rendered || this.activeTab !== 'preview' || noteMode(file.path) !== 'article' || !source) return;
      requestAnimationFrame(() => {
        if (token !== this.revision || this.activeTab !== 'preview') return;
        this.unlinkScroll?.();
        const article = host.querySelector<HTMLElement>('.xpd-article');
        const target = article && article.scrollHeight > article.clientHeight + 2 ? article : host;
        this.unlinkScroll = syncScroll(source, target, markdown);
      });
    };
    const select = (tab: 'preview' | 'checks') => {
      this.activeTab = tab; host.remove(); checksHost.remove();
      root.append(tab === 'preview' ? host : checksHost);
      previewTab.toggleClass('is-active', tab === 'preview'); checksTab.toggleClass('is-active', tab === 'checks');
      previewTab.setAttribute('aria-selected', String(tab === 'preview')); checksTab.setAttribute('aria-selected', String(tab === 'checks'));
      bindScroll();
    };
    previewTab.onclick = () => select('preview'); checksTab.onclick = () => select('checks');
    select(this.activeTab);
    const updateChecks = (items: CheckItem[]) => {
      if (token !== this.revision) return;
      renderChecks(checksBox, items);
      checksTab.querySelector('.xpd-badge')?.remove();
      const warnings = items.filter(item => item.warning).length;
      if (warnings) checksTab.createSpan({ cls: 'xpd-badge', text: String(warnings) });
    };
    try {
      if (noteMode(file.path) === 'post') await renderPost(host, markdown, metadata(markdown), url => this.embeds.get(url), updateChecks);
      else {
        const fm = metadata(markdown), checks: CheckItem[] = [];
        if (!fm.cover) checks.push({ warning: true, text: '没有封面图' });
        if (fm.delivery_ready !== true) checks.push({ warning: true, text: '还没验收' });
        if (typeof fm.expires_at === 'string' && Date.parse(fm.expires_at) < Date.now()) checks.push({ warning: true, text: '核验已过期，先重新核实再上传' });
        updateChecks(checks);
        await renderArticle(host, { app: this.app, component, file, markdown, frontmatter: fm, getEmbed: url => this.embeds.get(url) });
      }
      if (token !== this.revision) return;
      rendered = true; bindScroll();
    } catch (error) {
      if (token === this.revision) { host.empty(); host.createDiv({ cls: 'xpd-alert', text: '预览暂不可用，请检查笔记格式' }); }
      console.error('X 发布台预览', error);
    }
  }
}

function syncScroll(source: MarkdownView, target: HTMLElement, markdown: string): () => void {
  const scroller = source.getMode() === 'source' ? source.containerEl.querySelector<HTMLElement>('.cm-scroller') : source.containerEl.querySelector<HTMLElement>('.markdown-preview-view');
  if (!scroller) return () => {};
  let locking = false, frame = 0;
  const cm = (source.editor as unknown as { cm?: EditorView }).cm;
  const readingSections = () => {
    const view = source as unknown as { previewMode?: { renderer?: { sections?: Array<{ el: HTMLElement; start: { line: number }; end: { line: number } }> } } };
    return (view.previewMode?.renderer?.sections || []).filter(section => section.el?.offsetHeight > 0 && Number.isFinite(section.start?.line));
  };
  const totalLines = markdown.split('\n').length - 1;
  const anchors = () => Array.from(target.querySelectorAll<HTMLElement>('[data-source-line]')).filter(el => el.offsetHeight > 0).map(el => ({
    line: Number(el.dataset.sourceLine), y: el.getBoundingClientRect().top - target.getBoundingClientRect().top + target.scrollTop
  })).sort((a, b) => a.line - b.line);
  const interpolate = (value: number, reverse = false) => {
    const points = [{ line: 0, y: 0 }, ...anchors(), { line: totalLines, y: Math.max(0, target.scrollHeight - target.clientHeight) }];
    const getX = (p: typeof points[number]) => reverse ? p.y : p.line;
    const getY = (p: typeof points[number]) => reverse ? p.line : p.y;
    points.sort((a, b) => getX(a) - getX(b));
    for (let i = 1; i < points.length; i++) {
      const a = points[i - 1], b = points[i];
      if (value <= getX(b)) return getY(a) + (getY(b) - getY(a)) * Math.max(0, Math.min(1, (value - getX(a)) / Math.max(1, getX(b) - getX(a))));
    }
    return getY(points[points.length - 1]);
  };
  const hold = (action: () => void) => {
    if (locking) return; locking = true; action();
    frame = requestAnimationFrame(() => { frame = requestAnimationFrame(() => { locking = false; }); });
  };
  const fromSource = () => hold(() => {
    const max = Math.max(1, scroller.scrollHeight - scroller.clientHeight);
    if (scroller.scrollTop >= max - 2) { target.scrollTop = target.scrollHeight; return; }
    let line = (scroller.scrollTop / max) * totalLines;
    if (source.getMode() === 'source' && cm?.lineBlockAtHeight) {
      const y = Math.max(0, scroller.getBoundingClientRect().top - cm.documentTop);
      const block = cm.lineBlockAtHeight(y);
      line = cm.state.doc.lineAt(block.from).number - 1 + Math.max(0, Math.min(1, (y - block.top) / Math.max(1, block.height)));
    } else if (source.getMode() === 'preview') {
      const top = scroller.getBoundingClientRect().top;
      const current = readingSections().find(section => section.el.getBoundingClientRect().bottom >= top);
      if (current) {
        const rect = current.el.getBoundingClientRect();
        line = current.start.line + Math.max(0, Math.min(1, (top - rect.top) / Math.max(1, rect.height))) * Math.max(1, current.end.line - current.start.line + 1);
      }
    }
    target.scrollTop = interpolate(line);
  });
  const fromTarget = () => hold(() => {
    const max = Math.max(1, target.scrollHeight - target.clientHeight);
    const line = interpolate(target.scrollTop, true);
    if (target.scrollTop >= max - 2) scroller.scrollTop = scroller.scrollHeight;
    else if (source.getMode() === 'source' && cm?.lineBlockAt) {
      const position = cm.state.doc.line(Math.max(1, Math.min(cm.state.doc.lines, Math.floor(line) + 1))).from;
      const block = cm.lineBlockAt(position);
      scroller.scrollTop += block.top + (line % 1) * block.height + cm.documentTop - scroller.getBoundingClientRect().top;
    } else {
      const section = readingSections().find(item => item.start.line <= line && item.end.line >= line);
      if (section) {
        const rect = section.el.getBoundingClientRect();
        scroller.scrollTop += rect.top - scroller.getBoundingClientRect().top + rect.height * (line - section.start.line) / Math.max(1, section.end.line - section.start.line + 1);
      } else scroller.scrollTop = line / Math.max(1, totalLines) * Math.max(0, scroller.scrollHeight - scroller.clientHeight);
    }
  });
  scroller.addEventListener('scroll', fromSource, { passive: true });
  target.addEventListener('scroll', fromTarget, { passive: true });
  fromSource();
  return () => { scroller.removeEventListener('scroll', fromSource); target.removeEventListener('scroll', fromTarget); cancelAnimationFrame(frame); };
}
