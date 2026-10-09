"""Obsidian button adapter: prepare, preflight, save and verify X Article drafts."""
import argparse,asyncio,datetime,fcntl,hashlib,importlib.util,json,re,subprocess,sys,tempfile
from pathlib import Path
ROOT=Path(__file__).resolve().parent
sys.path.insert(0,str(ROOT))
from config import CONFIG,state_dir
VAULT=Path(CONFIG['vault']).expanduser()
# Optional third-party tool, installed by the user (its license forbids redistribution).
SCRIPT=Path(CONFIG['article_uploader']).expanduser() if CONFIG['article_uploader'] else None
STATE=state_dir()
def emit(**v):print(json.dumps(v,ensure_ascii=False),flush=True)
def prepare(req):
 p=Path(req['note_path']).resolve();md=req['markdown']
 if not any(p.is_relative_to(VAULT/CONFIG[name]) for name in ('articles','drafts')) or p.suffix!='.md':raise ValueError('请选择长文文件夹（%s）里的笔记'%CONFIG['articles'])
 if p.read_text()!=md:raise ValueError('笔记未保存或已经变化，请重新点击')
 fm=re.match(r'\A---\s*\n(.*?)\n---\s*\n',md,re.S)
 fields=dict(re.findall(r'^([\w_]+):\s*(.*?)\s*$',fm.group(1),re.M)) if fm else {}
 if fields.get('status','').strip('"\'') in ('published','已发布'):raise ValueError('这篇文章已标记发布，请先确认需要的新版本')
 if fields.get('delivery_ready')=='false':raise ValueError('这篇文章尚未验收完成')
 if fields.get('expires_at'):
  expiry=datetime.datetime.fromisoformat(fields['expires_at'].strip('"\''))
  if expiry.tzinfo is None or expiry<=datetime.datetime.now(datetime.timezone.utc):raise ValueError('文章核验已过期，请先重新核实')
 source=md[fm.end():] if fm else md
 heads=list(re.finditer(r'^## 正文\s*$',source,re.M))
 if len(heads)>1:raise ValueError('只能有一个正文区块')
 if heads:
  source=source[heads[0].end():].lstrip('\n')
  source=re.split(r'^## (?:备选版本|素材话题|来源素材|核实记录|我的切入点|验收记录)\s*$',source,maxsplit=1,flags=re.M)[0]
 elif re.search(r'^## (?:备选版本|核实记录|验收记录)\s*$',source,re.M):raise ValueError('含内部记录的笔记需要明确的“## 正文”区块')
 source=re.sub(r'^```x-(?:draft|article-draft|publish)\n.*?^```\s*$', '',source,flags=re.M|re.S).strip()
 if not source:raise ValueError('长文正文为空')
 def wiki_image(match):
  ref=match.group(1).split('|')[0].strip()
  if not ref or Path(ref).is_absolute() or '..' in Path(ref).parts:raise ValueError('长文配图路径无效')
  candidates=[VAULT/ref,p.parent/ref,VAULT/CONFIG['attachments']/ref]
  existing=[f for f in candidates if f.is_file()]
  if '/' not in ref:existing.extend(f for f in VAULT.rglob('*') if f.name==ref and not any(part.startswith('.') for part in f.relative_to(VAULT).parts))
  found={str(f.resolve()):f for f in existing if f.is_file() and f.resolve().is_relative_to(VAULT.resolve())}
  if len(found)!=1:raise ValueError('长文配图不存在或同名不唯一：'+ref)
  image=next(iter(found.values()))
  if image.suffix.lower() not in ('.jpg','.jpeg','.png','.webp','.gif'):raise ValueError('长文图片格式不支持')
  return '![](<'+str(image.resolve())+'>)'
 source=re.sub(r'!\[\[([^]\n]+)\]\]',wiki_image,source)
 if re.search(r'\[\[',source):raise ValueError('长文含 Obsidian 双链，请先改为标准 Markdown 链接或图片路径')
 title=fields.get('title','').strip('"\'')
 h=re.match(r'^# (.+)\n',source)
 if not title:title=h.group(1) if h else p.stem
 if h and h.group(1)==title:source=source[h.end():].lstrip('\n')
 return p,title,source

def run(request,dry_only=False):
 if SCRIPT is None or not SCRIPT.is_file():raise ValueError('没有配置长文上传工具，见 README「长文上传（可选）」')
 req=json.loads(Path(request).read_text());p,title,source=prepare(req)
 STATE.mkdir(exist_ok=True);key=hashlib.sha256((str(p)+'\0'+title+'\0'+source).encode()).hexdigest()
 with open(STATE/'upload.lock','w') as lock:
  try:fcntl.flock(lock,fcntl.LOCK_EX|fcntl.LOCK_NB)
  except BlockingIOError:raise ValueError('已有上传正在执行')
  folder=STATE/('article-'+key);folder.mkdir(exist_ok=True)
  if not dry_only and (folder/'attempt.json').exists():
   url=(folder/'draft-url.txt').read_text().strip() if (folder/'draft-url.txt').exists() else ''
   raise ValueError('本版本已有上传尝试，为避免重复未再次创建。请检查 '+(url or str(folder)))
  # Same parent preserves relative image paths; remove only our own temporary snapshot.
  with tempfile.NamedTemporaryFile(mode='w',encoding='utf-8',prefix='.x-article-upload-',suffix='.md',dir=p.parent,delete=False) as f:
   f.write(source);snapshot=Path(f.name)
  try:
   args=[sys.executable,str(SCRIPT),str(snapshot),'--title',title,'--result-json',str(folder/'result.json'),'--url-output',str(folder/'draft-url.txt'),'--screenshot',str(folder/'final.png')]
   emit(stage='检查长文、图片和表格…')
   pre=subprocess.run(args+['--dry-run'],capture_output=True,text=True,timeout=120)
   (folder/'preflight.log').write_text(pre.stdout+'\n'+pre.stderr)
   if pre.returncode:raise ValueError('长文预检查未通过，未打开 X。详情：'+str(folder/'preflight.log'))
   info=json.JSONDecoder().raw_decode(pre.stdout.lstrip())[0]
   if info.get('preflight',{}).get('errors'):raise ValueError('长文预检查存在错误，未上传：'+str(folder/'preflight.log'))
   if dry_only:emit(verified=False,preflight_passed=True,title=title);return
   if p.read_text()!=req['markdown']:raise ValueError('检查期间文章已修改，请重新点击')
   # Verify the signed-in account before the article script creates any draft.
   spec=importlib.util.spec_from_file_location('post_upload',ROOT/'upload.py');u=importlib.util.module_from_spec(spec);spec.loader.exec_module(u)
   async def identity():
    async with u.async_playwright() as pw:
     b=await pw.chromium.launch(headless=True)
     try:
      c=await u.context(b);page=await c.new_page();await u.compose(page)
     finally:await b.close()
   asyncio.run(identity())
   (folder/'attempt.json').write_text(json.dumps({'note_path':str(p),'hash':key,'at':datetime.datetime.now(datetime.timezone.utc).isoformat()}))
   emit(stage='正在保存 X 长文草稿并回读核对…')
   with open(folder/'upload.log','w') as log:r=subprocess.run(args,stdout=log,stderr=log,timeout=1800)
   result=json.loads((folder/'result.json').read_text()) if (folder/'result.json').exists() else {}
   if r.returncode or result.get('verification_contract')!='x-article-persistence-v1' or result.get('persistence_verified') is not True:raise RuntimeError('长文未通过保存后核验；请检查运行记录，勿重复上传：'+str(folder))
   emit(verified=True,draft_url=result.get('draft_url'),cover_missing=result.get('cover_missing'),publicly_posted=False,kind='article')
  finally:snapshot.unlink(missing_ok=True)
if __name__=='__main__':
 parser=argparse.ArgumentParser();parser.add_argument('--request',required=True);parser.add_argument('--dry-run',action='store_true');args=parser.parse_args()
 try:run(args.request,args.dry_run)
 except Exception as e:emit(verified=False,error=str(e));sys.exit(1)
