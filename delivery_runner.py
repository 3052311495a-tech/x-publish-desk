"""Explicit post delivery entry point; old draft-only runners stay unchanged."""
import argparse,asyncio,datetime,fcntl,hashlib,importlib.util,json,os,re,shutil,subprocess,sys,uuid
from pathlib import Path
sys.path.insert(0,str(Path(__file__).resolve().parent))
from checks import body_problems

ROOT=Path(__file__).resolve().parent
BACKEND=ROOT
from config import CONFIG,state_dir,excluded
STATE=state_dir()
VAULT=Path(CONFIG['vault']).expanduser()
UTC=datetime.timezone.utc

def emit(**value):print(json.dumps(value,ensure_ascii=False),flush=True)
def module(name,path):
    spec=importlib.util.spec_from_file_location(name,path);value=importlib.util.module_from_spec(spec);spec.loader.exec_module(value);return value
def sha(value):return hashlib.sha256(value).hexdigest()
def atomic_json(path,value):
    path.parent.mkdir(parents=True,exist_ok=True,mode=0o700)
    temporary=path.with_name(path.name+'.'+uuid.uuid4().hex+'.tmp')
    descriptor=os.open(temporary,os.O_WRONLY|os.O_CREAT|os.O_EXCL,0o600)
    with os.fdopen(descriptor,'w') as stream:
        json.dump(value,stream,ensure_ascii=False,indent=2);stream.flush();os.fsync(stream.fileno())
    os.replace(temporary,path)

def resolve_node():
    # Finder-launched Obsidian does not inherit the interactive shell's PATH.
    candidates=[shutil.which('node'),Path.home()/'.local/node/bin/node','/opt/homebrew/bin/node','/usr/local/bin/node']
    for candidate in candidates:
        if candidate and Path(candidate).is_file() and os.access(candidate,os.X_OK):
            return str(Path(candidate).resolve())
    raise ValueError('找不到 Node.js，暂时不能核对 X 字数')

def weighted_length(body):
    # Use the identical installed twitter-text implementation as the preview.
    node=resolve_node()
    script='let text="";process.stdin.setEncoding("utf8");process.stdin.on("data",s=>text+=s);process.stdin.on("end",()=>console.log(require(process.argv[1]).parseTweet(text).weightedLength));'
    result=subprocess.run([node,'-e',script,str(ROOT/'node_modules/twitter-text')],input=body,text=True,capture_output=True,timeout=15,check=True)
    return int(result.stdout.strip())

def expiry_time(markdown):
    frontmatter=re.match(r'\A---\r?\n(.*?)\r?\n---(?:\r?\n|\Z)',markdown,re.S)
    expiry=re.search(r'^expires_at:\s*(.+)$',frontmatter.group(1),re.M) if frontmatter else None
    try:value=datetime.datetime.fromisoformat(expiry.group(1).strip().strip('"\'')) if expiry else None
    except (ValueError,TypeError):raise ValueError('稿件核验有效期无效，请先重新核实')
    if value is None:
        # Validity windows are optional unless the strict ready-field mode is on.
        if CONFIG['require_ready_fields']:raise ValueError('稿件核验有效期必须带时区，请先重新核实')
        return None
    if value.tzinfo is None:raise ValueError('稿件核验有效期必须带时区，请先重新核实')
    return value.astimezone(UTC)

def prepare(request,now=None):
    now=now or datetime.datetime.now(UTC)
    if request.get('confirmed') is not True:raise ValueError('需要本人点击当前稿件的发布确认')
    action=request.get('action')
    if action not in ('publish','schedule'):raise ValueError('发布方式无效')
    if request.get('kind','post')!='post':raise ValueError('本次直接发布与定时发布仅支持普通推文；Articles 由本人在 X 处理')
    path=Path(request.get('note_path','')).resolve()
    if not path.is_relative_to(VAULT/CONFIG['drafts']) or excluded(path):raise ValueError('请选择草稿文件夹（%s）里的普通推文'%CONFIG['drafts'])
    draft=module('delivery_existing_runner',BACKEND/'runner.py')
    path,markdown_body,quote=draft.extract(request)
    raw_body=re.findall(r'^## 正文\s*\n(.*?)(?=^## |^---\s*$|\Z)',request['markdown'],re.M|re.S)[0].strip()
    _,media=draft.extract_media(raw_body,path)
    upload=module('delivery_existing_upload',ROOT/'upload.py')
    body,ranges=upload.parse_bold(markdown_body)
    length=weighted_length(body)
    if length>25000:raise ValueError('正文超过 25,000 加权字符')
    expiry=expiry_time(request['markdown'])
    if expiry and expiry<=now:raise ValueError('核验已过期，请先重新核实')
    scheduled_for=None
    if action=='schedule':
        try:due=datetime.datetime.fromisoformat(request.get('scheduledFor','').replace('Z','+00:00'))
        except (ValueError,TypeError):raise ValueError('请选择明确的定时时间')
        if due.tzinfo is None:raise ValueError('定时时间必须带时区')
        if due<=now+datetime.timedelta(minutes=2):raise ValueError('定时时间至少要在 2 分钟以后')
        if expiry and due>expiry:raise ValueError('定时时间超过这篇稿件的核验有效期，请先重新核实')
        scheduled_for=due.astimezone(UTC).isoformat()
    media_hashes=[sha(f.read_bytes()) for f in media]
    content={'account':upload.ACCOUNT,'body':body,'bold_ranges':ranges,'quote':quote,'media_hashes':media_hashes}
    key=sha(json.dumps(content,ensure_ascii=False,sort_keys=True,separators=(',',':')).encode())
    return {'content_key':key,'account':upload.ACCOUNT,'note_path':str(path),'markdown':request['markdown'],'note_sha256':sha(request['markdown'].encode()),'markdown_body':markdown_body,'body':body,'bold_ranges':ranges,'quote':quote,'media_paths':[str(p) for p in media],'media_hashes':media_hashes,'weighted_length':length,'action':action,'scheduled_for':scheduled_for,'time_zone':request.get('timeZone',CONFIG['default_time_zone'])}

def check_unchanged(snapshot,now=None):
    now=now or datetime.datetime.now(UTC)
    if Path(snapshot['note_path']).read_text()!=snapshot['markdown']:raise ValueError('确认后笔记已变化，已停止；请重新打开发布确认')
    expiry=expiry_time(snapshot['markdown'])
    if expiry and expiry<=now:raise ValueError('核验已过期，请先重新核实')
    if len(snapshot['media_paths'])!=len(snapshot['media_hashes']):raise ValueError('配图快照不完整，已停止')
    if any(sha(Path(path).read_bytes())!=digest for path,digest in zip(snapshot['media_paths'],snapshot['media_hashes'])):raise ValueError('确认后图片已变化，已停止')
    if snapshot.get('scheduled_for'):
        due=datetime.datetime.fromisoformat(snapshot['scheduled_for'])
        if due.tzinfo is None:raise ValueError('定时时间必须带时区')
        if due<=now+datetime.timedelta(minutes=1):raise ValueError('准备耗时后定时时间已过近，请重新选择')
        if expiry and due>expiry:raise ValueError('定时时间超过这篇稿件的核验有效期，请先重新核实')

def review(snapshot,folder):
    """Program check before sending (replaced the Codex review on 2026-10-08)."""
    emit(stage='检查当前正文和配图')
    body=snapshot['body']
    problems=body_problems(body)
    atomic_json(folder/'check.json',{'checker':'program-v1','problems':problems,'body_sha256':sha(body.encode())})
    if problems:raise ValueError('检查未通过：'+'；'.join(problems))
    check_unchanged(snapshot)

def run(request,prepare_only=False):
    snapshot=prepare(json.loads(Path(request).read_text()))
    if not CONFIG['account'] or not CONFIG['cookies']:raise ValueError('请先在 X 发布台设置里填写 X 账号和 cookie 文件')
    STATE.mkdir(parents=True,exist_ok=True)
    ledger_dir=STATE/'发布回执';ledger_path=ledger_dir/(snapshot['content_key']+'.json')
    with open(STATE/'upload.lock','a') as lock:
        try:fcntl.flock(lock,fcntl.LOCK_EX|fcntl.LOCK_NB)
        except BlockingIOError:raise ValueError('已有草稿或发布操作正在执行，请等待完成')
        if ledger_path.exists() and not prepare_only:
            previous=json.loads(ledger_path.read_text())
            if previous.get('state') in ('posted','published','scheduled'):
                if previous.get('verified') is not True:raise ValueError('上次发布记录尚未核验，已停止重发；请先到 X 查看结果')
                if previous.get('action')!=snapshot['action']:raise ValueError('这条正文已有发布或定时记录，请先到 X 核对，避免重复发送')
                if snapshot['action']=='schedule' and previous.get('scheduled_for')!=snapshot['scheduled_for']:raise ValueError('这条正文已按另一个时间定时，请先在 X 修改或取消原定时，避免重复发送')
                emit(**{**previous,'already_exists':True});return
            if previous.get('mutation_started') or previous.get('state')=='uncertain':raise ValueError('上次提交的结果待核对，已停止重发；请先在 X 查看结果')
        folder=STATE/('delivery-'+datetime.datetime.now().strftime('%Y%m%d-%H%M%S')+'-'+uuid.uuid4().hex[:6]);folder.mkdir(mode=0o700)
        review(snapshot,folder)
        attempt_recorded=False
        def before_commit():
            nonlocal attempt_recorded
            if prepare_only:raise RuntimeError('准备测试不允许提交')
            check_unchanged(snapshot)
            atomic_json(ledger_path,{'state':'uncertain','action':snapshot['action'],'mutation_started':True,'verified':False,'content_key':snapshot['content_key'],'note_path':snapshot['note_path'],'account':snapshot['account'],'scheduled_for':snapshot['scheduled_for'],'evidence_dir':str(folder),'attempted_at':datetime.datetime.now(UTC).isoformat()})
            attempt_recorded=True
        from delivery.post_delivery import deliver
        try:
            emit(stage='打开 X 并核对编辑框')
            result=asyncio.run(deliver(snapshot,folder,snapshot['action'],snapshot['scheduled_for'],before_commit=before_commit,prepare_only=prepare_only))
            result.update(account=snapshot['account'],action=snapshot['action'],mode='x-native',content_key=snapshot['content_key'],note_path=snapshot['note_path'],body_sha256=sha(snapshot['body'].encode()),scheduled_for=snapshot['scheduled_for'],evidence_dir=str(folder))
            if not prepare_only:
                expected_states=('published','posted') if snapshot['action']=='publish' else ('scheduled',)
                if result.get('verified') is True and (not attempt_recorded or result.get('state') not in expected_states or result.get('commit_sent') is False):
                    result.update(verified=False,error='发布回执与提交状态不一致，尚未完成核验')
                if result.get('verified') is True:
                    result.update(mutation_started=True,commit_sent=True,retry_allowed=False)
                elif result.get('commit_sent') is False:
                    # The callback records an intent before the network gate. A
                    # blocked request is still known not to have been submitted.
                    result.update(state='unsupported' if result.get('state')=='unsupported' else 'failed',mutation_started=False,uncertain=False,retry_allowed=True)
                elif attempt_recorded or result.get('commit_sent') is True:
                    result.update(state='uncertain',mutation_started=True,uncertain=True,retry_allowed=False)
                else:
                    result.update(state='unsupported' if result.get('state')=='unsupported' else 'failed',mutation_started=False,uncertain=False,retry_allowed=True)
                atomic_json(ledger_path,result)
            atomic_json(folder/'receipt.json',result)
            emit(**result)
            if not prepare_only and result.get('verified') is not True:raise SystemExit(1)
        except Exception as error:
            result={'verified':False,'action':snapshot['action'],'state':'uncertain' if attempt_recorded else 'failed','mutation_started':attempt_recorded,'uncertain':attempt_recorded,'retry_allowed':not attempt_recorded,'content_key':snapshot['content_key'],'note_path':snapshot['note_path'],'account':snapshot['account'],'scheduled_for':snapshot['scheduled_for'],'error':str(error),'evidence_dir':str(folder)}
            if not prepare_only:atomic_json(ledger_path,result)
            atomic_json(folder/'receipt.json',result);emit(**result);raise SystemExit(1)

ARCHIVE_RECEIPTS=STATE/'归档回执'
FOLLOW_UP_DELAY=datetime.timedelta(minutes=3)
FOLLOW_UP_RETRY=datetime.timedelta(minutes=20)
FOLLOW_UP_GIVE_UP=datetime.timedelta(hours=6)

def note_content(path,markdown):
    """Body, bold, quote and media of an archived note, without the creation-area checks."""
    draft=module('delivery_existing_runner',BACKEND/'runner.py')
    upload=module('delivery_existing_upload',ROOT/'upload.py')
    raw_body=re.findall(r'^## 正文\s*\n(.*?)(?=^## |^---\s*$|\Z)',markdown,re.M|re.S)[0].strip()
    text,media=draft.extract_media(raw_body,path)
    body,ranges=upload.parse_bold(text)
    frontmatter=re.match(r'\A---\r?\n(.*?)\r?\n---',markdown,re.S)
    quote=re.search(r'^quote:\s*(.+)$',frontmatter.group(1),re.M) if frontmatter else None
    return {'account':upload.ACCOUNT,'body':body,'bold_ranges':ranges,'quote':quote.group(1).strip().strip('"\'') if quote else None,'media_paths':[str(p) for p in media]}

def due_follow_ups(now):
    """Archived native schedules whose time has passed and that were not checked recently."""
    for path in sorted(ARCHIVE_RECEIPTS.glob('*.json')):
        try:receipt=json.loads(path.read_text())
        except (OSError,ValueError):continue
        if receipt.get('state')!='scheduled' or receipt.get('verified') is not True or not receipt.get('scheduled_for'):continue
        due=datetime.datetime.fromisoformat(receipt['scheduled_for'])
        checked=receipt.get('follow_up_checked_at')
        if now<due+FOLLOW_UP_DELAY:continue
        if checked and now<datetime.datetime.fromisoformat(checked)+FOLLOW_UP_RETRY:continue
        yield path,receipt,due

def follow_up(now=None):
    """Read-only check of scheduled posts after their time; never submits anything."""
    now=now or datetime.datetime.now(UTC)
    pending=list(due_follow_ups(now))
    if not pending:emit(follow_up=[]);return
    with open(STATE/'upload.lock','a') as lock:
        try:fcntl.flock(lock,fcntl.LOCK_EX|fcntl.LOCK_NB)
        except BlockingIOError:emit(follow_up=[],skipped='busy');return
        from delivery.post_delivery import follow_up_scheduled
        report=[]
        for path,receipt,due in pending:
            emit(stage='核对到点的定时推文：'+Path(receipt['archived_path']).stem)
            note=VAULT/receipt['archived_path'];update={'follow_up_checked_at':now.isoformat()}
            try:
                markdown=note.read_text()
                if sha(markdown.encode())!=receipt.get('archive_note_sha256'):raise ValueError('归档笔记已被改动，无法按原稿核对')
                snapshot=note_content(note,markdown)
                if sha(snapshot['body'].encode())!=receipt.get('body_sha256'):raise ValueError('归档正文与定时回执不一致')
                folder=STATE/('followup-'+datetime.datetime.now().strftime('%Y%m%d-%H%M%S')+'-'+uuid.uuid4().hex[:6])
                found=asyncio.run(follow_up_scheduled(snapshot,receipt['scheduled_for'],folder))
                if found['found']:
                    update.update(state='published',publicly_posted=True,post_id=found['post_id'],post_url=found['post_url'],published_at=found['published_at'],format_differences=found['format_differences'],follow_up_evidence=found['evidence'],follow_up_error=None)
                elif now>due+FOLLOW_UP_GIVE_UP:update.update(follow_up_error='到点 6 小时后仍没在主页找到这条，请到 X 核对是否发出')
                else:update.update(follow_up_error='还没在主页找到，稍后会再查')
            except Exception as error:update.update(follow_up_error=str(error))
            receipt.update(update);atomic_json(path,receipt)
            if update.get('state')=='published':
                ledger=STATE/'发布回执'/(receipt.get('content_key','')+'.json')
                if receipt.get('content_key') and ledger.exists():
                    entry=json.loads(ledger.read_text());entry.update({k:v for k,v in update.items() if k!='follow_up_checked_at'});atomic_json(ledger,entry)
            report.append({'archived_path':receipt['archived_path'],'state':receipt['state'],'post_url':receipt.get('post_url'),'format_differences':receipt.get('format_differences') or [],'error':receipt.get('follow_up_error')})
        emit(follow_up=report)

if __name__=='__main__':
    parser=argparse.ArgumentParser();parser.add_argument('--request');parser.add_argument('--prepare-only',action='store_true');parser.add_argument('--follow-up',action='store_true');args=parser.parse_args()
    if args.follow_up:
        try:follow_up()
        except Exception as error:emit(follow_up=[],error=str(error));sys.exit(1)
        sys.exit(0)
    if not args.request:parser.error('--request is required')
    try:run(args.request,args.prepare_only)
    except Exception as error:emit(verified=False,state='failed',error=str(error));sys.exit(1)
