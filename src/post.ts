import { setIcon } from 'obsidian';
import { accountLabel, displayName } from './config';
import type { Embed } from './embeds';
import { postBody, postStats, quoteLink, type TextRun } from './model';

export interface CheckItem { text: string; warning: boolean; }
export function dateLabel(value: unknown): string {
  if (typeof value !== 'string' || !Number.isFinite(Date.parse(value))) return '';
  if (/^\d{4}-\d{2}-\d{2}/.test(value)) return value.slice(5, 10);
  const date = new Date(value);
  return `${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
}
export function postChecks(body: string, frontmatter: Record<string, unknown>, quoteLoaded = false): CheckItem[] {
  const stats = postStats(body), items: CheckItem[] = [];
  if (stats.weightedLength > 280) {
    const lastParagraph = stats.plain.lastIndexOf('\n\n') + 2;
    items.push({ warning: true, text: lastParagraph >= stats.foldIndex
      ? `结尾那句判断在折叠线下面，读者不点「显示更多」就看不到。删短 ${stats.weightedLength - 280} 字，或把它提到前面。`
      : '超过 280 的部分要点「显示更多」才看得到，重要的话放前面。' });
  }
  const periods = body.split('\n').map((line, index) => /。/.test(line.replace(/。{3,}/g, '')) ? index + 1 : 0).filter(Boolean);
  for (const line of periods) items.push({ warning: true, text: `第 ${line} 行有句号，推特不用句号，改成换行。` });
  const expired = typeof frontmatter.expires_at === 'string' && Date.parse(frontmatter.expires_at) < Date.now();
  if (frontmatter.delivery_ready !== true) items.push({ warning: true, text: '还没验收' });
  if (expired) items.push({ warning: true, text: '核验已过期，先重新核实再上传' });
  if (!body.trim()) items.push({ warning: true, text: '正文为空' });
  if (stats.weightedLength > stats.limit) items.push({ warning: true, text: '正文超过 25,000 加权字符' });
  if (!periods.length) items.push({ warning: false, text: '没有句号' });
  if (frontmatter.delivery_ready === true && !expired) {
    const date = dateLabel(frontmatter.expires_at);
    items.push({ warning: false, text: date ? `已验收，有效至 ${date}` : '已验收' });
  }
  if (quoteLoaded) items.push({ warning: false, text: `引用卡片已取到 · 加粗 ${stats.runs.filter(run => run.bold).length} 处` });
  return items;
}
export function renderChecks(parent: HTMLElement, items: CheckItem[]) {
  parent.empty();
  for (const item of items) {
    const row = parent.createDiv({ cls: item.warning ? 'xpd-alert' : 'xpd-check' });
    if (item.warning) { row.createEl('b', { text: '!' }); row.createSpan({ text: item.text }); }
    else row.setText(item.text);
  }
}
function renderRuns(parent: HTMLElement, runs: TextRun[], from: number, to: number) {
  let index = 0;
  for (const run of runs) {
    const start = Math.max(from - index, 0), end = Math.min(to - index, run.text.length);
    if (end > start) {
      const value = run.text.slice(start, end);
      if (run.bold) parent.createEl('b', { text: value }); else parent.appendText(value);
    }
    index += run.text.length;
  }
}
export async function renderPost(host: HTMLElement, markdown: string, frontmatter: Record<string, unknown>, getEmbed: (url: string) => Promise<Embed>, checksChanged: (items: CheckItem[]) => void) {
  const body = postBody(markdown), stats = postStats(body);
  host.createDiv({ cls: 'xpd-caption', text: '按 X 时间线的样子显示，跟着你改的内容实时变' });
  const card = host.createDiv({ cls: 'xpd-post' });
  card.createDiv({ cls: 'xpd-avatar', text: Array.from(displayName().replace(/^@/, ''))[0] || 'X', attr: { 'aria-hidden': 'true' } });
  const main = card.createDiv({ cls: 'xpd-post-main' });
  const header = main.createDiv({ cls: 'xpd-post-head' });
  header.createEl('b', { text: displayName() }); header.createSpan({ text: accountLabel() + ' · 草稿' });
  const before = main.createDiv({ cls: 'xpd-post-body' });
  renderRuns(before, stats.runs, 0, stats.foldIndex);
  if (stats.foldIndex < stats.plain.length) {
    const fold = main.createDiv({ cls: 'xpd-fold', attr: { role: 'separator' } });
    fold.createSpan({ text: '时间线在这里折叠 · 280' });
    const after = main.createDiv({ cls: 'xpd-post-body xpd-folded' });
    renderRuns(after, stats.runs, stats.foldIndex, stats.plain.length);
  }
  let quoteLoaded = false;
  const quote = quoteLink(frontmatter.quote);
  if (quote) {
    const embed = main.createDiv({ cls: 'xpd-quote is-missing' });
    const quoteHeader = embed.createDiv({ cls: 'xpd-quote-head' });
    quoteHeader.createSpan({ cls: 'xpd-quote-avatar', text: quote.author[1].toUpperCase() });
    const name = quoteHeader.createEl('b', { text: quote.author.slice(1) });
    const original = quoteHeader.createSpan({ text: quote.author, attr: { title: quote.url, role: 'link', tabindex: '0' } });
    original.onclick = () => { window.open(quote.url, '_blank', 'noopener'); };
    original.onkeydown = event => { if (event.key === 'Enter') original.click(); };
    const opening = embed.createDiv({ cls: 'xpd-quote-text', text: '原帖内容取不到，上传时照样会引用' });
    void getEmbed(quote.url).then(value => {
      if (value.name) name.setText(value.name);
      if (value.text) { embed.removeClass('is-missing'); opening.setText(value.text); quoteLoaded = true; }
      updateChecks();
    });
  }
  const actions = main.createDiv({ cls: 'xpd-actions', attr: { 'aria-hidden': 'true' } });
  for (const [icon, label] of [['message-circle', '回复'], ['repeat-2', '转帖'], ['heart', '喜欢'], ['bar-chart-2', '浏览'], ['bookmark', '书签']]) {
    const item = actions.createSpan({ attr: { title: label } }); setIcon(item, icon);
  }
  const meter = host.createDiv({ cls: 'xpd-meter' });
  const meterRow = meter.createDiv({ cls: 'xpd-meter-row' });
  meterRow.createSpan({ text: '字数（X 算法，汉字算 2）' });
  const counter = meterRow.createEl('b', { text: `${stats.weightedLength.toLocaleString('en-US')} / 25,000` });
  counter.dataset.weightedLength = String(stats.weightedLength);
  meter.createDiv({ cls: 'xpd-bar' }).createEl('i').style.width = `${Math.min(100, stats.weightedLength / 250)}%`;
  meter.createDiv({ cls: 'xpd-caption', text: stats.weightedLength > 280 ? `时间线默认露出前 280，超出 ${stats.weightedLength - 280}` : '时间线默认露出前 280' });
  const checks = host.createDiv({ cls: 'xpd-checks' });
  function updateChecks() { const items = postChecks(body, frontmatter, quoteLoaded); renderChecks(checks, items); checksChanged(items); }
  updateChecks();
}
