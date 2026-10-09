import { MarkdownRenderer, TFile } from 'obsidian';
import { accountLabel, displayName } from './config';
import type { App, Component } from 'obsidian';
import { buildPreviewMarkdown } from '../vendor/icy-cat/markdown';
import { articleBodyRange, articleTitle, bindArticleEditing, type ArticleEditableField, type ArticleEditingHandle, type ArticleEditingOptions } from './article-edit';

export interface ArticleContext {
  app: App;
  component: Component;
  file: TFile;
  markdown: string;
  frontmatter: Record<string, unknown>;
  getEmbed: (url: string) => Promise<{ author: string; text: string; url: string }>;
  editing?: ArticleEditingOptions;
  onMedia?: (media: ArticleMediaInfo) => void;
}
export interface ArticleMediaImage {
  source: string; alt: string; file: TFile | null; start: number; end: number; line: number;
  width?: number; height?: number; warnings: string[];
}
export interface ArticleMediaInfo { cover: ArticleMediaImage | null; images: ArticleMediaImage[]; warnings: string[]; }
export interface ArticleRenderHandle extends ArticleEditingHandle { media: ArticleMediaInfo; }

interface SourceBlock { text: string; start: number; end: number; }
const renderVersions = new WeakMap<HTMLElement, number>();
const dimensionCache = new WeakMap<App, Map<string, { stamp: string; width: number; height: number }>>();
const imageStamp = (file: TFile) => `${file.stat?.mtime ?? 0}:${file.stat?.size ?? 0}`;
const POST_PATTERN = /^https?:\/\/(?:www\.)?(?:x\.com|twitter\.com)\/([^/]+)\/status\/(\d+)(?:[/?#].*)?$/i;
const IMAGE_EXTENSION = /^(?:avif|bmp|gif|jpeg|jpg|png|svg|webp)$/i;

/** X Article renderer. Source-line attributes are zero-based lines in the original note. */
export async function renderArticle(host: HTMLElement, context: ArticleContext): Promise<ArticleRenderHandle> {
  const version = (renderVersions.get(host) ?? 0) + 1;
  renderVersions.set(host, version);
  const doc = host.ownerDocument, stage = el(doc, 'div', 'xpd-article xpd-post');
  const media = articleMediaInfo(context.app, context.file, context.markdown);
  const inactive: ArticleRenderHandle = { media, flush: async () => {}, dispose: () => {}, isEditing: () => false, applyBold: () => {}, applyHeading: () => {} };
  const original = context.markdown, range = articleBodyRange(original);
  const rawBody = range.body.replace(/\r\n?/g, '\n');
  const body = buildPreviewMarkdown(context.file.basename, rawBody, { stripFrontmatter: false, useFilenameAsTitle: false });
  const leading = body ? rawBody.slice(0, rawBody.indexOf(body)) : '';
  const lineOffset = original.slice(0, range.start).split(/\r\n|\n|\r/).length - 1 + leading.split('\n').length - 1;
  const blocks = splitArticleBlocks(body, lineOffset), title = articleTitle(original, context.file.basename);
  const fields: ArticleEditableField[] = [], lineStarts = sourceLineStarts(original);
  let coverSlot: HTMLElement;
  if (media.cover?.file) {
    const image = el(doc, 'img', 'xpd-cover', stage) as HTMLImageElement;
    image.alt = '长文封面'; image.src = context.app.vault.getResourcePath(media.cover.file); coverSlot = image;
    image.dataset.sourceLine = String(media.cover.line);
  } else {
    coverSlot = el(doc, 'div', 'xpd-cover-empty', stage);
    el(doc, 'b', '', coverSlot).textContent = '封面 5:2';
    el(doc, 'span', '', coverSlot).textContent = '把图拖到这里当封面';
  }
  const titleNode = el(doc, 'div', 'xpd-article-title', stage);
  titleNode.textContent = title; titleNode.dataset.sourceLine = String(lineOffset);
  fields.push({ element: titleNode, kind: 'title' });
  const author = el(doc, 'div', 'xpd-author', stage);
  el(doc, 'span', 'xpd-avatar', author).textContent = Array.from(displayName().replace(/^@/, ''))[0] || 'X';
  el(doc, 'b', '', author).textContent = displayName(); el(doc, 'span', '', author).textContent = accountLabel();
  if (!body.trim()) el(doc, 'p', '', stage).textContent = '这篇长文还没有正文。';
  else {
    const definitions = collectLinkDefinitions(body);
    for (const block of blocks) {
      if (block === blocks[0] && /^#\s/.test(block.text) && block.text.replace(/^#\s+/, '').trim() === title) continue;
      const start = Math.max(range.start, lineStarts[block.start] ?? original.length);
      const next = lineStarts[block.end + 1] ?? original.length;
      const end = next - (original.slice(start, next).match(/(?:\r\n|\n|\r)$/)?.[0].length ?? 0);
      const source = original.slice(start, end);
      let renderedText = block.text;
      // The cover is a source embed, rendered once in the designed cover slot.
      if (media.cover && media.cover.start >= start && media.cover.end <= end) {
        const normalizedStart = original.slice(start, media.cover.start).replace(/\r\n?/g, '\n').length;
        const normalizedLength = original.slice(media.cover.start, media.cover.end).replace(/\r\n?/g, '\n').length;
        renderedText = renderedText.slice(0, normalizedStart) + renderedText.slice(normalizedStart + normalizedLength);
      }
      if (!renderedText.trim()) continue;
      const fragment = el(doc, 'div', '');
      const fence = renderedText.match(/^\s*(`{3,}|~{3,})([^\n]*)\n/);
      if (fence) {
        const pre = el(doc, 'pre', '', fragment), code = el(doc, 'code', '', pre), lines = renderedText.split('\n');
        if (new RegExp(`^\\s*${fence[1][0]}{${fence[1].length},}\\s*$`).test(lines.at(-1) ?? '')) lines.pop();
        code.textContent = lines.slice(1).join('\n');
        const language = fence[2].trim().split(/\s/)[0];
        if (language) code.className = `language-${language.replace(/[^a-zA-Z0-9_-]/g, '')}`;
      } else {
        await MarkdownRenderer.render(context.app, prepareLocalMarkdown(renderedText + '\n\n' + definitions, context), fragment, context.file.path, context.component);
      }
      if (renderVersions.get(host) !== version) return inactive;
      const children = Array.from(fragment.children).filter((node): node is HTMLElement => node instanceof HTMLElement);
      for (const node of children) {
        node.dataset.sourceLine = String(block.start); node.dataset.sourceLineEnd = String(block.end);
        node.dataset.sourceStart = String(start); node.dataset.sourceEnd = String(end); stage.append(node);
        if (node.matches('pre,table') || node.querySelector('pre,table')) {
          node.setAttribute('contenteditable', 'false'); node.title = '代码块和表格在原始笔记里改';
        }
        // A single source block owns one editable paragraph or heading. Images,
        // comments, link definitions, quotes and lists retain their original bytes.
        if (context.editing && children.length === 1 && node.matches('p,h1,h2,h3,h4,h5,h6')
          && !node.querySelector('img,pre,table') && !source.includes('%%')
          && !/^ {0,3}\[[^\]]+\]:/m.test(source) && !/^\s*https?:\/\/(?:www\.)?(?:x|twitter)\.com\/[^/]+\/status\//i.test(source)
          && renderedText === block.text && prepareLocalMarkdown(block.text, context) === block.text) {
          fields.push({ element: node, kind: /^H/.test(node.tagName) ? 'heading' : 'paragraph', span: { start, end, original: source } });
        }
      }
    }
    enhancePostLinks(stage, context);
    stage.querySelectorAll<HTMLAnchorElement>('a.external-link').forEach(link => { link.target = '_blank'; link.rel = 'noopener noreferrer'; });
  }
  if (renderVersions.get(host) !== version) return inactive;
  host.replaceChildren(stage);
  const editing = context.editing ? bindArticleEditing(stage, context.app, context.file, original, fields, context.editing) : inactive;
  const drop = async (event: DragEvent) => {
    if (!context.editing?.onCoverDrop || !event.dataTransfer?.files.length) return;
    event.preventDefault(); event.stopPropagation();
    try { await editing.flush(); await context.editing.onCoverDrop(Array.from(event.dataTransfer.files)); }
    catch (error) { context.editing.onSaveState?.('error', error instanceof Error ? error.message : '封面没有添加成功'); }
  };
  const dragover = (event: DragEvent) => { if (context.editing?.onCoverDrop && event.dataTransfer?.types.includes('Files')) event.preventDefault(); };
  coverSlot.addEventListener('dragover', dragover); coverSlot.addEventListener('drop', drop);
  let disposed = false;
  const handle: ArticleRenderHandle = { ...editing, media, dispose: () => {
    disposed = true; editing.dispose(); coverSlot.removeEventListener('dragover', dragover); coverSlot.removeEventListener('drop', drop);
  } };
  context.component.register(() => handle.dispose()); context.onMedia?.(media);
  void enrichDimensions(media, context, () => { if (!disposed && renderVersions.get(host) === version) context.onMedia?.(media); });
  return handle;
}

function sourceLineStarts(markdown: string): number[] {
  const starts = [0]; for (const match of markdown.matchAll(/\r\n|\n|\r/g)) starts.push(match.index! + match[0].length); return starts;
}

/** Parse media without reading files or causing network requests. */
export function articleMediaInfo(app: App, file: TFile, markdown: string): ArticleMediaInfo {
  const range = articleBodyRange(markdown), masked = maskMediaMarkdown(range.body);
  const definitions = new Map<string, string>();
  for (const match of masked.matchAll(/^ {0,3}\[([^\]]+)\]:[ \t]*(?:<([^>]+)>|(\S+))/gm)) definitions.set(match[1].toLowerCase(), match[2] || match[3]);
  const images: ArticleMediaImage[] = [];
  const pattern = /!\[\[([^\]\r\n]+)\]\]|!\[([^\]\r\n]*)\]\([ \t]*(?:<([^>\r\n]+)>|([^\)\r\n]*))[ \t]*\)|!\[([^\]\r\n]*)\](?:\[([^\]\r\n]*)\])?/g;
  for (const match of masked.matchAll(pattern)) {
    const source = match[1] || match[3] || match[4] || definitions.get((match[6] || match[5] || '').toLowerCase()) || '';
    const local = resolveImage({ app, file }, source), start = range.start + match.index!, end = start + match[0].length;
    images.push({ source, alt: match[2] || match[5] || '', file: local, start, end,
      line: markdown.slice(0, start).split(/\r\n|\n|\r/).length - 1, warnings: local ? [] : ['图片不在仓库里或路径无效'] });
  }
  const title = articleTitle(markdown, file.basename);
  let firstContent = masked.replace(/^\s*#\s+([^\r\n]+)(?:\r?\n|$)/, (all, value: string) => value.trim() === title ? ' '.repeat(all.length) : all);
  const first = images[0], relativeStart = first ? first.start - range.start : 0;
  const cover = first?.file && !firstContent.slice(0, relativeStart).trim()
    && !firstContent.slice(relativeStart + first.end - first.start).split(/\r\n|\n|\r/)[0].trim() ? first : null;
  const bodyImages = cover ? images.slice(1) : images;
  for (const image of images) if (image.file) {
    const cached = dimensionCache.get(app)?.get(image.file.path);
    if (cached?.stamp === imageStamp(image.file)) { image.width = cached.width; image.height = cached.height; }
  }
  if (cover?.height && cover.width && Math.abs(cover.width / cover.height / 2.5 - 1) > 0.2) cover.warnings.push('封面会被裁成 5:2');
  const warnings = bodyImages.length > 25 ? ['正文图片超过 25 张'] : [];
  if (!cover) warnings.push('没有封面图');
  warnings.push(...images.flatMap(image => image.warnings));
  return { cover, images: bodyImages, warnings };
}

function maskMediaMarkdown(markdown: string): string {
  let fence: FenceMark | null = null, comment = false;
  return markdown.split(/(\r\n|\n|\r)/).map((line, index) => {
    if (index % 2) return line;
    const mark = fenceMark(line);
    if (!comment && mark) {
      if (!fence) fence = mark; else if (mark.marker[0] === fence.marker[0] && mark.marker.length >= fence.marker.length && !mark.info.trim()) fence = null;
      return ' '.repeat(line.length);
    }
    if (fence) return ' '.repeat(line.length);
    let out = '', cursor = 0;
    while (cursor < line.length) {
      const next = line.indexOf('%%', cursor), limit = next < 0 ? line.length : next;
      out += comment ? ' '.repeat(limit - cursor) : line.slice(cursor, limit);
      if (next < 0) break; out += '  '; comment = !comment; cursor = next + 2;
    }
    return out.replace(/(`+)(.*?)\1/g, match => ' '.repeat(match.length));
  }).join('');
}

async function enrichDimensions(media: ArticleMediaInfo, context: ArticleContext, changed: () => void): Promise<void> {
  const ImageConstructor = context.app.workspace?.containerEl?.ownerDocument.defaultView?.Image;
  if (!ImageConstructor) return;
  await Promise.all([media.cover, ...media.images].filter((item): item is ArticleMediaImage => !!item?.file).map(async item => {
    await new Promise<void>(resolve => {
      const image = new ImageConstructor();
      image.onload = () => { item.width = image.naturalWidth; item.height = image.naturalHeight;
        let cache = dimensionCache.get(context.app); if (!cache) dimensionCache.set(context.app, cache = new Map());
        cache.set(item.file!.path, { stamp: imageStamp(item.file!), width: item.width, height: item.height });
        if (item === media.cover && item.height && Math.abs(item.width / item.height / 2.5 - 1) > 0.2 && !item.warnings.includes('封面会被裁成 5:2')) {
          item.warnings.push('封面会被裁成 5:2'); media.warnings.push('封面会被裁成 5:2');
        }
        changed(); resolve(); };
      image.onerror = () => resolve(); image.src = context.app.vault.getResourcePath(item.file!);
    });
  }));
}

function el(doc: Document, tag: string, className: string, parent?: HTMLElement): HTMLElement {
  const node = doc.createElement(tag);
  node.className = className;
  parent?.append(node);
  return node;
}

/** Resolve only a real image file inside the vault; remote and external filesystem refs fail closed. */
function resolveImage(context: Pick<ArticleContext, 'app' | 'file'>, source: string): TFile | null {
  let normalized = source.trim()
    .replace(/^!?\[\[|\]\]$/g, '')
    .replace(/^!\[[^\]]*\]\((.+)\)$/u, '$1')
    .replace(/^<|>$/g, '')
    .split('|')[0].trim();
  // A Markdown image destination may carry an optional quoted title.
  normalized = normalized.replace(/\s+["'][^"']*["']$/, '');
  try { normalized = decodeURIComponent(normalized); } catch { return null; }
  if (!normalized || /^[a-z][a-z\d+.-]*:/i.test(normalized) || /^[/\\]/.test(normalized)
    || /(?:^|[/\\])\.\.(?:[/\\]|$)/.test(normalized)) return null;
  const target = context.app.metadataCache.getFirstLinkpathDest(normalized, context.file.path)
    ?? context.app.metadataCache.getFirstLinkpathDest(normalized.replace(/^\.\//, ''), context.file.path);
  return target instanceof TFile && IMAGE_EXTENSION.test(target.extension) ? target : null;
}

/** Prevent Markdown/HTML media from introducing requests other than the supplied oEmbed service. */
function prepareLocalMarkdown(markdown: string, context: ArticleContext): string {
  const images: { token: string; markdown: string }[] = []; let prefix = '\uE000xpd-local-image-';
  while (markdown.includes(prefix)) prefix += '-';
  const localImage = (source: string, alt: string): string => {
    const target = resolveImage(context, source);
    if (!target) return `〔${alt || '图片'}：仅预览仓库内图片〕`;
    const url = context.app.vault.getResourcePath(target);
    const token = prefix + images.length + '\uE001';
    images.push({ token, markdown: `![${alt.replace(/[\[\]]/g, '')}](<${url}>)` }); return token;
  };
  // Remove raw HTML elements, including iframe, audio, SVG and CSS URLs, before rendering.
  // Autolinks such as <https://x.com/...> are kept because ':' is not an HTML tag delimiter.
  const protectedCode = protectNestedFences(markdown);
  let output = protectedCode.markdown.replace(/<!--[^]*?-->/g, '');
  output = output.replace(/<(script|style|iframe|object|audio|video|svg)\b[^]*?<\/\1\s*>/gi, '');
  output = output.replace(/<\/?[A-Za-z][\w-]*(?:\s[^>]*|\s*\/?)>/g, '');
  const references = new Map<string, string>();
  output.replace(/^ {0,3}\[([^\]]+)\]:\s*(?:<([^>]+)>|(\S+))/gm, (_all, id: string, bracket: string, plain: string) => {
    references.set(id.toLowerCase(), bracket || plain); return _all;
  });
  output = output.replace(/!\[\[([^\]]+)\]\]/g, (_all, source: string) => localImage(source, ''));
  output = output.replace(/!\[([^\]]*)\]\(\s*(?:<([^>]+)>|([^)]*))\s*\)/g,
    (_all, alt: string, bracket: string, plain: string) => localImage(bracket || plain, alt));
  output = output.replace(/!\[([^\]]*)\]\[([^\]]*)\]/g,
    (_all, alt: string, id: string) => localImage(references.get((id || alt).toLowerCase()) ?? '', alt));
  // An unresolved shortcut reference must stay text, otherwise an external reference can become media.
  output = output.replace(/!\[([^\]]*)\](?!\()/g,
    (_all, alt: string) => localImage(references.get(alt.toLowerCase()) ?? '', alt));
  for (const image of images) output = output.replace(image.token, () => image.markdown);
  return protectedCode.restore(output);
}

interface FenceMark { prefix: string; marker: string; info: string; }
function fenceMark(line: string): FenceMark | null {
  // Markdown fences can occur inside a quote, a list, or a quote within a list.
  const match = line.match(/^([ \t]*(?:(?:>[ \t]*)|(?:(?:[-+*]|\d+[.)])[ \t]+))*)(`{3,}|~{3,})(.*)$/);
  return match ? { prefix: match[1], marker: match[2], info: match[3] } : null;
}

function protectNestedFences(markdown: string): { markdown: string; restore: (value: string) => string } {
  const lines = markdown.split('\n'), output: string[] = [];
  const protectedBlocks: { token: string; text: string }[] = [];
  let prefix = '\uE000xpd-fenced-code-';
  while (markdown.includes(prefix)) prefix += '-';
  for (let index = 0; index < lines.length; index++) {
    const opening = fenceMark(lines[index]);
    if (!opening) { output.push(lines[index]); continue; }
    const block = [opening.prefix + opening.marker];
    // Every nested fence has a blank info string: no code-block processor can
    // interpret x-draft, x-publish, or another plugin's executable language.
    while (++index < lines.length) {
      block.push(lines[index]);
      const closing = fenceMark(lines[index]);
      if (closing && closing.marker[0] === opening.marker[0]
        && closing.marker.length >= opening.marker.length && !closing.info.trim()) break;
    }
    const token = prefix + protectedBlocks.length + '\uE001';
    protectedBlocks.push({ token, text: block.join('\n') });
    output.push(token);
  }
  return {
    markdown: output.join('\n'),
    restore: (value) => {
      for (const block of protectedBlocks) value = value.replace(block.token, () => block.text);
      return value;
    },
  };
}

function collectLinkDefinitions(markdown: string): string {
  return markdown.split('\n').filter((line) => /^ {0,3}\[[^\]]+\]:\s/.test(line)).join('\n');
}

/** Block ranges preserve the source note's line numbers, including hidden Obsidian comments. */
export function splitArticleBlocks(markdown: string, offset = 0): SourceBlock[] {
  const lines = maskCommentsOutsideFences(markdown).split('\n');
  const blocks: SourceBlock[] = [];
  const isList = (line: string) => /^\s{0,3}(?:[-*+]\s|\d+[.)]\s)/.test(line);
  const isStarter = (line: string) => /^\s{0,3}(?:#{1,6}\s|>|`{3,}|~{3,}|(?:[-*_]\s*){3,}$)/.test(line) || isList(line);
  for (let i = 0; i < lines.length;) {
    if (!lines[i].trim() || /^ {0,3}\[[^\]]+\]:\s/.test(lines[i])) { i++; continue; }
    const start = i;
    const fence = lines[i].match(/^\s{0,3}(`{3,}|~{3,})/);
    if (fence) {
      i++;
      const closing = new RegExp(`^\\s{0,3}${fence[1][0]}{${fence[1].length},}\\s*$`);
      while (i < lines.length && !closing.test(lines[i])) i++;
      if (i < lines.length) i++;
    } else if (/^\s{0,3}#{1,6}\s/.test(lines[i]) || /^\s{0,3}(?:[-*_]\s*){3,}$/.test(lines[i])) {
      i++;
    } else if (isList(lines[i]) || /^\s{0,3}>/.test(lines[i])) {
      const list = isList(lines[i]);
      i++;
      while (i < lines.length) {
        if (!lines[i].trim()) {
          let next = i + 1;
          while (next < lines.length && !lines[next].trim()) next++;
          if (next < lines.length && (list ? isList(lines[next]) || /^\s{2,}\S/.test(lines[next]) : /^\s{0,3}>/.test(lines[next]))) { i = next; continue; }
          break;
        }
        const lazyContinuation = !isStarter(lines[i]) && !/^ {0,3}\[[^\]]+\]:\s/.test(lines[i]);
        if (list ? isList(lines[i]) || /^\s{2,}\S/.test(lines[i]) || lazyContinuation : /^\s{0,3}>/.test(lines[i]) || lazyContinuation) { i++; continue; }
        break;
      }
    } else if (i + 1 < lines.length && /^\s{0,3}(?:=+|-+)\s*$/.test(lines[i + 1])) {
      // A Setext heading and its underline form one Markdown block.
      i += 2;
    } else {
      i++;
      while (i < lines.length && lines[i].trim() && !isStarter(lines[i])) i++;
    }
    blocks.push({ text: lines.slice(start, i).join('\n'), start: start + offset, end: i - 1 + offset });
  }
  return blocks;
}

function maskCommentsOutsideFences(markdown: string): string {
  let fence: { character: string; length: number } | null = null;
  let commentOpen = false;
  return markdown.split('\n').map((line) => {
    if (fence) {
      const closing = fenceMark(line);
      if (closing && closing.marker[0] === fence.character
        && closing.marker.length >= fence.length && !closing.info.trim()) fence = null;
      return line;
    }
    const literalFence = !commentOpen && fenceMark(line);
    if (literalFence) {
      fence = { character: literalFence.marker[0], length: literalFence.marker.length };
      return line;
    }
    // Mask comments with spaces so hidden blocks keep their original source lines.
    let output = '', position = 0;
    while (position < line.length) {
      const delimiter = line.indexOf('%%', position);
      const end = delimiter < 0 ? line.length : delimiter;
      output += commentOpen ? ' '.repeat(end - position) : line.slice(position, end);
      if (delimiter < 0) break;
      output += '  ';
      commentOpen = !commentOpen;
      position = delimiter + 2;
    }
    const opening = fenceMark(output);
    if (opening && !commentOpen) {
      fence = { character: opening.marker[0], length: opening.marker.length };
    }
    return output;
  }).join('\n');
}

function enhancePostLinks(article: HTMLElement, context: ArticleContext): void {
  article.querySelectorAll<HTMLAnchorElement>('a').forEach((link) => {
    const match = link.href.match(POST_PATTERN);
    const block = link.closest<HTMLElement>('p');
    if (!match || !block || block.querySelectorAll('a').length !== 1
      || block.textContent?.trim() !== link.textContent?.trim()) return;
    const card = el(article.ownerDocument, 'div', 'xpd-quote');
    card.dataset.postUrl = link.href;
    card.dataset.sourceLine = block.dataset.sourceLine ?? '';
    card.dataset.sourceLineEnd = block.dataset.sourceLineEnd ?? '';
    const header = el(article.ownerDocument, 'div', 'xpd-quote-head', card);
    const avatar = el(article.ownerDocument, 'span', 'xpd-quote-avatar', header);
    avatar.textContent = match[1][0].toUpperCase();
    const author = el(article.ownerDocument, 'b', '', header);
    author.textContent = `@${match[1]}`;
    const original = el(article.ownerDocument, 'a', '', header) as HTMLAnchorElement;
    original.href = link.href;
    el(article.ownerDocument, 'span', '', original).textContent = `@${match[1]}`;
    original.target = '_blank'; original.rel = 'noopener noreferrer';
    const text = el(article.ownerDocument, 'div', 'xpd-quote-text', card);
    text.textContent = '正在加载原帖…';
    block.replaceWith(card);
    const missing = () => {
      card.classList.add('is-missing');
      text.textContent = '原帖内容取不到，上传时照样会引用';
    };
    // No widgets.js, iframe, avatar image or external image is loaded by this preview.
    void context.getEmbed(link.href).then((embed) => {
      author.textContent = embed.author || `@${match[1]}`;
      if (embed.text) text.textContent = embed.text; else missing();
    }, missing);
  });
}
