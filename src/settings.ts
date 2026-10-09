import { App, Notice, PluginSettingTab, Setting, type Plugin } from 'obsidian';
import { config, loadConfig, saveConfig, type DeskConfig } from './config';

type Host = Plugin & { setBackendDir(dir: string): Promise<void> };

export class DeskSettingTab extends PluginSettingTab {
  constructor(app: App, private host: Host) { super(app, host); }

  display(): void {
    const { containerEl } = this;
    containerEl.empty();
    containerEl.createEl('p', { text: '发布功能需要先装好后端（见 README）。这些设置保存在后端文件夹的 config.json，命令行入口也读同一份。' });
    new Setting(containerEl).setName('后端文件夹').setDesc('git clone 下来的仓库位置，里面有 .venv 和 delivery_runner.py')
      .addText(text => text.setPlaceholder('/Users/you/x-publish-desk').setValue(config.backendDir).onChange(async value => {
        await this.host.setBackendDir(value.trim());
      }))
      .addButton(button => button.setButtonText('重新读取').onClick(() => {
        const problem = loadConfig(config.backendDir); new Notice(problem || '已读取 config.json'); this.display();
      }));
    const text = (key: keyof DeskConfig, name: string, desc: string, placeholder = ''): void => {
      new Setting(containerEl).setName(name).setDesc(desc).addText(input => input.setPlaceholder(placeholder)
        .setValue(String(config[key] ?? '')).onChange(value => { (config as unknown as Record<string, unknown>)[key] = value.trim(); this.save(); }));
    };
    containerEl.createEl('h3', { text: 'X 账号' });
    text('account', 'X 账号', '用来核对登录的是不是这个号，例如 @your_handle', '@your_handle');
    text('display_name', '显示名', '预览卡片上显示的名字');
    text('cookies', 'Cookie 文件', '从已登录 X 的浏览器导出的 cookie JSON（绝对路径）。不要放进笔记库或 git 仓库');
    containerEl.createEl('h3', { text: '文件夹' });
    text('vault', '笔记库绝对路径', '后端用它找笔记和配图', (this.app.vault.adapter as { getBasePath?: () => string }).getBasePath?.() || '');
    text('drafts', '草稿文件夹', '这里的笔记可以存草稿、直接发布、定时发布');
    text('published', '已发布文件夹', '发布核对通过后，笔记会移到这里');
    text('articles', '长文文件夹', 'X Articles 长文');
    text('attachments', '附件文件夹', '粘贴或拖入的配图存这里');
    containerEl.createEl('h3', { text: '其他' });
    new Setting(containerEl).setName('要求验收字段').setDesc('打开后，只有 frontmatter 写了 status: writing、delivery_ready: true 和带时区的 expires_at 的笔记才能发')
      .addToggle(toggle => toggle.setValue(config.require_ready_fields).onChange(value => { config.require_ready_fields = value; this.save(); }));
    text('default_time_zone', '默认时区', '命令行定时发布默认用这个时区', 'Asia/Shanghai');
    text('article_uploader', '长文上传工具（可选）', '第三方 x-article-draft-uploader 的 upload_markdown_to_x_article.py 路径；不填就只能预览长文');
  }

  private save(): void {
    if (!config.backendDir) { new Notice('请先填后端文件夹'); return; }
    try { saveConfig(); } catch (error) { new Notice('保存 config.json 失败：' + String(error)); }
  }
}
