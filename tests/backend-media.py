"""配图后端的本机隔离验收；不登录 X、不读 cookie、不执行上传。"""
import ast
import asyncio
import importlib.util
import pathlib
import tempfile
import unittest

PROJECT = pathlib.Path(__file__).resolve().parents[1]
BACKEND = PROJECT
UPLOAD = PROJECT / 'upload.py'


def load(name, file):
    spec = importlib.util.spec_from_file_location(name, file)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


runner = load('desk_post_runner_test', BACKEND / 'runner.py')
article = load('desk_article_runner_test', BACKEND / 'article_runner.py')
uploader = load('desk_post_upload_test', UPLOAD)


class ExtractMediaTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory(dir=PROJECT / 'work')
        self.directory = pathlib.Path(self.temporary.name)
        self.vault = self.directory / 'vault'
        self.vault.mkdir()
        self.old_post_vault, self.old_article_vault = runner.VAULT, article.VAULT
        runner.VAULT = article.VAULT = self.vault
        self.note = self.vault / '推特创作/03创作中/test.md'
        self.note.parent.mkdir(parents=True)
        self.attachments = self.vault / '推特创作/附件'
        self.attachments.mkdir()
        (self.attachments / 'a.png').write_bytes(b'PNG fixture')
        (self.attachments / 'b.jpg').write_bytes(b'JPEG fixture')
        (self.attachments / 'moving.gif').write_bytes(b'GIF fixture')

    def tearDown(self):
        runner.VAULT, article.VAULT = self.old_post_vault, self.old_article_vault
        self.temporary.cleanup()

    def prepare_article(self, body):
        raw = '---\ntitle: 测试文章\nstatus: writing\ndelivery_ready: true\n---\n\n' + body
        self.note.write_text(raw)
        return article.prepare({'note_path': str(self.note), 'markdown': raw})

    def test_text_and_internal_line_breaks_unchanged(self):
        self.assertEqual(runner.extract_media('**第一段**\n\n第二段', self.note), ('**第一段**\n\n第二段', []))

    def test_trailing_order_and_display_alias(self):
        text, images = runner.extract_media('**正文**\n\n![[ a.png |320]]\n\n![[b.jpg]]\n', self.note)
        self.assertEqual(text, '**正文**')
        self.assertEqual(images, [(self.attachments / 'a.png').resolve(), (self.attachments / 'b.jpg').resolve()])

    def test_non_trailing_embed_is_not_silently_removed(self):
        self.assertIn('![[a.png]]', runner.extract_media('![[a.png]]\n仍有正文', self.note)[0])

    def test_basename_duplicates_rejected_even_when_attachments_match(self):
        other = self.vault / '另一文件夹'
        other.mkdir()
        (other / 'a.png').write_bytes(b'another image')
        with self.assertRaisesRegex(ValueError, '同名不唯一'):
            runner.extract_media('正文\n![[a.png]]', self.note)
        with self.assertRaisesRegex(ValueError, '同名不唯一'):
            self.prepare_article('正文\n![[a.png]]')

    def test_explicit_vault_path_is_unambiguous(self):
        other = self.vault / '另一文件夹'
        other.mkdir()
        (other / 'a.png').write_bytes(b'another image')
        _, images = runner.extract_media('正文\n![[推特创作/附件/a.png]]', self.note)
        self.assertEqual(images, [(self.attachments / 'a.png').resolve()])

    def test_hidden_plugin_assets_do_not_create_false_basename_ambiguity(self):
        hidden = self.vault / '.obsidian/plugins/test'
        hidden.mkdir(parents=True)
        (hidden / 'a.png').write_bytes(b'plugin asset')
        _, images = runner.extract_media('正文\n![[a.png]]', self.note)
        self.assertEqual(len(images), 1)

    def test_absolute_parent_escape_and_external_symlink_rejected(self):
        for reference in ('../a.png', '/a.png'):
            with self.assertRaises(ValueError):
                runner.extract_media('正文\n![[%s]]' % reference, self.note)
            with self.assertRaises(ValueError):
                self.prepare_article('正文\n![[%s]]' % reference)
        outside = self.directory / 'outside.png'
        outside.write_bytes(b'outside vault')
        (self.attachments / 'a.png').unlink()
        (self.attachments / 'a.png').symlink_to(outside)
        with self.assertRaises(ValueError):
            runner.extract_media('正文\n![[a.png]]', self.note)
        with self.assertRaises(ValueError):
            self.prepare_article('正文\n![[a.png]]')

    def test_count_format_mixed_motion_and_size_constraints(self):
        for body in ('正文\n' + '\n'.join(['![[a.png]]'] * 5), '正文\n![[a.png]]\n![[moving.gif]]'):
            with self.assertRaises(ValueError):
                runner.extract_media(body, self.note)
        (self.attachments / 'unknown.svg').write_text('<svg/>')
        with self.assertRaises(ValueError):
            runner.extract_media('正文\n![[unknown.svg]]', self.note)
        with (self.attachments / 'a.png').open('wb') as file:
            file.truncate(5 * 1024 * 1024 + 1)
        with self.assertRaisesRegex(ValueError, '5MB'):
            runner.extract_media('正文\n![[a.png]]', self.note)
        with (self.attachments / 'moving.gif').open('wb') as file:
            file.truncate(15 * 1024 * 1024 + 1)
        with self.assertRaisesRegex(ValueError, '15MB'):
            runner.extract_media('正文\n![[moving.gif]]', self.note)

    def test_article_image_conversion_preserves_position_and_title(self):
        _, title, source = self.prepare_article('# 测试文章\n\n![[a.png]]\n\n段落\n\n![[b.jpg]]')
        self.assertEqual(title, '测试文章')
        self.assertEqual(source, '![](%s)\n\n段落\n\n![](%s)' % ((self.attachments / 'a.png').resolve(), (self.attachments / 'b.jpg').resolve()))

    def test_article_non_media_wikilinks_still_rejected(self):
        with self.assertRaisesRegex(ValueError, '双链'):
            self.prepare_article('正文 [[其他笔记]]')


class FakeLocator:
    def __init__(self, counts, name='dialog'):
        self.counts, self.name = counts, name
        self.last = self

    def locator(self, name):
        return FakeLocator(self.counts, name)

    async def count(self):
        if ',' in self.name:
            return sum(self.counts.get(name.strip(), 0) for name in self.name.split(','))
        return self.counts.get(self.name, 0)


class MediaPersistenceContractTests(unittest.IsolatedAsyncioTestCase):
    async def test_attachment_remove_buttons_are_primary_count(self):
        page = FakeLocator({'[data-testid="attachments"]': 1, '[data-testid="removeMedia"]': 2, 'img': 8})
        self.assertEqual(await uploader.media_count(page), 2)

    async def test_quote_images_and_avatars_without_body_media_are_zero(self):
        self.assertEqual(await uploader.media_count(FakeLocator({'img': 3})), 0)
        self.assertEqual(await uploader.media_count(FakeLocator({'[data-testid="attachments"]': 1, 'img': 2})), 0)
        self.assertEqual(await uploader.media_count(FakeLocator({'[data-testid="attachments"]': 1, 'video': 1})), 0)

    async def test_same_count_is_the_documented_contract_mismatch_cannot_succeed(self):
        page = FakeLocator({'[data-testid="attachments"]': 1, '[data-testid="removeMedia"]': 1})
        self.assertIsNone(await uploader.verify_media(page, 1))
        with self.assertRaisesRegex(RuntimeError, '应有 2，实际 1'):
            await uploader.verify_media(page, 2)


class RealDOMMediaBoundaryTests(unittest.IsolatedAsyncioTestCase):
    """Actual DOM selectors in a blank local browser, no X login or requests."""
    async def asyncSetUp(self):
        self.playwright = await uploader.async_playwright().start()
        self.browser = await self.playwright.chromium.launch(headless=True)
        self.context = await self.browser.new_context()
        await self.context.route('**/*', lambda route: route.abort())
        self.page = await self.context.new_page()

    async def set_content(self, markup):
        await self.page.set_content('<style>[role="progressbar"]{width:100px;height:4px}</style>' + markup)

    async def asyncTearDown(self):
        await self.context.close()
        await self.browser.close()
        await self.playwright.stop()

    async def test_reference_card_avatar_and_photos_are_not_body_media(self):
        await self.set_content('''<div role="dialog"><div data-testid="attachments">
          <button role="button"><div data-testid="Tweet-User-Avatar"><div data-testid="UserAvatar-Container-author"><img alt="avatar"></div></div>
          <div data-testid="tweetText">被引用正文</div><div data-testid="tweetPhoto"><img alt="quote photo 1"><img alt="quote photo 2"></div>
          <video aria-label="quoted video"></video></button></div></div>''')
        self.assertEqual(await self.page.locator('img').count(), 3)
        self.assertEqual(await uploader.media_count(self.page), 0)
        self.assertIsNone(await uploader.verify_media(self.page, 0))

    async def test_composer_media_count_excludes_quote_and_other_dialog_media(self):
        await self.set_content('''<img alt="page avatar">
          <div role="dialog"><div data-testid="attachments"><button data-testid="removeMedia">old dialog media</button></div></div>
          <div role="dialog"><div data-testid="attachments">
            <div><img alt="body media 1"><button data-testid="removeMedia">remove 1</button></div>
            <div><img alt="body media 2"><button data-testid="removeMedia">remove 2</button></div>
          </div><div data-testid="attachments"><button role="button"><div data-testid="Tweet-User-Avatar"><img alt="quote avatar"></div>
            <div data-testid="tweetPhoto"><img alt="quote photo"></div></button></div></div>''')
        self.assertEqual(await uploader.media_count(self.page), 2)
        self.assertIsNone(await uploader.verify_media(self.page, 2))
        with self.assertRaisesRegex(RuntimeError, '应有 0，实际 2'):
            await uploader.verify_media(self.page, 0)

    async def test_current_remove_media_buttons_are_counted(self):
        await self.set_content('''<div role="dialog"><div data-testid="attachments">
          <div><img alt="body photo"><button aria-label="Remove media">remove photo</button></div>
          <div><video></video><button aria-label="Remove media">remove video</button></div>
          <button role="button"><img alt="quote avatar"><img alt="quote photo"></button>
          </div></div>''')
        self.assertEqual(await uploader.media_count(self.page), 2)
        self.assertIsNone(await uploader.verify_media(self.page, 2))

    async def test_legacy_and_current_controls_are_combined_without_double_counting(self):
        await self.set_content('''<button aria-label="Remove media">outside composer</button>
          <div role="dialog"><div data-testid="attachments"><button aria-label="Remove media">previous dialog</button></div></div>
          <div role="dialog"><div data-testid="attachments">
            <button data-testid="removeMedia">legacy control</button>
            <button aria-label="Remove media">current control</button>
            <button data-testid="removeMedia" aria-label="Remove media">both attributes</button>
            <button role="button"><img alt="quote avatar"><img alt="quote photo"></button>
          </div><button aria-label="Remove media">outside attachment region</button></div>''')
        self.assertEqual(await uploader.media_count(self.page), 3)

    async def test_video_counts_single_remove_control_not_its_thumbnail(self):
        await self.set_content('''<div role="dialog"><div data-testid="attachments">
          <div><video></video><img alt="video thumbnail"><button data-testid="removeMedia">remove video</button></div>
          <button role="button"><img alt="quote avatar"><img alt="quote photo"></button>
          </div></div>''')
        self.assertEqual(await uploader.media_count(self.page), 1)

    async def test_character_counters_idle_top_bar_and_hidden_progress_do_not_block(self):
        await self.set_content('''<div role="dialog"><div data-testid="attachments">
          <button aria-label="Remove media">remove photo</button>
          <div role="progressbar" style="display:none" aria-valuenow="50"></div></div>
          <div data-testid="dual-phase-countdown-circle"><div role="progressbar" aria-valuenow="40"></div></div>
          <div data-testid="countdown-circle"><div role="progressbar" aria-valuenow="60"></div></div>
          <div data-viewportview="true"><div role="progressbar" aria-valuemax="100" aria-valuenow="0">
            <div data-testid="progressBar-bar" style="width:0%"></div></div></div>
          <div role="progressbar" style="visibility:hidden" aria-valuenow="80"></div>
          <button data-testid="tweetButton">Post</button></div>''')
        self.assertTrue(await uploader.media_ready(self.page, 1))

    async def test_visible_upload_progress_blocks_media_readiness(self):
        for progress in (
            '<div data-viewportview="true"><div role="progressbar" aria-valuemax="100" aria-valuenow="25"><div data-testid="progressBar-bar" style="width:25%"></div></div></div>',
            '<div data-viewportview="true"><div role="progressbar" aria-valuemax="100"><div data-testid="progressBar-bar" style="width:0%"></div></div></div>',
            '<div role="progressbar" aria-valuenow="0"></div>',
            '<div role="progressbar" aria-valuenow="100"></div>',
        ):
            with self.subTest(progress=progress):
                await self.set_content('''<div role="dialog"><div data-testid="attachments">
                  <button aria-label="Remove media">remove photo</button></div>
                  %s<button data-testid="tweetButton">Post</button></div>''' % progress)
                self.assertFalse(await uploader.media_ready(self.page, 1))

    async def test_idle_strip_needs_all_observed_identifiers(self):
        for progress in (
            '<div><div role="progressbar" aria-valuemax="100" aria-valuenow="0"><div data-testid="progressBar-bar" style="width:0%"></div></div></div>',
            '<div data-viewportview="true"><div role="progressbar" aria-valuemax="100" aria-valuenow="0"></div></div>',
            '<div data-viewportview="true"><div role="progressbar" aria-valuemax="100" aria-valuenow="0"><div data-testid="progressBar-bar" style="width:10%"></div></div></div>',
            '<div data-viewportview="true"><div role="progressbar" aria-valuenow="0"><div data-testid="progressBar-bar" style="width:0%"></div></div></div>',
            '<div data-viewportview="true"><div role="progressbar" aria-valuemax="100"><div data-testid="progressBar-bar" style="width:0%"></div></div></div>',
            '<div data-viewportview="true"><div><div role="progressbar" aria-valuemax="100" aria-valuenow="0"><div data-testid="progressBar-bar" style="width:0%"></div></div></div></div>',
            '<div data-viewportview="true"><div role="progressbar" aria-valuemax="100" aria-valuenow="0"><div><div data-testid="progressBar-bar" style="width:0%"></div></div></div></div>',
        ):
            with self.subTest(progress=progress):
                await self.set_content('''<div role="dialog"><div data-testid="attachments">
                  <button aria-label="Remove media">remove photo</button></div>
                  %s<button data-testid="tweetButton">Post</button></div>''' % progress)
                self.assertFalse(await uploader.media_ready(self.page, 1))

    async def test_attachment_progress_is_upload_even_when_its_value_is_zero(self):
        for progress in (
            '<div role="progressbar" aria-valuenow="0"></div>',
            '<div data-viewportview="true"><div role="progressbar" aria-valuemax="100" aria-valuenow="0"><div data-testid="progressBar-bar" style="width:0%"></div></div></div>',
        ):
            with self.subTest(progress=progress):
                await self.set_content('''<div role="dialog"><div data-testid="attachments">
                  <button aria-label="Remove media">remove photo</button>%s</div>
                  <button data-testid="tweetButton">Post</button></div>''' % progress)
                self.assertFalse(await uploader.media_ready(self.page, 1))

    async def test_disabled_or_missing_post_button_and_count_mismatch_block(self):
        for button in ('<button data-testid="tweetButton" disabled>Post</button>',
                       '<button data-testid="tweetButton" aria-disabled="true">Post</button>', ''):
            with self.subTest(button=button):
                await self.set_content('''<div role="dialog"><div data-testid="attachments">
                  <button aria-label="Remove media">remove photo</button></div>%s</div>''' % button)
                self.assertFalse(await uploader.media_ready(self.page, 1))
        await self.set_content('''<div role="dialog"><div data-testid="attachments">
          <button aria-label="Remove media">remove photo</button></div>
          <button data-testid="tweetButton">Post</button></div>''')
        self.assertFalse(await uploader.media_ready(self.page, 2))

    async def test_readiness_uses_last_dialog(self):
        await self.set_content('''<div role="dialog"><div role="progressbar" aria-valuenow="50"></div>
          <button data-testid="tweetButton" disabled>Post</button></div>
          <div role="dialog"><div data-testid="attachments"><button aria-label="Remove media">remove photo</button></div>
          <button data-testid="tweetButton">Post</button></div>''')
        self.assertTrue(await uploader.media_ready(self.page, 1))


class RestrictedChangeAudit(unittest.TestCase):
    @unittest.skipUnless((PROJECT / 'work/第二版后端备份/upload.py').exists(), 'local backup not in the public repo')
    def test_public_request_guard_and_all_non_media_uploader_functions_unchanged(self):
        backup = ast.parse((PROJECT / 'work/第二版后端备份/upload.py').read_text())
        current = ast.parse(UPLOAD.read_text())
        old = {node.name: node for node in backup.body if isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef))}
        new = {node.name: node for node in current.body if isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef))}
        # context() now reads cookies through load_cookies() (config + extension exports).
        allowed = {'find_draft', 'upload', 'context'}
        self.assertEqual(set(new) - set(old), {'media_count', 'media_ready', 'verify_media', 'attach_media', 'load_cookies'})
        for name in old.keys() - allowed:
            self.assertEqual(ast.dump(new[name], include_attributes=False), ast.dump(old[name], include_attributes=False), name)
        # Module-level settings now come from config.json; the public-post guard must stay.
        source = UPLOAD.read_text()
        self.assertIn("'/createtweet','/createnotetweet','/statuses/update'", source)
        self.assertIn('Blocked public posting request', source)


if __name__ == '__main__':
    unittest.main()
