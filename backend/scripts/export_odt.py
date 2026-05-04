#!/usr/bin/env python3
"""
export_odt.py — Markdown → HTML → ODT
Estilos fijos: Arial, encabezados 12pt negrita, cuerpo 10pt,
sangría primera línea 1.2cm, tablas con bordes, citas Book Antiqua 9pt itálica fondo azul claro.
"""
import base64, io, tempfile
try:
    from odf.draw import Frame, Image as OdfImage
    from odf.namespaces import DRAWNS, XLINKNS
    _HAS_DRAW = True
except ImportError:
    _HAS_DRAW = False

import sys, json, re, os
from markdown_it import MarkdownIt
from bs4 import BeautifulSoup, NavigableString, Tag

from odf.opendocument import OpenDocumentText, load
from odf.style import (Style, TextProperties, ParagraphProperties,
                       PageLayout, PageLayoutProperties, MasterPage,
                       TableCellProperties, TableColumnProperties, Footer)
from odf.text import P, Span, LineBreak, PageNumber
from odf.table import Table, TableColumn, TableRow, TableCell
try:
    from odf.table import CoveredTableCell as _CoveredTableCell
except ImportError:
    _CoveredTableCell = None
from odf.namespaces import STYLENS, FONS, TEXTNS
try:
    from odf.namespaces import TABLENS
except ImportError:
    TABLENS = "urn:oasis:names:tc:opendocument:xmlns:table:1.0"
import odf.dc

FIELD_RE   = re.compile(r'\{\{[A-Z0-9_]+\}\}')
FONT       = 'Arial'
FONT_QUOTE = 'Book Antiqua'

# ─── PAGE LAYOUT ──────────────────────────────────────────────────────────────

def _apply_page_layout(doc):
    pl = PageLayout(name='PageLayout')
    plp = PageLayoutProperties()
    plp.setAttrNS(FONS, 'page-width',    '21cm')
    plp.setAttrNS(FONS, 'page-height',   '29.7cm')
    plp.setAttrNS(FONS, 'margin-top',    '2.5cm')
    plp.setAttrNS(FONS, 'margin-bottom', '2.5cm')
    plp.setAttrNS(FONS, 'margin-left',   '3cm')
    plp.setAttrNS(FONS, 'margin-right',  '3cm')
    pl.addElement(plp)
    doc.automaticstyles.addElement(pl)

    mp = MasterPage(name='Standard', pagelayoutname='PageLayout')
    # Footer: centered page number
    try:
        footer = Footer()
        fp = P()
        fp.setAttrNS(TEXTNS, 'style-name', 'FooterPara')
        pn = PageNumber()
        pn.setAttrNS(TEXTNS, 'select-page', 'current')
        fp.addElement(pn)
        footer.addElement(fp)
        mp.addElement(footer)
    except Exception:
        pass
    doc.masterstyles.addElement(mp)

# ─── STYLE BUILDERS ───────────────────────────────────────────────────────────

def _para_style(doc, name, size='10pt', bold=False, italic=False,
                align='justify', mb='0.2cm', mt='0cm', lineheight='140%',
                font=None, first_indent='1.2cm', bg=None,
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


def _text_style(doc, name, bold=False, italic=False, bg=None,
                color=None, font=None, size=None,
                underline=False, strikethrough=False):
    s = Style(name=name, family='text')
    tp = TextProperties()
    if bold:   tp.setAttrNS(FONS, 'font-weight', 'bold')
    if italic: tp.setAttrNS(FONS, 'font-style',  'italic')
    if bg:     tp.setAttrNS(FONS, 'background-color', bg)
    if color:  tp.setAttrNS(FONS, 'color', color)
    if font:   tp.setAttrNS(FONS, 'font-family', font)
    if size:   tp.setAttrNS(FONS, 'font-size', size)
    if underline:
        tp.setAttrNS(STYLENS, 'text-underline-style', 'solid')
        tp.setAttrNS(STYLENS, 'text-underline-width', 'auto')
        tp.setAttrNS(STYLENS, 'text-underline-color', 'font-color')
    if strikethrough:
        tp.setAttrNS(STYLENS, 'text-line-through-style', 'solid')
    s.addElement(tp)
    doc.styles.addElement(s)


def _cell_style(doc, name, bg=None):
    s = Style(name=name, family='table-cell')
    tcp = TableCellProperties()
    border = '0.05cm solid #000000'
    tcp.setAttrNS(FONS, 'border',  border)
    tcp.setAttrNS(FONS, 'padding-top',    '0.15cm')
    tcp.setAttrNS(FONS, 'padding-bottom', '0.15cm')
    tcp.setAttrNS(FONS, 'padding-left',   '0.2cm')
    tcp.setAttrNS(FONS, 'padding-right',  '0.2cm')
    if bg:
        tcp.setAttrNS(FONS, 'background-color', bg)
    s.addElement(tcp)
    doc.automaticstyles.addElement(s)  # ← aquí el cambio


def _apply_all_styles(doc):
    # Headings: 12pt Arial bold, no first-line indent, centered for H1
    _para_style(doc, 'Titulo 1', size='10pt', bold=True, align='justify',
                mb='0.4cm', mt='0.5cm', lineheight='130%', first_indent='1.2cm')
    for i in range(2, 7):
        _para_style(doc, f'Heading{i}', size='10pt', bold=True,
                    align='justify', mb='0.25cm', mt='0.35cm',
                    lineheight='130%', first_indent='1.2cm')

    # Body: 10pt Arial, justified, 1.2cm first-line indent
    _para_style(doc, 'BodyText',  size='10pt', first_indent='1.2cm', mb='0.21cm', mt='0cm')

    # List: 10pt Arial, no indent
    _para_style(doc, 'ListItem',  size='10pt', first_indent='1.2cm', mb='0.1cm')

    # Blockquote: Book Antiqua 9pt italic, light blue bg, no indent
    _para_style(doc, 'Blockquote',
        size='10pt',
        italic=True,
        font=FONT_QUOTE,
        first_indent=None,
        mb='0.25cm',
        mt='0.15cm',
        bg='#F2F2F2',
        border_left='0.06cm solid #C0C0C0',
        padding_left='0.3cm',
        ml='1cm',
        mr='1cm'
    )

    # Table paragraph: 10pt Arial, no indent
    _para_style(doc, 'TablePara', size='10pt', first_indent=None,
                mb='0cm', mt='0cm', align='start')

    # Code: monospace 9pt, no indent
    _para_style(doc, 'CodePara', size='9pt', first_indent=None,
                font='Liberation Mono', mb='0cm', mt='0cm', align='start')

    # HR
    _para_style(doc, 'HRPara', size='10pt', first_indent=None,
                mb='0.2cm', mt='0.2cm', align='center')

    # Inline text styles
    _text_style(doc, 'Bold',        bold=True)
    _text_style(doc, 'Italic',      italic=True)
    _text_style(doc, 'BoldItalic',  bold=True, italic=True)
    _text_style(doc, 'Underline',   underline=True)
    _text_style(doc, 'Strike',      strikethrough=True)
    _text_style(doc, 'CodeInline',  font='Liberation Mono', size='9pt', bg='#F0F0F0')
    # Unfilled {{CAMPO}} placeholders: yellow highlight + red text
    _text_style(doc, 'FieldMarker', color='#CC0000', bg='#FFFF00')

    # Footer paragraph: small, centered
    _para_style(doc, 'FooterPara', size='9pt', first_indent=None,
                mb='0cm', mt='0cm', align='center')

    # Table cell styles
    _cell_style(doc, 'CellHeader', bg='#E0E0E0')
    _cell_style(doc, 'CellNormal')

# ─── TEXT HELPERS ─────────────────────────────────────────────────────────────

def _add_text_with_fields(odf_el, text):
    last = 0
    for m in FIELD_RE.finditer(text):
        if m.start() > last:
            odf_el.addText(text[last:m.start()])
        sp = Span()
        sp.setAttrNS(TEXTNS, 'style-name', 'FieldMarker')
        sp.addText(m.group(0))
        odf_el.addElement(sp)
        last = m.end()
    if last < len(text):
        odf_el.addText(text[last:])


def _render_inline(odf_el, node, bold=False, italic=False,
                   underline=False, strike=False, code=False):
    if isinstance(node, NavigableString):
        text = str(node)
        if not text:
            return
        if code:
            sp = Span(); sp.setAttrNS(TEXTNS, 'style-name', 'CodeInline')
            _add_text_with_fields(sp, text); odf_el.addElement(sp)
        elif bold and italic:
            sp = Span(); sp.setAttrNS(TEXTNS, 'style-name', 'BoldItalic')
            _add_text_with_fields(sp, text); odf_el.addElement(sp)
        elif bold:
            sp = Span(); sp.setAttrNS(TEXTNS, 'style-name', 'Bold')
            _add_text_with_fields(sp, text); odf_el.addElement(sp)
        elif italic:
            sp = Span(); sp.setAttrNS(TEXTNS, 'style-name', 'Italic')
            _add_text_with_fields(sp, text); odf_el.addElement(sp)
        elif underline:
            sp = Span(); sp.setAttrNS(TEXTNS, 'style-name', 'Underline')
            _add_text_with_fields(sp, text); odf_el.addElement(sp)
        elif strike:
            sp = Span(); sp.setAttrNS(TEXTNS, 'style-name', 'Strike')
            _add_text_with_fields(sp, text); odf_el.addElement(sp)
        else:
            _add_text_with_fields(odf_el, text)
        return

    if not isinstance(node, Tag):
        return
    tag = node.name.lower() if node.name else ''
    if tag == 'br':
        odf_el.addElement(LineBreak()); return

    nb = bold      or tag in ('strong', 'b')
    ni = italic    or tag in ('em', 'i')
    nu = underline or tag == 'u'
    ns = strike    or tag in ('s', 'del', 'strike')
    nc = code      or tag in ('code', 'tt')
    for child in node.children:
        _render_inline(odf_el, child, bold=nb, italic=ni,
                       underline=nu, strike=ns, code=nc)

# ─── BLOCK RENDERING ──────────────────────────────────────────────────────────

def _p(style):
    el = P(); el.setAttrNS(TEXTNS, 'style-name', style); return el


def _render_block(doc, node):
    if isinstance(node, NavigableString):
        text = str(node).strip()
        if text:
            p = _p('BodyText'); _add_text_with_fields(p, text); doc.text.addElement(p)
        return
    if not isinstance(node, Tag):
        return

    tag = node.name.lower() if node.name else ''

    if tag in ('h1','h2','h3','h4','h5','h6'):
        level = int(tag[1])
        p = _p(f'Heading{level}')
        p.setAttrNS(TEXTNS, 'outline-level', str(level))
        for c in node.children: _render_inline(p, c)
        doc.text.addElement(p)

    elif tag == 'p':
        p = _p('BodyText')
        for c in node.children: _render_inline(p, c)
        doc.text.addElement(p)

    elif tag == 'blockquote':
        for c in node.children:
            if isinstance(c, Tag) and c.name == 'p':
                p = _p('Blockquote')
                for ic in c.children: _render_inline(p, ic)
                doc.text.addElement(p)
            else:
                _render_block(doc, c)

    elif tag == 'pre':
        code_node = node.find('code')
        text = code_node.get_text() if code_node else node.get_text()
        for line in text.splitlines():
            p = _p('CodePara')
            sp = Span(); sp.setAttrNS(TEXTNS, 'style-name', 'CodeInline')
            sp.addText(line if line else ' '); p.addElement(sp)
            doc.text.addElement(p)

    elif tag in ('ul', 'ol'):
        _render_list(doc, node, depth=0)

    elif tag == 'hr':
        p = _p('HRPara'); p.addText('─' * 60); doc.text.addElement(p)

    elif tag == 'table':
        _render_table(doc, node)

    elif tag in ('div','section','article','body','html'):
        for c in node.children: _render_block(doc, c)


def _numero_a_palabra(n):
    """Convierte un número a su representación en palabras (Primero, Segundo, etc.)"""
    numeros = ['PRIMERO', 'SEGUNDO', 'TERCERO', 'CUARTO', 'QUINTO', 
               'SEXTO', 'SÉPTIMO', 'OCTAVO', 'NOVENO', 'DÉCIMO',
               'UNDÉCIMO', 'DUODÉCIMO', 'DECIMOTERCERO', 'DECIMOCUARTO', 'DECIMOQUINTO']
    if 1 <= n <= len(numeros):
        return numeros[n-1]
    return str(n)


def _render_list(doc, list_node, depth=0, parent_counters=None):
    """
    Renderiza una lista con esquema jurídico:
    - Nivel 0: Primero, Segundo, Tercero... (para ol) o • (para ul)
    - Nivel 1: A), B), C)... (para ol) o ◦ (para ul)
    - Nivel 2+: 1), 2), 3)... (para ol) o ▪ (para ul)
    """
    is_ordered = list_node.name == 'ol'
    if parent_counters is None:
        parent_counters = []
    
    idx = 1
    for c in list_node.children:
        if isinstance(c, Tag) and c.name == 'li':
            _render_list_item(doc, c, depth, is_ordered, idx, parent_counters)
            idx += 1


def _render_list_item(doc, li, depth=0, ordered=False, index=1, parent_counters=None):
    """
    Renderiza un elemento de lista con esquema jurídico.
    Esquema: Primero/A)/1) para ordenadas; •/◦/▪ para sin orden.
    """
    if parent_counters is None:
        parent_counters = []
    
    # Construir el prefijo según el esquema jurídico
    if ordered:
        if depth == 0:
            # Nivel 0: Primero, Segundo, Tercero...
            prefix = f'{_numero_a_palabra(index)}. '
        elif depth == 1:
            # Nivel 1: A), B), C)...
            letters = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ'
            prefix = f'{letters[min(index-1, 25)]}) '
        else:
            # Nivel 2+: 1), 2), 3)...
            prefix = f'{index}) '
    else:
        # Listas sin orden: bullets estándar
        bullets = ['•', '◦', '▪']
        prefix = bullets[min(depth, 2)] + ' '

    # Sangría progresiva según profundidad
    indent = '    ' * depth

    p = _p('ListItem')
    p.addText(indent + prefix)

    # Actualizar contadores para listas anidadas
    current_counters = parent_counters + [index]

    for c in li.children:
        if isinstance(c, Tag) and c.name in ('ul', 'ol'):
            doc.text.addElement(p)
            _render_list(doc, c, depth+1, current_counters)
            return
        elif isinstance(c, Tag) and c.name == 'p':
            for ic in c.children: _render_inline(p, ic)
        else:
            _render_inline(p, c)
    doc.text.addElement(p)


def _render_table(doc, table_node):
    rows = table_node.find_all('tr')
    if not rows: return

    # Count columns accounting for colspan
    ncols = 0
    for r in rows:
        span = sum(max(1, int(c.get('colspan', 1) or 1)) for c in r.find_all(['th', 'td']))
        ncols = max(ncols, span)
    if ncols == 0: return

    table = Table()
    col_width = f'{15.0/ncols:.2f}cm'
    for _ in range(ncols):
        tc_col = TableColumn()
        tc_col.setAttrNS(STYLENS, 'column-width', col_width)
        table.addElement(tc_col)

    # Track cells covered by rowspan: set of (row_idx, col_idx)
    covered = set()
    CoveredCell = _CoveredTableCell if _CoveredTableCell else TableCell

    for row_idx, row_node in enumerate(rows):
        tr = TableRow()
        col = 0
        for cell in row_node.find_all(['th', 'td']):
            # Insert covered-cell placeholders for rowspan from above rows
            while col < ncols and (row_idx, col) in covered:
                tr.addElement(CoveredCell())
                col += 1

            is_header = cell.name == 'th'
            colspan = max(1, int(cell.get('colspan', 1) or 1))
            rowspan = max(1, int(cell.get('rowspan', 1) or 1))

            tc = TableCell(stylename='CellHeader' if is_header else 'CellNormal')
            if colspan > 1:
                tc.setAttrNS(TABLENS, 'number-columns-spanned', str(colspan))
            if rowspan > 1:
                tc.setAttrNS(TABLENS, 'number-rows-spanned', str(rowspan))

            # Mark future cells as covered
            for r_off in range(rowspan):
                for c_off in range(colspan):
                    if r_off > 0 or c_off > 0:
                        covered.add((row_idx + r_off, col + c_off))

            p = _p('TablePara')
            if is_header:
                sp = Span(); sp.setAttrNS(TEXTNS, 'style-name', 'Bold')
                for ch in cell.children: _render_inline(sp, ch)
                p.addElement(sp)
            else:
                for ch in cell.children: _render_inline(p, ch)
            tc.addElement(p)
            tr.addElement(tc)

            # Add covered placeholders for colspan within this row
            for _ in range(1, colspan):
                tr.addElement(CoveredCell())
            col += colspan

        # Fill trailing covered cells (from rowspan in previous rows)
        while col < ncols:
            tr.addElement(CoveredCell())
            col += 1

        table.addElement(tr)

    doc.text.addElement(table)

# ─── MAIN ─────────────────────────────────────────────────────────────────────
def _embed_image_in_doc(doc, png_b64, width_cm=15.0):
    """Incrusta una imagen PNG base64 en el documento ODT."""
    if not _HAS_DRAW or not png_b64:
        return None
    try:
        img_data = base64.b64decode(png_b64)
        # Calcular proporciones
        from PIL import Image as PILImage
        img = PILImage.open(io.BytesIO(img_data))
        w_px, h_px = img.size
        ratio = h_px / w_px if w_px else 0.5
        height_cm = width_cm * ratio
        height_cm = min(height_cm, 20.0)  # máx 20cm de alto

        # Añadir imagen al ODT como binario
        img_filename = f'Pictures/diagram_{id(png_b64)}.png'
        doc.addPicture(img_filename, 'image/png', img_data)

        # Crear frame con la imagen
        frame = Frame()
        frame.setAttrNS(DRAWNS, 'name', f'diagram_{id(png_b64)}')
        frame.setAttrNS(DRAWNS, 'anchor-type', 'paragraph')
        frame.setAttrNS(STYLENS, 'wrap', 'none')
        from odf.namespaces import SVGNS
        frame.setAttrNS(SVGNS, 'width', f'{width_cm:.2f}cm')
        frame.setAttrNS(SVGNS, 'height', f'{height_cm:.2f}cm')

        img_el = OdfImage()
        img_el.setAttrNS(XLINKNS, 'href', img_filename)
        img_el.setAttrNS(XLINKNS, 'type', 'simple')
        img_el.setAttrNS(XLINKNS, 'show', 'embed')
        img_el.setAttrNS(XLINKNS, 'actuate', 'onLoad')
        frame.addElement(img_el)

        return frame
    except Exception as e:
        print(f'[WARN] No se pudo incrustar imagen: {e}', file=sys.stderr)
        return None
    
    
def _inject_diagrams(doc, diagram_order, diagrams):
    """Recorre los párrafos del doc y reemplaza placeholders %%ODT_DIAGRAM_N%% por imágenes."""
    if not diagrams:
        return
    import re as _re
    nodes_to_replace = []
    for child in list(doc.text.childNodes):
        text = child.getAttribute(('urn:oasis:names:tc:opendocument:xmlns:text:1.0', 'text')) if hasattr(child, 'getAttribute') else ''
        try:
            full_text = ''.join(str(t) for t in child.childNodes if hasattr(t, 'data') or isinstance(t, str))
        except Exception:
            full_text = ''
        m = _re.match(r'%%ODT_DIAGRAM_(\d+)%%', full_text.strip())
        if m:
            nodes_to_replace.append((child, int(m.group(1))))

    for (node, idx) in nodes_to_replace:
        key = f'DIAGRAM_{idx}'
        b64 = diagrams.get(key)
        frame = _embed_image_in_doc(doc, b64) if b64 else None
        if frame:
            p = _p('BodyText')
            p.setAttrNS(('urn:oasis:names:tc:opendocument:xmlns:text:1.0', 'text-align'), 'center')
            p.addElement(frame)
            try:
                doc.text.insertBefore(p, node)
                doc.text.removeChild(node)
            except Exception:
                doc.text.addElement(p)
        else:
            # Sin imagen: dejar un párrafo indicativo
            p = _p('BodyText')
            p.addText('[Diagrama no disponible]')
            try:
                doc.text.insertBefore(p, node)
                doc.text.removeChild(node)
            except Exception:
                doc.text.addElement(p)    
def main():
    if len(sys.argv) < 3:
        print('Usage: export_odt.py <input.json> <output.odt> [template]', file=sys.stderr)
        sys.exit(1)

    input_path  = sys.argv[1]
    output_path = sys.argv[2]
    template    = sys.argv[3] if len(sys.argv) > 3 else None

    with open(input_path, encoding='utf-8') as f:
        data = json.load(f)

    title    = data.get('title', 'Acuerdo')
    markdown = data.get('markdown', '')
    meta     = data.get('meta', {})
    diagrams = data.get('diagrams', {})  # ← NUEVO: dict {DIAGRAM_0: base64png, ...}

    # Sustituir bloques mermaid por placeholders con índice
    diagram_order = []
    def _replace_mermaid(m):
        idx = len(diagram_order)
        diagram_order.append(f'DIAGRAM_{idx}')
        return f'\n\n%%ODT_DIAGRAM_{idx}%%\n\n'

    markdown_clean = re.sub(r'```mermaid\n[\s\S]*?```', _replace_mermaid, markdown)

    # Markdown → HTML → soup (sin los bloques mermaid)
    md   = MarkdownIt('commonmark').enable('table').enable('strikethrough')
    html = md.render(markdown_clean)
    soup = BeautifulSoup(html, 'html.parser')

    # ... resto del setup del doc (igual que antes) ...
    if template and os.path.exists(template):
        doc = load(template)
        for child in list(doc.text.childNodes):
            doc.text.removeChild(child)
    else:
        doc = OpenDocumentText()
        _apply_page_layout(doc)

    _apply_all_styles(doc)

    # Metadata
    try:
        if meta.get('title'):
            el = odf.dc.Title(); el.addText(meta['title']); doc.meta.addElement(el)
        if meta.get('creator'):
            el = odf.dc.Creator(); el.addText(meta['creator']); doc.meta.addElement(el)
        if meta.get('subject'):
            el = odf.dc.Subject(); el.addText(meta['subject']); doc.meta.addElement(el)
    except Exception:
        pass

    # Title
    title_p = _p('Titulo 1')
    title_p.setAttrNS(TEXTNS, 'outline-level', '1')
    _add_text_with_fields(title_p, title)
    doc.text.addElement(title_p)
    doc.text.addElement(_p('BodyText'))

    # Body — renderizar, inyectando imágenes donde había diagramas
    for node in soup.children:
        _render_block(doc, node)

    # Post-proceso: sustituir placeholders por imágenes
    # (los placeholders quedan como párrafos de texto)
    _inject_diagrams(doc, diagram_order, diagrams)

    doc.save(output_path)
    print(f'OK:{output_path}', flush=True)
    if len(sys.argv) < 3:
        print('Usage: export_odt.py <input.json> <output.odt> [template]', file=sys.stderr)
        sys.exit(1)

    input_path  = sys.argv[1]
    output_path = sys.argv[2]
    template    = sys.argv[3] if len(sys.argv) > 3 else None

    with open(input_path, encoding='utf-8') as f:
        data = json.load(f)

    title    = data.get('title', 'Acuerdo')
    markdown = data.get('markdown', '')
    meta     = data.get('meta', {})

    # Markdown → HTML
    md   = MarkdownIt('commonmark').enable('table').enable('strikethrough')
    html = md.render(markdown)

    # HTML → BeautifulSoup
    soup = BeautifulSoup(html, 'html.parser')

    # Load template or create new ODT
    if template and os.path.exists(template):
        doc = load(template)
        for child in list(doc.text.childNodes):
            doc.text.removeChild(child)
    else:
        doc = OpenDocumentText()
        _apply_page_layout(doc)

    _apply_all_styles(doc)

    # Metadata
    try:
        if meta.get('title'):
            el = odf.dc.Title(); el.addText(meta['title']); doc.meta.addElement(el)
        if meta.get('creator'):
            el = odf.dc.Creator(); el.addText(meta['creator']); doc.meta.addElement(el)
        if meta.get('subject'):
            el = odf.dc.Subject(); el.addText(meta['subject']); doc.meta.addElement(el)
    except Exception:
        pass

    # Title
    title_p = _p('Titulo 1')
    title_p.setAttrNS(TEXTNS, 'outline-level', '1')
    _add_text_with_fields(title_p, title)
    doc.text.addElement(title_p)
    doc.text.addElement(_p('BodyText'))  # blank line

    # Body
    for node in soup.children:
        _render_block(doc, node)

    doc.save(output_path)
    print(f'OK:{output_path}', flush=True)


if __name__ == '__main__':
    main()