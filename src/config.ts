import * as fs from 'fs';
import * as path from 'path';

/** Same keys and defaults as config.py; the file lives in the backend folder (never committed). */
export interface DeskConfig {
  vault: string; drafts: string; published: string; articles: string; attachments: string; excluded: string[];
  account: string; display_name: string; cookies: string; require_ready_fields: boolean; state_dir: string;
  article_uploader: string; style_check: string[]; revision_learning: string; revision_log_note: string; default_time_zone: string;
}
export const DEFAULT_CONFIG: DeskConfig = {
  vault: '', drafts: '推特创作/03创作中', published: '推特创作/04已发布', articles: '推特创作/05长文', attachments: '推特创作/附件',
  excluded: ['推特创作/03创作中/评论'], account: '', display_name: '', cookies: '', require_ready_fields: false, state_dir: 'state',
  article_uploader: '', style_check: [], revision_learning: '', revision_log_note: '', default_time_zone: 'Asia/Shanghai',
};

/** Shared, mutable settings. backendDir is stored in the plugin's own data.json. */
export const config: DeskConfig & { backendDir: string } = { ...DEFAULT_CONFIG, backendDir: '' };

const trim = (value: string): string => value.replace(/^\/+|\/+$/g, '');
export const folderPrefix = (name: 'drafts' | 'published' | 'articles'): string => trim(config[name]) + '/';
export const isExcluded = (file: string): boolean => config.excluded.some(item => file.startsWith(trim(item) + '/'));
export const folderName = (name: 'drafts' | 'published' | 'articles'): string => trim(config[name]).split('/').pop() || config[name];
export function accountLabel(): string {
  return config.account ? (config.account.startsWith('@') ? config.account : '@' + config.account) : '未设置账号';
}
export const displayName = (): string => config.display_name || accountLabel();
export const configFile = (): string => path.join(config.backendDir, 'config.json');
export const pythonPath = (): string => path.join(config.backendDir, '.venv/bin/python');
export function stateDir(): string {
  return path.isAbsolute(config.state_dir) ? config.state_dir : path.join(config.backendDir, config.state_dir);
}
export const archiveReceipts = (): string => path.join(stateDir(), '归档回执');

export function loadConfig(backendDir: string): string | undefined {
  Object.assign(config, DEFAULT_CONFIG, { backendDir });
  if (!backendDir) return '请在设置里填写后端文件夹';
  try { Object.assign(config, JSON.parse(fs.readFileSync(configFile(), 'utf8')) as Partial<DeskConfig>, { backendDir }); }
  catch { return '没有读到 ' + configFile() + '，请先在设置里保存一次'; }
}
export function saveConfig(): void {
  const { backendDir, ...value } = config;
  fs.writeFileSync(path.join(backendDir, 'config.json'), JSON.stringify(value, null, 2) + '\n', { mode: 0o600 });
}
