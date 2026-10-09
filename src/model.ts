import { parse as parseYaml } from 'yaml';
import { folderPrefix, isExcluded } from './config';
import twitter from 'twitter-text';

export type NoteMode = 'post' | 'article' | null;
export function isArchivedPost(path: string): boolean {
  return path.startsWith(folderPrefix('published')) && !isExcluded(path) && !path.startsWith(folderPrefix('published') + '评论/');
}
export function noteMode(path: string): NoteMode {
  if (isArchivedPost(path) || (path.startsWith(folderPrefix('drafts')) && !isExcluded(path))) return 'post';
  return path.startsWith(folderPrefix('articles')) ? 'article' : null;
}
export function metadata(markdown: string): Record<string, unknown> {
  const match = /^\uFEFF?---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/.exec(markdown);
  try {
    const value: unknown = match ? parseYaml(match[1]) : {};
    return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
  } catch { return {}; }
}
export function withoutComments(markdown: string): string {
  // An unfinished Obsidian comment hides the remainder too.
  return markdown.replace(/%%[\s\S]*?(?:%%|$)/g, '');
}
export function postBody(markdown: string): string {
  const clean = withoutComments(markdown).replace(/\r\n/g, '\n');
  const lines = clean.split('\n');
  let active = false, fence = '', body: string[] = [];
  for (const line of lines) {
    if (!active) { if (/^##\s+正文\s*$/.test(line)) active = true; continue; }
    const fenced = /^\s*(`{3,}|~{3,})/.exec(line);
    if (fenced) { if (!fence) fence = fenced[1][0]; else if (fence === fenced[1][0]) fence = ''; }
    if (!fence && (/^#{1,2}\s/.test(line) || /^---\s*$/.test(line))) break;
    body.push(line);
  }
  return body.join('\n').trim();
}
export interface TextRun { text: string; bold: boolean; }
export function textRuns(body: string): TextRun[] {
  const runs: TextRun[] = [];
  const expression = /\*\*(.+?)\*\*/g;
  let start = 0;
  for (const match of body.matchAll(expression)) {
    if (match.index! > start) runs.push({ text: body.slice(start, match.index), bold: false });
    runs.push({ text: match[1], bold: true }); start = match.index! + match[0].length;
  }
  if (start < body.length) runs.push({ text: body.slice(start), bold: false });
  return runs;
}
export function postStats(body: string) {
  const runs = textRuns(body), plain = runs.map(run => run.text).join('');
  const parsed = twitter.parseTweet(plain);
  const rawEnd = parsed.validRangeEnd + 1;
  // twitter-text counts whole URLs and emoji; never split either at the folding line.
  const rawFoldIndex = parsed.weightedLength > 280 ? Math.max(0, rawEnd) : plain.length;
  const inLine = rawFoldIndex < plain.length && plain[rawFoldIndex] !== '\n' && (rawFoldIndex === 0 || plain[rawFoldIndex - 1] !== '\n');
  const foldIndex = inLine ? plain.lastIndexOf('\n', rawFoldIndex - 1) + 1 : rawFoldIndex;
  return { runs, plain, weightedLength: parsed.weightedLength, rawFoldIndex, foldIndex, limit: 25_000 };
}
/** Text X will autolink (including bare domains such as claude.ai), using X's own rules. */
export function autolinks(plain: string): string[] { return twitter.extractUrls(plain); }
/** Non-blocking reminders: links become t.co, and on 2026-10-08 X dropped bold from a post with a link. */
export function linkWarnings(plain: string, hasBold: boolean): string[] {
  const links = autolinks(plain);
  if (!links.length) return [];
  const warnings = [`会变成链接：${links.join('、')}；X 会转成短链，每处按 23 字算`];
  if (hasBold) warnings.push('正文同时有链接和加粗：10-08 那条发出去加粗被 X 丢了，发完看一眼加粗还在不在');
  return warnings;
}
export function postWarnings(body: string, frontmatter: Record<string, unknown>, now = Date.now()): string[] {
  const warnings: string[] = [];
  if (/。/.test(body.replace(/。{3,}/g, ''))) warnings.push('正文含句号「。」');
  if (frontmatter.delivery_ready !== true) warnings.push('尚未标记为交付就绪');
  if (typeof frontmatter.expires_at === 'string') {
    const expires = Date.parse(frontmatter.expires_at);
    if (Number.isFinite(expires) && expires < now) warnings.push('稿件已过有效期');
  }
  if (!body.trim()) warnings.push('正文为空');
  return warnings;
}
export function quoteLink(value: unknown): { url: string; author: string } | null {
  if (typeof value !== 'string') return null;
  try {
    const parsed = new URL(value);
    if (!['x.com', 'www.x.com', 'twitter.com', 'www.twitter.com'].includes(parsed.hostname) || parsed.protocol !== 'https:') return null;
    const match = /^\/([A-Za-z0-9_]{1,15})\/status\/(\d+)\/?$/.exec(parsed.pathname);
    if (!match) return null;
    return { url: `https://x.com/${match[1]}/status/${match[2]}`, author: `@${match[1]}` };
  } catch { return null; }
}
