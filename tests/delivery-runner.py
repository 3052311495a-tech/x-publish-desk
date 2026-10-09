"""Offline ledger and final-commit checks; no browser, account, or auth imports."""
import datetime
import importlib.util
import json
import os
import sys
import tempfile
import unittest
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import patch

ROOT = Path(__file__).resolve().parents[1]
spec = importlib.util.spec_from_file_location('delivery_runner_under_test', ROOT / 'delivery_runner.py')
r = importlib.util.module_from_spec(spec)
spec.loader.exec_module(r)
UTC = datetime.timezone.utc


def markdown(expiry):
    return '---\nstatus: writing\ndelivery_ready: true\nexpires_at: ' + expiry + '\n---\n## 正文\n准备完成\n'


class RunnerTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.folder = Path(self.temp.name)
        self.state = self.folder / 'state'
        self.note = self.folder / '稿件.md'
        self.request = self.folder / 'request.json'
        self.request.write_text('{}')
        self.now = datetime.datetime.now(UTC)
        self.md = markdown((self.now + datetime.timedelta(days=2)).isoformat())
        self.note.write_text(self.md)
        self.snap = {
            'content_key': 'same-content', 'account': '@offline-fixture',
            'note_path': str(self.note), 'markdown': self.md, 'markdown_body': '准备完成',
            'body': '准备完成', 'bold_ranges': [], 'quote': None, 'media_paths': [],
            'media_hashes': [], 'action': 'publish', 'scheduled_for': None,
        }
        self.outputs = []
        self.calls = []
        self.behavior = self.success
        self.patches = [
            patch.object(r, 'STATE', self.state),
            patch.object(r, 'prepare', lambda _: dict(self.snap)),
            patch.object(r, 'review', lambda *_: None),
            patch.object(r, 'emit', lambda **value: self.outputs.append(value)),
            patch.dict(sys.modules, {'delivery.post_delivery': SimpleNamespace(deliver=self.deliver)}),
        ]
        for item in self.patches:
            item.start()
            self.addCleanup(item.stop)

    async def deliver(self, snapshot, folder, action, due, before_commit, prepare_only):
        self.calls.append((action, due))
        return await self.behavior(snapshot, folder, action, due, before_commit, prepare_only)

    async def success(self, snapshot, folder, action, due, before_commit, prepare_only):
        if prepare_only:
            return {'verified': False, 'state': 'prepared', 'commit_sent': False, 'prepared': True}
        before_commit()
        return {'verified': True, 'state': 'published' if action == 'publish' else 'scheduled',
                'commit_sent': True, 'post_id': 'offline-id'}

    def run_it(self, succeeds=True, prepare_only=False):
        if succeeds:
            r.run(str(self.request), prepare_only=prepare_only)
        else:
            with self.assertRaises(SystemExit) as caught:
                r.run(str(self.request), prepare_only=prepare_only)
            self.assertEqual(caught.exception.code, 1)
        return self.outputs[-1]

    def ledger(self):
        return json.loads((self.state / '发布回执' / 'same-content.json').read_text())

    def write_ledger(self, value):
        r.atomic_json(self.state / '发布回执' / 'same-content.json', value)

    def test_published_success_is_reused_without_second_submit(self):
        first = self.run_it()
        second = self.run_it()
        self.assertTrue(first['verified'])
        self.assertTrue(second['already_exists'])
        self.assertEqual(len(self.calls), 1)

    def test_old_posted_state_is_recognized(self):
        self.write_ledger({'state': 'posted', 'verified': True, 'action': 'publish'})
        result = self.run_it()
        self.assertTrue(result['already_exists'])
        self.assertEqual(self.calls, [])

    def test_same_schedule_returns_original_success(self):
        self.snap.update(action='schedule', scheduled_for=(self.now + datetime.timedelta(hours=2)).isoformat())
        self.run_it()
        result = self.run_it()
        self.assertTrue(result['already_exists'])
        self.assertEqual(len(self.calls), 1)

    def test_different_schedule_time_cannot_reuse_receipt(self):
        self.snap.update(action='schedule', scheduled_for=(self.now + datetime.timedelta(hours=2)).isoformat())
        self.run_it()
        self.snap['scheduled_for'] = (self.now + datetime.timedelta(hours=3)).isoformat()
        with self.assertRaisesRegex(ValueError, '另一个时间'):
            r.run(str(self.request))
        self.assertEqual(len(self.calls), 1)

    def test_published_cannot_be_rescheduled(self):
        self.run_it()
        self.snap.update(action='schedule', scheduled_for=(self.now + datetime.timedelta(hours=2)).isoformat())
        with self.assertRaisesRegex(ValueError, '已有发布或定时记录'):
            r.run(str(self.request))
        self.assertEqual(len(self.calls), 1)

    def test_unverified_success_record_never_claims_success(self):
        self.write_ledger({'state': 'published', 'verified': False, 'action': 'publish'})
        with self.assertRaisesRegex(ValueError, '尚未核验'):
            r.run(str(self.request))
        self.assertEqual(self.calls, [])

    def test_callback_then_explicit_not_sent_is_safe_to_retry(self):
        async def rejected(snapshot, folder, action, due, before_commit, prepare_only):
            before_commit()
            return {'verified': False, 'state': 'unsupported', 'commit_sent': False, 'error': 'blocked by gate'}
        self.behavior = rejected
        result = self.run_it(succeeds=False)
        self.assertEqual(result['state'], 'unsupported')
        self.assertFalse(self.ledger()['mutation_started'])
        self.assertFalse(result['uncertain'])
        self.assertTrue(result['retry_allowed'])
        self.behavior = self.success
        self.assertTrue(self.run_it()['verified'])
        self.assertEqual(len(self.calls), 2)

    def test_unexpected_exception_after_callback_is_uncertain_and_blocks_retry(self):
        async def crashed(snapshot, folder, action, due, before_commit, prepare_only):
            before_commit()
            raise RuntimeError('unexpected transport failure')
        self.behavior = crashed
        result = self.run_it(succeeds=False)
        self.assertEqual(result['state'], 'uncertain')
        self.assertTrue(self.ledger()['mutation_started'])
        self.assertFalse(result['retry_allowed'])
        with self.assertRaisesRegex(ValueError, '待核对'):
            r.run(str(self.request))
        self.assertEqual(len(self.calls), 1)

    def test_missing_sent_signal_after_callback_stays_uncertain(self):
        async def unclear(snapshot, folder, action, due, before_commit, prepare_only):
            before_commit()
            return {'verified': False, 'state': 'failed'}
        self.behavior = unclear
        self.assertEqual(self.run_it(succeeds=False)['state'], 'uncertain')

    def test_unexpected_exception_before_callback_is_retryable(self):
        async def crashed(*_):
            raise RuntimeError('editor failed')
        self.behavior = crashed
        result = self.run_it(succeeds=False)
        self.assertEqual(result['state'], 'failed')
        self.assertFalse(self.ledger()['mutation_started'])
        self.assertTrue(result['retry_allowed'])
        self.behavior = self.success
        self.assertTrue(self.run_it()['verified'])

    def test_verified_state_requires_final_callback(self):
        async def wrong(*_):
            return {'verified': True, 'state': 'published', 'commit_sent': False}
        self.behavior = wrong
        result = self.run_it(succeeds=False)
        self.assertFalse(result['verified'])
        self.assertEqual(result['state'], 'failed')

    def test_prepare_only_does_not_write_ledger_or_call_final_callback(self):
        result = self.run_it(prepare_only=True)
        self.assertEqual(result['state'], 'prepared')
        self.assertFalse((self.state / '发布回执').exists())

    def callback_rejection(self, mutate, expected):
        async def rejected(snapshot, folder, action, due, before_commit, prepare_only):
            mutate(snapshot)
            try:
                before_commit()
            except Exception as error:
                return {'verified': False, 'state': 'failed', 'commit_sent': False, 'error': str(error)}
            self.fail('final callback should have blocked this request')
        self.behavior = rejected
        result = self.run_it(succeeds=False)
        self.assertIn(expected, result['error'])
        self.assertFalse(self.ledger()['mutation_started'])

    def test_final_callback_rechecks_markdown(self):
        self.callback_rejection(lambda _: self.note.write_text(self.md + '后来改稿'), '笔记已变化')

    def test_final_callback_rechecks_media(self):
        image = self.folder / '配图.png'
        image.write_bytes(b'original')
        self.snap.update(media_paths=[str(image)], media_hashes=[r.sha(b'original')])
        self.callback_rejection(lambda _: image.write_bytes(b'changed'), '图片已变化')

    def test_final_callback_rechecks_expiry(self):
        expired = markdown((self.now - datetime.timedelta(minutes=1)).isoformat())
        self.snap['markdown'] = expired
        self.note.write_text(expired)
        self.callback_rejection(lambda _: None, '核验已过期')


class SnapshotChecks(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.note = Path(self.temp.name) / '稿件.md'
        self.now = datetime.datetime(2030, 10, 1, 12, tzinfo=UTC)
        self.md = markdown('2030-10-01T13:00:00Z')
        self.note.write_text(self.md)
        self.snap = {'note_path': str(self.note), 'markdown': self.md,
                     'media_paths': [], 'media_hashes': [], 'scheduled_for': None}

    def test_expiry_must_be_timezone_aware_and_in_frontmatter(self):
        for value in ('2030-10-01T13:00:00', 'invalid'):
            with self.assertRaises(ValueError):
                r.expiry_time(markdown(value))
        with patch.dict(r.CONFIG, {'require_ready_fields': True}), self.assertRaises(ValueError):
            r.expiry_time('## 正文\nexpires_at: 2030-10-01T13:00:00Z\n')
        # Without the strict mode a note may simply have no validity window.
        with patch.dict(r.CONFIG, {'require_ready_fields': False}):
            self.assertIsNone(r.expiry_time('## 正文\nexpires_at: 2030-10-01T13:00:00Z\n'))

    def test_schedule_is_rechecked_against_expiry_at_final_gate(self):
        self.snap['scheduled_for'] = '2030-10-01T13:00:01Z'
        with self.assertRaisesRegex(ValueError, '有效期'):
            r.check_unchanged(self.snap, now=self.now)

    def test_elapsed_preparation_can_make_schedule_too_close(self):
        self.snap['scheduled_for'] = '2030-10-01T12:00:30Z'
        with self.assertRaisesRegex(ValueError, '过近'):
            r.check_unchanged(self.snap, now=self.now)

    def test_incomplete_media_hashes_are_not_ignored_by_zip(self):
        self.snap['media_paths'] = ['/never/read/this.png']
        with self.assertRaisesRegex(ValueError, '快照不完整'):
            r.check_unchanged(self.snap, now=self.now)

    def test_valid_snapshot_passes_in_same_instant(self):
        self.snap['scheduled_for'] = '2030-10-01T20:30:00+08:00'
        r.check_unchanged(self.snap, now=self.now)


class RuntimeTests(unittest.TestCase):
    GUI_PATH = '/usr/bin:/bin'
    LOCAL_NODE = Path.home() / '.local/node/bin/node'

    def test_gui_path_resolves_existing_local_node(self):
        if not self.LOCAL_NODE.is_file():
            self.skipTest('needs Node.js installed at ~/.local/node')
        with patch.dict(os.environ, {'PATH': self.GUI_PATH}):
            resolved = Path(r.resolve_node())
        self.assertTrue(resolved.is_absolute())
        self.assertTrue(resolved.samefile(self.LOCAL_NODE), 'GUI PATH 缺失 Node 目录时仍须找到本机安装版')
        self.assertTrue(os.access(resolved, os.X_OK))

    def test_missing_node_has_explicit_error_before_spawning(self):
        with patch('shutil.which', return_value=None), \
             patch.object(Path, 'is_file', return_value=False), \
             patch('os.path.isfile', return_value=False), \
             patch('os.access', return_value=False), \
             patch.object(r.subprocess, 'run', side_effect=AssertionError('缺少运行时时不应启动进程')):
            with self.assertRaisesRegex(ValueError, '找不到 Node.js'):
                r.resolve_node()
            with self.assertRaisesRegex(ValueError, '找不到 Node.js'):
                r.weighted_length('中文')

    def test_non_executable_path_candidate_is_skipped(self):
        with tempfile.TemporaryDirectory() as folder:
            unusable = Path(folder) / 'node'
            unusable.write_text('offline non-executable fixture')
            unusable.chmod(0o600)
            self.assertFalse(os.access(unusable, os.X_OK))
            with patch('shutil.which', return_value=str(unusable)):
                resolved = Path(r.resolve_node())
            self.assertTrue(resolved.samefile(self.LOCAL_NODE))

    def test_real_weighted_length_under_gui_path_uses_twitter_text(self):
        samples = {
            '中文': 4,
            '👩🏽‍💻': 2,
            'https://example.com/very/long/path?source=offline': 23,
            '中文 👩🏽‍💻 https://example.com/very/long/path?source=offline': 31,
        }
        # Execute only the installed local Node.js and twitter-text package.
        # No subprocess here imports the uploader or opens an X session.
        with patch.dict(os.environ, {'PATH': self.GUI_PATH}):
            for body, expected in samples.items():
                with self.subTest(body=body):
                    self.assertEqual(r.weighted_length(body), expected)



class ProgramCheckTest(unittest.TestCase):
    def check(self, body):
        with tempfile.TemporaryDirectory() as folder, patch.object(r, 'check_unchanged', lambda *_: None):
            r.review({'body': body}, Path(folder))
            return json.loads((Path(folder) / 'check.json').read_text())

    def test_clean_body_passes_without_any_model(self):
        self.assertEqual(self.check('在 claude.ai 的设置里领\n\n每个月不结转')['problems'], [])

    def test_leftovers_and_placeholders_block(self):
        for body in ['未配对 ** 加粗', '见 [[笔记]]', '![图](a.png)', '[官方](https://a.b)', '%%备注%%', '数字待补', '']:
            with self.subTest(body=body), self.assertRaises(ValueError):
                self.check(body)


class FollowUpSelectionTest(unittest.TestCase):
    def test_only_due_unchecked_native_schedules_are_selected(self):
        now = datetime.datetime(2026, 10, 9, 4, 0, tzinfo=UTC)
        rows = {
            'due': {'state': 'scheduled', 'verified': True, 'scheduled_for': '2026-10-09T03:00:00+00:00'},
            'future': {'state': 'scheduled', 'verified': True, 'scheduled_for': '2026-10-09T03:58:30+00:00'},
            'recent': {'state': 'scheduled', 'verified': True, 'scheduled_for': '2026-10-09T03:00:00+00:00', 'follow_up_checked_at': '2026-10-09T03:50:00+00:00'},
            'done': {'state': 'published', 'verified': True, 'scheduled_for': '2026-10-09T03:00:00+00:00'},
            'unverified': {'state': 'scheduled', 'verified': False, 'scheduled_for': '2026-10-09T03:00:00+00:00'},
        }
        with tempfile.TemporaryDirectory() as folder, patch.object(r, 'ARCHIVE_RECEIPTS', Path(folder)):
            for name, value in rows.items():
                (Path(folder) / (name + '.json')).write_text(json.dumps(value))
            self.assertEqual([path.stem for path, _, _ in r.due_follow_ups(now)], ['due'])

if __name__ == '__main__':
    unittest.main()
