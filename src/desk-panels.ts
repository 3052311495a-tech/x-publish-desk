import { Notice } from 'obsidian';
import { config } from './config';
import { spawn } from 'child_process';
import { createHash } from 'crypto';
import { linkWarnings, metadata, postBody, postStats, quoteLink, textRuns, withoutComments } from './model';

export interface PanelCheck { text: string; warning: boolean; }
export interface MediaCheckItem {
  name: string;
  extension: string;
  size?: number;
  resolved?: boolean;
  width?: number;
  height?: number;
}
export interface MediaCheckSummary { images: MediaCheckItem[]; cover?: MediaCheckItem | null; }
export interface StyleFinding { name: string; line: number; hit: string; advice: string; }
export interface WritingStyleResult {
  status: 'passed' | 'failed' | 'unavailable' | 'skipped';
  findings: StyleFinding[];
  error?: string;
}
export interface PublishingCheckInput {
  markdown: string;
  mode: 'post' | 'article';
  /** Article callers can provide the exact text prepared for their renderer. */
  body?: string;
  quoteState?: 'none' | 'loading' | 'loaded' | 'missing';
  media?: MediaCheckSummary;
  style?: WritingStyleResult;
  now?: number;
}

function withoutMedia(body: string): string {
  return body.replace(/!\[\[[^\]]+\]\]/g, '')
    .replace(/!\[[^\]]*\]\(\s*(?:<[^>]+>|[^)]*)\s*\)/g, '');
}
function inputBody(input: PublishingCheckInput): string {
  if (input.body !== undefined) return input.body;
  if (input.mode === 'post' || /^##\s+正文\s*$/m.test(input.markdown)) return postBody(input.markdown);
  return withoutComments(input.markdown.replace(/^\uFEFF?---\r?\n[\s\S]*?\r?\n---(?:\r?\n|$)/, '')).trim();
}
function shortDate(value: unknown): string {
  return typeof value === 'string' && /^\d{4}-\d{2}-\d{2}/.test(value) ? value.slice(5, 10) : '';
}
function inferMedia(body: string): MediaCheckItem[] {
  const images: MediaCheckItem[] = [];
  for (const match of body.matchAll(/!\[\[([^\]]+)\]\]|!\[[^\]]*\]\(\s*(?:<([^>]+)>|([^)]*))\s*\)/g)) {
    const name = (match[1] || match[2] || match[3] || '').split('|')[0].trim();
    const extension = /\.([a-z\d]+)(?:[?#].*)?$/i.exec(name)?.[1].toLowerCase() || '';
    images.push({ name, extension });
  }
  return images;
}

/** Checks describe observable facts; they never block saving a draft. */
export function buildPublishingChecks(input: PublishingCheckInput): PanelCheck[] {
  const fm = metadata(input.markdown), body = inputBody(input), plainBody = withoutMedia(body);
  const stats = postStats(plainBody), now = input.now ?? Date.now(), items: PanelCheck[] = [];
  const add = (text: string, warning = false) => items.push({ text, warning });
  const periods = plainBody.split('\n').map((line, index) => /。/.test(line.replace(/。{3,}/g, '')) ? index + 1 : 0).filter(Boolean);
  for (const line of periods) add(`第 ${line} 行有句号，推特不用句号，改成换行。`, true);
  if (!periods.length) add('没有句号');
  if (!plainBody.trim()) add('正文为空', true);

  if (input.mode === 'post') {
    if (stats.weightedLength > 280) {
      const paragraphBreak = stats.plain.lastIndexOf('\n\n');
      const lastParagraphStart = paragraphBreak < 0 ? 0 : paragraphBreak + 2;
      add(lastParagraphStart >= stats.foldIndex
        ? `结尾那句判断在折叠线下面，读者不点「显示更多」就看不到。删短 ${stats.weightedLength - 280} 字，或把它提到前面。`
        : '超过 280 的部分要点「显示更多」才看得到，重要的话放前面。', true);
    } else add('没超过 280，时间线上整条都看得到');
    if (stats.weightedLength > 25_000) add('正文超过 25,000 加权字符', true);
    const firstLine = stats.plain.split('\n')[0] || '';
    const firstLength = postStats(firstLine).weightedLength;
    if (!firstLine.trim()) add('第一行为空，需要先写开头', true);
    else if (firstLength > 280) add(`第一行 ${firstLength} 加权字符，开头会被折叠`, true);
    else add(`第一行 ${firstLength} 加权字符，时间线里可见`);
  }

  if (fm.delivery_ready !== true) add('还没验收', true);
  const expiration = typeof fm.expires_at === 'string' ? Date.parse(fm.expires_at) : NaN;
  if (typeof fm.expires_at === 'string' && !Number.isFinite(expiration)) add('有效期格式无效，请先重新核实', true);
  else if (Number.isFinite(expiration) && expiration <= now) add('核验已过期，先重新核实再上传', true);
  else if (fm.delivery_ready === true) add(shortDate(fm.expires_at) ? `已验收，核实有效至 ${shortDate(fm.expires_at)}` : '已验收');

  const quote = quoteLink(fm.quote);
  if (fm.quote && !quote) add('引用原帖链接格式有问题，请在原始笔记里核对', true);
  else if (quote && input.mode === 'post') {
    if (input.quoteState === 'loaded') add(`引用 ${quote.author} 的原帖还在，卡片内容已取到`);
    else if (input.quoteState === 'loading') add(`正在读取 ${quote.author} 的引用原帖`, true);
    else add(`引用 ${quote.author} 的原帖内容取不到，上传时照样会引用`, true);
  } else add('没有引用原帖');
  add(`加粗 ${stats.runs.filter(run => run.bold).length} 处`);
  if (input.mode === 'post') for (const text of linkWarnings(stats.plain, stats.runs.some(run => run.bold))) add(text, true);

  const media = input.media || { images: inferMedia(body) };
  const images = media.images;
  if (input.mode === 'post') {
    const moving = images.filter(image => /^(gif|mp4|mov)$/i.test(image.extension));
    if (images.length > 4) add(`配图 ${images.length} / 4，超过推文上限`, true);
    else add(`配图 ${images.length} / 4`);
    if (moving.length && images.length !== 1) add('推文只能放 1 个 GIF 或视频，不能与其他配图混用', true);
  } else {
    add(`正文图片 ${images.length} / 25${images.length > 25 ? '，超过长文上限' : ''}`, images.length > 25);
    const cover = media.cover;
    if (!cover) add('没有封面图', true);
    else {
      add('封面已准备');
      if (cover.width && cover.height && Math.abs(cover.width / cover.height / 2.5 - 1) > 0.2) add('封面会被裁成 5:2', true);
      if (cover.resolved === false) add(`封面图片找不到：${cover.name}`, true);
    }
  }
  for (const image of images) {
    const extension = image.extension.replace(/^\./, '').toLowerCase();
    if (image.resolved === false) add(`配图文件找不到：${image.name}`, true);
    if (!/^(jpe?g|png|webp|gif|mp4|mov)$/.test(extension)) add(`配图格式不支持：${image.name}；请用 JPG、PNG、WebP、GIF 或视频`, true);
    const limit = extension === 'gif' ? 15 * 1024 * 1024 : /^(jpe?g|png|webp)$/.test(extension) ? 5 * 1024 * 1024 : null;
    if (limit && typeof image.size === 'number' && image.size > limit) add(`配图太大：${image.name}，${extension === 'gif' ? 'GIF 不超过 15 MB' : '单张图片不超过 5 MB'}`, true);
  }

  if (input.style?.status === 'skipped') { /* No style checker configured. */ }
  else if (!input.style) add('文风脚本尚未检查', true);
  else if (input.style.status === 'unavailable') add(input.style.error || '文风脚本暂不可用，请稍后重试', true);
  else if (input.style.status === 'passed') add('文风脚本 0 个明确问题；语义仍需自己判断');
  else for (const finding of input.style.findings) add(`文风脚本：第 ${finding.line} 行「${finding.hit}」：${finding.name}。${finding.advice}`, true);
  return [...items.filter(item => item.warning), ...items.filter(item => !item.warning)];
}

export function renderPublishingChecks(host: HTMLElement, checks: PanelCheck[]): void {
  host.querySelector('.xpd-list')?.remove();
  const list = host.createDiv({ cls: 'xpd-col xpd-list' });
  list.createDiv({ cls: 'xpd-list-head', text: '点「存到草稿箱」之前自动再查一遍；有「!」的不拦，但建议先处理' });
  for (const check of [...checks.filter(item => item.warning), ...checks.filter(item => !item.warning)]) {
    list.createDiv({ cls: 'xpd-row' + (check.warning ? ' is-warn' : ''), text: check.text });
  }
}

const styleCache = new Map<string, Promise<WritingStyleResult>>();
export function parseWritingStyleOutput(output: string, code: number | null): WritingStyleResult {
  const findings: StyleFinding[] = [];
  const blocks = output.split(/(?=^\[(?:ERROR|WARN)\])/m);
  for (const block of blocks) {
    const heading = /^\[(?:ERROR|WARN)\]\s*(?:第\s*\d+\s*条|推特规则)｜([^｜\n]+)｜第\s*(\d+)\s*行/m.exec(block);
    if (!heading) continue;
    findings.push({ name: heading[1], line: Number(heading[2]), hit: /^命中：(.*)$/m.exec(block)?.[1] || '', advice: /^建议：(.*)$/m.exec(block)?.[1] || '' });
  }
  if (code === 0 && /自动检查汇总：ERROR×0/.test(output)) return { status: 'passed', findings: [] };
  if (code === 1 && findings.length) return { status: 'failed', findings };
  return { status: 'unavailable', findings: [], error: '文风脚本没有返回完整结果，请稍后重试' };
}
/** The checker receives only this body over stdin and cannot modify the note. */
export function runWritingStyleCheck(body: string): Promise<WritingStyleResult> {
  const text = withoutMedia(body), key = createHash('sha256').update(text).digest('hex');
  const cached = styleCache.get(key); if (cached) return cached;
  const pending = new Promise<WritingStyleResult>(resolve => {
    let completed = false, output = '';
    const finish = (result: WritingStyleResult) => { if (!completed) { completed = true; resolve(result); } };
    try {
      const [command, ...args] = config.style_check;
      if (!command) { finish({ status: 'skipped', findings: [] }); return; }
      const child = spawn(command, args, { shell: false, stdio: ['pipe', 'pipe', 'pipe'] });
      const timer = setTimeout(() => { child.kill(); finish({ status: 'unavailable', findings: [], error: '文风脚本检查超时，请稍后重试' }); }, 10_000);
      child.stdout.on('data', chunk => { output = (output + chunk.toString()).slice(-64_000); });
      child.stderr.on('data', () => {});
      child.on('error', () => { clearTimeout(timer); finish({ status: 'unavailable', findings: [], error: '文风脚本暂不可用，请检查本机脚本' }); });
      child.on('close', code => { clearTimeout(timer); finish(parseWritingStyleOutput(output, code)); });
      child.stdin.on('error', () => {}); child.stdin.end(text, 'utf8');
    } catch { finish({ status: 'unavailable', findings: [], error: '文风脚本暂不可用，请检查本机脚本' }); }
  });
  styleCache.set(key, pending);
  void pending.then(result => {
    if (result.status === 'unavailable') styleCache.delete(key);
    while (styleCache.size > 50) styleCache.delete(styleCache.keys().next().value!);
  });
  return pending;
}

export interface DetailSection { title: string; content: string; open: boolean; }
const DETAIL_TITLES = ['素材话题', '来源素材', '核实记录', '我的切入点', '验收记录'];
/** Internal records are read only from Obsidian comments, never from the publish body. */
export function detailSections(markdown: string): DetailSection[] {
  const sections: DetailSection[] = [];
  const fm = /^\uFEFF?---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/.exec(markdown);
  if (fm?.[1].trim()) sections.push({ title: '笔记属性', content: fm[1].trim(), open: true });
  const comments = [...markdown.matchAll(/%%([\s\S]*?)(?:%%|$)/g)].map(match => match[1].replace(/\r\n/g, '\n'));
  for (const title of DETAIL_TITLES) {
    const content = comments.flatMap(comment => [...comment.matchAll(new RegExp(`^## ${title}[^\\S\\n]*\\n([\\s\\S]*?)(?=^## |(?![\\s\\S]))`, 'gm'))].map(match => match[1].trim())).filter(Boolean).join('\n\n');
    if (content) sections.push({ title, content, open: title === '素材话题' });
  }
  return sections;
}
export function renderDetails(host: HTMLElement, markdown: string, onOpenSource: () => unknown, onCompare?: () => unknown): void {
  host.querySelectorAll('.xpd-details').forEach(element => element.remove());
  host.querySelectorAll('.xpd-note').forEach(element => element.remove());
  const box = host.createDiv({ cls: 'xpd-col xpd-details' });
  for (const section of detailSections(markdown)) {
    const details = box.createEl('details'); details.open = section.open;
    details.createEl('summary', { text: section.title });
    details.createDiv({ cls: 'xpd-details-body', text: section.content });
  }
  const note = host.createDiv({ cls: 'xpd-col xpd-note' });
  note.appendText('这些是写稿时留的底稿，只看不上传。要改就去 ');
  const source = note.createEl('a', { cls: 'xpd-link', text: 'Obsidian 的原始笔记', href: '#' });
  source.onclick = event => { event.preventDefault(); onOpenSource(); };
  if (!onCompare) return;
  note.appendText(' · ');
  const compare = note.createEl('a', { cls: 'xpd-link', text: '看改稿对照', href: '#' });
  compare.onclick = event => { event.preventDefault(); onCompare(); };
}

interface ParsedVersion { label: string; text: string; start: number; end: number; }
function parseDraftVersions(markdown: string): { body: RegExpExecArray | null; versions: ParsedVersion[] } {
  const body = /^## 正文\s*\n([\s\S]*?)(?=^## |^---\s*$|^%%|(?![\s\S]))/m.exec(markdown);
  const section = /^## 备选版本\s*\n([\s\S]*?)(?=^%%|^## |(?![\s\S]))/m.exec(markdown);
  if (!body || !section) return { body, versions: [] };
  const versions: ParsedVersion[] = [];
  const expression = /^> \*\*(版本 [A-Z]｜[^\n]+)\*\*\s*\n([\s\S]*?)(?=^> \*\*(?:版本 [A-Z]｜|选择理由)|^%%|(?![\s\S]))/gm;
  let match: RegExpExecArray | null;
  while ((match = expression.exec(section[0]))) {
    const text = match[2].split('\n').map(line => line.replace(/^> ?/, '')).join('\n').trim();
    if (text) versions.push({ label: match[1], text, start: section.index + match.index, end: section.index + match.index + match[0].length });
  }
  return { body, versions };
}
export interface VersionCard { label: string; text: string; current: boolean; selectLabel?: string; reason?: string; }
export interface VersionModel { current: VersionCard; alternatives: VersionCard[]; }
export function versionCards(markdown: string): VersionModel {
  const { body, versions } = parseDraftVersions(markdown), fm = metadata(markdown);
  const selected = typeof fm.selected_version === 'string' ? fm.selected_version : '';
  const reason = /^> \*\*选择理由：\*\*\s*(.*)$/m.exec(markdown)?.[1] || '';
  return {
    current: { label: selected || '正文（推荐）', text: body?.[1].trim() || '', current: true },
    alternatives: versions.map(version => ({ label: version.label, text: version.text, current: false, selectLabel: version.label, reason })),
  };
}
/** Pure form of the old plugin's swap; the caller owns concurrency-safe saving. */
export function swapVersion(markdown: string, label: string): string {
  const { body, versions } = parseDraftVersions(markdown), selected = versions.find(version => version.label === label);
  if (!body || !selected) throw Error('备选版本已变化，请重新选择');
  const current = typeof metadata(markdown).selected_version === 'string' ? metadata(markdown).selected_version as string : '版本 A｜原推荐稿';
  const quoted = body[1].trim().split('\n').map(line => '> ' + line).join('\n');
  let next = markdown.slice(0, selected.start) + '> **' + current + '**\n>\n' + quoted + '\n>\n' + markdown.slice(selected.end);
  next = next.slice(0, body.index) + '## 正文\n\n' + selected.text + '\n\n' + next.slice(body.index + body[0].length);
  next = /^selected_version: /m.test(next)
    ? next.replace(/^selected_version: .+$/m, 'selected_version: ' + JSON.stringify(label))
    : next.replace(/^---\n/, '---\nselected_version: ' + JSON.stringify(label) + '\n');
  next = next.replace(/^> \*\*选择理由：\*\*.*$/m, '> **选择理由：** 已手动选择' + label + '；原正文保留为备选。');
  return next;
}
function renderVersionText(host: HTMLElement, text: string): void {
  for (const run of textRuns(text)) run.bold ? host.createEl('b', { text: run.text }) : host.appendText(run.text);
}
export function renderVersions(host: HTMLElement, markdown: string, onSelect: (label: string) => Promise<unknown>): void {
  host.querySelectorAll('.xpd-version-card').forEach(element => element.remove());
  const model = versionCards(markdown);
  for (const card of [model.current, ...model.alternatives]) {
    const box = host.createDiv({ cls: 'xpd-col xpd-version-card' + (card.current ? ' is-current' : '') });
    const heading = box.createDiv({ cls: 'xpd-version-head' }); heading.createEl('b', { text: card.label });
    if (card.current) heading.createSpan({ cls: 'xpd-version-tag', text: '正在用这版' });
    else {
      const button = heading.createEl('button', { cls: 'xpd-version-use clickable-icon', text: '换成这版', attr: { type: 'button' } });
      button.onclick = async () => {
        button.disabled = true;
        try { await onSelect(card.selectLabel!); }
        catch (error) { new Notice(error instanceof Error ? error.message : '版本切换没有完成'); }
        finally { button.disabled = false; }
      };
    }
    renderVersionText(box.createDiv({ cls: 'xpd-version-text' }), card.text);
    if (card.reason) box.createDiv({ cls: 'xpd-version-why', text: '没选的原因：' + card.reason });
  }
}
