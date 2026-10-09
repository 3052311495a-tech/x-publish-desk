import argparse,asyncio,datetime,fcntl,hashlib,importlib.util,json,os,re,subprocess,sys,uuid
from pathlib import Path
sys.path.insert(0,str(Path(__file__).resolve().parent))
from checks import body_problems
ROOT=Path(__file__).resolve().parent
from config import CONFIG,state_dir,excluded
VAULT=Path(CONFIG['vault']).expanduser()
STATE=state_dir()
def emit(**v):print(json.dumps(v,ensure_ascii=False),flush=True)
def extract_media(body,note_path):
 lines=body.splitlines();refs=[]
 while lines and not lines[-1].strip():lines.pop()
 while lines:
  m=re.fullmatch(r'!\[\[([^]\n]+)\]\]',lines[-1].strip())
  if not m:break
  refs.insert(0,m.group(1).split('|')[0].strip());lines.pop()
  while lines and not lines[-1].strip():lines.pop()
 files=[]
 for ref in refs:
  if not ref or Path(ref).is_absolute() or '..' in Path(ref).parts:raise ValueError('配图路径无效')
  candidates=[VAULT/ref,note_path.parent/ref,VAULT/CONFIG['attachments']/ref]
  existing=[f for f in candidates if f.is_file()]
  # A bare Obsidian filename must be unique throughout visible vault files,
  # even when the attachment folder already contains a candidate.
  if '/' not in ref:existing.extend(f for f in VAULT.rglob('*') if f.name==ref and not any(part.startswith('.') for part in f.relative_to(VAULT).parts))
  unique={str(f.resolve()):f for f in existing if f.is_file() and f.resolve().is_relative_to(VAULT.resolve())}
  if len(unique)!=1:raise ValueError('配图不存在或同名不唯一：'+ref)
  f=next(iter(unique.values()));ext=f.suffix.lower();size=f.stat().st_size
  if ext not in ('.jpg','.jpeg','.png','.webp','.gif','.mp4','.mov'):raise ValueError('配图格式不支持：'+ext)
  if ext in ('.jpg','.jpeg','.png','.webp') and size>5*1024*1024:raise ValueError('图片超过 5MB：'+f.name)
  if ext=='.gif' and size>15*1024*1024:raise ValueError('GIF 超过 15MB：'+f.name)
  files.append(f.resolve())
 if len(files)>4:raise ValueError('普通推文最多 4 张图片')
 if any(f.suffix.lower() in ('.gif','.mp4','.mov') for f in files) and len(files)!=1:raise ValueError('GIF 或视频只能单独上传，不能与图片混用')
 return '\n'.join(lines).strip(),files

def extract(req):
 p=Path(req['note_path']).resolve()
 if not p.is_relative_to(VAULT/CONFIG['drafts']) or excluded(p) or p.suffix!='.md':raise ValueError('请选择草稿文件夹（%s）里的笔记'%CONFIG['drafts'])
 md=req['markdown']
 if p.read_text()!=md:raise ValueError('笔记尚未保存或已变化，请保存后再点一次')
 fm=re.match(r'\A---\n(.*?)\n---\n',md,re.S)
 fields=dict(re.findall(r'^([\w_]+):\s*(.*?)\s*$',fm.group(1),re.M)) if fm else {}
 if CONFIG['require_ready_fields']:
  if fields.get('status')!='writing' or fields.get('delivery_ready')!='true':raise ValueError('仅上传已验收、待发布的成稿')
  if not fields.get('expires_at'):raise ValueError('缺少 expires_at（核验有效期）')
 if fields.get('expires_at'):
  expiry=datetime.datetime.fromisoformat(fields['expires_at'].strip('"\''))
  if expiry.tzinfo is None or expiry<=datetime.datetime.now(datetime.timezone.utc):raise ValueError('核验已过期，请先重新核实')
 matches=re.findall(r'^## 正文\s*\n(.*?)(?=^## |^---\s*$|\Z)',md,re.M|re.S)
 if len(matches)!=1:raise ValueError('需要且只能有一个“## 正文”区块')
 body=matches[0].strip()
 body,_media=extract_media(body,p)
 if not body or len(body)>25000:raise ValueError('正文为空或超过长度上限')
 if re.search(r'!\[|!\[\[|<\s*(?:img|video|audio)|^```|\[\[',body,re.M|re.I):raise ValueError('当前仅支持文字及 **重点** 加粗，请处理图片、附件或双链')
 # 2026-09-30 本人要求：二创稿要引用原帖。frontmatter 写 quote: <原帖链接>，上传时打开原帖点「引用」，在引用框里写草稿（2026-09-30 实测可行）
 quote=fields.get('quote','').strip('"\'') or None
 if quote and not re.fullmatch(r'https://(?:x|twitter)\.com/[A-Za-z0-9_]{1,15}/status/\d+',quote):raise ValueError('quote 必须是一条帖子的完整链接，例如 https://x.com/账号/status/数字')
 return p,body,quote

def run(request):
 req=json.loads(Path(request).read_text());p,body,quote=extract(req)
 raw_body=re.findall(r'^## 正文\s*\n(.*?)(?=^## |^---\s*$|\Z)',req['markdown'],re.M|re.S)[0].strip()
 _,media=extract_media(raw_body,p)
 media_hashes=[hashlib.sha256(f.read_bytes()).hexdigest() for f in media]
 digest=hashlib.sha256(body.encode()).hexdigest()
 STATE.mkdir(exist_ok=True)
 with open(STATE/'upload.lock','w') as lock:
  try:fcntl.flock(lock,fcntl.LOCK_EX|fcntl.LOCK_NB)
  except BlockingIOError:raise ValueError('已有上传正在执行，请等待完成')
  run_dir=STATE/(datetime.datetime.now().strftime('%Y%m%d-%H%M%S')+'-'+uuid.uuid4().hex[:6]);run_dir.mkdir(mode=0o700)
  emit(stage='检查正文')
  spec=importlib.util.spec_from_file_location('x_draft_upload',ROOT/'upload.py');module=importlib.util.module_from_spec(spec);spec.loader.exec_module(module)
  problems=body_problems(module.parse_bold(body)[0])
  (run_dir/'check.json').write_text(json.dumps({'checker':'program-v1','problems':problems,'body_sha256':digest},ensure_ascii=False))
  if problems:raise ValueError('检查未通过：'+'；'.join(problems))
  if p.read_text()!=req['markdown']:raise ValueError('检查期间正文已修改，已停止；请重新点击')
  if any(hashlib.sha256(f.read_bytes()).hexdigest()!=h for f,h in zip(media,media_hashes)):raise ValueError('检查期间配图已修改，已停止；请重新点击')
  emit(stage='正在保存并核对 X 草稿')
  if quote:emit(stage='引用原帖：'+quote)
  result=asyncio.run(module.upload(body,run_dir,quote=quote,media_files=media))
  result.update(note_path=str(p),quote=quote,body_sha256=digest,verified_at=datetime.datetime.now(datetime.timezone.utc).isoformat(),evidence=str(run_dir/'drafts.png'))
  (run_dir/'receipt.json').write_text(json.dumps(result,ensure_ascii=False,indent=2))
  emit(**result)
if __name__=='__main__':
 a=argparse.ArgumentParser();a.add_argument('--request',required=True);args=a.parse_args()
 try:run(args.request)
 except Exception as e:emit(verified=False,error=str(e));sys.exit(1)
