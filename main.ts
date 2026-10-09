import { MarkdownView, Notice, Plugin, TFile, WorkspaceLeaf } from 'obsidian';
import { Backend } from './src/backend';
import { Toolbar } from './src/toolbar';
import { Embeds, type DeskData } from './src/embeds';
import { DeskView, DESK_TYPE } from './src/desk-view';
import { noteMode } from './src/model';
import { DefaultOpening } from './src/default-opening';
import { config, loadConfig } from './src/config';
import { DeskSettingTab } from './src/settings';

export default class XPublishDesk extends Plugin {
  backend!: Backend;
  toolbar!: Toolbar;
  embeds!: Embeds;
  private opening?: DefaultOpening;
  private saveQueue: Promise<void> = Promise.resolve();
  private data!: DeskData;
  async setBackendDir(dir: string) {
    this.data.backendDir = dir; loadConfig(dir);
    this.saveQueue = this.saveQueue.catch(() => {}).then(() => this.saveData(this.data)); await this.saveQueue;
  }
  private unloading = false;
  async onload() {
    const saved = await this.loadData();
    const data: DeskData = { quoteCache: saved?.quoteCache && typeof saved.quoteCache === 'object' ? saved.quoteCache : {},
      backendDir: typeof saved?.backendDir === 'string' ? saved.backendDir : '' };
    this.data = data;
    const problem = loadConfig(data.backendDir || '');
    if (problem) new Notice('X 发布台：' + problem, 8000);
    this.addSettingTab(new DeskSettingTab(this.app, this));
    this.embeds = new Embeds(data, () => { this.saveQueue = this.saveQueue.catch(() => {}).then(() => this.saveData(data)); return this.saveQueue; });
    this.backend = new Backend(this.app);
    const css = await this.app.vault.adapter.read(this.app.vault.configDir + '/plugins/' + this.manifest.id + '/styles.css');
    this.registerView(DESK_TYPE, leaf => new DeskView(leaf, this.backend, this.embeds, css, file => this.openSource(file)));
    this.opening = new DefaultOpening(WorkspaceLeaf.prototype, {
      owns: leaf => leaf.view.app === this.app,
      eligible: file => {
        const target = this.app.vault.getAbstractFileByPath(file);
        return target instanceof TFile && target.extension === 'md' && Boolean(noteMode(file));
      }, deskType: DESK_TYPE,
      beforeChange: async leaf => { if (leaf.view instanceof DeskView) await leaf.view.flush(); },
    });
    this.register(() => this.opening?.dispose());
    this.registerEvent(this.app.workspace.on('file-menu', (menu, file) => {
      if (file instanceof TFile && noteMode(file.path)) menu.addItem(item => item.setTitle('打开原始笔记').setIcon('file-text').onClick(() => { void this.openSource(file); }));
    }));
    this.registerDomEvent(document, 'click', event => {
      const target = event.target instanceof Element ? event.target.closest('.nav-file-title[data-path]') : null;
      const path = target?.getAttribute('data-path');
      if (path && noteMode(path)) { const leaf = this.app.workspace.getMostRecentLeaf(); if (leaf) this.opening?.fromDirectory(leaf); }
    }, true);
    this.app.workspace.detachLeavesOfType('x-publish-desk-preview');
    this.toolbar = new Toolbar(this, this.backend, {
      css, open: file => this.openDesk(file), currentFile: () => this.currentDesk()?.file || null,
      upload: kind => this.currentDesk()?.upload(kind) || Promise.resolve(undefined),
      beforeLearning: async () => { await this.currentDesk()?.flush(); },
    });
    this.toolbar.register();
    const open = () => { const file = this.app.workspace.getActiveFile() || this.currentDesk()?.file; if (file && noteMode(file.path)) void this.openDesk(file); };
    this.addCommand({ id: 'open-x-publish-desk', name: '用 X 发布台打开当前笔记', callback: open });
    this.addCommand({ id: 'open-x-preview', name: '用 X 发布台打开当前笔记（旧快捷键）', callback: open });
    this.addCommand({ id: 'open-x-source', name: '打开当前稿件的原始笔记', callback: () => { const file = this.currentDesk()?.file || this.app.workspace.getActiveFile(); if (file && noteMode(file.path)) void this.openSource(file); } });
    this.app.workspace.onLayoutReady(() => {
      // Scheduled posts: check once shortly after startup, then every 10 minutes.
      window.setTimeout(() => { void this.followUpScheduled(); }, 15_000);
      this.registerInterval(window.setInterval(() => { void this.followUpScheduled(); }, 10 * 60_000));
      const leaf = this.app.workspace.getMostRecentLeaf();
      if (leaf?.view instanceof MarkdownView && leaf.view.file && noteMode(leaf.view.file.path)) {
        void leaf.setViewState({ type: DESK_TYPE, state: { file: leaf.view.file.path, tab: 'preview' }, active: true })
          .catch(error => new Notice('X 发布台：' + String(error)));
      }
    });
  }
  private async followUpScheduled() {
    if (this.unloading) return;
    const report = await this.backend.followUpScheduled();
    const published = report.filter(item => item.state === 'published' && typeof item.archived_path === 'string');
    for (const item of published) {
      const name = String(item.archived_path).split('/').pop()!.replace(/\.md$/, '');
      const differences = Array.isArray(item.format_differences) ? item.format_differences.join('；') : '';
      new Notice(`X 定时推文已发出：${name}` + (differences ? `；${differences}` : '，核对一致'), 10000);
    }
    for (const item of report) if (typeof item.error === 'string' && item.error.includes('6 小时')) new Notice('X 定时推文：' + item.error, 15000);
    const paths = published.map(item => String(item.archived_path));
    if (paths.length) for (const leaf of this.app.workspace.getLeavesOfType(DESK_TYPE)) if (leaf.view instanceof DeskView) await leaf.view.refreshArchived(paths);
  }
  currentDesk(): DeskView | undefined {
    const leaf = this.app.workspace.getMostRecentLeaf();
    return leaf?.view instanceof DeskView ? leaf.view : undefined;
  }
  async openDesk(file: TFile) {
    if (this.unloading || !noteMode(file.path)) return;
    const current = this.app.workspace.getMostRecentLeaf();
    if (current?.view instanceof DeskView) await current.view.flush();
    const leaf = current && (current.view instanceof MarkdownView || current.view instanceof DeskView) ? current : this.app.workspace.getLeaf(false);
    await leaf.setViewState({ type: DESK_TYPE, state: { file: file.path, tab: 'preview' }, active: true });
    await leaf.loadIfDeferred();
    await this.app.workspace.revealLeaf(leaf);
  }
  private async openSource(file: TFile) {
    if (this.unloading || !this.opening) return;
    try {
      await this.currentDesk()?.flush();
      const leaf = this.app.workspace.getLeaf('tab');
      await this.opening.openSource(leaf, file.path, () => leaf.openFile(file, { active: true }));
      await this.app.workspace.revealLeaf(leaf);
    } catch (error) { new Notice('原始笔记：' + String(error)); }
  }
  onunload() { this.unloading = true; this.opening?.dispose(); this.toolbar?.dispose(); this.app.workspace.detachLeavesOfType(DESK_TYPE); }
}
