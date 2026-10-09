import { requestUrl } from 'obsidian';
import { quoteLink } from './model';

export interface Embed { author: string; text: string; url: string; name?: string; date?: string; }
interface CachedEmbed extends Embed { savedAt: number; }
export interface DeskData { quoteCache: Record<string, CachedEmbed>; backendDir?: string; }
export class Embeds {
  private pending = new Map<string, Promise<Embed>>();
  private failed = new Map<string, number>();
  constructor(private data: DeskData, private save: () => Promise<void>) {}
  async get(url: string): Promise<Embed> {
    const link = quoteLink(url);
    if (!link) return { author: '原帖', text: '', url: '' };
    const fallback = { ...link, text: '' };
    const cache = this.data.quoteCache[link.url];
    if (cache && Date.now() - cache.savedAt < 7 * 86400_000) return cache;
    if ((this.failed.get(link.url) || 0) > Date.now() - 600_000) return cache || fallback;
    const pending = this.pending.get(link.url); if (pending) return pending;
    const request = this.fetch(link.url).then(async value => {
      const paragraph = /<p\b[^>]*>([\s\S]*?)<\/p>/i.exec(value.html || '')?.[1] || '';
      // Strip every real tag before parsing entities. Even inert DOMParser documents
      // can load media, so raw oEmbed markup must never reach an HTML parser.
      const cleaned = paragraph.replace(/<(script|style|iframe)\b[\s\S]*?<\/\1\s*>/gi, '')
        .replace(/<br\s*\/?\s*>/gi, '\n').replace(/<[^>]*>/g, '').replace(/</g, '&lt;');
      const parsed = new DOMParser().parseFromString(`<p>${cleaned}</p>`, 'text/html');
      const text = parsed.body.textContent?.trim() || '';
      const result = { author: link.author, name: value.author_name, text: text.slice(0, 2000), url: link.url, savedAt: Date.now() };
      this.data.quoteCache[link.url] = result;
      const keys = Object.keys(this.data.quoteCache).sort((a, b) => this.data.quoteCache[b].savedAt - this.data.quoteCache[a].savedAt);
      for (const key of keys.slice(200)) delete this.data.quoteCache[key];
      await this.save(); return result;
    }).catch(() => { this.failed.set(link.url, Date.now()); return cache || fallback; }).finally(() => this.pending.delete(link.url));
    this.pending.set(link.url, request); return request;
  }
  private async fetch(url: string): Promise<{ html?: string; author_name?: string }> {
    const endpoint = `https://publish.twitter.com/oembed?url=${encodeURIComponent(url)}&omit_script=true&dnt=true`;
    // Obsidian's native request avoids renderer CORS and sends no supplied login credentials.
    let timeout: ReturnType<typeof setTimeout> | undefined;
    try {
      const response = await Promise.race([
        requestUrl({ url: endpoint, headers: { Accept: 'application/json' }, throw: false }),
        new Promise<never>((_, reject) => { timeout = setTimeout(() => reject(Error('引用请求超时')), 15000); }),
      ]);
      if (response.status !== 200 || response.text.length > 512_000) throw Error('引用暂不可用');
      return response.json;
    } finally { if (timeout) clearTimeout(timeout); }
  }
}
