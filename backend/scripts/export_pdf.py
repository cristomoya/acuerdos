#!/usr/bin/env python3
"""
export_pdf.py — Markdown → HTML → PDF
Usa WeasyPrint para generar PDF con maquetación institucional.
Soporta diagramas Mermaid pre-renderizados como imágenes PNG base64.
"""

import sys, json, re, os, base64
from markdown_it import MarkdownIt
from bs4 import BeautifulSoup, NavigableString, Tag
from weasyprint import HTML, CSS

FIELD_RE = re.compile(r'\{\{[A-Z0-9_]+\}\}')
TASK_ITEM_RE = re.compile(r'^\[([ xX])\]\s*')

HTML_TEMPLATE = """<!DOCTYPE html>
<html lang="es">
<head>
<meta charset="UTF-8">
<style>
@page {
  size: A4;
  margin: 2.5cm 3cm;
  @bottom-center {
    content: counter(page) " / " counter(pages);
    font-size: 9pt;
    color: #666;
  }
}
body {
  font-family: 'Segoe UI', 'Helvetica Neue', Arial, sans-serif;
  font-size: 11pt;
  line-height: 1.7;
  color: #1a1a18;
}
h1 {
  font-size: 14pt;
  font-weight: 700;
  text-align: center;
  margin-bottom: 1cm;
  margin-top: 0.5cm;
}
h2 {
  font-size: 12pt;
  font-weight: 700;
  margin-top: 0.8cm;
  margin-bottom: 0.4cm;
}
h3 {
  font-size: 11pt;
  font-weight: 700;
  margin-top: 0.6cm;
  margin-bottom: 0.3cm;
}
p {
  text-align: justify;
  text-indent: 1.2cm;
  margin-bottom: 0.3cm;
  margin-top: 0;
}
ul, ol {
  margin-left: 0.5cm;
  margin-bottom: 0.3cm;
}
li {
  margin-bottom: 0.15cm;
}
li.task-item {
  list-style: none;
  margin-left: -1.2cm;
}
blockquote {
  font-style: italic;
  border-left: 3px solid #ccc;
  padding-left: 0.5cm;
  margin-left: 0.5cm;
  margin-right: 0.5cm;
  color: #444;
}
code {
  font-family: 'Courier New', monospace;
  font-size: 10pt;
  background: #f5f5f5;
  padding: 0.05cm 0.15cm;
  border-radius: 2pt;
}
pre {
  background: #f5f5f5;
  padding: 0.4cm;
  border-radius: 3pt;
  overflow-x: auto;
  font-size: 10pt;
}
pre code {
  background: transparent;
  padding: 0;
}
table {
  width: 100%;
  border-collapse: collapse;
  margin-bottom: 0.4cm;
  font-size: 10pt;
}
th, td {
  border: 0.5pt solid #999;
  padding: 0.2cm 0.3cm;
  text-align: left;
}
th {
  background: #f0f0f0;
  font-weight: 600;
}
hr {
  border: none;
  border-top: 0.5pt solid #999;
  margin: 0.5cm 0;
}
.field-marker {
  color: #0000CC;
  background: #FFFF99;
  padding: 0.05cm 0.1cm;
  border-radius: 2pt;
  font-family: monospace;
  font-size: 10pt;
}
.header-inst {
  text-align: center;
  font-size: 10pt;
  color: #555;
  margin-bottom: 0.3cm;
  border-bottom: 0.5pt solid #ccc;
  padding-bottom: 0.2cm;
}
.diagram-block {
  text-align: center;
  margin: 0.5cm 0;
  page-break-inside: avoid;
}
.diagram-block img {
  max-width: 15cm;
  height: auto;
  display: block;
  margin: 0 auto;
  border: 0.5pt solid #ddd;
  border-radius: 4pt;
  padding: 0.3cm;
  background: #fff;
}
.diagram-missing {
  text-align: center;
  color: #888;
  font-style: italic;
  font-size: 10pt;
  padding: 0.5cm;
  border: 0.5pt dashed #ccc;
  border-radius: 4pt;
  margin: 0.5cm 0;
}
</style>
</head>
<body>
<div class="header-inst">{{HEADER}}</div>
{{BODY}}
</body>
</html>
"""

def _add_fields_html(text):
    last = 0
    parts = []
    for m in FIELD_RE.finditer(text):
        if m.start() > last:
            parts.append(text[last:m.start()])
        parts.append(f'<span class="field-marker">{m.group(0)}</span>')
        last = m.end()
    if last < len(text):
        parts.append(text[last:])
    return ''.join(parts)


def _inline_html(node, bold=False, italic=False, underline=False, strike=False, code=False):
    if isinstance(node, NavigableString):
        text = str(node)
        if not text:
            return ''
        if code:
            return f'<code>{_add_fields_html(text)}</code>'
        if bold and italic:
            return f'<strong><em>{_add_fields_html(text)}</em></strong>'
        if bold:
            return f'<strong>{_add_fields_html(text)}</strong>'
        if italic:
            return f'<em>{_add_fields_html(text)}</em>'
        if underline:
            return f'<u>{_add_fields_html(text)}</u>'
        if strike:
            return f'<s>{_add_fields_html(text)}</s>'
        return _add_fields_html(text)
    if not isinstance(node, Tag):
        return ''
    tag = node.name.lower() if node.name else ''
    if tag == 'br':
        return '<br>'
    nb = bold or tag in ('strong', 'b')
    ni = italic or tag in ('em', 'i')
    nu = underline or tag == 'u'
    ns = strike or tag in ('s', 'del', 'strike')
    nc = code or tag in ('code', 'tt')
    inner = ''.join(_inline_html(c, nb, ni, nu, ns, nc) for c in node.children)
    if tag == 'a':
        href = node.get('href', '')
        return f'<a href="{href}">{inner}</a>' if href else inner
    return inner


def _block_html(node, diagrams=None):
    """
    Convierte un nodo BeautifulSoup a HTML para el PDF.
    diagrams: dict {"DIAGRAM_0": "<base64png>", ...}
    """
    if diagrams is None:
        diagrams = {}

    if isinstance(node, NavigableString):
        text = str(node).strip()
        # Detectar placeholder de diagrama en texto suelto
        if re.match(r'^%%PDF_DIAGRAM_\d+%%$', text):
            return _diagram_html(text, diagrams)
        return f'<p>{_add_fields_html(text)}</p>' if text else ''

    if not isinstance(node, Tag):
        return ''

    tag = node.name.lower() if node.name else ''

    if tag in ('h1', 'h2', 'h3', 'h4', 'h5', 'h6'):
        level = tag[1]
        inner = ''.join(_inline_html(c) for c in node.children)
        return f'<{tag}>{inner}</{tag}>'

    if tag == 'p':
        # Detectar placeholder de diagrama dentro de <p>
        text_content = node.get_text().strip()
        if re.match(r'^%%PDF_DIAGRAM_\d+%%$', text_content):
            return _diagram_html(text_content, diagrams)
        inner = ''.join(_inline_html(c) for c in node.children)
        return f'<p>{inner}</p>'

    if tag == 'blockquote':
        inner = ''.join(_block_html(c, diagrams) for c in node.children)
        return f'<blockquote>{inner}</blockquote>'

    if tag == 'pre':
        code_node = node.find('code')
        text = code_node.get_text() if code_node else node.get_text()
        lines = '<br>'.join(_add_fields_html(line) for line in text.splitlines())
        return f'<pre>{lines}</pre>'

    if tag in ('ul', 'ol'):
        items = []
        for li in node.find_all('li', recursive=False):
            li_inner = ''.join(_inline_html(c) for c in li.children if c.name not in ('ul', 'ol'))
            nested = ''.join(_block_html(c, diagrams) for c in li.children if c.name in ('ul', 'ol'))
            task_match = TASK_ITEM_RE.match(li_inner)
            if task_match:
                checked = task_match.group(1).lower() == 'x'
                li_inner = TASK_ITEM_RE.sub('', li_inner, count=1)
                box = '&#9745;' if checked else '&#9744;'
                items.append(f'<li class="task-item">{box} {li_inner}{nested}</li>')
            else:
                items.append(f'<li>{li_inner}{nested}</li>')
        return f'<{tag}>{"".join(items)}</{tag}>'

    if tag == 'hr':
        return '<hr>'

    if tag == 'table':
        rows = []
        for tr in node.find_all('tr'):
            cells = []
            for cell in tr.find_all(['th', 'td']):
                inner = ''.join(_inline_html(c) for c in cell.children)
                cells.append(f'<{cell.name}>{inner}</{cell.name}>')
            rows.append(f'<tr>{"".join(cells)}</tr>')
        return f'<table><tbody>{"".join(rows)}</tbody></table>'

    if tag in ('div', 'section', 'article', 'body', 'html'):
        return ''.join(_block_html(c, diagrams) for c in node.children)

    return ''.join(_inline_html(c) for c in node.children)


def _diagram_html(placeholder, diagrams):
    """Genera el HTML para incrustar una imagen de diagrama en el PDF."""
    m = re.search(r'%%PDF_DIAGRAM_(\d+)%%', placeholder)
    if not m:
        return ''
    idx = int(m.group(1))
    key = f'DIAGRAM_{idx}'
    b64 = diagrams.get(key)
    if b64:
        return (
            f'<div class="diagram-block">'
            f'<img src="data:image/png;base64,{b64}" alt="Diagrama {idx}"/>'
            f'</div>'
        )
    else:
        return f'<div class="diagram-missing">[Diagrama {idx} — imagen no disponible]</div>'


def main():
    if len(sys.argv) < 3:
        print('Usage: export_pdf.py <input.json> <output.pdf>', file=sys.stderr)
        sys.exit(1)

    input_path  = sys.argv[1]
    output_path = sys.argv[2]

    with open(input_path, encoding='utf-8') as f:
        data = json.load(f)

    title    = data.get('title', 'Acuerdo')
    markdown = data.get('markdown', '')
    categoria = data.get('categoria', '')
    diagrams  = data.get('diagrams', {})  # {"DIAGRAM_0": "<base64png>", ...}

    # ── Sustituir bloques ```mermaid ... ``` por placeholders ─────────────────
    diagram_counter = [0]

    def _replace_mermaid(m):
        idx = diagram_counter[0]
        diagram_counter[0] += 1
        return f'\n\n%%PDF_DIAGRAM_{idx}%%\n\n'

    markdown_clean = re.sub(
        r'```mermaid\n[\s\S]*?```',
        _replace_mermaid,
        markdown
    )

    # ── Markdown → HTML ───────────────────────────────────────────────────────
    md_parser = MarkdownIt('commonmark').enable('table').enable('strikethrough')
    html_body = md_parser.render(markdown_clean)
    soup = BeautifulSoup(html_body, 'html.parser')

    # ── Construir cuerpo HTML con soporte de diagramas ────────────────────────
    body = ''.join(_block_html(c, diagrams) for c in soup.children)

    header_text = f"{categoria} — {title}" if categoria else title
    full_html = (
        HTML_TEMPLATE
        .replace('{{HEADER}}', header_text)
        .replace('{{BODY}}', body)
    )

    HTML(string=full_html).write_pdf(output_path)
    print(f'OK:{output_path}', flush=True)


if __name__ == '__main__':
    main()
