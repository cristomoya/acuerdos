#!/usr/bin/env python3
"""
export_odt.py - Markdown -> HTML -> ODT with style modes:
- oficial: administrative/classic
- moderno: clean and legible
- mixto: modern headings with official body text

The backend passes:
- argv[1]: input JSON
- argv[2]: output .odt path
- argv[3] (optional): template .ott/.odt to reuse styles/layout from
"""

from __future__ import annotations

import json
import os
import sys
from typing import Optional

from bs4 import BeautifulSoup, NavigableString, Tag
from markdown_it import MarkdownIt
from odf.namespaces import FONS, TEXTNS
from odf.opendocument import OpenDocumentText, load
from odf.style import ParagraphProperties, Style, TableCellProperties, TextProperties
from odf.table import Table, TableCell, TableColumn, TableRow
from odf.text import LineBreak, P, Span

FONT_BODY = "Arial"
FONT_CODE = "Courier New"

STYLE_NAMES = {
    "title1": "AC_Title1",
    "title2": "AC_Heading2",
    "title3": "AC_Heading3",
    "title4": "AC_Heading4",
    "title5": "AC_Heading5",
    "title6": "AC_Heading6",
    "body": "AC_BodyText",
    "list": "AC_ListItem",
    "quote": "AC_Quote",
    "codeblock": "AC_CodeBlock",
    "rule": "AC_Rule",
    "table_cell": "AC_TableCell",
    "table_cell_alt": "AC_TableCellAlt",
    "table_header": "AC_TableHeader",
    "strong": "AC_Strong",
    "em": "AC_Emphasis",
    "code": "AC_InlineCode",
    "link": "AC_Link",
    "strike": "AC_Strike",
}

HEADING_TAGS = {"h1", "h2", "h3", "h4", "h5", "h6"}
INLINE_TAGS = {"strong", "b", "em", "i", "code", "span", "a", "br", "img", "del", "s", "sub", "sup", "kbd", "u"}


def _add_paragraph_style(
    doc,
    name,
    *,
    size="10pt",
    bold=False,
    italic=False,
    align="justify",
    mb="0.2cm",
    mt="0.2cm",
    lineheight="140%",
    font=None,
    first_indent="1.2cm",
    bg=None,
    color=None,
    ml=None,
    mr=None,
    border_left=None,
    padding_left=None,
    border_bottom=None,
):
    style = Style(name=name, family="paragraph")

    pp = ParagraphProperties()
    pp.setAttrNS(FONS, "text-align", align)
    pp.setAttrNS(FONS, "margin-bottom", mb)
    pp.setAttrNS(FONS, "margin-top", mt)
    pp.setAttrNS(FONS, "line-height", lineheight)
    if first_indent:
        pp.setAttrNS(FONS, "text-indent", first_indent)
    if ml:
        pp.setAttrNS(FONS, "margin-left", ml)
    if mr:
        pp.setAttrNS(FONS, "margin-right", mr)
    if bg:
        pp.setAttrNS(FONS, "background-color", bg)
    if border_left:
        pp.setAttrNS(FONS, "border-left", border_left)
    if padding_left:
        pp.setAttrNS(FONS, "padding-left", padding_left)
    if border_bottom:
        pp.setAttrNS(FONS, "border-bottom", border_bottom)
    style.addElement(pp)

    tp = TextProperties()
    tp.setAttrNS(FONS, "font-size", size)
    tp.setAttrNS(FONS, "font-family", font or FONT_BODY)
    if bold:
        tp.setAttrNS(FONS, "font-weight", "bold")
    if italic:
        tp.setAttrNS(FONS, "font-style", "italic")
    if color:
        tp.setAttrNS(FONS, "color", color)
    style.addElement(tp)

    doc.styles.addElement(style)


def _add_text_style(
    doc,
    name,
    *,
    size=None,
    bold=False,
    italic=False,
    underline=False,
    strike=False,
    font=None,
    color=None,
    bg=None,
):
    style = Style(name=name, family="text")
    tp = TextProperties()
    if size:
        tp.setAttrNS(FONS, "font-size", size)
    tp.setAttrNS(FONS, "font-family", font or FONT_BODY)
    if bold:
        tp.setAttrNS(FONS, "font-weight", "bold")
    if italic:
        tp.setAttrNS(FONS, "font-style", "italic")
    if underline:
        tp.setAttrNS(FONS, "text-underline-style", "solid")
        tp.setAttrNS(FONS, "text-underline-width", "auto")
    if strike:
        tp.setAttrNS(FONS, "text-line-through-style", "solid")
    if color:
        tp.setAttrNS(FONS, "color", color)
    if bg:
        tp.setAttrNS(FONS, "background-color", bg)
    style.addElement(tp)
    doc.styles.addElement(style)


def _add_table_cell_style(
    doc,
    name,
    *,
    bg=None,
    border="0.5pt solid #d0d7de",
    padding="0.12cm",
    bold=False,
    color=None,
):
    style = Style(name=name, family="table-cell")
    cp = TableCellProperties()
    if bg:
        cp.setAttrNS(FONS, "background-color", bg)
    if border:
        cp.setAttrNS(FONS, "border", border)
        cp.setAttrNS(FONS, "border-left", border)
        cp.setAttrNS(FONS, "border-right", border)
        cp.setAttrNS(FONS, "border-top", border)
        cp.setAttrNS(FONS, "border-bottom", border)
    if padding:
        cp.setAttrNS(FONS, "padding", padding)
    cp.setAttrNS(FONS, "vertical-align", "middle")
    style.addElement(cp)

    tp = TextProperties()
    tp.setAttrNS(FONS, "font-family", FONT_BODY)
    tp.setAttrNS(FONS, "font-size", "10pt")
    if bold:
        tp.setAttrNS(FONS, "font-weight", "bold")
    if color:
        tp.setAttrNS(FONS, "color", color)
    style.addElement(tp)

    doc.styles.addElement(style)


def _add_table_paragraph_style(
    doc,
    name,
    *,
    bold=False,
    bg=None,
    color=None,
):
    _add_paragraph_style(
        doc,
        name,
        size="10pt",
        bold=bold,
        align="start",
        mb="0cm",
        mt="0cm",
        lineheight="120%",
        font=FONT_BODY,
        first_indent=None,
        bg=bg,
        color=color,
    )


def _apply_common_styles(doc, *, title1_size, title2_size, title3_size, body_align, body_indent, body_lineheight, list_align, list_indent, list_left_margin):
    _add_paragraph_style(
        doc,
        STYLE_NAMES["title1"],
        size=title1_size,
        bold=True,
        align="start" if body_align == "start" else "justify",
        mt="0cm",
        mb="0.5cm",
        first_indent=None,
    )
    _add_paragraph_style(
        doc,
        STYLE_NAMES["title2"],
        size=title2_size,
        bold=True,
        align="start",
        mt="0.45cm",
        mb="0.2cm",
        first_indent=None,
    )
    _add_paragraph_style(
        doc,
        STYLE_NAMES["title3"],
        size=title3_size,
        bold=True,
        align="start",
        mt="0.3cm",
        mb="0.15cm",
        first_indent=None,
    )
    _add_paragraph_style(
        doc,
        STYLE_NAMES["title4"],
        size="11pt",
        bold=True,
        align="start",
        mt="0.25cm",
        mb="0.12cm",
        first_indent=None,
    )
    _add_paragraph_style(
        doc,
        STYLE_NAMES["title5"],
        size="10.5pt",
        bold=True,
        align="start",
        mt="0.2cm",
        mb="0.1cm",
        first_indent=None,
    )
    _add_paragraph_style(
        doc,
        STYLE_NAMES["title6"],
        size="10pt",
        bold=True,
        align="start",
        mt="0.15cm",
        mb="0.08cm",
        first_indent=None,
    )
    _add_paragraph_style(
        doc,
        STYLE_NAMES["body"],
        size="10pt",
        align=body_align,
        mt="0cm",
        mb="0.21cm",
        lineheight=body_lineheight,
        first_indent=body_indent,
    )
    _add_paragraph_style(
        doc,
        STYLE_NAMES["list"],
        size="10pt",
        align=list_align,
        mt="0cm",
        mb="0.1cm",
        lineheight=body_lineheight,
        first_indent=None,
        ml=list_left_margin,
        padding_left=list_indent,
    )
    _add_paragraph_style(
        doc,
        STYLE_NAMES["quote"],
        size="10pt",
        align=body_align,
        mt="0.08cm",
        mb="0.18cm",
        lineheight=body_lineheight,
        first_indent=None,
        bg="#f7faff",
        border_left="0.1cm solid #cbd5e1",
        padding_left="0.28cm",
    )
    _add_paragraph_style(
        doc,
        STYLE_NAMES["codeblock"],
        size="9pt",
        align="start",
        mt="0.08cm",
        mb="0.18cm",
        lineheight="120%",
        font=FONT_CODE,
        first_indent=None,
        bg="#f5f5f5",
        padding_left="0.2cm",
    )
    _add_paragraph_style(
        doc,
        STYLE_NAMES["rule"],
        size="10pt",
        align="center",
        mt="0.15cm",
        mb="0.15cm",
        first_indent=None,
    )

    _add_text_style(doc, STYLE_NAMES["strong"], bold=True)
    _add_text_style(doc, STYLE_NAMES["em"], italic=True)
    _add_text_style(doc, STYLE_NAMES["code"], font=FONT_CODE, bg="#f5f5f5")
    _add_text_style(doc, STYLE_NAMES["link"], color="#1a5fb4", underline=True)
    _add_text_style(doc, STYLE_NAMES["strike"], strike=True)
   _add_table_cell_style(
    doc,
    STYLE_NAMES["table_cell"],
    bg="#ffffff",
    border="0.4pt solid #a0a0a0",
    padding="0.10cm"
)

_add_table_cell_style(
    doc,
    STYLE_NAMES["table_cell_alt"],
    bg="#f7f7f7",
    border="0.4pt solid #a0a0a0",
    padding="0.10cm"
)

_add_table_cell_style(
    doc,
    STYLE_NAMES["table_header"],
    bg="#4a4a4a",
    border="0.6pt solid #4a4a4a",
    padding="0.12cm",
    bold=True,
    color="#ffffff"
)


def _apply_all_styles_oficial(doc):
    _apply_common_styles(
        doc,
        title1_size="12pt",
        title2_size="11pt",
        title3_size="10.5pt",
        body_align="justify",
        body_indent="1.2cm",
        body_lineheight="135%",
        list_align="justify",
        list_indent="0.3cm",
        list_left_margin="0.7cm",
    )


def _apply_all_styles_modern(doc):
    _apply_common_styles(
        doc,
        title1_size="16pt",
        title2_size="13pt",
        title3_size="11pt",
        body_align="start",
        body_indent=None,
        body_lineheight="145%",
        list_align="start",
        list_indent="0.2cm",
        list_left_margin="0.5cm",
    )


def _apply_all_styles_mixto(doc):
    _apply_common_styles(
        doc,
        title1_size="15pt",
        title2_size="12.5pt",
        title3_size="11pt",
        body_align="justify",
        body_indent="1.2cm",
        body_lineheight="135%",
        list_align="justify",
        list_indent="0.25cm",
        list_left_margin="0.55cm",
    )


def _p(style_name):
    el = P()
    el.setAttrNS(TEXTNS, "style-name", style_name)
    return el


def _span(style_name):
    el = Span()
    el.setAttrNS(TEXTNS, "style-name", style_name)
    return el


def _is_tag(node, name):
    return isinstance(node, Tag) and node.name.lower() == name


def _iter_direct_tags(node):
    for child in getattr(node, "children", []):
        if isinstance(child, Tag):
            yield child


def _append_preserved_text(parent, text):
    lines = text.splitlines()
    if not lines:
        parent.addText("")
        return
    for i, line in enumerate(lines):
        if i:
            parent.addElement(LineBreak())
        parent.addText(line)


def _render_inline(parent, node):
    if node is None:
        return

    if isinstance(node, NavigableString):
        parent.addText(str(node))
        return

    if not isinstance(node, Tag):
        return

    name = node.name.lower()

    if name == "br":
        parent.addElement(LineBreak())
        return

    if name in {"p", "div", "section"}:
        for child in node.children:
            _render_inline(parent, child)
        return

    if name in {"strong", "b"}:
        sp = _span(STYLE_NAMES["strong"])
        for child in node.children:
            _render_inline(sp, child)
        parent.addElement(sp)
        return

    if name in {"em", "i"}:
        sp = _span(STYLE_NAMES["em"])
        for child in node.children:
            _render_inline(sp, child)
        parent.addElement(sp)
        return

    if name in {"code", "kbd"}:
        sp = _span(STYLE_NAMES["code"])
        sp.addText(node.get_text("", strip=False))
        parent.addElement(sp)
        return

    if name == "a":
        sp = _span(STYLE_NAMES["link"])
        text = node.get_text(" ", strip=False) or node.get("href", "")
        sp.addText(text)
        parent.addElement(sp)
        return

    if name in {"del", "s"}:
        sp = _span(STYLE_NAMES["strike"])
        for child in node.children:
            _render_inline(sp, child)
        parent.addElement(sp)
        return

    if name == "img":
        alt = node.get("alt") or node.get("title") or node.get("src") or "[imagen]"
        parent.addText(alt)
        return

    if name in {"sub", "sup", "span", "u"}:
        for child in node.children:
            _render_inline(parent, child)
        return

    for child in node.children:
        _render_inline(parent, child)


def _render_paragraph(doc, node, *, style_name, prefix=""):
    p = _p(style_name)
    if prefix:
        p.addText(prefix)
    for child in node.children:
        _render_inline(p, child)
    doc.text.addElement(p)


def _render_heading(doc, node, *, prefix=""):
    level = int(node.name[1])
    if level <= 1:
        style_name = STYLE_NAMES["title1"]
    else:
        style_name = STYLE_NAMES.get(f"title{level}", STYLE_NAMES["title6"])
    p = _p(style_name)
    if prefix:
        p.addText(prefix)
    for child in node.children:
        _render_inline(p, child)
    doc.text.addElement(p)


def _render_pre(doc, node, *, prefix=""):
    text = node.get_text("\n", strip=False)
    code = _p(STYLE_NAMES["codeblock"])
    if prefix:
        code.addText(prefix)
    _append_preserved_text(code, text.rstrip("\n"))
    doc.text.addElement(code)


def _render_rule(doc, *, prefix=""):
    p = _p(STYLE_NAMES["rule"])
    if prefix:
        p.addText(prefix)
    p.addText("────────────")
    doc.text.addElement(p)


def _render_table(doc, node, *, prefix=""):
    rows = []
    max_cols = 0
    for tr in node.find_all("tr", recursive=True):
        cells = []
        for cell in tr.find_all(["th", "td"], recursive=False):
            cells.append(cell)
        if cells:
            rows.append(cells)
            max_cols = max(max_cols, len(cells))

    if not rows:
        return

    table = Table(name="Tabla")
    for _ in range(max_cols or 1):
        table.addElement(TableColumn())

    for row_idx, row_cells in enumerate(rows):
        tr = TableRow()
        for cell in row_cells:
            is_header = cell.name.lower() == "th"
            cell_style = STYLE_NAMES["table_header"] if is_header else (STYLE_NAMES["table_cell"] if row_idx % 2 == 0 else STYLE_NAMES["table_cell_alt"])
            tc = TableCell(stylename=cell_style)
            cell_p = _p("AC_TableHeaderText" if is_header else "AC_TableText")
            if prefix:
                cell_p.addText(prefix)
            if is_header:
                for child in cell.children:
                    _render_inline(cell_p, child)
            else:
                for child in cell.children:
                    _render_inline(cell_p, child)
            tc.addElement(cell_p)
            tr.addElement(tc)
        table.addElement(tr)

    doc.text.addElement(table)


def _render_list_item(doc, li, *, ordered, index, level=0, prefix=""):
    bullet = f"{index}. " if ordered else "• "
    item_prefix = prefix + ("  " * level) + bullet
    p = _p(STYLE_NAMES["list"])
    p.addText(item_prefix)

    nested_lists = []
    for child in li.children:
        if isinstance(child, NavigableString):
            if child.strip():
                _render_inline(p, child)
            continue
        if not isinstance(child, Tag):
            continue
        name = child.name.lower()
        if name in {"ul", "ol"}:
            nested_lists.append(child)
            continue
        if name == "p":
            for grandchild in child.children:
                _render_inline(p, grandchild)
            continue
        if name in INLINE_TAGS or name in {"div", "section"}:
            _render_inline(p, child)
            continue
        if name == "pre":
            _render_inline(p, child)
            continue
        if name == "blockquote":
            _render_inline(p, child)
            continue
        _render_inline(p, child)

    doc.text.addElement(p)

    for nested in nested_lists:
        _render_block(doc, nested, level=level + 1, prefix=prefix)


def _render_block(doc, node, *, level=0, prefix=""):
    if isinstance(node, NavigableString):
        if node.strip():
            _render_paragraph(doc, node, style_name=STYLE_NAMES["body"], prefix=prefix)
        return

    if not isinstance(node, Tag):
        return

    name = node.name.lower()

    if name in HEADING_TAGS:
        _render_heading(doc, node, prefix=prefix)
        return

    if name == "p":
        _render_paragraph(doc, node, style_name=STYLE_NAMES["body"], prefix=prefix)
        return

    if name == "pre":
        _render_pre(doc, node, prefix=prefix)
        return

    if name in {"ul", "ol"}:
        ordered = name == "ol"
        items = [child for child in node.children if _is_tag(child, "li")]
        for idx, li in enumerate(items, start=1):
            _render_list_item(doc, li, ordered=ordered, index=idx, level=level, prefix=prefix)
        return

    if name == "blockquote":
        children = [child for child in node.children if not (isinstance(child, NavigableString) and not child.strip())]
        if not children:
            return
        first = True
        for child in children:
            child_prefix = prefix + ("Nota: " if first else "")
            first = False
            if isinstance(child, Tag) and child.name.lower() in {"ul", "ol"}:
                _render_block(doc, child, level=level, prefix=child_prefix)
                continue
            if isinstance(child, Tag) and child.name.lower() == "p":
                _render_paragraph(doc, child, style_name=STYLE_NAMES["quote"], prefix=child_prefix)
                continue
            if isinstance(child, Tag) and child.name.lower() == "pre":
                _render_pre(doc, child, prefix=child_prefix)
                continue
            p = _p(STYLE_NAMES["quote"])
            if child_prefix:
                p.addText(child_prefix)
            _render_inline(p, child)
            doc.text.addElement(p)
        return

    if name == "hr":
        _render_rule(doc, prefix=prefix)
        return

    if name == "table":
        _render_table(doc, node, prefix=prefix)
        return

    if name == "li":
        _render_list_item(doc, node, ordered=False, index=1, level=level, prefix=prefix)
        return

    if name in {"div", "section", "article", "body"}:
        for child in node.children:
            _render_block(doc, child, level=level, prefix=prefix)
        return

    # Fallback: recurse into children so we do not silently drop unknown tags.
    handled_child = False
    for child in node.children:
        if isinstance(child, Tag) or (isinstance(child, NavigableString) and child.strip()):
            handled_child = True
            _render_block(doc, child, level=level, prefix=prefix)
    if not handled_child and node.get_text(strip=True):
        _render_paragraph(doc, node, style_name=STYLE_NAMES["body"], prefix=prefix)


def _make_document(template_path: Optional[str] = None):
    if template_path and os.path.exists(template_path):
        doc = load(template_path)
        try:
            for child in list(doc.text.childNodes):
                doc.text.removeChild(child)
        except Exception:
            pass
        return doc
    return OpenDocumentText()


def _render_markdown(doc, markdown):
    md = MarkdownIt("commonmark", {"html": True, "linkify": False})
    md.enable(["table", "strikethrough"])
    html = md.render(markdown or "")
    soup = BeautifulSoup(html, "html.parser")
    for node in soup.contents:
        if isinstance(node, NavigableString) and not node.strip():
            continue
        _render_block(doc, node)


def _pick_style_mode(raw_mode):
    mode = (raw_mode or "oficial").strip().lower()
    if mode in {"oficial", "moderno", "mixto"}:
        return mode
    return "oficial"


def _apply_mode_styles(doc, mode):
    if mode == "moderno":
        _apply_all_styles_modern(doc)
    elif mode == "mixto":
        _apply_all_styles_mixto(doc)
    else:
        _apply_all_styles_oficial(doc)


def main(argv=None):
    argv = sys.argv if argv is None else argv
    if len(argv) < 3:
        print("Usage: export_odt.py <input.json> <output.odt> [template.ott|template.odt]", file=sys.stderr)
        return 1

    input_path = argv[1]
    output_path = argv[2]
    template_path = argv[3] if len(argv) > 3 else None

    with open(input_path, encoding="utf-8") as f:
        data = json.load(f)

    markdown = data.get("markdown", "")
    mode = _pick_style_mode(data.get("style_mode", "oficial"))

    doc = _make_document(template_path)
    _apply_mode_styles(doc, mode)
    _render_markdown(doc, markdown)
    doc.save(output_path)
    print("OK:", output_path)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
