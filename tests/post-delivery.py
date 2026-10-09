"""Offline safety contracts; never opens a browser or loads authentication."""
import importlib.util
import json
import unittest
import asyncio
import tempfile
from contextlib import asynccontextmanager
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import patch

ROOT = Path(__file__).resolve().parents[1]
if ROOT.name == 'work':
    ROOT = ROOT.parent
MODULE = ROOT / 'delivery/post_delivery.py'
spec = importlib.util.spec_from_file_location('post_delivery_under_test', MODULE)
d = importlib.util.module_from_spec(spec)
spec.loader.exec_module(d)


def snapshot(body='准备完成', bold_ranges=(), quote=None, media_paths=()):
    return {'body': body, 'markdown_body': body, 'bold_ranges': bold_ranges,
            'quote': quote, 'media_paths': media_paths, 'account': '@zwzw3888'}


def payload(body='准备完成', media=(), quote=None, bold=()):
    variables = {'tweet_text': body, 'media': {'media_entities': list(media)}}
    if quote:
        variables['attachment_url'] = quote
    if bold:
        variables['richtext_options'] = {'richtext_tags': [
            {'from_index': start, 'to_index': end, 'richtext_types': ['Bold']}
            for start, end in bold]}
    return {'variables': variables}


class FakeRoute:
    def __init__(self, body=None, operation='CreateTweet', method='POST'):
        self.request = SimpleNamespace(url='https://x.com/i/api/graphql/private-id/' + operation,
                                       method=method, post_data=json.dumps(body or payload()))
        self.aborted = False
        self.continued = False

    async def abort(self):
        self.aborted = True

    async def continue_(self):
        self.continued = True

    async def fallback(self):
        self.continued = True


class GateTests(unittest.IsolatedAsyncioTestCase):
    async def test_schedule_metadata_waits_for_complete_hydration(self):
        metadata = [
            [{'value': str(i), 'text': d.calendar.month_name[i]} for i in range(1, 13)],
            [{'value': str(i), 'text': str(i)} for i in range(1, 32)],
            [{'value': str(i), 'text': str(i)} for i in range(2026, 2036)],
            [{'value': str(i), 'text': str(i)} for i in range(1, 13)],
            [{'value': str(i), 'text': str(i).zfill(2)} for i in range(60)],
            [{'value': 'am', 'text': 'AM'}, {'value': 'pm', 'text': 'PM'}],
        ]
        class Hydrating:
            calls = 0
            def locator(self, _):
                return self
            async def evaluate_all(self, _):
                self.calls += 1
                return [] if self.calls == 1 else metadata
        waits = []
        async def wait(ms):
            waits.append(ms)
        scheduling = Hydrating()
        result = await d.wait_schedule_options(SimpleNamespace(wait_for_timeout=wait), scheduling,
                                               d.utc_time('2030-10-31T20:05:00Z'))
        self.assertEqual(result['day'], (1, '31'))
        self.assertEqual(waits, [250])

    async def test_preparation_blocks_publish_and_schedule(self):
        gate = d.CommitGate(snapshot(), 'publish')
        for op in ('CreateTweet', 'CreateNoteTweet', 'CreateScheduledTweet'):
            route = FakeRoute(operation=op)
            await gate.route(route)
            self.assertTrue(route.aborted)
        self.assertFalse(gate.sent)

    async def test_durable_callback_is_required(self):
        gate = d.CommitGate(snapshot(), 'publish')
        with self.assertRaises(ValueError):
            await gate.arm(None)
        with self.assertRaises(ValueError):
            await gate.arm(lambda: False)
        self.assertFalse(gate.armed)

    async def test_callback_failure_does_not_arm(self):
        gate = d.CommitGate(snapshot(), 'publish')
        async def failure():
            raise OSError('disk full')
        with self.assertRaises(OSError):
            await gate.arm(failure)
        self.assertFalse(gate.armed)

    async def test_exactly_one_submit(self):
        gate = d.CommitGate(snapshot(), 'publish')
        calls = []
        await gate.arm(lambda: calls.append('persisted'))
        first = FakeRoute()
        await gate.route(first)
        second = FakeRoute()
        await gate.route(second)
        self.assertEqual(calls, ['persisted'])
        self.assertTrue(first.continued)
        self.assertTrue(second.aborted)
        self.assertTrue(gate.sent)

    async def test_changed_body_blocks_before_network(self):
        gate = d.CommitGate(snapshot(), 'publish')
        await gate.arm(lambda: None)
        route = FakeRoute(payload('后来修改过的正文'))
        await gate.route(route)
        self.assertTrue(route.aborted)
        self.assertFalse(gate.sent)

    async def test_wrong_action_blocks(self):
        gate = d.CommitGate(snapshot(), 'schedule', '2030-10-01T12:00:00Z')
        await gate.arm(lambda: None)
        route = FakeRoute()
        await gate.route(route)
        self.assertTrue(route.aborted)
        self.assertFalse(gate.sent)

    async def test_regular_read_is_allowed_without_arm(self):
        gate = d.CommitGate(snapshot(), 'publish')
        route = FakeRoute(operation='TweetDetail', method='GET')
        await gate.route(route)
        self.assertTrue(route.continued)
        self.assertFalse(gate.sent)

    async def test_response_matches_only_submitted_request(self):
        gate = d.CommitGate(snapshot(), 'publish')
        await gate.arm(lambda: None)
        route = FakeRoute()
        await gate.route(route)
        self.assertTrue(gate.matches_response(SimpleNamespace(request=route.request)))
        other = FakeRoute(payload('另一个帖子'))
        self.assertFalse(gate.matches_response(SimpleNamespace(request=other.request)))


class FakeComposer:
    def __init__(self, context):
        self.context = context
        self.last = self
        self.response_future = None
        self.click_count = 0

    def locator(self, _):
        return self

    def get_by_test_id(self, _):
        return self

    async def fill(self, _):
        pass

    async def screenshot(self, **_):
        pass

    async def wait_for(self, **_):
        pass

    async def is_enabled(self):
        return True

    async def click(self):
        self.click_count += 1
        route = FakeRoute()
        await self.context.gate(route)
        if route.continued:
            async def invalid_json():
                return {'data': {}}
            self.response_future.set_result(SimpleNamespace(ok=True, request=route.request, json=invalid_json))

    def expect_response(self, predicate, **_):
        self.response_future = asyncio.get_running_loop().create_future()
        future = self.response_future
        class Pending:
            value = future
            async def __aenter__(self):
                return self
            async def __aexit__(self, *args):
                if not args[0]:
                    response = await future
                    if not predicate(response):
                        raise RuntimeError('response predicate mismatch')
        return Pending()


class FakeContext:
    def __init__(self):
        self.page = FakeComposer(self)
        self.gate = None

    async def route(self, _, gate):
        self.gate = gate

    async def new_page(self):
        return self.page

    async def new_cdp_session(self, _):
        async def send(*_):
            pass
        return SimpleNamespace(send=send)


class DeliveryFlowTests(unittest.IsolatedAsyncioTestCase):
    async def run_delivery(self, prepare_only, callback):
        ctx = FakeContext()
        async def noop(*_):
            pass
        async def context(_):
            return ctx
        @asynccontextmanager
        async def session(_):
            yield object()
        module = SimpleNamespace(ACCOUNT='@zwzw3888', parse_bold=lambda text: (text, []),
                                 context=context, editor=lambda _: ctx.page,
                                 compose=noop, compose_quote=noop, apply_bold=noop,
                                 attach_media=noop, verify_format=noop, verify_media=noop,
                                 check_account=noop, verify_quote=noop)
        with tempfile.TemporaryDirectory() as folder, patch.object(d, 'uploader', lambda: module), patch.object(d, 'browser_session', session):
            result = await d.deliver(snapshot(), Path(folder), 'publish', before_commit=callback,
                                     prepare_only=prepare_only)
        return result, ctx

    async def test_prepare_only_never_arms_or_clicks_final(self):
        persisted = []
        result, ctx = await self.run_delivery(True, lambda: persisted.append('attempt'))
        self.assertEqual(result['state'], 'prepared')
        self.assertFalse(result['verified'])
        self.assertEqual(persisted, [])
        self.assertEqual(ctx.page.click_count, 0)

    async def test_click_and_http_success_do_not_prove_posted(self):
        persisted = []
        result, ctx = await self.run_delivery(False, lambda: persisted.append('attempt'))
        self.assertEqual(persisted, ['attempt'])
        self.assertEqual(ctx.page.click_count, 1)
        self.assertEqual(result['state'], 'uncertain')
        self.assertFalse(result['verified'])
        self.assertFalse(result['retry_allowed'])

    async def test_failed_attempt_write_never_clicks(self):
        result, ctx = await self.run_delivery(False, lambda: False)
        self.assertFalse(result['commit_sent'])
        self.assertEqual(ctx.page.click_count, 0)


class ContractTests(unittest.TestCase):
    def test_actual_blocked_client_payload_fixtures(self):
        for name, mode in (('native-note-observed.json', 'publish'), ('native-schedule-observed.json', 'schedule')):
            observed = json.loads((ROOT / 'tests/fixtures' / name).read_text())
            self.assertFalse(observed['actual_submission'])
            variables = observed['payload']['variables']
            content = variables.get('post_tweet_request') or variables
            body = content.get('status', content.get('tweet_text'))
            snap = snapshot(body, bold_ranges=[(0, 4)])
            when = None
            if mode == 'schedule':
                when = d.dt.datetime.fromtimestamp(variables['execute_at'], d.dt.timezone.utc).isoformat()
            self.assertTrue(d.request_contract(observed['payload'], snap, mode, when))
            snap['body'] += '改'
            with self.assertRaises(ValueError):
                d.request_contract(observed['payload'], snap, mode, when)

    def test_quote_and_media_are_exact(self):
        quote = 'https://x.com/author/status/123456'
        snap = snapshot(quote=quote, media_paths=['/tmp/one.png'])
        good = payload(quote=quote, media=[{'media_id': '111'}])
        self.assertTrue(d.request_contract(good, snap, 'publish'))
        with self.assertRaises(ValueError):
            d.request_contract(payload(quote=quote), snap, 'publish')
        with self.assertRaises(ValueError):
            d.request_contract(payload(quote=quote.replace('123456', '999'), media=[{'media_id': '111'}]), snap, 'publish')

    def test_missing_bold_does_not_silently_degrade(self):
        snap = snapshot('😀保留重点', bold_ranges=[(1, 5)])
        with self.assertRaises(d.UnsupportedDelivery):
            d.request_contract(payload(snap['body']), snap, 'publish')
        self.assertTrue(d.request_contract(payload(snap['body'], bold=[(2, 6)]), snap, 'publish'))
        changed = payload(snap['body'], bold=[(2, 6)])
        changed['variables']['richtext_options']['richtext_tags'][0]['richtext_types'].append('Italic')
        with self.assertRaises(ValueError):
            d.request_contract(changed, snap, 'publish')

    def test_no_length_limit_is_guessed(self):
        snap = snapshot('汉' * 500)
        self.assertTrue(d.request_contract(payload(snap['body']), snap, 'publish'))

    def test_timezone_and_schedule_epoch(self):
        when = '2030-10-01T20:00:00+08:00'
        with self.assertRaises(ValueError):
            d.utc_time('2030-10-01T12:00:00')
        self.assertEqual(d.utc_time(when).isoformat(), '2030-10-01T12:00:00+00:00')
        data = {'variables': {'post_tweet_request': {'status': '准备完成', 'media_ids': [], 'thread_tweets': []},
                              'execute_at': int(d.utc_time(when).timestamp())}}
        self.assertTrue(d.request_contract(data, snapshot(), 'schedule', when))
        data['variables']['execute_at'] += 60
        with self.assertRaises(ValueError):
            d.request_contract(data, snapshot(), 'schedule', when)

    def test_schedule_submission_rejects_readback_milliseconds(self):
        when = '2026-10-03T12:09:00Z'
        data = {'variables': {'post_tweet_request': {'status': '准备完成', 'media_ids': [], 'thread_tweets': []},
                              'execute_at': 1791029340000}}
        with self.assertRaisesRegex(ValueError, '定时时间'):
            d.request_contract(data, snapshot(), 'schedule', when)
        data['variables']['execute_at'] = 1791029340
        self.assertTrue(d.request_contract(data, snapshot(), 'schedule', when))

    def test_native_schedule_preserves_long_bold_and_rejects_thread(self):
        snap = snapshot('长' * 500, bold_ranges=[(0, 4)])
        when = '2030-10-01T12:00:00Z'
        content = {'status': snap['body'], 'media_ids': [], 'thread_tweets': [],
                   'richtext_options': {'richtext_tags': [
                       {'from_index': 0, 'to_index': 4, 'richtext_types': ['Bold']}]}}
        data = {'variables': {'post_tweet_request': content,
                              'execute_at': int(d.utc_time(when).timestamp())}}
        self.assertTrue(d.request_contract(data, snap, 'schedule', when))
        content['thread_tweets'] = [{'status': 'next'}]
        with self.assertRaises(d.UnsupportedDelivery):
            d.request_contract(data, snap, 'schedule', when)

    def test_created_id_does_not_pick_quote(self):
        result = {'data': {'create_tweet': {'tweet_results': {'result': {
            'rest_id': '777', 'legacy': {'full_text': '准备完成', 'quoted_status_id_str': '999'},
            'quoted_status_result': {'result': {'rest_id': '999'}},
            'core': {'user_results': {'result': {'legacy': {'screen_name': 'zwzw3888'}}}}
        }}}}}
        self.assertEqual(d.created_post(result)['post_id'], '777')
        with self.assertRaises(ValueError):
            d.verify_created_post(result, snapshot())
        result['data']['create_tweet']['tweet_results']['result']['legacy'].pop('quoted_status_id_str')
        self.assertEqual(d.verify_created_post(result, snapshot())['post_id'], '777')

    def test_current_note_create_response_uses_root_tweet_and_note_text(self):
        # The envelope is from the current official client's CreateNoteTweet
        # handler; the IDs and tweet contents are offline fixtures.
        result = {'data': {'notetweet_create': {'tweet_results': {'result': {
            '__typename': 'Tweet', 'rest_id': '777',
            'legacy': {'id_str': '777', 'full_text': '普通字段里的截断文本',
                       'quoted_status_id_str': '999',
                       'extended_entities': {'media': [{'id_str': '111'}]}},
            'note_tweet': {'note_tweet_results': {'result': {'text': '😀重点正文'}}},
            'quoted_status_result': {'result': {'rest_id': '999'}},
            'core': {'user_results': {'result': {'core': {'screen_name': 'zwzw3888'}}}},
        }}}}}
        snap = snapshot('😀重点正文', quote='https://x.com/author/status/999', media_paths=['/tmp/image.png'])
        snap['_committed_media_ids'] = ['111']
        post = d.verify_created_post(result, snap)
        self.assertEqual(post['post_id'], '777')
        self.assertEqual(post['body'], '😀重点正文')
        self.assertEqual(post['media_ids'], ['111'])

    def test_current_note_create_cannot_use_nested_quote_as_created_id(self):
        for root_id in (None, 'not-a-tweet-id'):
            with self.subTest(root_id=root_id):
                result = {'data': {'notetweet_create': {'tweet_results': {'result': {
                    'rest_id': root_id, 'legacy': {'full_text': '准备完成', 'quoted_status_id_str': '999'},
                    'quoted_status_result': {'result': {'rest_id': '999', 'legacy': {'id_str': '999'}}},
                }}}}}
                with self.assertRaisesRegex(ValueError, '未找到本次新帖 ID'):
                    d.created_post(result)

    def test_root_legacy_id_is_fallback_when_rest_id_is_missing(self):
        for name in ('create_tweet', 'create_note_tweet', 'notetweet_create'):
            with self.subTest(name=name):
                result = {'data': {name: {'tweet_results': {'result': {
                    'legacy': {'id_str': '777', 'full_text': '准备完成', 'quoted_status_id_str': '999'},
                    'quoted_status_result': {'result': {'rest_id': '999', 'legacy': {'id_str': '999'}}},
                }}}}}
                snap = snapshot(quote='https://x.com/author/status/999')
                self.assertEqual(d.verify_created_post(result, snap)['post_id'], '777')

    def test_conflicting_root_rest_and_legacy_ids_cannot_verify(self):
        for name in ('create_tweet', 'create_note_tweet', 'notetweet_create'):
            with self.subTest(name=name):
                result = {'data': {name: {'tweet_results': {'result': {
                    'rest_id': '777', 'legacy': {'id_str': '888', 'full_text': '准备完成'},
                }}}}}
                with self.assertRaisesRegex(ValueError, '新帖 ID 不一致'):
                    d.created_post(result)
                with self.assertRaisesRegex(ValueError, '新帖 ID 不一致'):
                    d.verify_created_post(result, snapshot())

    def test_graphql_errors_with_creation_data_cannot_prove_success(self):
        result = {'errors': [{'message': 'server reported a failure'}],
                  'data': {'notetweet_create': {'tweet_results': {'result': {
                      'rest_id': '777', 'legacy': {'full_text': '准备完成'},
                  }}}}}
        for verify in (lambda: d.created_post(result), lambda: d.verify_created_post(result, snapshot())):
            with self.subTest(verify=verify):
                with self.assertRaisesRegex(ValueError, 'X 返回发布错误'):
                    verify()

    def test_display_range_uses_utf16(self):
        result = {'data': {'create_tweet': {'tweet_results': {'result': {
            'rest_id': '777', 'legacy': {'full_text': '😀正文 https://t.co/private', 'display_text_range': [0, 4]},
        }}}}}
        self.assertEqual(d.created_post(result)['body'], '😀正文')

    def test_api_errors_never_prove_success(self):
        with self.assertRaises(ValueError):
            d.verify_created_post({'errors': [{'message': 'failed'}]}, snapshot())

    def test_response_links_restore_only_exact_source_urls(self):
        result = {'data': {'create_tweet': {'tweet_results': {'result': {
            'rest_id': '777', 'legacy': {
                'full_text': '来源 https://t.co/id',
                'entities': {'urls': [{'url': 'https://t.co/id', 'expanded_url': 'https://example.com/source'}]},
            },
        }}}}}
        post = d.verify_created_post(result, snapshot('来源 https://example.com/source'))
        self.assertEqual(post['body'], '来源 https://example.com/source')
        with self.assertRaises(ValueError):
            d.verify_created_post(result, snapshot('来源 https://example.com/another'))

    def test_response_restores_autolinked_bare_domain(self):
        result = {'data': {'create_tweet': {'tweet_results': {'result': {
            'rest_id': '777', 'legacy': {
                'full_text': '在 https://t.co/id 的设置',
                'entities': {'urls': [{'url': 'https://t.co/id', 'expanded_url': 'http://claude.ai',
                                       'display_url': 'claude.ai'}]},
            },
        }}}}}
        post = d.verify_created_post(result, snapshot('在 claude.ai 的设置'))
        self.assertEqual(post['body'], '在 claude.ai 的设置')
        self.assertEqual(post['source_url_map'], {'https://t.co/id': 'claude.ai'})
        with self.assertRaises(ValueError):
            d.verify_created_post(result, snapshot('在 openai.com 的设置'))

    def timeline(self, text, created, rest_id='900', quoted=''):
        return {'data': {'user': {'result': {'timeline': {'instructions': [{'entries': [{'content': {'itemContent': {
            'tweet_results': {'result': {'rest_id': rest_id, 'core': {'user_results': {'result': {'core': {'screen_name': 'zwzw3888'}}}},
                'legacy': {'id_str': rest_id, 'full_text': text, 'created_at': created, 'quoted_status_id_str': quoted}}}}}}]}]}}}}}

    def test_follow_up_finds_only_matching_post_near_due_time(self):
        due = d.utc_time('2026-10-09T03:16:00Z')
        snap = snapshot('定时正文')
        found, created = d.find_timeline_post([self.timeline('定时正文', 'Fri Oct 09 03:16:00 +0000 2026')], snap, due)
        self.assertEqual((found['post_id'], created.isoformat()), ('900', '2026-10-09T03:16:00+00:00'))
        for text, when in [('别的正文', 'Fri Oct 09 03:16:00 +0000 2026'),
                           ('定时正文', 'Fri Oct 09 02:00:00 +0000 2026'),
                           ('定时正文', 'Fri Oct 09 04:00:00 +0000 2026')]:
            self.assertEqual(d.find_timeline_post([self.timeline(text, when)], snap, due), (None, None))

    def test_bold_differences_are_reported_not_hidden(self):
        snap = snapshot('ab cd', bold_ranges=[(3, 5)])
        self.assertEqual(d.bold_differences(snap, [False, False, False, True, True]), [])
        self.assertEqual(d.bold_differences(snap, [False] * 5), ['加粗被 X 丢了，线上是普通字'])
        self.assertEqual(d.bold_differences(snap, [True, True, False, False, False]), ['加粗位置与稿件不同'])
        self.assertEqual(d.bold_differences(snapshot('ab'), [False, False]), [])

    def test_schedule_selects_use_options_and_ampm(self):
        def numbers(values):
            return [{'value': str(n), 'text': str(n).zfill(2)} for n in values]
        controls = [
            [{'value': str(i - 1), 'text': d.calendar.month_name[i]} for i in range(1, 13)],
            numbers(range(1, 32)), numbers(range(2026, 2036)),
            numbers(range(1, 13)), numbers(range(60)),
            [{'value': 'AM', 'text': 'AM'}, {'value': 'PM', 'text': 'PM'}],
        ]
        selection = d.schedule_selection(controls, d.utc_time('2030-10-01T20:05:00Z'))
        self.assertEqual(selection['month'], (0, '9'))
        self.assertEqual(selection['hour'], (3, '8'))
        self.assertEqual(selection['minute'], (4, '5'))
        self.assertEqual(selection['ampm'], (5, 'PM'))
        midnight = d.schedule_selection(controls, d.utc_time('2030-10-01T00:00:00Z'))
        self.assertEqual(midnight['hour'], (3, '12'))
        self.assertEqual(midnight['ampm'], (5, 'AM'))
        # Reordering dynamic controls does not change the chosen semantics.
        shuffled = d.schedule_selection(list(reversed(controls)), d.utc_time('2030-10-01T20:05:00Z'))
        self.assertEqual(shuffled['month'], (5, '9'))

    def test_ambiguous_native_selects_stop(self):
        with self.assertRaises(d.UnsupportedDelivery):
            d.schedule_selection([[{'value': '1', 'text': '1'}]], d.utc_time('2030-10-01T20:05:00Z'))

    def test_month_and_year_can_change_before_day_resolution(self):
        controls = [
            [{'value': str(i), 'text': d.calendar.month_name[i]} for i in range(1, 13)],
            [{'value': str(i), 'text': str(i)} for i in range(1, 31)],
            [{'value': str(i), 'text': str(i)} for i in range(2026, 2036)],
        ]
        target = d.utc_time('2030-10-31T20:05:00Z')
        resolved = d.schedule_selection(controls, target, {'year', 'month'})
        self.assertEqual(resolved['month'], (0, '10'))
        with self.assertRaises(d.UnsupportedDelivery):
            d.schedule_selection(controls, target, {'day'})
        controls[1].append({'value': '31', 'text': '31'})
        self.assertEqual(d.schedule_selection(controls, target, {'day'})['day'], (1, '31'))


class NativeReadbackTests(unittest.TestCase):
    def setUp(self):
        self.when = '2026-10-03T12:09:00Z'
        self.snap = snapshot('😀重点正文', bold_ranges=[(1, 3)],
                             quote='https://x.com/author/status/123456', media_paths=['/tmp/image.png'])
        self.snap['_committed_media_ids'] = ['111']
        self.created = {'data': {'tweet': {'rest_id': '777'}}}
        self.row = {
            'rest_id': '777',
            'tweet_create_request': {
                'type': 'PostTweetRequest', 'status': self.snap['body'], 'media_ids': ['111'],
                'attachment_url': self.snap['quote'], 'thread_tweets': [],
                'richtext_options': {'richtext_tags': [{'from_index': 2, 'to_index': 4, 'richtext_types': ['Bold']}]},
            },
            # FetchScheduledTweets returns milliseconds; its create request uses seconds.
            'scheduling_info': {'execute_at': 1791029340000, 'state': 'Scheduled'},
            'media_entities': [{'media_key': '3_111'}],
        }
        self.listed = {'data': {'viewer': {'scheduled_tweet_list': [self.row]}}}

    def test_fresh_native_list_proves_exact_content_format_quote_media_and_time(self):
        result = d.verify_native_scheduled(self.created, self.listed, self.snap, self.when)
        self.assertTrue(result['verified'])
        self.assertEqual(result['scheduled_id'], '777')
        self.assertEqual(result['native_state'], 'Scheduled')
        self.assertTrue(result['scheduled_readback_verified'])

    def test_exact_integral_float_milliseconds_also_verify(self):
        self.row['scheduling_info']['execute_at'] = 1791029340000.0
        self.assertTrue(d.verify_native_scheduled(self.created, self.listed, self.snap, self.when)['verified'])

    def test_wrong_or_invalid_readback_time_cannot_verify(self):
        for value in (1791029340001, 1791029400000, 1791029340,
                      True, False, '1791029340000', None, 1791029340000.5,
                      float('nan'), float('inf'), float('-inf')):
            with self.subTest(execute_at=value):
                self.row['scheduling_info']['execute_at'] = value
                with self.assertRaises(ValueError) as raised:
                    d.verify_native_scheduled(self.created, self.listed, self.snap, self.when)
                self.assertNotIn('阻止发送', str(raised.exception))

    def test_empty_or_duplicate_list_cannot_verify(self):
        with self.assertRaises(LookupError):
            d.verify_native_scheduled(self.created, {'data': {'viewer': {'scheduled_tweet_list': []}}}, self.snap, self.when)
        self.listed['data']['viewer']['scheduled_tweet_list'].append(self.row)
        with self.assertRaises(ValueError):
            d.verify_native_scheduled(self.created, self.listed, self.snap, self.when)

    def test_failed_completed_draft_unknown_states_stop(self):
        for state in ('Failed', 'Completed', 'Canceled', 'Dismissed', 'Draft', 'Unknown'):
            self.row['scheduling_info']['state'] = state
            with self.assertRaises(ValueError):
                d.verify_native_scheduled(self.created, self.listed, self.snap, self.when)

    def test_wrong_time_or_removed_bold_never_verifies(self):
        self.row['scheduling_info']['execute_at'] += 60000
        with self.assertRaises(ValueError):
            d.verify_native_scheduled(self.created, self.listed, self.snap, self.when)
        self.row['scheduling_info']['execute_at'] -= 60000
        self.row['tweet_create_request'].pop('richtext_options')
        with self.assertRaises(d.UnsupportedDelivery) as raised:
            d.verify_native_scheduled(self.created, self.listed, self.snap, self.when)
        self.assertTrue(str(raised.exception).startswith('X 原生定时回读核验未通过：'))
        self.assertNotIn('阻止发送', str(raised.exception))

    def test_content_readback_errors_do_not_claim_submission_was_blocked(self):
        self.row['tweet_create_request']['status'] += '改'
        with self.assertRaises(ValueError) as raised:
            d.verify_native_scheduled(self.created, self.listed, self.snap, self.when)
        self.assertTrue(str(raised.exception).startswith('X 原生定时回读核验未通过：'))
        self.assertNotIn('阻止发送', str(raised.exception))

    def test_replaced_media_ids_cannot_verify(self):
        self.row['tweet_create_request']['media_ids'] = ['222']
        self.row['media_entities'] = [{'media_key': '3_222'}]
        with self.assertRaises(ValueError):
            d.verify_native_scheduled(self.created, self.listed, self.snap, self.when)


if __name__ == '__main__':
    unittest.main()
