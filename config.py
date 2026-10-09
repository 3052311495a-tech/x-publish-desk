"""Shared settings for every backend entry (plugin, CLI). Edited from the plugin's settings tab.

config.json lives next to this file and is never committed; see config.example.json.
"""
import json
from pathlib import Path

ROOT = Path(__file__).resolve().parent
FILE = ROOT / 'config.json'
DEFAULTS = {
    'vault': '',                      # absolute path of the Obsidian vault
    'drafts': '推特创作/03创作中',      # posts ready to save / publish
    'published': '推特创作/04已发布',   # verified posts are moved here
    'articles': '推特创作/05长文',      # X Articles (long-form)
    'attachments': '推特创作/附件',
    'excluded': ['推特创作/03创作中/评论'],
    'account': '',                    # X handle the cookies belong to, e.g. @name
    'display_name': '',
    'cookies': '',                    # cookie JSON exported from a logged-in browser
    'require_ready_fields': False,    # require status: writing / delivery_ready: true / expires_at
    'state_dir': 'state',             # receipts, ledger, evidence (relative to this folder)
    'article_uploader': '',           # optional, see README
    'style_check': [],                # optional command, reads the body on stdin
    'revision_learning': '',          # optional script path
    'revision_log_note': '',
    'default_time_zone': 'Asia/Shanghai',
}


def load():
    value = dict(DEFAULTS)
    if FILE.exists():
        value.update(json.loads(FILE.read_text(encoding='utf-8')))
    return value


CONFIG = load()


def require(*names):
    missing = [name for name in names if not CONFIG.get(name)]
    if missing:
        raise ValueError('请先在 X 发布台设置里填写：' + '、'.join(missing))


def vault():
    require('vault')
    return Path(CONFIG['vault']).expanduser()


def folder(name):
    return vault() / CONFIG[name]


def excluded(path):
    return any(Path(path).resolve().is_relative_to((vault() / item).resolve()) for item in CONFIG['excluded'])


def state_dir():
    path = Path(CONFIG['state_dir']).expanduser()
    return path if path.is_absolute() else ROOT / path
