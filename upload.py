import asyncio,json,re
from pathlib import Path
from playwright.async_api import async_playwright

import sys
sys.path.insert(0,str(Path(__file__).resolve().parent))
from config import CONFIG
COOKIES=Path(CONFIG['cookies']).expanduser()
ACCOUNT=CONFIG['account'] if not CONFIG['account'] or CONFIG['account'].startswith('@') else '@'+CONFIG['account']
SAME_SITE={'no_restriction':'None','none':'None','lax':'Lax','strict':'Strict','unspecified':'Lax'}

def load_cookies():
 """Accept Playwright storage state, a plain list, or a browser-extension export (e.g. Cookie-Editor)."""
 if not ACCOUNT or not CONFIG['cookies']:raise RuntimeError('请先在 X 发布台设置里填写 X 账号和 cookie 文件')
 raw=json.loads(COOKIES.read_text())
 items=raw if isinstance(raw,list) else raw['cookies']
 cookies=[]
 for item in items:
  cookie={k:item[k] for k in ('name','value','domain','path','secure','httpOnly') if k in item}
  cookie.setdefault('path','/')
  expires=item.get('expires',item.get('expirationDate'))
  if isinstance(expires,(int,float)) and expires>0:cookie['expires']=float(expires)
  same=str(item.get('sameSite') or '').lower()
  if same in SAME_SITE:cookie['sameSite']=SAME_SITE[same]
  cookies.append(cookie)
 return cookies

def normalize(s):return s.replace('\r\n','\n').strip()


def parse_bold(markdown):
 # Only paired inline **...** is interpreted; no invented emphasis on upload.
 pieces=[];ranges=[];pos=0;length=0
 for m in re.finditer(r'\*\*(.+?)\*\*',markdown):
  before=markdown[pos:m.start()];pieces.append(before);length+=len(before)
  value=m.group(1)
  if '*' in value:raise ValueError('加粗标记包含嵌套星号，请使用 **重点**')
  pieces.append(value);ranges.append((length,length+len(value)));length+=len(value);pos=m.end()
 pieces.append(markdown[pos:])
 text=''.join(pieces)
 if '**' in text:raise ValueError('加粗标记未配对或跨段，请逐段使用 **重点**')
 return text,ranges

async def bold_mask(box):
 return await box.evaluate("""e=>{
 const blocks=[...e.querySelectorAll('[data-block="true"]')];const mask=[];
 for(let i=0;i<blocks.length;i++){
  if(i)mask.push(false);
  const w=document.createTreeWalker(blocks[i],NodeFilter.SHOW_TEXT);let n;
  while(n=w.nextNode()){
   const weight=getComputedStyle(n.parentElement).fontWeight;
   const b=weight==='bold'||Number(weight)>=600;
   for(const c of n.data)mask.push(b);
  }
 }return mask;
 }""")

async def verify_format(box,body,ranges):
 if normalize(await read_body(box))!=normalize(body):raise RuntimeError('草稿正文不一致')
 actual=await bold_mask(box)
 wanted=[False]*len(body)
 for start,end in ranges:wanted[start:end]=[True]*(end-start)
 if len(actual)!=len(wanted) or any(a!=w for c,a,w in zip(body,actual,wanted) if not c.isspace()):
  raise RuntimeError('草稿加粗格式不一致，不能确认成功；请检查 X 草稿，不要重复上传')

async def apply_bold(page,box,body,ranges):
 for start,end in ranges:
  # DOM Range offsets count UTF-16 units, Python string indices count codepoints.
  offsets=[len(body[:n].encode('utf-16-le'))//2 for n in (start,end)]
  await box.evaluate("""(e,[start,end])=>{
   e.focus();const nodes=[];let pos=0;
   const blocks=[...e.querySelectorAll('[data-block="true"]')];
   blocks.forEach((b,i)=>{
    if(i)pos++;
    const w=document.createTreeWalker(b,NodeFilter.SHOW_TEXT);let n;
    while(n=w.nextNode()){nodes.push({n,start:pos,end:pos+n.length});pos+=n.length;}
   });
   const a=nodes.find(x=>x.start<=start&&x.end>start);
   const b=nodes.find(x=>x.start<end&&x.end>=end);
   if(!a||!b)throw Error('无法定位加粗范围');
   const r=document.createRange();r.setStart(a.n,start-a.start);r.setEnd(b.n,end-b.start);
   const sel=window.getSelection();sel.removeAllRanges();sel.addRange(r);
   document.dispatchEvent(new Event('selectionchange'));
  }""",offsets)
  await box.press('Meta+b')
 await verify_format(box,body,ranges)

async def read_body(box):
 # Draft.js renders an empty paragraph as a block plus BR; innerText doubles its blank line.
 return await box.evaluate("e => {const blocks=e.querySelectorAll('[data-block=\"true\"]');return blocks.length ? Array.from(blocks,b=>b.textContent).join('\\n') : e.innerText}")

async def context(browser):
 c=await browser.new_context(viewport={'width':1280,'height':900},locale='en-US')
 await c.add_cookies(load_cookies())
 c.set_default_timeout(20000)
 # Defense in depth: this tool must never send a public post.
 async def guard(route):
  url=route.request.url.lower()
  if route.request.method=='POST' and any(x in url for x in ('/createtweet','/createnotetweet','/statuses/update')):
   await route.abort();raise RuntimeError('Blocked public posting request')
  else:await route.continue_()
 await c.route('**/*',guard)
 return c

async def check_account(page):
 if ACCOUNT not in (await page.get_by_test_id('SideNav_AccountSwitcher_Button').inner_text()).splitlines():
  raise RuntimeError('X 登录账号不匹配；请检查登录状态')

def editor(page):
 # 编辑框一律在弹窗里找：从帖子页点「引用」时，页面底下还有一个回复框，直接 .first 会点错
 return page.locator('[role="dialog"]').last.get_by_test_id('tweetTextarea_0').first

async def compose(page):
 await page.goto('https://x.com/compose/post',wait_until='domcontentloaded',timeout=45000)
 await editor(page).wait_for()
 await check_account(page)

async def compose_quote(page,quote):
 """2026-09-30：引用走 X 自己的「转帖 → 引用」。实测草稿会保留引用卡片；
 把链接接在正文末尾的做法只显示成普通链接，已弃用。"""
 sid=quote.rstrip('/').split('/')[-1]
 await page.goto(quote,wait_until='domcontentloaded',timeout=45000)
 art=page.locator(f'article:has(a[href$="/status/{sid}"])').first
 await art.wait_for()
 await check_account(page)
 await art.get_by_test_id('retweet').first.click()
 item=page.locator('[role="menuitem"]').filter(has_text=re.compile(r'^\s*(Quote|引用)\s*$'))
 await item.first.wait_for()
 await item.first.click()
 await editor(page).wait_for()
 await verify_quote(page,quote)

async def verify_quote(page,quote):
 handle=quote.split('/')[3]
 txt=await page.locator('[role="dialog"]').last.inner_text()
 if '@'+handle.lower() not in txt.lower():raise RuntimeError('编辑框里没看到被引用的帖子，已停止')

async def close_save(page):
 await page.locator('[role="dialog"]').last.get_by_test_id('app-bar-close').click()
 confirm=page.get_by_test_id('confirmationSheetConfirm')
 try:
  await confirm.wait_for(timeout=4000)
 except Exception:
  if await page.get_by_test_id('tweetTextarea_0').count()>1:
   raise RuntimeError('保存状态不明，请在 X 草稿箱检查')
  return
 if (await confirm.inner_text()).strip()!='Save':raise RuntimeError('不是保存草稿确认，已停止')
 await confirm.click()
 await confirm.wait_for(state='hidden')

def row_matches(text,prefix,quote):
 # 引用草稿在列表里第一行是被引用帖子的链接，正文从第二行开始
 lines=normalize(text).split('\n')
 if quote:
  return lines[0].strip()==quote and normalize('\n'.join(lines[1:])).startswith(prefix)
 return normalize(text).startswith(prefix)

async def media_count(page):
 dialog=page.locator('[role="dialog"]').last
 attachments=dialog.locator('[data-testid="attachments"]')
 if not await attachments.count():return 0
 # The same attachment region contains quoted-post avatars/photos. Only
 # composer-owned media has removeMedia controls; counting img/video includes
 # the quoted post and cannot establish this draft's attachment count.
 # X now exposes the same control by its accessible label. A CSS union counts
 # a control carrying both attributes once and keeps quoted media excluded.
 return await attachments.locator('[data-testid="removeMedia"], button[aria-label="Remove media"]').count()

async def verify_media(page,expected):
 actual=await media_count(page)
 if actual!=expected:raise RuntimeError(f'草稿配图数量不一致：应有 {expected}，实际 {actual}；请检查 X 草稿，不要重复上传')

async def media_ready(page,expected):
 if await media_count(page)!=expected:return False
 dialog=page.locator('[role="dialog"]').last
 submit=dialog.get_by_test_id('tweetButton')
 if await submit.count()!=1 or not await submit.is_enabled():return False
 # Character counters are permanent progressbars. The native top progress
 # strip also remains mounted at 0 while idle; active/unknown indicators still
 # block, including upload progress outside the attachments region.
 return await dialog.locator('[role="progressbar"]').evaluate_all('''bars=>bars.every(e=>{
  if(!e.checkVisibility({checkOpacity:true,checkVisibilityCSS:true}))return true;
  if(e.closest('[data-testid="countdown-circle"], [data-testid="dual-phase-countdown-circle"]'))return true;
  const strip=e.querySelector(':scope > [data-testid="progressBar-bar"]');
  if(!e.closest('[data-testid="attachments"]') && e.parentElement?.matches('[data-viewportview="true"]') && strip?.style.width==='0%' && e.getAttribute('aria-valuemax')==='100' && e.getAttribute('aria-valuenow')==='0')return true;
  return false;
 })''')

async def attach_media(page,files):
 if not files:return
 dialog=page.locator('[role="dialog"]').last
 await dialog.locator('input[data-testid="fileInput"]').set_input_files([str(f) for f in files])
 # A thumbnail alone is not enough: wait for the composer to finish processing.
 for _ in range(90):
  if await media_ready(page,len(files)):break
  await page.wait_for_timeout(500)
 else:raise RuntimeError('配图未完成加载，未保存草稿')
 await page.wait_for_timeout(1000)
 await verify_media(page,len(files))
 if not await media_ready(page,len(files)):raise RuntimeError('配图仍在处理，未提交或保存草稿')

async def find_draft(page,body,ranges=(),quote=None,media_files=()):
 await compose(page)
 await page.get_by_test_id('unsentButton').click()
 await page.get_by_test_id('unsentTweet').first.wait_for()
 await page.wait_for_timeout(500)
 prefix=body.split('\n')[0][:70]
 previous=None
 for _ in range(60):
  rows=page.get_by_test_id('unsentTweet')
  texts=await rows.all_inner_texts()
  for i,t in enumerate(texts):
   if row_matches(t,prefix,quote):
    await rows.nth(i).click()
    box=editor(page)
    await box.wait_for()
    await page.wait_for_timeout(1000)
    actual=normalize(await read_body(box))
    if actual!=normalize(body):
     await close_save(page)
     raise RuntimeError('草稿箱存在相同开头的不同版本，请先在 X 处理，避免重复或误覆盖')
    if quote:await verify_quote(page,quote)
    await verify_format(box,body,ranges)
    try:await verify_media(page,len(media_files))
    except Exception:
     await close_save(page);raise
    await close_save(page)
    return True
  fingerprint=tuple(texts)
  if fingerprint==previous:return False
  previous=fingerprint
  if not texts:return False
  await rows.last.scroll_into_view_if_needed()
  await page.wait_for_timeout(600)
 raise RuntimeError('草稿过多，未能完成查重，已停止')

async def upload(body,evidence_dir,quote=None,media_files=()):
 body,ranges=parse_bold(body)
 async with async_playwright() as p:
  browser=await p.chromium.launch(headless=True)
  try:
   c=await context(browser);page=await c.new_page()
   exists=await find_draft(page,body,ranges,quote,media_files)
   if not exists:
    if quote:await compose_quote(page,quote)
    else:await compose(page)
    box=editor(page)
    await box.fill(body)
    if normalize(await read_body(box))!=normalize(body):raise RuntimeError('编辑框内容不一致，未保存')
    await apply_bold(page,box,body,ranges)
    await attach_media(page,media_files)
    await close_save(page)
   await c.close()
   # Fresh context contains cookies only, no old page, localStorage or sessionStorage.
   verify=await context(browser);vp=await verify.new_page()
   if not await find_draft(vp,body,ranges,quote,media_files):raise RuntimeError('保存后没有从新会话读回草稿，不能确认成功')
   await compose(vp);await vp.get_by_test_id('unsentButton').click()
   await vp.get_by_test_id('unsentTweet').first.wait_for()
   if not any(row_matches(t,body.split('\n')[0][:70],quote) for t in await vp.get_by_test_id('unsentTweet').all_inner_texts()):
    raise RuntimeError('回读后草稿列表未保留目标，状态待检查')
   await vp.locator('[role="dialog"]').last.screenshot(path=str(Path(evidence_dir)/'drafts.png'))
   await verify.close()
   return {'verified':True,'already_exists':exists,'account':ACCOUNT,'publicly_posted':False,'bold_verified':True,'bold_segments':len(ranges),'quote':quote,'quote_verified':bool(quote),'media_verified':True,'media_count':len(media_files)}
  finally:await browser.close()
