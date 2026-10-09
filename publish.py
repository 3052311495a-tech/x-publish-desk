"""Command-line entry for chat-driven publishing (used by the Haiku skill).

  preview   show exactly what would be sent; sends nothing, prints a confirm code
  send      needs the confirm code from preview of the same note/action/time
  follow-up check scheduled posts whose time has passed (read-only)

Same runner, ledger, lock and archive receipts as the Obsidian plugin.
"""
import argparse,datetime,hashlib,json,os,re,subprocess,sys,uuid
from pathlib import Path
from zoneinfo import ZoneInfo

ROOT=Path(__file__).resolve().parent
sys.path.insert(0,str(ROOT))
import delivery_runner as r
from checks import body_problems

PYTHON=str(ROOT/'.venv/bin/python')
SOURCE=r.VAULT/r.CONFIG['drafts']
DESTINATION=r.VAULT/r.CONFIG['published']

def out(value):print(json.dumps(value,ensure_ascii=False,indent=1),flush=True)

def resolve_note(value):
    path=Path(value).expanduser()
    if not path.is_absolute():
        # Accept a bare title or file name from chat.
        matches=[p for p in SOURCE.glob('*.md') if p.name==value or p.stem==value or value in p.stem]
        if len(matches)!=1:raise ValueError('在草稿文件夹找到 %d 篇匹配「%s」，请给完整文件名' % (len(matches),value))
        path=matches[0]
    return path.resolve()

def due_time(at,zone):
    if not at:return None
    local=datetime.datetime.strptime(at.strip(),'%Y-%m-%d %H:%M').replace(tzinfo=ZoneInfo(zone))
    # Reject times that do not exist or are ambiguous around a DST change.
    if local.astimezone(datetime.timezone.utc).astimezone(ZoneInfo(zone)).replace(tzinfo=None)!=local.replace(tzinfo=None):raise ValueError('这个时间在该时区不存在（夏令时切换），请换一个')
    return local.astimezone(datetime.timezone.utc).isoformat().replace('+00:00','Z')

def request_for(args):
    note=resolve_note(args.note)
    if args.action=='schedule' and not args.at:raise ValueError('定时发布需要 --at "YYYY-MM-DD HH:MM"')
    return {'confirmed':True,'action':args.action,'kind':'post','note_path':str(note),'markdown':note.read_text(),
            'scheduledFor':due_time(args.at,args.zone),'timeZone':args.zone}

def confirm_code(request):
    key=json.dumps([request['note_path'],request['markdown'],request['action'],request['scheduledFor']],ensure_ascii=False)
    return hashlib.sha256(key.encode()).hexdigest()[:6]

def autolinks(body):
    script='let t="";process.stdin.setEncoding("utf8");process.stdin.on("data",s=>t+=s);process.stdin.on("end",()=>console.log(JSON.stringify(require(process.argv[1]).extractUrls(t))));'
    result=subprocess.run([r.resolve_node(),'-e',script,str(ROOT/'node_modules/twitter-text')],input=body,text=True,capture_output=True,timeout=15,check=True)
    return json.loads(result.stdout)

def preview(args):
    request=request_for(args);snapshot=r.prepare(request)
    links=autolinks(snapshot['body']);warnings=[]
    if links:warnings.append('会变成链接（X 转短链，每处按 23 字算）：'+'、'.join(links))
    if links and snapshot['bold_ranges']:warnings.append('同时有链接和加粗：10-08 那条发出去加粗被 X 丢了，发完看一眼')
    if snapshot['weighted_length']>280:warnings.append('超过 280，后面的部分要点「显示更多」才看得到')
    due=snapshot['scheduled_for']
    out({'将要执行':'定时发布' if args.action=='schedule' else '立即公开发布','账号':snapshot['account'],
         '时间':datetime.datetime.fromisoformat(due).astimezone(ZoneInfo(args.zone)).strftime('%Y-%m-%d %H:%M ')+args.zone if due else '确认后立即发出',
         '正文':snapshot['markdown_body'],'加权字数':snapshot['weighted_length'],'加粗处数':len(snapshot['bold_ranges']),
         '引用':snapshot['quote'] or '无','配图':[Path(p).name for p in snapshot['media_paths']] or '无',
         '检查未通过':body_problems(snapshot['body']),'提醒':warnings,'确认码':confirm_code(request),
         '说明':'这一步什么都没发。本人确认后，用 send 带上同样的参数和确认码才会发出'})

def archive(note,markdown,result,action,zone):
    """Same move and receipt format as the plugin's archiveVerifiedDelivery."""
    DESTINATION.mkdir(parents=True,exist_ok=True)
    if note.read_text()!=markdown:raise ValueError('发布期间笔记又有修改，已保留在创作区')
    target=DESTINATION/note.name;number=2
    while target.exists():target=DESTINATION/f'{note.stem}（{number}）.md';number+=1
    relative=str(target.relative_to(r.VAULT))
    receipt={**result,'action':action,'time_zone':zone,'retry_allowed':False,'original_note_path':str(note.relative_to(r.VAULT)),
             'archived_path':relative,'archive_note_sha256':hashlib.sha256(markdown.encode()).hexdigest(),
             'archived_at':datetime.datetime.now(datetime.timezone.utc).isoformat(),'archive_status':'archived'}
    r.atomic_json(r.ARCHIVE_RECEIPTS/(hashlib.sha256(relative.encode()).hexdigest()+'.json'),receipt)
    os.rename(note,target)
    return relative

def send(args):
    request=request_for(args)
    if args.confirm!=confirm_code(request):raise ValueError('确认码不对：稿子、方式或时间和预览时不一样，请重新 preview 给本人看')
    folder=r.ROOT/'请求';folder.mkdir(exist_ok=True,mode=0o700)
    path=folder/(uuid.uuid4().hex+'.json');path.write_text(json.dumps(request,ensure_ascii=False));os.chmod(path,0o600)
    try:
        process=subprocess.run([PYTHON,str(ROOT/'delivery_runner.py'),'--request',str(path)],cwd=ROOT,capture_output=True,text=True,timeout=900)
    finally:path.unlink(missing_ok=True)
    result=None
    for line in process.stdout.splitlines():
        try:value=json.loads(line)
        except ValueError:continue
        if isinstance(value,dict) and 'verified' in value:result=value
    if result is None:out({'结果':'没有收到完整回执，可能已提交，请先到 X 核对，不要重发'});sys.exit(1)
    summary={'核对通过':result.get('verified') is True,'状态':result.get('state'),'链接':result.get('post_url') or result.get('scheduled_url'),
             '格式差异':result.get('format_differences') or [],'错误':result.get('error')}
    if result.get('verified') is True and result.get('state') in ('published','posted','scheduled'):
        try:summary['已归档到']=archive(Path(request['note_path']),request['markdown'],result,args.action,args.zone)
        except Exception as error:summary['归档未完成']=str(error)
    elif result.get('uncertain') or result.get('state')=='uncertain':summary['提示']='结果待核对，请先到 X 查看，不要重发'
    out(summary)
    if result.get('verified') is not True:sys.exit(1)

def main():
    parser=argparse.ArgumentParser(description=__doc__,formatter_class=argparse.RawDescriptionHelpFormatter)
    sub=parser.add_subparsers(dest='command',required=True)
    for name in ('preview','send'):
        p=sub.add_parser(name);p.add_argument('--note',required=True,help='草稿文件夹里的笔记路径、文件名或标题关键词')
        p.add_argument('--action',choices=('publish','schedule'),required=True)
        p.add_argument('--at',help='定时时间，格式 "YYYY-MM-DD HH:MM"')
        p.add_argument('--zone',default=r.CONFIG['default_time_zone'],help='IANA 时区，例如 Asia/Shanghai')
        if name=='send':p.add_argument('--confirm',required=True,help='preview 给出的确认码')
    sub.add_parser('follow-up')
    args=parser.parse_args()
    try:
        if args.command=='preview':preview(args)
        elif args.command=='send':send(args)
        else:
            process=subprocess.run([PYTHON,str(ROOT/'delivery_runner.py'),'--follow-up'],cwd=ROOT,capture_output=True,text=True,timeout=1800)
            report=[json.loads(l) for l in process.stdout.splitlines() if l.startswith('{') and '"follow_up"' in l]
            out(report[-1] if report else {'follow_up':[],'error':'没有收到核对结果'})
    except Exception as error:out({'错误':str(error)});sys.exit(1)

if __name__=='__main__':main()
