#!/usr/bin/env python3
"""Convert MDX documentation files to HTML."""
import re, os, html as htmlmod

BASE_DIR = os.path.dirname(os.path.abspath(__file__))

# ── CSS (from entry-summary.html + additional) ─────────────────
MAIN_CSS = ""
ref_path = os.path.join(os.path.dirname(BASE_DIR), '[1]entry-summary', 'entry-summary.html')
with open(ref_path, 'r', encoding='utf-8') as f:
    ref_lines = f.readlines()
# Extract lines 8-455 (the CSS inside <style> tags)
in_style = False
for line in ref_lines:
    if '<style>' in line:
        in_style = True
        continue
    if '</style>' in line:
        break
    if in_style:
        MAIN_CSS += line

ADDITIONAL_CSS = """
    /* === Additional styles === */
    blockquote.callout {
      background: var(--bg2);
      border-left: 4px solid var(--orange);
      padding: 14px 20px;
      border-radius: 0 var(--radius) var(--radius) 0;
      margin: 16px 0;
      color: var(--text-2);
    }
    blockquote.callout strong { color: var(--text); font-weight: 700; }
    .mermaid-wrap {
      background: #fff;
      border: 1px solid var(--border);
      border-radius: var(--radius-lg);
      padding: 24px;
      margin: 16px 0;
      overflow-x: auto;
    }
    .checklist { list-style: none; padding-left: 0; }
    .checklist li { display: flex; align-items: flex-start; gap: 10px; padding: 5px 0; color: var(--text-2); }
    .checklist input[type="checkbox"] { margin-top: 3px; flex-shrink: 0; accent-color: var(--orange); }
    .back-link {
      display: inline-flex; align-items: center; gap: 6px;
      margin-top: 48px; padding: 8px 18px;
      background: var(--bg2); border: 1.5px solid var(--border);
      border-radius: var(--radius); font-size: .85rem; font-weight: 600;
      color: var(--text-2); text-decoration: none;
      transition: border-color .15s, color .15s;
    }
    .back-link:hover { border-color: var(--orange); color: var(--orange-dk); text-decoration: none; }
    h4 { font-size: .95rem; font-weight: 600; color: var(--text); margin: 16px 0 8px; }
    ul, ol { padding-left: 22px; color: var(--text-2); margin-bottom: 10px; }
    li { margin-bottom: 4px; line-height: 1.6; }
    li > ul, li > ol { margin-top: 4px; margin-bottom: 2px; }
    strong { color: var(--text); font-weight: 700; }
    em { font-style: italic; }
"""


def heading_to_id(text):
    """Convert heading text to HTML-safe id."""
    text = re.sub(r'[`*_]', '', text)
    text = re.sub(r'\[([^\]]+)\]\([^)]+\)', r'\1', text)  # remove link markup
    text = re.sub(r'[^\w\s一-鿿-]', '', text)
    text = re.sub(r'\s+', '-', text.strip())
    return text.lower()


def inline(text):
    """Convert inline markdown to HTML."""
    # Process code spans first to protect their content
    parts = []
    last = 0
    for m in re.finditer(r'`([^`]+)`', text):
        before = text[last:m.start()]
        parts.append(inline_no_code(before))
        parts.append(f'<code>{htmlmod.escape(m.group(1))}</code>')
        last = m.end()
    parts.append(inline_no_code(text[last:]))
    return ''.join(parts)


def inline_no_code(text):
    """Inline markdown without code spans."""
    # Links
    def link_r(m):
        t, u = m.group(1), m.group(2)
        u = re.sub(r'\.mdx$', '.html', u)
        return f'<a href="{u}">{t}</a>'
    text = re.sub(r'\[([^\]]+)\]\(([^)]+)\)', link_r, text)
    # Bold **text**
    text = re.sub(r'\*\*(.+?)\*\*', r'<strong>\1</strong>', text)
    # Italic *text*
    text = re.sub(r'(?<!\*)\*(?!\*)(.+?)(?<!\*)\*(?!\*)', r'<em>\1</em>', text)
    return text


def render_body(body_lines):
    """Convert body lines to HTML."""
    out = []
    i = 0
    first_bq = True

    while i < len(body_lines):
        line = body_lines[i]

        # ── Code blocks ──
        if line.startswith('```'):
            lang = line[3:].strip()
            code = []
            i += 1
            while i < len(body_lines) and not body_lines[i].startswith('```'):
                code.append(body_lines[i])
                i += 1
            i += 1  # skip closing ```
            ct = htmlmod.escape('\n'.join(code))
            if lang == 'mermaid':
                out.append(f'<div class="mermaid-wrap">\n  <div class="mermaid">\n{ct}\n  </div>\n</div>')
            else:
                out.append(f'<pre><code>{ct}</code></pre>')
            continue

        # ── HR ──
        if line.strip() == '---':
            out.append('<hr class="divider">')
            i += 1
            continue

        # ── Tables ──
        if re.match(r'^\|', line.strip()):
            tlines = []
            while i < len(body_lines) and re.match(r'^\|', body_lines[i].strip()):
                tlines.append(body_lines[i])
                i += 1
            if len(tlines) >= 3:
                out.append('<div class="table-wrap">')
                out.append('  <table>')
                hdr = [c.strip() for c in tlines[0].strip().strip('|').split('|')]
                ths = ''.join(f'<th>{inline(c)}</th>' for c in hdr)
                out.append(f'    <thead><tr>{ths}</tr></thead>')
                out.append('    <tbody>')
                for tl in tlines[2:]:
                    cells = [c.strip() for c in tl.strip().strip('|').split('|')]
                    tds = ''.join(f'<td>{inline(c)}</td>' for c in cells)
                    out.append(f'    <tr>{tds}</tr>')
                out.append('    </tbody>')
                out.append('  </table>')
                out.append('</div>')
            continue

        # ── Blockquotes ──
        if line.startswith('> ') or line == '>':
            bqlines = []
            while i < len(body_lines) and (body_lines[i].startswith('> ') or body_lines[i] == '>'):
                bqlines.append(body_lines[i][2:] if body_lines[i].startswith('> ') else '')
                i += 1
            bqt = ' '.join(bqlines)
            if first_bq:
                out.append(f'<blockquote class="callout"><p>{inline(bqt)}</p></blockquote>')
                first_bq = False
            else:
                out.append(f'<blockquote><p>{inline(bqt)}</p></blockquote>')
            continue

        # ── Checkboxes ──
        if re.match(r'^- \[([ x])\]', line):
            items = []
            while i < len(body_lines):
                m = re.match(r'^- \[([ x])\]\s+(.*)', body_lines[i])
                if not m:
                    break
                chk = ' checked' if m.group(1) == 'x' else ''
                items.append(f'<li><input type="checkbox"{chk} disabled> <span>{inline(m.group(2))}</span></li>')
                i += 1
            out.append(f'<ul class="checklist">{"".join(items)}</ul>')
            continue

        # ── Unordered list ──
        if re.match(r'^- ', line):
            items = []
            while i < len(body_lines) and re.match(r'^- ', body_lines[i]):
                text = body_lines[i][2:]
                items.append(f'<li>{inline(text)}</li>')
                i += 1
            out.append(f'<ul>{"".join(items)}</ul>')
            continue

        # ── Ordered list ──
        if re.match(r'^\d+\.\s', line):
            items = []
            while i < len(body_lines) and re.match(r'^\d+\.\s', body_lines[i]):
                text = re.sub(r'^\d+\.\s+', '', body_lines[i])
                items.append(f'<li>{inline(text)}</li>')
                i += 1
            out.append(f'<ol>{"".join(items)}</ol>')
            continue

        # ── Sub-headings (### or ####) ──
        hm = re.match(r'^(#{3,4})\s+(.*)', line)
        if hm:
            lvl = len(hm.group(1))
            txt = hm.group(2).strip()
            out.append(f'<h{lvl}>{inline(txt)}</h{lvl}>')
            i += 1
            continue

        # ── Empty line ──
        if line.strip() == '':
            i += 1
            continue

        # ── Paragraph ──
        plines = [line]
        i += 1
        while i < len(body_lines):
            nl = body_lines[i]
            if nl.strip() == '' or nl.startswith('#') or nl.startswith('```') or \
               nl.startswith('> ') or nl.startswith('- ') or \
               re.match(r'^\d+\.\s', nl) or re.match(r'^\|', nl.strip()) or \
               nl.strip() == '---':
                break
            plines.append(nl)
            i += 1
        out.append(f'<p>{inline(" ".join(plines))}</p>')

    return '\n'.join(out)


def build_html(title, description, h2_sections):
    """Build the full HTML document."""
    nav = ['<li><a href="index.html">← 返回工具总览</a></li>']
    sections = []

    for h2_text, body in h2_sections:
        sid = heading_to_id(h2_text)
        nav.append(f'<li><a href="#{sid}">{h2_text}</a></li>')
        body_html = render_body(body)
        sections.append(f'<section id="{sid}">\n<h2>{inline(h2_text)}</h2>\n{body_html}\n</section>')

    nav_html = '\n    '.join(nav)
    sections_html = '\n\n  '.join(sections)

    return f"""<!DOCTYPE html>
<html lang="zh-CN">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>{htmlmod.escape(title)} — Claude Code 工具详解</title>
  <style>{MAIN_CSS}{ADDITIONAL_CSS}
    section {{ margin-top: 56px; }}
  </style>
</head>
<body>

<header class="hero">
  <div class="hero-badge">工具系统 · 工具详解</div>
  <h1>{htmlmod.escape(title)}</h1>
  <p>{htmlmod.escape(description)}</p>
  <ul class="nav-links">
    {nav_html}
  </ul>
</header>

<div class="page-wrap">
  {sections_html}
  <a href="index.html" class="back-link">← 返回工具总览</a>
</div>

<script src="https://cdn.jsdelivr.net/npm/mermaid@10/dist/mermaid.min.js"></script>
<script>mermaid.initialize({{ startOnLoad: true, theme: 'neutral' }});</script>
</body>
</html>"""


def process_file(mdx_path):
    """Convert one MDX file to HTML."""
    with open(mdx_path, 'r', encoding='utf-8') as f:
        content = f.read()

    lines = content.split('\n')

    # Extract frontmatter
    title = description = ''
    ci = 0
    if lines and lines[0].strip() == '---':
        for j in range(1, len(lines)):
            if lines[j].strip() == '---':
                ci = j + 1
                break
            if lines[j].startswith('title:'):
                title = lines[j][6:].strip().strip('"').strip("'")
            elif lines[j].startswith('description:'):
                description = lines[j][12:].strip().strip('"').strip("'")

    # Skip first # heading
    body_lines = lines[ci:]
    if body_lines and body_lines[0].startswith('# '):
        body_lines = body_lines[1:]

    # Split by ## headings
    h2_sections = []
    cur_h2 = None
    cur_body = []
    for bl in body_lines:
        m = re.match(r'^##\s+(.*)', bl)
        if m:
            if cur_h2 is not None or cur_body:
                h2_sections.append((cur_h2, cur_body))
            cur_h2 = m.group(1).strip()
            cur_body = []
        else:
            cur_body.append(bl)
    if cur_h2 is not None or cur_body:
        h2_sections.append((cur_h2, cur_body))

    # Filter out None h2 (content before first ##)
    pre_content = []
    real_sections = []
    for h2t, h2b in h2_sections:
        if h2t is None:
            pre_content = h2b
        else:
            real_sections.append((h2t, h2b))

    # If there's content before first ## and no ## sections, wrap it
    if not real_sections and pre_content:
        real_sections = [(title, pre_content)]

    html_doc = build_html(title, description, real_sections)

    html_path = mdx_path.rsplit('.', 1)[0] + '.html'
    with open(html_path, 'w', encoding='utf-8') as f:
        f.write(html_doc)
    print(f"OK: {os.path.basename(mdx_path)} -> {os.path.basename(html_path)}")


if __name__ == '__main__':
    files = [
        'PowerShellTool.mdx', 'PushNotificationTool.mdx',
        'ReadMcpResourceTool.mdx', 'SearchExtraToolsTool.mdx',
        'SendMessageTool.mdx', 'SendUserFileTool.mdx',
        'SkillTool.mdx', 'SleepTool.mdx',
        'SnipTool.mdx', 'SubscribePRTool.mdx',
        'SuggestBackgroundPRTool.mdx', 'SyntheticOutputTool.mdx',
    ]
    for f in files:
        p = os.path.join(BASE_DIR, f)
        if os.path.exists(p):
            process_file(p)
        else:
            print(f"NOT FOUND: {f}")
