"""Ordinary X posts: verified preparation and one guarded final UI submission.

The caller owns saved-note checks, review, a shared upload lock, and a durable
content ledger. No retry is performed here. Existing draft helpers stay intact.
"""
from __future__ import annotations

import datetime as dt
import calendar
import hashlib
import importlib.util
import inspect
import json
import re
from contextlib import asynccontextmanager
from pathlib import Path
from urllib.parse import urlparse

UPLOAD_SCRIPT = Path(__file__).resolve().parents[1] / 'upload.py'
PUBLISH_OPERATIONS = frozenset({'CreateTweet', 'CreateNoteTweet'})
# Filled only with operation names verified from the native scheduler UI.
SCHEDULE_OPERATION = 'CreateScheduledTweet'
SCHEDULE_CONTROLS = {
    'trigger': '[data-testid="scheduleOption"]',
    'confirm': '[data-testid="scheduledConfirmationPrimaryAction"]',
    # The final button and native readback adapter follow actual UI discovery.
    'submit': '[data-testid="tweetButton"]',
    'verify': None,
}


class UnsupportedDelivery(ValueError):
    pass


def uploader():
    spec = importlib.util.spec_from_file_location('x_delivery_draft_helpers', UPLOAD_SCRIPT)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


@asynccontextmanager
async def browser_session(module):
    # Close Chromium while its Playwright driver is still alive.
    async with module.async_playwright() as pw:
        browser = await pw.chromium.launch(headless=True)
        try:
            yield browser
        finally:
            await browser.close()


def utc_time(value: str) -> dt.datetime:
    parsed = dt.datetime.fromisoformat(str(value).replace('Z', '+00:00'))
    if parsed.tzinfo is None:
        raise ValueError('定时日期必须包含时区')
    return parsed.astimezone(dt.timezone.utc)


def operation(url: str) -> str:
    return urlparse(url).path.rstrip('/').rsplit('/', 1)[-1]


def public_mutation(url: str) -> bool:
    name = operation(url).lower()
    return bool(
        name in {'createtweet', 'createnotetweet', 'createscheduledtweet',
                 'createretweet', 'publisharticle', 'publisharticletweet'}
        or '/statuses/update' in urlparse(url).path.lower()
        or (any(action in name for action in ('create', 'publish', 'update', 'edit', 'delete', 'send'))
            and ('tweet' in name or 'article' in name))
    )


def _find_key(value, key):
    if isinstance(value, dict):
        if key in value:
            yield value[key]
        for child in value.values():
            yield from _find_key(child, key)
    elif isinstance(value, list):
        for child in value:
            yield from _find_key(child, key)


def _utf16_range(body, span):
    return tuple(len(body[:i].encode('utf-16-le')) // 2 for i in span)


def richtext_ranges(value):
    result = []
    for collection in _find_key(value, 'richtext_tags'):
        if not isinstance(collection, list):
            continue
        for item in collection:
            if not isinstance(item, dict):
                continue
            types = item.get('richtext_types', item.get('types', []))
            if not any(str(t).lower() == 'bold' for t in types):
                continue
            start = item.get('from_index', item.get('start_index'))
            end = item.get('to_index', item.get('end_index'))
            if isinstance(start, int) and isinstance(end, int):
                result.append((start, end))
    return sorted(result)


def request_contract(payload: dict, snapshot: dict, mode: str, scheduled_for=None):
    """Check the browser's mutation data, without using private API query IDs."""
    variables = payload.get('variables', payload)
    if variables.get('reply') or list(_find_key(variables, 'in_reply_to_status_id')) or list(_find_key(variables, 'in_reply_to_tweet_id')):
        replies = list(_find_key(variables, 'in_reply_to_status_id')) + list(_find_key(variables, 'in_reply_to_tweet_id'))
        if variables.get('reply') or any(replies):
            raise UnsupportedDelivery('本次只支持独立推文或引用，不支持作为回复发送')
    if mode == 'schedule':
        content = variables.get('post_tweet_request')
        if not isinstance(content, dict):
            raise ValueError('X 定时请求缺少已核验的普通推文数据，已阻止发送')
        if content.get('thread_tweets'):
            raise UnsupportedDelivery('本次只支持单条推文定时，不支持线程')
        texts = [content.get('status')]
        media_ids = content.get('media_ids') or []
        if not isinstance(media_ids, list):
            raise ValueError('X 定时请求配图数据格式不匹配')
        media_count = len(media_ids)
    else:
        content = variables
        texts = list(_find_key(content, 'tweet_text'))
        entities = list(_find_key(content, 'media_entities'))
        media_count = sum(len(items) for items in entities if isinstance(items, list))
    if texts != [snapshot['body']]:
        raise ValueError('提交正文与已核验快照不一致，已阻止发送')
    if media_count != len(snapshot.get('media_paths') or []):
        raise ValueError('提交配图数量与已核验快照不一致，已阻止发送')
    submitted_ids = (media_ids if mode == 'schedule' else
                     [item.get('media_id') for items in entities if isinstance(items, list)
                      for item in items if isinstance(item, dict)])
    if len(submitted_ids) != media_count or any(not str(value or '').isdigit() for value in submitted_ids):
        raise ValueError('提交配图缺少有效媒体 ID，已阻止发送')
    quote = snapshot.get('quote')
    attachment_urls = list(_find_key(content, 'attachment_url'))
    if quote:
        expected = quote.rstrip('/').split('/')[-1]
        if len(attachment_urls) != 1 or not re.fullmatch(
            r'https://(?:x|twitter)\.com/[^/]+/status/' + re.escape(expected),
            str(attachment_urls[0]).rstrip('/'),
        ):
            raise ValueError('提交引用帖子与已核验快照不一致，已阻止发送')
    elif any(attachment_urls):
        raise ValueError('提交包含快照中不存在的引用，已阻止发送')
    spans = sorted(tuple(span) for span in snapshot.get('bold_ranges') or [])
    for tags in _find_key(content, 'richtext_tags'):
        if isinstance(tags, list) and any(any(str(style).lower() != 'bold' for style in tag.get('richtext_types', []))
                                          for tag in tags if isinstance(tag, dict)):
            raise ValueError('提交包含快照中不存在的文字格式，已阻止发送')
    if spans:
        actual = richtext_ranges(content)
        wanted = sorted(_utf16_range(snapshot['body'], span) for span in spans)
        if actual not in (wanted, spans):
            raise UnsupportedDelivery('X 的提交数据未保留本稿加粗，已停止；请在 X 手动处理')
    elif richtext_ranges(content):
        raise ValueError('提交增加了快照中不存在的加粗，已阻止发送')
    if mode == 'schedule':
        expected_epoch = int(utc_time(scheduled_for).timestamp())
        epochs = list(_find_key(variables, 'execute_at'))
        if len(epochs) != 1 or not isinstance(epochs[0], (int, float)):
            raise UnsupportedDelivery('尚未核验 X 定时提交的日期数据，已阻止发送')
        if int(epochs[0]) != expected_epoch:
            raise ValueError('X 提交的定时时间与确认日期不一致，已阻止发送')
    return True


class CommitGate:
    """The highest-priority context route admits one exact, verified mutation."""
    def __init__(self, snapshot, mode, scheduled_for=None):
        self.snapshot, self.mode, self.scheduled_for = snapshot, mode, scheduled_for
        self.armed = False
        self.sent = False
        self.request_hash = None
        self.request_operation = None
        self.blocked_reason = None
        self.blocked_unsupported = False
        self.media_ids = []

    async def arm(self, before_commit):
        if before_commit is None:
            raise ValueError('缺少持久发布记录回调，不能发送')
        result = before_commit()
        if inspect.isawaitable(result):
            result = await result
        if result is False:
            raise ValueError('持久发布记录未写入，不能发送')
        self.blocked_reason = None
        self.blocked_unsupported = False
        self.armed = True

    async def route(self, route):
        request = route.request
        if request.method != 'POST' or not public_mutation(request.url):
            # Keep older guards and caller-installed read-only routes in force.
            await route.fallback()
            return
        expected = PUBLISH_OPERATIONS if self.mode == 'publish' else {SCHEDULE_OPERATION}
        try:
            if not self.armed or self.sent or operation(request.url) not in expected:
                raise ValueError('未授权或重复的公开提交，已阻止发送')
            payload = json.loads(request.post_data or '{}')
            request_contract(payload, self.snapshot, self.mode, self.scheduled_for)
        except Exception as exc:
            self.blocked_reason = str(exc)
            self.blocked_unsupported = isinstance(exc, UnsupportedDelivery)
            await route.abort()
            return
        # Mark before network continuation, including continuation failures.
        self.armed = False
        self.sent = True
        self.request_operation = operation(request.url)
        self.request_hash = hashlib.sha256((request.post_data or '').encode()).hexdigest()
        variables = payload.get('variables', payload)
        if self.mode == 'schedule':
            self.media_ids = [str(value) for value in variables['post_tweet_request'].get('media_ids') or []]
        else:
            self.media_ids = [str(item['media_id']) for items in _find_key(variables, 'media_entities') for item in items]
        await route.continue_()

    def matches_response(self, response):
        request = response.request
        return bool(self.sent and request.method == 'POST'
                    and operation(request.url) == self.request_operation
                    and hashlib.sha256((request.post_data or '').encode()).hexdigest()
                    == self.request_hash)


def tweet_fields(candidate):
    """Fields of one tweet result object; None when it carries no usable ID."""
    if not isinstance(candidate, dict):
        return None
    if candidate.get('__typename') == 'TweetWithVisibilityResults':
        candidate = candidate.get('tweet') or {}
    legacy = candidate.get('legacy') or {}
    rest_id, legacy_id = candidate.get('rest_id'), legacy.get('id_str')
    if rest_id and legacy_id and str(rest_id) != str(legacy_id):
        raise ValueError('发布响应的新帖 ID 不一致，发送结果需要检查')
    # The native success guard uses this root's legacy.id_str.
    post_id = str(rest_id or legacy_id or '')
    if not post_id.isdigit():
        return None
    note = (((candidate.get('note_tweet') or {}).get('note_tweet_results') or {}).get('result') or {})
    text = note.get('text') or legacy.get('full_text') or ''
    if not note and isinstance(legacy.get('display_text_range'), list):
        start, end = legacy['display_text_range']
        # X indexes UTF-16 code units, including astral emoji.
        text = text.encode('utf-16-le')[start * 2:end * 2].decode('utf-16-le')
    user = (((candidate.get('core') or {}).get('user_results') or {}).get('result') or {})
    handle = (user.get('core') or {}).get('screen_name') or (user.get('legacy') or {}).get('screen_name')
    media = (legacy.get('extended_entities') or {}).get('media') or []
    urls = ((note.get('entity_set') or {}).get('urls') if note else (legacy.get('entities') or {}).get('urls')) or []
    return {'post_id': post_id, 'body': text, 'handle': handle,
            'quoted_status_id': str(legacy.get('quoted_status_id_str') or ''),
            'media_count': len(media), 'media_ids': [str(item.get('id_str') or '') for item in media],
            'richtext': note, 'urls': urls, 'created_at': legacy.get('created_at') or ''}


def created_post(payload):
    """Extract only the root created tweet, never an embedded quoted tweet ID."""
    if payload.get('errors'):
        raise ValueError('X 返回发布错误，发送结果需要检查')
    data = payload.get('data') or {}
    # Current CreateNoteTweet clients read notetweet_create; retain the older
    # observed names without recursively picking a quoted tweet's ID.
    for name in ('create_tweet', 'create_note_tweet', 'notetweet_create'):
        post = tweet_fields(((data.get(name) or {}).get('tweet_results') or {}).get('result'))
        if post:
            return post
    raise ValueError('发布响应中未找到本次新帖 ID')


def match_post(post, snapshot):
    """Raise unless this tweet is exactly the snapshot (text, author, quote, media)."""
    url_map = {}
    for item in post['urls']:
        raw, expanded, shown = item.get('url'), item.get('expanded_url'), item.get('display_url')
        # Only restore an exact source URL, never a guessed or canonicalized one.
        if raw and expanded and expanded in snapshot['body']:
            post['body'] = post['body'].replace(raw, expanded)
            url_map[raw] = expanded
        # X also autolinks a bare domain such as "claude.ai" (expanded to
        # http://claude.ai); restore it only when the source has that exact text.
        elif (raw and shown and shown in snapshot['body']
              and (expanded or '').rstrip('/') in ('http://' + shown, 'https://' + shown)):
            post['body'] = post['body'].replace(raw, shown)
            url_map[raw] = shown
    post['source_url_map'] = url_map
    if post['body'] != snapshot['body']:
        raise ValueError('发布响应的正文与快照不一致')
    if post['handle'] and '@' + post['handle'].lower() != snapshot['account'].lower():
        raise ValueError('发布响应的账号与确认账号不一致')
    expected_quote = (snapshot.get('quote') or '').rstrip('/').split('/')[-1]
    if post['quoted_status_id'] != expected_quote:
        raise ValueError('发布响应的引用与快照不一致')
    if post['media_count'] != len(snapshot.get('media_paths') or []):
        raise ValueError('发布响应的配图数量与快照不一致')
    return post


def verify_created_post(payload, snapshot):
    if payload.get('errors'):
        raise ValueError('X 返回发布错误，发送结果需要检查')
    post = match_post(created_post(payload), snapshot)
    if '_committed_media_ids' in snapshot and post['media_ids'] != snapshot['_committed_media_ids']:
        raise ValueError('发布响应的配图 ID 与本次已提交配图不一致')
    return post


async def verify_public_page(page, snapshot, post, evidence_dir):
    url = 'https://x.com/' + snapshot['account'].lstrip('@') + '/status/' + post['post_id']
    await page.goto(url, wait_until='domcontentloaded', timeout=45000)
    await uploader().check_account(page)
    article = page.locator('article').filter(has=page.locator(
        'a[href$="/status/' + post['post_id'] + '"]')).first
    await article.wait_for(timeout=20000)
    box = article.get_by_test_id('tweetText').first
    await box.wait_for()
    evidence = await box.evaluate('''(e,urlMap) => {
      const chars=[],mask=[];
      const append=(text,parent)=>{
        const weight=getComputedStyle(parent).fontWeight;
        for(const c of text){chars.push(c);mask.push(weight==='bold'||Number(weight)>=600);}
      };
      const visit=n=>{
        if(n.nodeType===Node.TEXT_NODE){append(n.data,n.parentElement);return;}
        if(n.nodeType!==Node.ELEMENT_NODE)return;
        if(n.tagName==='BR'){append('\\n',n);return;}
        if(n.tagName==='IMG'&&n.alt){append(n.alt,n);return;}
        if(n.tagName==='A'&&urlMap[n.href]){append(urlMap[n.href],n);return;}
        for(const child of n.childNodes)visit(child);
      };
      visit(e);return {text:chars.join(''),mask};
    }''', post.get('source_url_map') or {})
    if evidence['text'] != snapshot['body']:
        raise ValueError('公开帖子回读正文不一致，不能确认成功')
    # Bind the author to this top-level tweet, rather than its quote card.
    author = article.get_by_test_id('User-Name').first
    if snapshot['account'].lower() not in (await author.inner_text()).lower():
        raise ValueError('公开帖子作者回读不一致')
    await article.screenshot(path=str(evidence_dir / 'published.png'))
    return url, bold_differences(snapshot, evidence['mask'])


def bold_differences(snapshot, mask):
    """The post is public either way; a format mismatch is reported, not hidden."""
    expected = [False] * len(snapshot['body'])
    for start, end in snapshot.get('bold_ranges') or []:
        expected[start:end] = [True] * (end - start)
    if len(mask) != len(expected):
        return ['加粗无法逐字核对，请到 X 看一眼']
    pairs = [(a, b) for ch, a, b in zip(snapshot['body'], mask, expected) if not ch.isspace()]
    if all(a == b for a, b in pairs):
        return []
    if any(b for _, b in pairs) and not any(a for a, _ in pairs):
        return ['加粗被 X 丢了，线上是普通字']
    return ['加粗位置与稿件不同']


async def prepare_schedule(page, snapshot, scheduled_for, require_verifier=True):
    """Native controls are configured after read-only UI discovery."""
    if SCHEDULE_CONTROLS is None:
        raise UnsupportedDelivery('X 原生定时控件尚未完成核验，暂不能提交')
    if require_verifier and (SCHEDULE_OPERATION is None or not callable(SCHEDULE_CONTROLS.get('verify'))):
        raise UnsupportedDelivery('X 原生定时回读尚未完成核验，暂不能提交')
    target = utc_time(scheduled_for)
    if target.second or target.microsecond:
        raise ValueError('X 原生定时只接受整分钟日期')
    if target <= dt.datetime.now(dt.timezone.utc) + dt.timedelta(minutes=1):
        raise ValueError('定时时间必须至少晚于现在 1 分钟')
    config = SCHEDULE_CONTROLS
    dialog = page.locator('[role="dialog"]').last
    trigger = dialog.locator(config['trigger'])
    if not await trigger.count() or not await trigger.is_enabled():
        raise UnsupportedDelivery('X 对这篇稿禁用了原生定时；请在 X 手动处理')
    await trigger.click()
    scheduling = page.locator('[role="dialog"]').last
    await scheduling.locator('select').first.wait_for(state='visible', timeout=20000)
    # IDs are generated dynamically. Identify each control by its actual options.
    controls = await wait_schedule_options(page, scheduling, target, required_fields={'year', 'month'})
    for name in ('year', 'month'):
        index, value = controls[name]
        await scheduling.locator('select').nth(index).select_option(value)
    controls = await wait_schedule_options(page, scheduling, target)
    for name in ('day', 'hour', 'minute', 'ampm'):
        index, value = controls[name]
        await scheduling.locator('select').nth(index).select_option(value)
    await scheduling.locator(config['confirm']).click()
    if not config.get('submit'):
        raise UnsupportedDelivery('X 原生定时最终按钮尚未完成核验，未提交')
    final = page.locator('[role="dialog"]').last.locator(config['submit'])
    await final.wait_for()
    if not await final.is_enabled():
        raise UnsupportedDelivery('X 未允许提交这篇定时稿；请在 X 手动处理')
    return final


async def wait_schedule_options(page, scheduling, target, required_fields=None):
    last_error = None
    for _ in range(40):
        metadata = await scheduling.locator('select').evaluate_all('''elements => elements.map(e=>
          Array.from(e.options,o=>({value:o.value,text:o.textContent.trim()})))''')
        try:
            if len(metadata) != 6:
                raise UnsupportedDelivery('X 定时日期控件尚未加载完整')
            return schedule_selection(metadata, target, required_fields)
        except UnsupportedDelivery as exc:
            last_error = exc
            await page.wait_for_timeout(250)
    raise last_error or UnsupportedDelivery('X 定时日期控件加载超时')


def schedule_selection(metadata, target, required_fields=None):
    """Resolve six native select controls by options, including 12-hour time."""
    found = {}
    required = set(required_fields) if required_fields is not None else {'year', 'month', 'day', 'hour', 'minute', 'ampm'}
    month_names = {calendar.month_name[i].lower(): i for i in range(1, 13)}
    month_names.update({calendar.month_abbr[i].lower(): i for i in range(1, 13)})
    for index, options in enumerate(metadata):
        options = [o for o in options if str(o.get('value', '')) != '']
        labels = [str(o.get('text', '')).strip() for o in options]
        lower = [s.lower() for s in labels]
        name, wanted, value = None, None, None
        month_labels = [month_names.get(label) for label in lower]
        if len(options) == 12 and all(month_labels) and set(month_labels) == set(range(1, 13)):
            name = 'month'
            value = next(o['value'] for o, month in zip(options, month_labels) if month == target.month)
        elif len(options) == 2 and set(lower) == {'am', 'pm'}:
            name = 'ampm'
            wanted = 'am' if target.hour < 12 else 'pm'
            value = next(o['value'] for o, label in zip(options, lower) if label == wanted)
        elif labels and all(re.fullmatch(r'\d+', label) for label in labels):
            numbers = [int(label) for label in labels]
            values = set(numbers)
            if all(1900 <= value <= 2200 for value in values):
                name, wanted = 'year', target.year
            elif values == set(range(60)):
                name, wanted = 'minute', target.minute
            elif values == set(range(1, 13)):
                name, wanted = 'hour', target.hour % 12 or 12
            elif max(values) in (28, 29, 30, 31) and values == set(range(1, max(values) + 1)):
                name, wanted = 'day', target.day
            if name and wanted in values:
                value = next(o['value'] for o, number in zip(options, numbers) if number == wanted)
        if name and name in required:
            if name in found or value is None:
                raise UnsupportedDelivery('X 定时日期控件存在歧义或不支持所选日期')
            found[name] = (index, str(value))
    if set(found) != required:
        raise UnsupportedDelivery('未能按实际选项识别 X 定时日期控件，未提交')
    return found


def scheduled_id(payload):
    if payload.get('errors'):
        raise ValueError('X 返回定时创建错误，结果需要检查')
    value = str(((payload.get('data') or {}).get('tweet') or {}).get('rest_id') or '')
    if not value.isdigit():
        raise ValueError('X 定时创建响应没有有效任务 ID')
    return value


def verify_native_scheduled(create_payload, list_payload, snapshot, scheduled_for):
    """Fields come from the current official ComposeScheduling client source."""
    target_id = scheduled_id(create_payload)
    if list_payload.get('errors'):
        raise ValueError('X 原生定时列表返回错误')
    rows = ((list_payload.get('data') or {}).get('viewer') or {}).get('scheduled_tweet_list')
    if not isinstance(rows, list):
        raise ValueError('X 原生定时列表响应格式不一致')
    candidates = [row for row in rows if isinstance(row, dict) and str(row.get('rest_id') or '') == target_id]
    if not candidates:
        raise LookupError('新会话原生定时列表未读到本次任务，结果需要检查')
    if len(candidates) != 1:
        raise ValueError('X 原生定时任务 ID 不唯一')
    row = candidates[0]
    request = row.get('tweet_create_request') or {}
    if request.get('type') != 'PostTweetRequest':
        raise ValueError('X 原生定时任务不是普通推文')
    info = row.get('scheduling_info') or {}
    if info.get('state') not in ('Pending', 'Scheduled'):
        raise ValueError('X 原生定时任务未处于有效待发状态')
    # Native creation sends Unix seconds, while FetchScheduledTweets returns
    # milliseconds (the client passes this field directly to new Date()).
    # Check the exact native unit before adapting; never guess or relax the
    # submission gate's seconds contract.
    expected_epoch = int(utc_time(scheduled_for).timestamp())
    readback_epoch = info.get('execute_at')
    if type(readback_epoch) not in (int, float) or readback_epoch != expected_epoch * 1000:
        raise ValueError('X 原生定时回读时间与确认日期不一致，结果待核对')
    try:
        request_contract({'variables': {'post_tweet_request': request, 'execute_at': expected_epoch}},
                         snapshot, 'schedule', scheduled_for)
    except (ValueError, UnsupportedDelivery) as exc:
        message = 'X 原生定时回读核验未通过：' + str(exc).replace('，已阻止发送', '')
        raise type(exc)(message) from exc
    media_ids = [str(value) for value in request.get('media_ids') or []]
    if '_committed_media_ids' in snapshot and media_ids != snapshot['_committed_media_ids']:
        raise ValueError('X 原生定时媒体 ID 与本次提交不一致')
    media_entities = row.get('media_entities') or []
    if not isinstance(media_entities, list) or len(media_entities) != len(snapshot.get('media_paths') or []):
        raise ValueError('X 原生定时配图回读数量不一致')
    hosted_ids = [str(item.get('media_key') or '').split('_')[-1] for item in media_entities]
    if hosted_ids != media_ids:
        raise ValueError('X 原生定时配图实体与媒体 ID 不一致')
    return {'verified': True, 'scheduled_id': target_id, 'native_state': info['state'],
            'scheduled_for': utc_time(scheduled_for).isoformat(),
            'scheduled_url': 'https://x.com/compose/post/unsent/scheduled',
            'verification_contract': 'x-native-scheduled-delivery-v1',
            'response_verified': True, 'scheduled_readback_verified': True,
            'body_sha256': hashlib.sha256(snapshot['body'].encode()).hexdigest(),
            'bold_verified': True, 'quote_verified': True, 'media_verified': True,
            'media_count': len(media_ids)}


async def verify_scheduled(page, snapshot, scheduled_for, payload, evidence_dir):
    """Fresh cookie-only session; native GET readback, never a second submit."""
    scheduled_id(payload)
    u = uploader()
    fresh = await u.context(page.context.browser)
    read_guard = CommitGate(snapshot, 'schedule', scheduled_for)
    await fresh.route('**/*', read_guard.route)
    vp = await fresh.new_page()
    try:
        last_error = None
        for attempt in range(3):
            async with vp.expect_response(lambda response: response.request.method == 'GET'
                                          and operation(response.url) == 'FetchScheduledTweets', timeout=45000) as pending:
                await vp.goto('https://x.com/compose/post/unsent/scheduled',
                              wait_until='domcontentloaded', timeout=45000)
            response = await pending.value
            if not response.ok:
                raise ValueError('X 原生定时列表请求未成功')
            await u.check_account(vp)
            try:
                result = verify_native_scheduled(payload, await response.json(), snapshot, scheduled_for)
                await vp.screenshot(path=str(evidence_dir / 'scheduled-list.png'))
                result['evidence'] = str(evidence_dir / 'scheduled-list.png')
                (evidence_dir / 'scheduled-readback.json').write_text(json.dumps(result, ensure_ascii=False, indent=2))
                return result
            except LookupError as exc:
                last_error = exc
                if attempt < 2:
                    await vp.wait_for_timeout(1000)
        raise last_error
    finally:
        await fresh.close()


SCHEDULE_CONTROLS['verify'] = verify_scheduled


def find_timeline_post(payloads, snapshot, due, window=dt.timedelta(minutes=15)):
    """The tweet X created from a native schedule: same content, posted near the due time."""
    for payload in payloads:
        for item in _find_key(payload, 'tweet_results'):
            post = tweet_fields((item or {}).get('result'))
            if not post or not post['created_at']:
                continue
            created = dt.datetime.strptime(post['created_at'], '%a %b %d %H:%M:%S %z %Y')
            if not due - dt.timedelta(minutes=1) <= created <= due + window:
                continue
            try:
                return match_post(post, snapshot), created
            except ValueError:
                continue
    return None, None


async def follow_up_scheduled(snapshot, scheduled_for, evidence_dir):
    """Read-only: after the due time, find the public tweet on the profile and read it back."""
    evidence_dir = Path(evidence_dir)
    evidence_dir.mkdir(parents=True, exist_ok=True)
    due = utc_time(scheduled_for)
    u = uploader()
    async with browser_session(u) as browser:
        context = await u.context(browser)
        page = await context.new_page()
        payloads = []

        async def collect(response):
            if response.request.method == 'GET' and operation(response.url) in ('UserOriginalsTimeline', 'UserTweets'):
                try:
                    payloads.append(await response.json())
                except Exception:
                    pass
        page.on('response', collect)
        await page.goto('https://x.com/' + snapshot['account'].lstrip('@'), wait_until='domcontentloaded', timeout=45000)
        post = created = None
        for _ in range(6):
            await page.wait_for_timeout(2500)
            post, created = find_timeline_post(payloads, snapshot, due)
            if post:
                break
            await page.mouse.wheel(0, 6000)
        if not post:
            return {'found': False}
        url, differences = await verify_public_page(page, snapshot, post, evidence_dir)
        return {'found': True, 'post_id': post['post_id'], 'post_url': url,
                'published_at': created.astimezone(dt.timezone.utc).isoformat(),
                'format_differences': differences, 'evidence': str(evidence_dir / 'published.png')}


async def deliver(snapshot: dict, evidence_dir: Path, mode: str,
                  scheduled_for: str | None = None, before_commit=None,
                  prepare_only=False) -> dict:
    """Return verified only after response contract and independent UI readback."""
    if mode not in ('publish', 'schedule'):
        raise ValueError('不支持的发布方式')
    evidence_dir = Path(evidence_dir)
    evidence_dir.mkdir(parents=True, exist_ok=True)
    u = uploader()
    body, ranges = u.parse_bold(snapshot['markdown_body'])
    if body != snapshot['body'] or [tuple(r) for r in snapshot['bold_ranges']] != ranges:
        raise ValueError('已核验正文/加粗快照不一致')
    if snapshot['account'] != u.ACCOUNT:
        raise ValueError('发布账号不是已核验账号')
    if mode == 'schedule' and not scheduled_for:
        raise ValueError('缺少定时日期')
    gate = CommitGate(snapshot, mode, scheduled_for)
    known_identity = {}
    try:
        async with browser_session(u) as browser:
            context = await u.context(browser)
            # UTC makes native select fields unambiguous and independent of host TZ.
            await context.route('**/*', gate.route)
            page = await context.new_page()
            timezone_session = await context.new_cdp_session(page)
            await timezone_session.send('Emulation.setTimezoneOverride', {'timezoneId': 'UTC'})
            if snapshot.get('quote'):
                await u.compose_quote(page, snapshot['quote'])
            else:
                await u.compose(page)
            box = u.editor(page)
            await box.fill(body)
            await u.apply_bold(page, box, body, ranges)
            await u.attach_media(page, [Path(p) for p in snapshot.get('media_paths') or []])
            await u.verify_format(box, body, ranges)
            await u.verify_media(page, len(snapshot.get('media_paths') or []))
            await u.check_account(page)
            if snapshot.get('quote'):
                await u.verify_quote(page, snapshot['quote'])
            await page.locator('[role="dialog"]').last.screenshot(path=str(evidence_dir / 'prepared.png'))
            if mode == 'schedule':
                final_button = await prepare_schedule(page, snapshot, scheduled_for, require_verifier=not prepare_only)
            else:
                final_button = page.locator('[role="dialog"]').last.get_by_test_id('tweetButton')
                await final_button.wait_for()
                if not await final_button.is_enabled():
                    raise UnsupportedDelivery('X 未允许发布这篇稿，请检查普通推文长度和配图')
            if prepare_only:
                return {'verified': False, 'prepared': True, 'state': 'prepared',
                        'commit_sent': False,
                        'account': snapshot['account'], 'publicly_posted': False,
                        'mode': mode, 'scheduled_for': scheduled_for,
                        'evidence': str(evidence_dir / 'prepared.png')}
            await gate.arm(before_commit)
            async with page.expect_response(gate.matches_response, timeout=45000) as pending:
                await final_button.click()
            response = await pending.value
            if not response.ok:
                raise ValueError('X 提交响应未成功，需要检查结果')
            payload = await response.json()
            # The response contains post data, never cookies/request headers.
            # Keep it in the caller's private evidence directory so a future
            # response-schema failure can be diagnosed without resubmission.
            (evidence_dir / 'creation-response.json').write_text(json.dumps(payload, ensure_ascii=False, indent=2))
            committed_snapshot = dict(snapshot, _committed_media_ids=gate.media_ids)
            if mode == 'publish':
                known_id = created_post(payload)['post_id']
                known_identity = {'post_id': known_id,
                                  'post_url': 'https://x.com/' + snapshot['account'].lstrip('@') + '/status/' + known_id}
                post = verify_created_post(payload, committed_snapshot)
                url, differences = await verify_public_page(page, committed_snapshot, post, evidence_dir)
                return {'verified': True, 'state': 'published', 'mode': mode, 'format_differences': differences,
                        'commit_sent': True, 'uncertain': False, 'retry_allowed': False,
                        'account': snapshot['account'], 'publicly_posted': True,
                        'post_id': post['post_id'], 'post_url': url,
                        'evidence': str(evidence_dir / 'published.png'),
                        'verification_contract': 'x-post-delivery-v1',
                        'response_verified': True, 'public_readback_verified': True}
            known_identity = {'scheduled_id': scheduled_id(payload),
                              'scheduled_url': 'https://x.com/compose/post/unsent/scheduled'}
            result = await verify_scheduled(page, committed_snapshot, scheduled_for, payload, evidence_dir)
            if result.get('verified') is not True or not result.get('scheduled_id'):
                raise ValueError('X 定时任务回读未通过核验')
            return dict(result, mode=mode, state='scheduled', publicly_posted=False,
                        commit_sent=True, uncertain=False, retry_allowed=False,
                        account=snapshot['account'], scheduled_for=scheduled_for)
    except Exception as exc:
        state = 'uncertain' if gate.sent else ('unsupported' if isinstance(exc, UnsupportedDelivery) or gate.blocked_unsupported else 'failed')
        return dict(known_identity, verified=False, state=state, uncertain=gate.sent,
                    commit_sent=gate.sent, mode=mode, account=snapshot['account'],
                    publicly_posted=None if gate.sent and mode == 'publish' else False,
                    error=gate.blocked_reason or str(exc), retry_allowed=not gate.sent,
                    evidence=str(evidence_dir / 'prepared.png'))
