"""Program check before saving a draft or sending a post (replaced the Codex review on 2026-10-08)."""
import re

# Leftovers that would be posted verbatim; length, account, quote and media are
# enforced elsewhere, and the X-side readback checks the final result.
LEFTOVERS = [('**', '加粗符号没配对'), ('[[', '双链 [[ ]] 没转换'), ('![', '图片语法 ![ ] 留在正文里'),
             ('](', 'Markdown 链接 [文字](网址) 留在正文里'), ('%%', 'Obsidian 注释 %% 留在正文里'),
             ('<!--', 'HTML 注释留在正文里')]
PLACEHOLDER = re.compile(r'TODO|TBD|待补|待填|待核实|占位')


def body_problems(body):
    """Problems in the plain text (bold markers already converted) that should block sending."""
    problems = [] if body.strip() else ['正文为空']
    problems += [reason for mark, reason in LEFTOVERS if mark in body]
    problems += ['正文里有占位字「%s」' % hit for hit in dict.fromkeys(PLACEHOLDER.findall(body))]
    return problems
