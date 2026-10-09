import { isScalar, parseDocument } from 'yaml';
import type { App, TFile } from 'obsidian';

export type ArticleSaveState = 'editing' | 'saving' | 'saved' | 'error';
export interface ArticleEditingOptions {
  onSaveState?: (state: ArticleSaveState, message: string) => void;
  onSaved?: (markdown: string) => void;
  onCoverDrop?: (files: File[]) => void | Promise<void>;
}
export interface ArticleSourceSpan { start: number; end: number; original: string; }
export interface ArticleEditableField {
  element: HTMLElement;
  kind: 'title' | 'paragraph' | 'heading';
  span?: ArticleSourceSpan;
}
export interface ArticleEditingHandle {
  flush(): Promise<void>;
  dispose(): void;
  isEditing(): boolean;
  applyBold(): void;
  applyHeading(): void;
}
interface EditOperation { start: number; end: number; replacement: string; field?: ArticleEditableField; }

export function articleBodyRange(markdown: string): { start: number; end: number; body: string } {
  const frontmatter = /^\uFEFF?---\r?\n(?:[\s\S]*?\r?\n)?---(?:\r?\n|$)/.exec(markdown);
  let start = frontmatter?.[0].length ?? (markdown.startsWith('\uFEFF') ? 1 : 0);
  let end = markdown.length;
  const visible = visibleHeadings(markdown.slice(start));
  const bodyHeading = visible.find(line => /^##\s+正文\s*$/.test(line.text));
  if (bodyHeading) {
    const base = start;
    start = base + bodyHeading.end;
    const next = visible.find(line => line.start > bodyHeading.start
      && /^##\s+(?:备选版本|素材话题|来源素材|核实记录|我的切入点|验收记录)\s*$/.test(line.text));
    if (next) end = base + next.start;
  }
  return { start, end, body: markdown.slice(start, end) };
}

function visibleHeadings(markdown: string): { text: string; start: number; end: number }[] {
  const result: { text: string; start: number; end: number }[] = [];
  let fence = '', comment = false;
  for (const match of markdown.matchAll(/[^\r\n]*(?:\r\n|\n|\r|$)/g)) {
    if (!match[0]) continue;
    const line = match[0].replace(/[\r\n]+$/, '');
    const mark = /^\s{0,3}(`{3,}|~{3,})/.exec(line)?.[1];
    if (!comment && mark) { if (!fence) fence = mark; else if (mark[0] === fence[0] && mark.length >= fence.length) fence = ''; continue; }
    if (fence) continue;
    let visible = '', cursor = 0;
    while (cursor < line.length) {
      const next = line.indexOf('%%', cursor), limit = next < 0 ? line.length : next;
      visible += comment ? ' '.repeat(limit - cursor) : line.slice(cursor, limit);
      if (next < 0) break;
      visible += '  '; comment = !comment; cursor = next + 2;
    }
    if (/^#{1,6}\s/.test(visible)) result.push({ text: visible, start: match.index!, end: match.index! + match[0].length });
  }
  return result;
}

function titleNode(markdown: string) {
  const match = /^\uFEFF?---\r?\n((?:[\s\S]*?\r?\n)?)---(?:\r?\n|$)/.exec(markdown);
  if (!match) return null;
  const yamlStart = /^\uFEFF?---\r?\n/.exec(markdown)![0].length;
  const document = parseDocument(match[1]);
  if (document.errors.length) throw Error('笔记属性格式有误，请先在原始笔记里修正');
  return { match, yamlStart, document, node: document.get('title', true) };
}

export function articleTitle(markdown: string, fallback: string): string {
  try {
    const frontmatter = titleNode(markdown);
    const direct = frontmatter?.document.get('title') ?? frontmatter?.document.get('Title');
    if (typeof direct === 'string' && direct.trim()) return direct.trim();
  } catch { /* Rendering can still show a filename if malformed YAML is being corrected. */ }
  return visibleHeadings(articleBodyRange(markdown).body).find(line => /^#\s+/.test(line.text))?.text.replace(/^#\s+/, '').trim() || fallback;
}

function resolveSpan(current: string, span: ArticleSourceSpan): number {
  const body = articleBodyRange(current);
  if (span.start >= body.start && span.end <= body.end && current.slice(span.start, span.end) === span.original) return span.start;
  if (!span.original) throw Error('这一段的位置已经变化，请重新打开后再改');
  const position = current.indexOf(span.original, body.start);
  if (position < body.start || position + span.original.length > body.end
    || (current.indexOf(span.original, position + 1) >= 0 && current.indexOf(span.original, position + 1) < body.end)) {
    throw Error('这一段在原始笔记里也被修改了，请重新打开后再改');
  }
  return position;
}

function titleOperations(current: string, expected: string, next: string, fallback: string): EditOperation[] {
  const title = next.replace(/[\r\n]+/g, ' ').trim();
  if (!title) throw Error('标题不能为空');
  if (articleTitle(current, fallback) !== expected) throw Error('标题在原始笔记里也被修改了，请重新打开后再改');
  const newline = current.includes('\r\n') ? '\r\n' : '\n';
  const frontmatter = titleNode(current);
  const body = articleBodyRange(current);
  const leadingHeading = /^\s*#([ \t]+)([^\r\n]+)(?:\r?\n|$)/.exec(body.body);
  const operations: EditOperation[] = [];
  if (frontmatter && isScalar(frontmatter.node) && frontmatter.node.range) {
    const [start, end] = frontmatter.node.range;
    const old = current.slice(frontmatter.yamlStart + start, frontmatter.yamlStart + end);
    operations.push({ start: frontmatter.yamlStart + start, end: frontmatter.yamlStart + end,
      replacement: JSON.stringify(title) + (/[\r\n]$/.test(old) ? newline : '') });
  } else if (frontmatter) {
    if (frontmatter.node !== undefined) throw Error('标题属性必须是文字，请先在原始笔记里修正');
    const insertion = frontmatter.yamlStart + frontmatter.match[1].length;
    operations.push({ start: insertion, end: insertion, replacement: 'title: ' + JSON.stringify(title) + newline });
  }
  if (leadingHeading && leadingHeading[2].trim() === expected) {
    const headingStart = body.start + leadingHeading[0].indexOf('#');
    const textStart = headingStart + 1 + leadingHeading[1].length;
    operations.push({ start: textStart, end: textStart + leadingHeading[2].length, replacement: title });
  } else if (!frontmatter) {
    // A leading H1 is the existing uploader's title source and keeps frontmatter untouched.
    operations.push({ start: body.start, end: body.start, replacement: '# ' + title + newline + newline });
  }
  return operations;
}

function headingMarkdown(original: string, value: string): string {
  const newline = original.includes('\r\n') ? '\r\n' : '\n';
  const line = value.replace(/[\r\n]+/g, ' ').trim();
  const atx = /^(\s{0,3}#{1,6}[ \t]+)([^\r\n]*?)([ \t]+#+[ \t]*)?$/.exec(original);
  if (atx) return atx[1] + line + (atx[3] ?? '');
  const setext = /^(.*?)(\r?\n[ \t]*(?:=+|-+)[ \t]*)$/.exec(original);
  return setext ? line + setext[2] : '## ' + line.replace(/\n/g, newline);
}

/** Pure, byte-preserving patcher used by the editor and its tests. */
export function applyArticleEdits(current: string, changes: { field: ArticleEditableField; value: string }[], expectedTitle: string, fallback: string): { markdown: string; operations: EditOperation[] } {
  const operations: EditOperation[] = [];
  for (const change of changes) {
    if (change.field.kind === 'title') { operations.push(...titleOperations(current, expectedTitle, change.value, fallback)); continue; }
    const span = change.field.span;
    if (!span) throw Error('这一段没有对应的原始笔记位置');
    const start = resolveSpan(current, span);
    const replacement = change.field.kind === 'heading' ? headingMarkdown(span.original, change.value)
      : change.value.replace(/\r?\n/g, current.includes('\r\n') ? '\r\n' : '\n');
    operations.push({ start, end: start + span.original.length, replacement, field: change.field });
  }
  const ascending = [...operations].sort((a, b) => a.start - b.start || a.end - b.end);
  for (let index = 1; index < ascending.length; index++) if (ascending[index].start < ascending[index - 1].end) throw Error('编辑位置重叠，请重新打开后再改');
  let markdown = current;
  for (const operation of [...operations].sort((a, b) => b.start - a.start || b.end - a.end)) {
    markdown = markdown.slice(0, operation.start) + operation.replacement + markdown.slice(operation.end);
  }
  return { markdown, operations };
}

function escapeText(value: string): string {
  return value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/\\/g, '\\\\').replace(/([*_`\[\]])/g, '\\$1');
}
export function editableMarkdown(element: HTMLElement): string {
  const children = (parent: Node): string => Array.from(parent.childNodes).map((node, index) => {
    const block = node instanceof HTMLElement && /^(?:div|p)$/i.test(node.tagName);
    return (block && index > 0 ? '\n' : '') + walk(node);
  }).join('');
  const walk = (node: Node): string => {
    if (node.nodeType === 3) return escapeText(node.textContent ?? '');
    if (!(node instanceof HTMLElement)) return '';
    const tag = node.tagName.toLowerCase();
    if (tag === 'br') return '\n';
    if (tag === 'img' || tag === 'script' || tag === 'style') return '';
    if ((tag === 'div' || tag === 'p') && node.childNodes.length === 1 && node.firstChild instanceof HTMLElement && node.firstChild.tagName === 'BR') return '';
    const contents = children(node);
    if (tag === 'b' || tag === 'strong') return contents ? '**' + contents + '**' : '';
    if (tag === 'i' || tag === 'em') return contents ? '*' + contents + '*' : '';
    if (tag === 'code') {
      const text = node.textContent ?? '', longest = Math.max(0, ...Array.from(text.matchAll(/`+/g), match => match[0].length));
      const marker = '`'.repeat(longest + 1), padding = /^`|`$/.test(text) ? ' ' : '';
      return marker + padding + text + padding + marker;
    }
    if (tag === 'a') {
      const internal = node.getAttribute('data-href');
      if (node.classList.contains('internal-link') && internal) {
        const target = internal.replace(/[\[\]\r\n]/g, ''), text = node.textContent ?? '';
        return text === target ? `[[${target}]]` : `[[${target}|${text.replace(/[\]\r\n]/g, '')}]]`;
      }
      const href = node.getAttribute('href') ?? '';
      return /^(?:https?:\/\/|mailto:)/i.test(href) ? `[${contents}](${href.replace(/\)/g, '%29')})` : contents;
    }
    return contents;
  };
  return children(element);
}

export function bindArticleEditing(stage: HTMLElement, app: App, file: TFile, markdown: string, fields: ArticleEditableField[], options: ArticleEditingOptions): ArticleEditingHandle {
  const pending = new Map<ArticleEditableField, string>(), composing = new Set<ArticleEditableField>();
  const removers: (() => void)[] = [];
  const surface = stage.getRootNode() as Document | (ShadowRoot & { getSelection?: () => Selection | null });
  const getSelection = () => typeof surface.getSelection === 'function' ? surface.getSelection() : stage.ownerDocument.getSelection();
  const getActiveElement = () => surface.activeElement || stage.ownerDocument.activeElement;
  const readonlyAnchors = Array.from(stage.querySelectorAll<HTMLElement>('[data-source-start][data-source-end]'))
    .filter(element => !fields.some(field => field.element === element))
    .map(element => { const start = Number(element.dataset.sourceStart), end = Number(element.dataset.sourceEnd); return { element, span: { start, end, original: markdown.slice(start, end) } }; });
  const syncAnchor = (element: HTMLElement, span: ArticleSourceSpan, saved: string) => {
    element.dataset.sourceStart = String(span.start); element.dataset.sourceEnd = String(span.end);
    element.dataset.sourceLine = String(saved.slice(0, span.start).split(/\r\n|\n|\r/).length - 1);
    element.dataset.sourceLineEnd = String(saved.slice(0, span.end).split(/\r\n|\n|\r/).length - 1);
  };
  let expectedTitle = articleTitle(markdown, file.basename), timer: ReturnType<typeof setTimeout> | undefined;
  let queue = Promise.resolve(), disposed = false, saving = false, lastField: ArticleEditableField | undefined, lastRange: Range | undefined;
  const rememberSelection = () => {
    const selection = getSelection();
    if (!selection?.rangeCount) return;
    const field = fields.find(item => item.element.contains(selection.anchorNode));
    if (field) { lastField = field; lastRange = selection.getRangeAt(0).cloneRange(); }
  };
  const selectedField = () => {
    const active = fields.find(field => field.kind !== 'title' && field.element.contains(getActiveElement()));
    if (active) return active;
    if (!lastField || lastField.kind === 'title' || !lastRange || !stage.contains(lastField.element)) return undefined;
    lastField.element.focus(); const selection = getSelection();
    selection?.removeAllRanges(); selection?.addRange(lastRange); return lastField;
  };
  stage.ownerDocument.addEventListener('selectionchange', rememberSelection); removers.push(() => stage.ownerDocument.removeEventListener('selectionchange', rememberSelection));
  const report = (state: ArticleSaveState, message: string) => options.onSaveState?.(state, message);
  const valueOf = (field: ArticleEditableField) => field.kind === 'title' ? (field.element.textContent ?? '').replace(/[\r\n]+/g, ' ').trim() : editableMarkdown(field.element);
  const schedule = (field: ArticleEditableField) => {
    if (disposed) return;
    pending.set(field, valueOf(field)); report('editing', '正在编辑…');
    if (timer) clearTimeout(timer);
    if (!composing.has(field)) timer = setTimeout(() => { void handle.flush().catch(() => {}); }, 1000);
  };
  const listen = (element: HTMLElement, event: string, callback: EventListener) => {
    element.addEventListener(event, callback); removers.push(() => element.removeEventListener(event, callback));
  };
  const bind = (field: ArticleEditableField) => {
    field.element.setAttribute('contenteditable', 'true');
    field.element.setAttribute('role', 'textbox');
    field.element.setAttribute('aria-multiline', String(field.kind === 'paragraph'));
    listen(field.element, 'input', () => schedule(field));
    listen(field.element, 'compositionstart', () => { composing.add(field); if (timer) clearTimeout(timer); });
    listen(field.element, 'compositionend', () => { composing.delete(field); schedule(field); });
    listen(field.element, 'drop', event => {
      const drop = event as DragEvent; drop.preventDefault();
      if (drop.dataTransfer?.files.length) return;
      stage.ownerDocument.execCommand('insertText', false, drop.dataTransfer?.getData('text/plain') ?? ''); schedule(field);
    });
    listen(field.element, 'keydown', (event) => {
      const key = event as KeyboardEvent;
      if (key.isComposing) return;
      if (key.key === 'Enter' && field.kind !== 'paragraph') key.preventDefault();
      if ((key.metaKey || key.ctrlKey) && key.key.toLowerCase() === 'b' && field.kind !== 'title') {
        key.preventDefault(); stage.ownerDocument.execCommand('bold'); schedule(field);
      }
    });
    listen(field.element, 'paste', (event) => {
      const paste = event as ClipboardEvent; paste.preventDefault();
      stage.ownerDocument.execCommand('insertText', false, paste.clipboardData?.getData('text/plain') ?? '');
      schedule(field);
    });
  };
  for (const field of fields) bind(field);
  const handle: ArticleEditingHandle = {
    flush: () => {
      if (composing.size) return Promise.reject(Error('请先完成正在输入的文字'));
      if (timer) clearTimeout(timer);
      const work = queue.catch(() => {}).then(async () => {
        while (pending.size && !disposed && !composing.size) {
          const changes = Array.from(pending, ([field, value]) => ({ field, value }));
          const positions = new Map<ArticleEditableField, number>(), readonlyPositions = new Map<ArticleSourceSpan, number>();
          let result: ReturnType<typeof applyArticleEdits> | undefined;
          saving = true; report('saving', '正在保存…');
          try {
            const saved = await app.vault.process(file, current => {
              for (const field of fields) if (field.span) {
                try { positions.set(field, resolveSpan(current, field.span)); } catch { /* Changed external blocks are left untouched. */ }
              }
              for (const anchor of readonlyAnchors) { try { readonlyPositions.set(anchor.span, resolveSpan(current, anchor.span)); } catch { /* External changes are rendered after editing ends. */ } }
              result = applyArticleEdits(current, changes, expectedTitle, file.basename);
              return result.markdown;
            });
            for (const field of fields) if (field.span && positions.has(field) && result) {
              const before = positions.get(field)!;
              const own = result.operations.find(operation => operation.field === field);
              const shift = result.operations.filter(operation => operation !== own && (operation.end <= before))
                .reduce((sum, operation) => sum + operation.replacement.length - (operation.end - operation.start), 0);
              field.span.start = before + shift;
              if (own) field.span.original = own.replacement;
              field.span.end = field.span.start + field.span.original.length; syncAnchor(field.element, field.span, saved);
            }
            for (const anchor of readonlyAnchors) if (readonlyPositions.has(anchor.span) && result) {
              const before = readonlyPositions.get(anchor.span)!;
              const shift = result.operations.filter(operation => operation.end <= before).reduce((sum, operation) => sum + operation.replacement.length - (operation.end - operation.start), 0);
              anchor.span.start = before + shift; anchor.span.end = anchor.span.start + anchor.span.original.length; syncAnchor(anchor.element, anchor.span, saved);
            }
            expectedTitle = articleTitle(saved, file.basename);
            for (const change of changes) if (pending.get(change.field) === change.value) pending.delete(change.field);
            report('saved', '✓ 已存进笔记 · 刚刚'); options.onSaved?.(saved);
          } catch (error) {
            report('error', error instanceof Error ? error.message : '保存没有完成，请重试');
            throw error;
          } finally { saving = false; }
        }
      });
      queue = work; return work;
    },
    dispose: () => { disposed = true; if (timer) clearTimeout(timer); for (const remove of removers) remove(); },
    isEditing: () => saving || pending.size > 0 || fields.some(field => field.element.contains(getActiveElement())),
    applyBold: () => {
      const active = selectedField();
      if (!active) return;
      stage.ownerDocument.execCommand('bold'); schedule(active);
    },
    applyHeading: () => {
      const active = selectedField();
      if (!active) return;
      const node = stage.ownerDocument.createElement(active.kind === 'heading' ? 'p' : 'h2');
      for (const attribute of Array.from(active.element.attributes)) node.setAttribute(attribute.name, attribute.value);
      while (active.element.firstChild) node.append(active.element.firstChild);
      active.element.replaceWith(node); active.element = node;
      active.kind = active.kind === 'heading' ? 'paragraph' : 'heading';
      bind(active); node.focus();
      const selection = getSelection(), range = stage.ownerDocument.createRange();
      range.selectNodeContents(node); range.collapse(false); selection?.removeAllRanges(); selection?.addRange(range);
      schedule(active);
    },
  };
  return handle;
}
