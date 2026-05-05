#!/usr/bin/env python3
"""
export_odt.py — Markdown → HTML → ODT con modos de estilo:
- oficial (administrativo clásico)
- moderno (legible, limpio)
- mixto (títulos modernos + cuerpo oficial)
"""

import base64, io, sys, json, re, os

from markdown_it import MarkdownIt
from bs4 import BeautifulSoup, NavigableString, Tag

from odf.opendocument import OpenDocumentText, load
from odf.style import Style, TextProperties, ParagraphProperties
from odf.text import P, Span, LineBreak
from odf.namespaces import FONS, TEXTNS

# ─────────────────────────────────────────────────────────────

FONT = 'Arial'

# ─── STYLE CORE ─────────────────────────────────────────────

def _para_style(doc, name, size='10pt', bold=False, italic=False,
                align='justify', mb='0.2cm', mt='0cm',
                lineheight='140%', font=None,
                first_indent='1.2cm', bg=None,
                ml=None, mr=None, border_left=None, padding_left=None):

    s = Style(name=name, family='paragraph')

    pp = ParagraphProperties()
    pp.setAttrNS(FONS, 'text-align', align)
    pp.setAttrNS(FONS, 'margin-bottom', mb)
    pp.setAttrNS(FONS, 'margin-top', mt)
    pp.setAttrNS(FONS, 'line-height', lineheight)

    if first_indent:
        pp.setAttrNS(FONS, 'text-indent', first_indent)
    if ml:
        pp.setAttrNS(FONS, 'margin-left', ml)
    if mr:
        pp.setAttrNS(FONS, 'margin-right', mr)
    if bg:
        pp.setAttrNS(FONS, 'background-color', bg)
    if border_left:
        pp.setAttrNS(FONS, 'border-left', border_left)
    if padding_left:
        pp.setAttrNS(FONS, 'padding-left', padding_left)

    s.addElement(pp)

    tp = TextProperties()
    tp.setAttrNS(FONS, 'font-size', size)
    tp.setAttrNS(FONS, 'font-family', font or FONT)
    if bold:
        tp.setAttrNS(FONS, 'font-weight', 'bold')
    if italic:
        tp.setAttrNS(FONS, 'font-style', 'italic')

    s.addElement(tp)
    doc.styles.addElement(s)

# ─── MODOS DE ESTILO ─────────────────────────────────────────

def _apply_all_styles_oficial(doc):

    _para_style(doc, 'Titulo 1',
        size='12pt', bold=True,
        align='justify',
        mt='0.5cm', mb='0.3cm',
        first_indent=None
    )

    for i in range(2,6):
        _para_style(doc, f'Heading{i}',
            size='11pt', bold=True,
            align='justify',
            mt='0.35cm', mb='0.2cm',
            first_indent=None
        )

    _para_style(doc, 'BodyText',
        size='10pt',
        align='justify',
        mt='0cm', mb='0.21cm',
        lineheight='135%',
        first_indent='1.2cm'
    )

    _para_style(doc, 'ListItem',
        size='10pt',
        align='justify',
        first_indent='1.2cm'
    )

def _apply_all_styles_modern(doc):

    _para_style(doc, 'Titulo 1',
        size='16pt', bold=True,
        align='start',
        mt='0cm', mb='0.6cm',
        first_indent=None
    )

    _para_style(doc, 'Heading2',
        size='13pt', bold=True,
        align='start',
        mt='0.5cm', mb='0.25cm',
        first_indent=None
    )

    _para_style(doc, 'Heading3',
        size='11pt', bold=True,
        align='start',
        mt='0.35cm', mb='0.2cm',
        first_indent=None
    )

    _para_style(doc, 'BodyText',
        size='10pt',
        align='start',
        lineheight='145%',
        first_indent=None
    )

    _para_style(doc, 'ListItem',
        size='10pt',
        align='start',
        ml='0.8cm',
        first_indent=None
    )

def _apply_all_styles_mixto(doc):

    _para_style(doc, 'Titulo 1',
        size='15pt', bold=True,
        align='start',
        mt='0cm', mb='0.5cm',
        first_indent=None
    )

    _para_style(doc, 'Heading2',
        size='12.5pt', bold=True,
        align='start',
        mt='0.45cm', mb='0.2cm',
        first_indent=None
    )

    _para_style(doc, 'Heading3',
        size='11pt', bold=True,
        align='start',
        mt='0.3cm', mb='0.15cm',
        first_indent=None
    )

    _para_style(doc, 'BodyText',
        size='10pt',
        align='justify',
        lineheight='135%',
        first_indent='1.2cm'
    )

    _para_style(doc, 'ListItem',
        size='10pt',
        align='justify',
        first_indent='1.2cm',
        ml='0.5cm'
    )

# ─── HELPERS ────────────────────────────────────────────────

def _p(style):
    el = P()
    el.setAttrNS(TEXTNS, 'style-name', style)
    return el

def _render_inline(odf_el, node):
    if isinstance(node, NavigableString):
        odf_el.addText(str(node))
        return

    if not isinstance(node, Tag):
        return

    for c in node.children:
        _render_inline(odf_el, c)

# ─── BLOQUES ───────────────────────────────────────────────

def _render_block(doc, node):

    if isinstance(node, NavigableString):
        return

    if not isinstance(node, Tag):
        return

    tag = node.name.lower()

    if tag in ('h1','h2','h3','h4','h5','h6'):
        level = int(tag[1])

        if level == 1:
            style = 'Titulo 1'
        else:
            style = f'Heading{level}'

        p = _p(style)

        for c in node.children:
            _render_inline(p, c)

        doc.text.addElement(p)

    elif tag == 'p':
        p = _p('BodyText')
        for c in node.children:
            _render_inline(p, c)
        doc.text.addElement(p)

# ─── MAIN ──────────────────────────────────────────────────

def main():

    input_path  = sys.argv[1]
    output_path = sys.argv[2]

    with open(input_path, encoding='utf-8') as f:
        data = json.load(f)

    markdown = data.get('markdown', '')
    mode     = data.get('style_mode', 'oficial')

    md = MarkdownIt()
    html = md.render(markdown)
    soup = BeautifulSoup(html, 'html.parser')

    doc = OpenDocumentText()

    # aplicar modo
    if mode == 'moderno':
        _apply_all_styles_modern(doc)
    elif mode == 'mixto':
        _apply_all_styles_mixto(doc)
    else:
        _apply_all_styles_oficial(doc)

    for node in soup.children:
        _render_block(doc, node)

    doc.save(output_path)
    print("OK:", output_path)


if __name__ == "__main__":
    main()