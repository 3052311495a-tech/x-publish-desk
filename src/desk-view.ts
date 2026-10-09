import { Component, FileView, MarkdownView, Notice, TFile, WorkspaceLeaf, setIcon } from 'obsidian';
import { accountLabel, config } from './config';
import { Backend, type UploadKind, type UploadResult } from './backend';
import { Embeds } from './embeds';
import { isArchivedPost, metadata, noteMode, postBody, postStats, quoteLink } from './model';
import { toolbarReviewChip } from './toolbar';
import { UploadStatus, type UploadContext } from './upload-status';
import { renderPost } from './post';
import { renderArticle, articleMediaInfo, type ArticleRenderHandle } from './article';
import { PostEditor } from './post-edit';
import { copyAttachments, resolvePostMedia, splitPostMedia } from './media';
import { articleBodyRange } from './article-edit';
import { buildPublishingChecks, renderPublishingChecks, renderDetails, renderVersions, versionCards, swapVersion, runWritingStyleCheck } from './desk-panels';
import { deliveryStateLabel, mountDeliveryControls, renderDeliveryResult, type DeliveryControlsHandle } from './delivery-controls';
import { deliveryReceiptUncertain } from './delivery-receipt';

type Tab = 'preview' | 'checks' | 'versions' | 'details';
export const DESK_TYPE = 'x-publish-desk';
export class DeskView extends FileView {
  surface!: HTMLElement;
  private markdown = '';
  private tab: Tab = 'preview';
  private component?: Component;
  private editor?: PostEditor;
  private article?: ArticleRenderHandle;
  private status?: UploadStatus;
  private delivery?: DeliveryControlsHandle;
  private deliveryBusy = false;
  private draftButton?: HTMLButtonElement;
  private revisionButton?: HTMLButtonElement;
  private completedDelivery?: { file: TFile; result: UploadResult };
  private lockedEditors = new Map<HTMLElement, string | null>();
  private lockedTools = new Map<HTMLButtonElement, boolean>();
  private lockedCards = new Map<HTMLElement, boolean>();
  private context!: UploadContext;
  private bodyHost?: HTMLElement;
  private tabs = new Map<Tab, HTMLButtonElement>();
  private quoteUrl = '';
  private quoteState: 'none'|'loading'|'loaded'|'missing' = 'none';
  private style?: Awaited<ReturnType<typeof runWritingStyleCheck>>;
  private revision = 0;
  private closing = false;
  private pendingExternal = false;
  private styleTimer?: number;
  constructor(leaf: WorkspaceLeaf, private backend: Backend, private embeds: Embeds, private css: string, private openOriginal: (file: TFile) => Promise<void>) { super(leaf); }
  getViewType() { return DESK_TYPE; }
  getDisplayText() { return this.file ? 'X 发布台 · ' + this.file.basename : 'X 发布台'; }
  getIcon() { return 'file-text'; }
  getState() { return { file: this.file?.path, tab: this.tab }; }
  async setState(state: { file?: string; tab?: Tab }, result: unknown) {
    if(this.file && state.file!==this.file.path) await this.flush();
    if (['preview','checks','versions','details'].includes(state.tab || '')) this.tab = state.tab!;
    await super.setState(state, result as never);
    await this.loadNote();
  }
  async onOpen() {
    this.contentEl.removeClass('view-content'); this.contentEl.addClass('xpd-root','xpd-view');
    const shadow=this.contentEl.shadowRoot||this.contentEl.attachShadow({mode:'open'});
    const style=document.createElement('style');style.textContent=this.css;shadow.append(style);
    const frame=document.createElement('div');frame.className='xpd-view';shadow.append(frame);
    this.surface=document.createElement('div');this.surface.className='xpd-root xpd-view';frame.append(this.surface);
    const theme=()=>frame.toggleClass('theme-dark',document.body.hasClass('theme-dark'));theme();
    const observer=new MutationObserver(theme);observer.observe(document.body,{attributes:true,attributeFilter:['class']});this.register(()=>observer.disconnect());
    this.registerEvent(this.app.vault.on('modify', file => {
      if (file === this.file && !this.closing) void this.externalChange();
    }));
    this.registerEvent(this.app.vault.on('rename', file => {
      if (file === this.file && !this.closing) { this.pendingExternal = true; void this.externalChange(); }
    }));
    this.register(this.backend.onBusyChange(() => {
      this.syncActionBusy();
      if (!this.backend.busy && !this.deliveryBusy && this.pendingExternal) void this.externalChange();
    }));
    await this.loadNote();
  }
  private async externalChange() {
    if (!this.file) return;
    // Moving a submitted note may emit both modify and rename before the
    // runner's verified receipt returns. Keep that delivery control alive.
    if (this.deliveryBusy || this.backend.busy) { this.pendingExternal = true; return; }
    const file = this.file, next = await this.app.vault.read(file);
    if (this.closing || this.file !== file) return;
    if (this.deliveryBusy || this.backend.busy) { this.pendingExternal = true; return; }
    if(this.editor?.isFocused || this.editor?.dirty || this.article?.isEditing()) { if(next!==this.markdown)this.pendingExternal=true;return; }
    if(next===this.markdown&&!this.pendingExternal)return;
    this.pendingExternal=false;this.markdown=next;await this.render();
  }
  private async loadNote() {
    if (!this.file) { this.surface.empty(); this.surface.createDiv({cls:'xpd-body',text:'打开创作中的推文或长文，即可编辑和预览'}); return; }
    this.markdown = await this.app.vault.read(this.file); await this.render();
  }
  /** Re-read an archived note's receipt after a background follow-up updated it. */
  async refreshArchived(paths: string[]) {
    if (!this.file || this.closing || !isArchivedPost(this.file.path) || !paths.includes(this.file.path)) return;
    this.markdown = await this.app.vault.read(this.file); await this.render();
  }
  async flush() { if (this.editor) this.markdown = await this.editor.flush(); if (this.article) await this.article.flush(); this.delivery?.refresh(); }
  async upload(kind?: UploadKind): Promise<UploadResult | undefined> {
    if (this.file && isArchivedPost(this.file.path)) { new Notice('归档笔记只能查看，请在创作区准备新稿'); return; }
    try { await this.flush(); this.style=await runWritingStyleCheck(noteMode(this.file?.path||'')==='article'?articleBodyRange(this.markdown).body:postBody(this.markdown));this.updateBadge();return await this.status?.run(kind); }
    catch(e) { new Notice(e instanceof Error ? e.message : String(e)); return undefined; }
    finally { this.syncActionBusy(); if (this.pendingExternal && !this.backend.busy && !this.deliveryBusy) void this.externalChange(); }
  }
  private async deliveryCompleted(file: TFile, result: UploadResult) {
    if (this.closing || this.file !== file) return;
    if (result.verified === true && !deliveryReceiptUncertain(result)) this.completedDelivery = { file, result };
    if (typeof result.archived_path === 'string' && result.verified === true && !deliveryReceiptUncertain(result)) {
      const archived = this.app.vault.getAbstractFileByPath(result.archived_path);
      if (!(archived instanceof TFile) || !isArchivedPost(archived.path)) throw new Error('归档后的笔记暂时没有加载，请从目录重新打开');
      // renameFile normally keeps the same TFile. Rebind defensively without
      // replacing the leaf or navigating away from the verified receipt.
      this.file = archived; this.completedDelivery = { file: archived, result };
      this.pendingExternal = false; this.markdown = await this.app.vault.read(archived);
      if (this.closing || this.file !== archived) return;
      await this.render(); this.app.workspace.requestSaveLayout();
    } else if (this.pendingExternal) await this.externalChange();
  }
  private syncActionBusy() {
    const busy = this.backend.busy || this.deliveryBusy;
    this.status?.syncBusy();
    if (busy && this.draftButton) this.draftButton.disabled = true;
    if (this.revisionButton) this.revisionButton.disabled = busy || this.backend.learningBusy;
    this.delivery?.setBusy(busy);
    if (busy) {
      this.surface?.querySelectorAll<HTMLElement>('.xpd-post,.xpd-editbar').forEach(element=>{
        if(!this.lockedCards.has(element))this.lockedCards.set(element,element.inert);
        element.inert=true;
      });
      this.surface?.querySelectorAll<HTMLElement>('[contenteditable="true"]').forEach(element=>{
        if(!this.lockedEditors.has(element))this.lockedEditors.set(element,element.getAttribute('contenteditable'));
        element.setAttribute('contenteditable','false');
      });
      this.surface?.querySelectorAll<HTMLButtonElement>('.xpd-editbar button').forEach(button=>{
        if(!this.lockedTools.has(button))this.lockedTools.set(button,button.disabled);
        button.disabled=true;
      });
    } else {
      for(const [element,value] of this.lockedEditors){if(value===null)element.removeAttribute('contenteditable');else element.setAttribute('contenteditable',value);}
      for(const [button,value] of this.lockedTools)button.disabled=value;
      for(const [element,value] of this.lockedCards)element.inert=value;
      this.lockedEditors.clear();this.lockedTools.clear();this.lockedCards.clear();
    }
  }
  private async select(tab: Tab) {
    try { await this.flush(); this.tab = tab; await this.render(); this.app.workspace.requestSaveLayout(); }
    catch(e) { new Notice(String(e)); }
  }
  private async render() {
    if (!this.file || this.closing) return;
    const token = ++this.revision, file = this.file, mode = noteMode(file.path)!, archived = isArchivedPost(file.path);
    const savedReceipt = archived ? this.backend.archivedDelivery(file, this.markdown) : undefined;
    // Archived receipts must match the current disk bytes via the backend.
    // A cached success belongs to the submitted version, never later edits.
    const receipt = archived ? savedReceipt : this.completedDelivery?.file === file ? this.completedDelivery.result : undefined;
    this.editor?.dispose(); this.editor = undefined; this.article?.dispose(); this.article = undefined;
    this.component?.unload(); this.component = new Component(); this.component.load();
    this.delivery?.dispose(); this.delivery = undefined; this.status?.dispose(); this.status = undefined;
    this.lockedEditors.clear(); this.lockedTools.clear(); this.lockedCards.clear();
    this.draftButton = undefined; this.revisionButton = undefined; this.surface.empty(); this.tabs.clear();
    const root = this.surface, bar = root.createDiv({cls:'xpd-topbar'});
    for (const [tab,label] of [['preview','预览'],['checks','发布检查'],['versions','备选版本'],['details','详情']] as const) {
      if (archived && (tab === 'checks' || tab === 'versions')) continue;
      if (tab === 'versions' && versionCards(this.markdown).alternatives.length === 0) continue;
      const button = bar.createEl('button',{cls:'xpd-seg'+(tab === this.tab?' is-active':''),text:label,attr:{type:'button',role:'tab','aria-selected':String(tab===this.tab)}});
      button.onclick = () => {void this.select(tab);}; this.tabs.set(tab,button);
    }
    if (!this.tabs.has(this.tab)) this.tab = 'preview';
    bar.createSpan({cls:'xpd-divider'});
    const fm = metadata(this.markdown);
    bar.createSpan({cls:'xpd-chip is-kind',text:mode==='post'?'推文':'长文'});
    if (archived) bar.createSpan({cls:'xpd-chip is-ok',text:deliveryStateLabel(receipt)});
    else { const review = toolbarReviewChip(fm); bar.createSpan({cls:'xpd-chip '+review.cls,text:review.text}); }
    const quote = mode==='post'?quoteLink(fm.quote):null; if(this.quoteUrl!==quote?.url){this.quoteUrl=quote?.url||'';this.quoteState=quote?'loading':'none';}
    if(quote) void this.embeds.get(quote.url).then(value=>{if(token!==this.revision)return;this.quoteState=value.text?'loaded':'missing';this.updateBadge();if(this.tab==='checks')this.renderChecks();});
    if (quote) {const chip=bar.createSpan({cls:'xpd-chip'});setIcon(chip,'arrow-up-right');chip.appendText('引用 '+quote.author);}
    if (mode==='article') {
      const info=articleMediaInfo(this.app,file,this.markdown);
      bar.createSpan({cls:'xpd-chip'+(info.cover?'':' is-warn'),text:info.cover?'封面 ✓':'没有封面图'});
      bar.createSpan({cls:'xpd-chip',text:`正文图片 ${info.images.length} / 25`});
    }
    bar.createSpan({cls:'xpd-spacer'});
    this.context={file,kind:mode,quote:quote?.author.slice(1)||null,fingerprint:this.markdown};
    let statusHost: HTMLElement | undefined;
    if (!archived) {
      if(config.revision_learning){
      const done=this.revisionButton=bar.createEl('button',{cls:'xpd-btn',text:'改稿完成，供 AI 学习',attr:{type:'button'}});
      done.onclick=async()=>{if(this.backend.busy||this.deliveryBusy)return;done.disabled=true;try{await this.flush();await this.backend.recordRevision(file);}catch(e){new Notice(String(e));}finally{this.syncActionBusy();}};
      }
      const upload=this.draftButton=bar.createEl('button',{cls:'xpd-btn-primary',attr:{type:'button'}});
      statusHost=document.createElement('div');statusHost.className='xpd-col';statusHost.hidden=true;
      this.status=new UploadStatus(upload,statusHost,this.backend,()=>this.context,()=>this.syncActionBusy());
      upload.onclick=()=>{void this.upload();};
    }
    const body=this.bodyHost=root.createDiv({cls:'xpd-body'});if(statusHost)body.append(statusHost);
    if (archived) {
      const receiptHost=body.createDiv({cls:'xpd-col'});
      if (receipt?.verified === true && !deliveryReceiptUncertain(receipt)) renderDeliveryResult(receiptHost,receipt);
      else receiptHost.createDiv({cls:'xpd-result',text:'已归档 · 未找到已核验的发布回执'});
    } else if(mode==='post') {
      const deliveryHost=body.createDiv({cls:'xpd-col'});deliveryHost.hidden=true;
      if(receipt?.verified===true&&!deliveryReceiptUncertain(receipt))renderDeliveryResult(deliveryHost,receipt);
      this.delivery=mountDeliveryControls({app:this.app,bar,host:deliveryHost,file,kind:mode,flush:()=>this.flush(),snapshotFingerprint:()=>this.markdown,backend:this.backend,onBusyChange:busy=>{this.deliveryBusy=busy;this.syncActionBusy();},onComplete:result=>this.deliveryCompleted(file,result)});
    }
    this.syncActionBusy();
    if (this.tab==='details') renderDetails(body,this.markdown,()=>this.openSource(),config.revision_log_note?()=>{void this.app.workspace.openLinkText(config.revision_log_note,'',false);}:undefined);
    else if(this.tab==='versions') renderVersions(body,this.markdown,async label=>{
      try {
        await this.flush(); const baseline=await this.app.vault.read(file);
        if(this.backend.busy)throw Error('请等待当前上传结束再切换');
        for(const leaf of this.app.workspace.getLeavesOfType('markdown')) {const v=leaf.view;if(v instanceof MarkdownView&&v.file===file&&v.getMode()==='source'&&v.editor.getValue()!==baseline)throw Error('请等笔记保存后再切换');}
        await this.app.vault.process(file,latest=>{if(latest!==baseline)throw Error('笔记已变化，请重新选择');return swapVersion(latest,label);});
        this.markdown=await this.app.vault.read(file);await this.render();
      }catch(e){new Notice(String(e));}
    });
    else if(this.tab==='checks') this.renderChecks();
    else if(archived) {
      const host=body.createDiv({cls:'xpd-col'});
      const content=splitPostMedia(postBody(this.markdown));
      await renderPost(host,'## 正文\n\n'+content.text,fm,url=>this.embeds.get(url),()=>{});
      if(token!==this.revision)return;
      host.querySelectorAll('.xpd-caption,.xpd-checks,.xpd-meter,.xpd-fold').forEach(el=>el.remove());
      host.querySelector('.xpd-folded')?.removeClass('xpd-folded');
      const account=host.querySelector<HTMLElement>('.xpd-post-head span');
      const handle=typeof receipt?.account==='string'?receipt.account:accountLabel();
      if(account)account.textContent=(handle.startsWith('@')?handle:'@'+handle)+' · '+deliveryStateLabel(receipt);
      if(content.references.length){
        const items=resolvePostMedia(this.app,file,content.references),main=host.querySelector<HTMLElement>('.xpd-post-main')!;
        const media=document.createElement('div');media.className=`xpd-media n${Math.max(1,Math.min(4,items.length))}`;
        main.insertBefore(media,main.querySelector('.xpd-quote,.xpd-actions'));
        for(const item of items){const node=media.createDiv({cls:'xpd-media-item'});
          if(item.resourceUrl&&(item.kind==='image'||item.kind==='gif'))node.createEl('img',{attr:{src:item.resourceUrl,alt:item.name,draggable:'false'}});
          else if(item.resourceUrl&&item.kind==='video')node.createEl('video',{attr:{src:item.resourceUrl,controls:'',preload:'metadata'}});
          else node.createSpan({text:item.name});
        }
      }
      body.createDiv({cls:'xpd-col xpd-hint',text:deliveryStateLabel(receipt)==='已排期待发布'?'归档内容只供查看；定时推文仍由 X 按排期发送。':'归档内容只供查看。'});
    }
    else if(mode==='post') {
      const editbar=body.createDiv({cls:'xpd-col xpd-editbar'});
      const bold=editbar.createEl('button',{cls:'xpd-tool is-bold',text:'B 加粗',attr:{type:'button'}});
      const add=editbar.createEl('button',{cls:'xpd-tool',text:'＋ 配图',attr:{type:'button'}});
      const caption=editbar.createSpan({cls:'xpd-caption'});editbar.createSpan({cls:'xpd-spacer'});
      const saved=editbar.createSpan({cls:'xpd-saved',text:'✓ 已存进笔记 · 刚刚'});
      const host=body.createDiv();
      await renderPost(host,this.markdown,fm,url=>this.embeds.get(url).then(value=>{if(token===this.revision){this.quoteState=value.text?'loaded':'missing';this.updateBadge();}return value;}),()=>{});
      if(token!==this.revision)return;
      host.querySelector('.xpd-caption')?.remove();host.querySelector('.xpd-checks')?.remove();host.querySelector('.xpd-meter')?.remove();
      const card=host.querySelector<HTMLElement>('.xpd-post')!;card.addClass('xpd-col');body.insertBefore(card,host);host.remove();
      const editable=card.querySelector<HTMLElement>('.xpd-post-body')!;
      card.querySelectorAll('.xpd-fold,.xpd-folded').forEach(el=>el.remove());
      const main=card.querySelector<HTMLElement>('.xpd-post-main')!,mediaHost=document.createElement('div');main.insertBefore(mediaHost,main.querySelector('.xpd-quote,.xpd-actions'));
      this.editor=new PostEditor(this.app,file,this.markdown,{onChange:()=>{this.updateMeter();this.updateBadge();this.delivery?.refresh();},onSaved:md=>{this.markdown=md;this.context={...this.context,fingerprint:md};this.status?.setContext(this.context);this.delivery?.refresh();this.scheduleStyle();},onError:message=>new Notice(message)});
      this.component.registerDomEvent(card,'focusout',()=>{window.setTimeout(()=>{if(token===this.revision)void this.externalChange();},0);});
      this.editor.mount({editable,card,boldButton:bold,addButton:add,mediaHost,saved,mediaCaption:caption});
      body.createDiv({cls:'xpd-col xpd-meter-inline'});this.updateMeter();
    } else {
      const editbar=body.createDiv({cls:'xpd-col is-wide xpd-editbar'});
      const bold=editbar.createEl('button',{cls:'xpd-tool is-bold',text:'B 加粗',attr:{type:'button'}});
      const heading=editbar.createEl('button',{cls:'xpd-tool',text:'H 小标题',attr:{type:'button'}});
      const add=editbar.createEl('button',{cls:'xpd-tool',text:'＋ 插图',attr:{type:'button'}});
      const input=editbar.createEl('input',{attr:{type:'file',accept:'image/jpeg,image/png,image/webp,image/gif',multiple:'',hidden:''}});
      add.onmousedown=event=>event.preventDefault();add.onclick=()=>input.click();input.onchange=()=>{void this.insertImages([...input.files||[]]);};
      heading.onmousedown=event=>event.preventDefault();heading.onclick=()=>this.article?.applyHeading();
      editbar.createSpan({cls:'xpd-spacer'});
      const saved=editbar.createSpan({cls:'xpd-caption',text:'文字直接改；代码块和表格在原始笔记里改'});
      const host=body.createDiv({cls:'xpd-col is-wide'});
      this.component.registerDomEvent(host,'focusout',()=>{window.setTimeout(()=>{if(token===this.revision)void this.externalChange();},0);});
      this.article=await renderArticle(host,{onMedia:()=>{this.updateBadge();},app:this.app,component:this.component,file,markdown:this.markdown,frontmatter:fm,getEmbed:url=>this.embeds.get(url),editing:{onSaveState:(state,message)=>{saved.textContent=message||'文字直接改；代码块和表格在原始笔记里改';},onSaved:md=>{this.markdown=md;this.context={...this.context,fingerprint:md};this.status?.setContext(this.context);},onCoverDrop:files=>{void this.setCover(files);}}});
      bold.onclick=()=>this.article?.applyBold();
    }
    root.querySelectorAll('button').forEach(button=>button.addClass('clickable-icon'));
    this.syncActionBusy();this.updateBadge();if(!archived)this.scheduleStyle();
  }
  private scheduleStyle() {
    if(this.styleTimer)window.clearTimeout(this.styleTimer);
    const markdown=this.markdown;
    this.styleTimer=window.setTimeout(()=>{void runWritingStyleCheck(noteMode(this.file?.path||'')==='article'?articleBodyRange(markdown).body:postBody(markdown)).then(result=>{if(this.markdown!==markdown||this.closing)return;this.style=result;this.updateBadge();if(this.tab==='checks')this.renderChecks();});},500);
  }
  private checks() {
    const markdown=this.markdown;
    const mode=noteMode(this.file?.path||'')||'post';
    const refs=splitPostMedia(this.editor?.getBody()||postBody(markdown)).references;
    const postImages=this.file?resolvePostMedia(this.app,this.file,refs).map(item=>({name:item.name,extension:item.name.split('.').pop()||'',size:item.size,resolved:!!item.file})):[];
    const info=mode==='article'&&this.file?(this.article?.media||articleMediaInfo(this.app,this.file,markdown)):null;
    const convert=(item:NonNullable<typeof info>['images'][number])=>({name:item.file?.name||item.source,extension:item.file?.extension||item.source.split('.').pop()||'',size:item.file?.stat.size,resolved:!!item.file,width:item.width,height:item.height});
    const media=info?{images:info.images.map(convert),cover:info.cover?convert(info.cover):null}:{images:postImages};
    return buildPublishingChecks({markdown,mode,body:mode==='article'?articleBodyRange(markdown).body:this.editor?.getBody(),quoteState:this.quoteState,style:this.style,media});
  }
  private updateBadge() {
    const tab=this.tabs.get('checks');if(!tab)return;tab.querySelector('.xpd-badge')?.remove();const n=this.checks().filter(c=>c.warning).length;if(n)tab.createSpan({cls:'xpd-badge',text:String(n)});
  }
  private renderChecks() {if(!this.bodyHost)return;this.bodyHost.querySelector('.xpd-list')?.remove();renderPublishingChecks(this.bodyHost,this.checks());}
  private updateMeter() {
    const meter=this.bodyHost?.querySelector<HTMLElement>('.xpd-meter-inline');if(!meter)return;
    const stats=postStats(splitPostMedia(this.editor?.getBody()||postBody(this.markdown)).text);meter.empty();
    const text=meter.createSpan();text.appendText('字数 ');text.createEl('b',{text:stats.weightedLength.toLocaleString('en-US')});text.appendText(' / 25,000');
    meter.createDiv({cls:'xpd-bar'}).createEl('i').style.width=`${Math.min(100,stats.weightedLength/250)}%`;
    meter.createSpan({cls:'xpd-caption',text:stats.weightedLength>280?`时间线默认露出前 280，超出 ${stats.weightedLength-280}`:'没超过 280，时间线上整条都看得到'});
  }
  private async openSource() {await this.flush();if(this.file)await this.openOriginal(this.file);}
  private async setCover(files: File[]) {await this.insertImages(files,true);}
  private async insertImages(files: File[], cover=false) {
    if(!this.file||!files.length)return;
    try {
      await this.flush();const file=this.file,baseline=await this.app.vault.read(file),range=articleBodyRange(baseline);
      const shadow=this.surface.getRootNode() as ShadowRoot & {getSelection?:()=>Selection|null};
      const selection=(shadow.getSelection?.()||window.getSelection())?.anchorNode?.parentElement?.closest<HTMLElement>('[data-source-end],[data-source-line-end]');
      const endLine=selection?Number(selection.dataset.sourceLineEnd):NaN;
      const endByte=selection?Number(selection.dataset.sourceEnd):NaN;
      const copied=await copyAttachments(this.app,cover?files.slice(0,1):files);if(!copied.length)return;
      const embeds=copied.map(image=>`![[${image.name}]]`).join('\n');
      let from=range.start,to=range.start,replacement='\n'+embeds+'\n\n';
      if(cover) {
        const existing=articleMediaInfo(this.app,file,baseline).cover;
        if(existing){from=existing.start;to=existing.end;replacement=embeds;}
      }else {
        const lines=baseline.match(/[^\n]*(?:\n|$)/g)||[];
        from=Number.isFinite(endByte)?endByte:Number.isFinite(endLine)?lines.slice(0,endLine+1).join('').length:range.end;
        from=Math.max(range.start,Math.min(range.end,from));to=from;replacement='\n\n'+embeds+'\n\n';
      }
      await this.app.vault.process(file,latest=>{if(latest!==baseline)throw Error('笔记已变化，请重新放图');return latest.slice(0,from)+replacement+latest.slice(to);});
      this.markdown=await this.app.vault.read(file);await this.render();
    }catch(e){new Notice(e instanceof Error?e.message:String(e));}
  }
  async onClose() {this.closing=true;try{await this.flush();}catch(e){new Notice(String(e));}this.revision++;this.delivery?.dispose();this.delivery=undefined;this.editor?.dispose();this.article?.dispose();this.component?.unload();this.status?.dispose();if(this.styleTimer)window.clearTimeout(this.styleTimer);}
}
