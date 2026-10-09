import type { App, TFile } from 'obsidian';
import * as fs from 'fs';
import * as path from 'path';
import * as crypto from 'crypto';
import type { UploadResult } from './backend';
import { deliveryReceiptUncertain } from './delivery-receipt';

import { archiveReceipts, folderPrefix, isExcluded } from './config';

const sourcePrefix = (): string => folderPrefix('drafts');
const destination = (): string => folderPrefix('published').slice(0, -1);
const digest = (value: string): string => crypto.createHash('sha256').update(value, 'utf8').digest('hex');
const receiptPath = (notePath: string): string => path.join(archiveReceipts(), digest(notePath) + '.json');

function saveReceipt(notePath: string, receipt: UploadResult): void {
  fs.mkdirSync(archiveReceipts(), { recursive: true, mode: 0o700 });
  const target = receiptPath(notePath), temporary = target + '.' + crypto.randomUUID() + '.tmp';
  try {
    fs.writeFileSync(temporary, JSON.stringify(receipt), { mode: 0o600 });
    fs.renameSync(temporary, target);
  } finally { if (fs.existsSync(temporary)) fs.unlinkSync(temporary); }
}

export function readArchivedDelivery(file: TFile, markdown: string): UploadResult | undefined {
  if (!file.path.startsWith(destination() + '/')) return;
  try {
    const value = JSON.parse(fs.readFileSync(receiptPath(file.path), 'utf8')) as UploadResult;
    if (value.verified === true && value.archived_path === file.path && value.archive_note_sha256 === digest(markdown)
      && ['published', 'posted', 'scheduled'].includes(String(value.state)) && !deliveryReceiptUncertain(value)) return value;
  } catch { /* Old notes or edited archived content have no matching receipt. */ }
}

/** A local archive failure must never change the verified remote result. */
export async function archiveVerifiedDelivery(
  app: App, file: TFile, originalPath: string, markdown: string, result: UploadResult,
  action: 'publish' | 'schedule', timeZone?: string,
): Promise<UploadResult> {
  if (result.verified !== true || deliveryReceiptUncertain(result)) return result;
  const receipt = { ...result, action, time_zone: timeZone || 'America/Los_Angeles', retry_allowed: false };
  try {
    const states = action === 'schedule' ? ['scheduled'] : ['published', 'posted'];
    if (!states.includes(String(result.state)) || result.commit_sent === false) throw Error('发布回执状态不一致，无法自动归档');
    if (file.path !== originalPath || !originalPath.startsWith(sourcePrefix()) || isExcluded(originalPath)) throw Error('稿件路径已变化，请手动核对归档');
    if (await app.vault.read(file) !== markdown) throw Error('发布期间笔记又有修改，已保留创作区的新内容');
    const DESTINATION = destination();
    const folder = app.vault.getAbstractFileByPath(DESTINATION);
    if (!folder) await app.vault.createFolder(DESTINATION);
    else if (!('children' in folder)) throw Error(`“${DESTINATION}”已被同名文件占用`);
    const name = path.posix.basename(originalPath), base = name.slice(0, -3);
    let target = DESTINATION + '/' + name, number = 2;
    while (app.vault.getAbstractFileByPath(target)) {
      if (number > 1000) throw Error('同名归档过多，请手动选择文件名');
      target = `${DESTINATION}/${base}（${number++}）.md`;
    }
    // Recheck after async folder creation before the actual move.
    if (file.path !== originalPath || await app.vault.read(file) !== markdown) throw Error('归档前笔记已变化，已保留当前稿件');
    const archived: UploadResult = { ...receipt, original_note_path: originalPath, archived_path: target,
      archive_note_sha256: digest(markdown), archived_at: new Date().toISOString(), archive_status: 'archived' };
    // Store the receipt first, so a rename event can immediately rebuild the
    // same leaf using a durable result. No source/Markdown bytes are rewritten.
    saveReceipt(target, archived);
    await app.fileManager.renameFile(file, target);
    return archived;
  } catch (error) {
    return { ...receipt, archive_status: 'failed', archive_error: error instanceof Error ? error.message : String(error) };
  }
}
