"""Offline checks for the chat publishing entry; no browser or network."""
import hashlib, importlib.util, json, sys, tempfile, unittest
from pathlib import Path
from unittest.mock import patch

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))
spec = importlib.util.spec_from_file_location('publish_under_test', ROOT / 'publish.py')
p = importlib.util.module_from_spec(spec)
spec.loader.exec_module(p)


class PublishCliTest(unittest.TestCase):
    def test_confirm_code_binds_note_action_and_time(self):
        base = {'note_path': '/a.md', 'markdown': '正文', 'action': 'schedule', 'scheduledFor': '2026-10-10T01:00:00Z'}
        code = p.confirm_code(base)
        for change in ({'markdown': '正文2'}, {'action': 'publish'}, {'scheduledFor': '2026-10-10T01:01:00Z'}):
            self.assertNotEqual(p.confirm_code({**base, **change}), code)

    def test_due_time_uses_the_named_zone(self):
        self.assertEqual(p.due_time('2026-10-10 09:00', 'Asia/Shanghai'), '2026-10-10T01:00:00Z')
        with self.assertRaises(ValueError):
            p.due_time('2027-03-14 02:30', 'America/Los_Angeles')

    def test_archive_moves_note_and_writes_plugin_receipt(self):
        with tempfile.TemporaryDirectory() as folder:
            vault = Path(folder) / 'vault'; source = vault / '推特创作/03创作中'; source.mkdir(parents=True)
            receipts = Path(folder) / 'receipts'; receipts.mkdir()
            note = source / '稿.md'; note.write_text('内容')
            (vault / '推特创作/04已发布').mkdir(parents=True); (vault / '推特创作/04已发布/稿.md').write_text('旧')
            with patch.object(p.r, 'VAULT', vault), patch.object(p.r, 'ARCHIVE_RECEIPTS', receipts), \
                    patch.object(p, 'DESTINATION', vault / '推特创作/04已发布'):
                relative = p.archive(note, '内容', {'verified': True, 'state': 'published'}, 'publish', 'Asia/Shanghai')
            self.assertEqual(relative, '推特创作/04已发布/稿（2）.md')
            self.assertFalse(note.exists())
            receipt = json.loads((receipts / (hashlib.sha256(relative.encode()).hexdigest() + '.json')).read_text())
            self.assertEqual((receipt['archived_path'], receipt['archive_note_sha256']), (relative, hashlib.sha256('内容'.encode()).hexdigest()))


if __name__ == '__main__':
    unittest.main()
