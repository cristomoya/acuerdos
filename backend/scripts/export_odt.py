#!/usr/bin/env python3
"""
export_odt.py — Genera documentos ODT de contratación municipal con maquetación
similar a la plantilla visual del Ayuntamiento de Totana.

Usage:
  python3 export_odt.py <input.json> <output.odt> [template.ott]

Campos input.json:
  title         : título del documento (ej. "INVITACIÓN A PRESENTAR OFERTA")
  subtitulo     : línea bajo el título (ej. "Contrato Menor — Art. 118 LCSP")
  expediente    : número de expediente (ej. "5017/2026")
  tipo_contrato : tipo mostrado bajo el expediente (ej. "Contrato Menor de Obras")
  secciones     : lista de secciones del documento (ver estructura abajo)
  markdown      : (opcional) cuerpo en markdown adicional al final

Estructura de secciones:
  [
    {
      "tipo": "datos",           # tabla de clave-valor sin bordes laterales
      "titulo": "Datos del expediente",
      "filas": [["Tipo de contrato", "Obras"], ...]
    },
    {
      "tipo": "economica",       # tabla con IVA y total destacado
      "titulo": null,
      "filas": [
        ["Presupuesto base (sin IVA)", "13.035,00 €"],
        ["IVA (21 %)", "3.465,00 €"],
        ["total", "16.500,00 €"]   # la fila con "total" recibe fondo azul
      ]
    },
    {
      "tipo": "aviso",           # callout con borde izquierdo naranja
      "texto": "IMPORTANTE. No se admitirán ofertas por Sede Electrónica..."
    },
    {
      "tipo": "texto",           # párrafo(s) de cuerpo
      "markdown": "..."
    },
    {
      "tipo": "firma",           # pie con CSV + firma electrónica
      "lugar": "Totana",
      "cargo": "El/La Responsable del Negociado de Contratación"
    }
  ]
"""

import sys, json, re, os
from copy import deepcopy

import mistune
from odf.opendocument import OpenDocumentText, load
from odf.style import (Style, TextProperties, ParagraphProperties, PageLayout,
                        MasterPage, TableCellProperties, TableProperties,
                        TableRowProperties, TableColumnProperties)
from odf.element import Element
from odf.text import P, Span, H, LineBreak
from odf.table import Table, TableRow, TableCell, TableColumn
from odf.namespaces import STYLENS, FONS, TEXTNS, OFFICENS, TABLENS

# ─── COLOR PALETTE (idéntica al HTM) ──────────────────────────────────────────
AZUL_INS   = "#1f3a5f"   # azul institucional
GRIS_LABEL = "#5b6470"   # etiquetas tabla
GRIS_TEXTO = "#262d3a"   # texto cuerpo
GRIS_CLARO = "#e2e4e8"   # líneas separadoras
GRIS_BG    = "#f3f5f8"   # fondo fila total / fondo CSV
NARANJA    = "#b85c2e"   # acento callout
NARANJA_BG = "#fbf3ee"   # fondo callout
DORADO     = "#c9a04e"   # línea decorativa bajo título
GRIS_META  = "#9aa0a8"   # texto secundario


# ─── HELPERS NS ───────────────────────────────────────────────────────────────

def fo(el, attr, val):
    el.setAttrNS(FONS, attr, val)

def st(el, attr, val):
    el.setAttrNS(STYLENS, attr, val)

def tbl(el, attr, val):
    el.setAttrNS(TABLENS, attr, val)


# ─── ESTILOS PÁRRAFO ──────────────────────────────────────────────────────────

def addParaStyle(doc, name, size="12pt", bold=False, italic=False,
                 align="start", mb="0.2cm", mt="0cm",
                 font="Liberation Serif", lh="150%",
                 color=None, border_bottom=None):
    s = Style(name=name, family="paragraph")
    pp = ParagraphProperties()
    fo(pp, 'text-align', align)
    fo(pp, 'margin-bottom', mb)
    fo(pp, 'margin-top', mt)
    fo(pp, 'line-height', lh)
    if border_bottom:
        # border-bottom: grosor estilo color (ej. "0.5pt solid #1f3a5f")
        fo(pp, 'border-bottom', border_bottom)
        fo(pp, 'padding-bottom', '0.15cm')
    s.addElement(pp)
    tp = TextProperties()
    fo(tp, 'font-size', size)
    fo(tp, 'font-family', font)
    if bold:   fo(tp, 'font-weight', 'bold')
    if italic: fo(tp, 'font-style', 'italic')
    if color:  fo(tp, 'color', color)
    s.addElement(tp)
    doc.styles.addElement(s)


def addTextStyle(doc, name, bold=False, italic=False,
                  bg=None, color=None, font=None, size=None):
    s = Style(name=name, family="text")
    tp = TextProperties()
    if bold:   fo(tp, 'font-weight', 'bold')
    if italic: fo(tp, 'font-style', 'italic')
    if bg:     fo(tp, 'background-color', bg)
    if color:  fo(tp, 'color', color)
    if font:   fo(tp, 'font-family', font)
    if size:   fo(tp, 'font-size', size)
    s.addElement(tp)
    doc.styles.addElement(s)


def addTableCellStyle(doc, name, bg=None, border_bottom=None,
                       border_top=None, valign="middle",
                       padding_top="0.2cm", padding_bottom="0.2cm",
                       padding_left="0.3cm", padding_right="0.3cm",
                       border_left=None, border_right=None):
    s = Style(name=name, family="table-cell")
    tcp = TableCellProperties()
    if bg:            fo(tcp, 'background-color', bg)
    if border_bottom: fo(tcp, 'border-bottom', border_bottom)
    if border_top:    fo(tcp, 'border-top', border_top)
    if border_left:   fo(tcp, 'border-left', border_left)
    if border_right:  fo(tcp, 'border-right', border_right)
    if not any([border_bottom, border_top, border_left, border_right]):
        fo(tcp, 'border', 'none')
    fo(tcp, 'padding-top',    padding_top)
    fo(tcp, 'padding-bottom', padding_bottom)
    fo(tcp, 'padding-left',   padding_left)
    fo(tcp, 'padding-right',  padding_right)
    st(tcp, 'vertical-align', valign)
    s.addElement(tcp)
    doc.styles.addElement(s)


def applyAllStyles(doc):
    """Define todos los estilos de contenido."""
    # ── párrafos ──
    addParaStyle(doc, 'BodyText',    '12pt', mb='0.25cm', lh='170%',
                 color=GRIS_TEXTO)
    addParaStyle(doc, 'BodySmall',   '10.5pt', mb='0.2cm', lh='160%',
                 color='#5b6470')
    addParaStyle(doc, 'BodyNote',    '11pt', mb='0.15cm', lh='160%',
                 color='#5b6470')

    # Cabecera institución
    addParaStyle(doc, 'InstNombre',  '16pt', bold=True, mb='0.1cm', mt='0cm',
                 font='Liberation Sans', color=AZUL_INS, lh='110%')
    addParaStyle(doc, 'InstSubdep',  '9pt', mb='0.1cm', mt='0.1cm',
                 font='Liberation Sans', color=GRIS_LABEL, lh='110%')
    addParaStyle(doc, 'InstDirec',   '9pt', mb='0cm', font='Liberation Serif',
                 color=GRIS_META, lh='110%')

    # Expediente box
    addParaStyle(doc, 'ExpLabel',    '8pt', bold=True, mb='0cm', mt='0cm',
                 font='Liberation Sans', color='#ffffff', lh='110%')
    addParaStyle(doc, 'ExpNumero',   '17pt', bold=True, mb='0cm', mt='0.1cm',
                 font='Liberation Sans', color=AZUL_INS, lh='100%')
    addParaStyle(doc, 'ExpTipo',     '9pt', mb='0.1cm', mt='0cm',
                 font='Liberation Serif', color='#6b7280', lh='110%')

    # Título principal
    addParaStyle(doc, 'DocSupratit', '9pt', mb='0.1cm', mt='0.8cm',
                 font='Liberation Sans', color=GRIS_META, align='center',
                 lh='110%')
    addParaStyle(doc, 'DocTitle',    '22pt', bold=True, mb='0.3cm', mt='0.2cm',
                 font='Liberation Sans', color=AZUL_INS, align='center',
                 lh='110%')
    addParaStyle(doc, 'TitleRule',   '3pt', mb='0.5cm', mt='0cm',
                 align='center', color=DORADO)

    # H2 sección (uppercase, borde inferior azul)
    addParaStyle(doc, 'SeccionH2',   '9.5pt', bold=True, mb='0cm', mt='0.7cm',
                 font='Liberation Sans', color=AZUL_INS, lh='110%',
                 border_bottom=f'0.75pt solid {AZUL_INS}')

    # Tabla datos — etiqueta
    addParaStyle(doc, 'TabLabel',    '9pt', bold=True, mb='0cm',
                 font='Liberation Sans', color=GRIS_LABEL, lh='130%')
    # Tabla datos — valor
    addParaStyle(doc, 'TabValor',    '11.5pt', mb='0cm', lh='150%',
                 color=GRIS_TEXTO)
    addParaStyle(doc, 'TabValorBold','11.5pt', bold=True, mb='0cm', lh='150%',
                 color=GRIS_TEXTO)
    # Tabla económica
    addParaStyle(doc, 'EcoLabel',    '11.5pt', mb='0cm', lh='140%',
                 color='#3a4150')
    addParaStyle(doc, 'EcoValor',    '11.5pt', bold=True, mb='0cm', lh='140%',
                 font='Liberation Sans', color=GRIS_TEXTO, align='end')
    addParaStyle(doc, 'EcoTotalLab', '11.5pt', bold=True, mb='0cm', lh='140%',
                 font='Liberation Sans', color=AZUL_INS)
    addParaStyle(doc, 'EcoTotalVal', '13pt', bold=True, mb='0cm', lh='140%',
                 font='Liberation Sans', color=AZUL_INS, align='end')

    # Callout aviso
    # AvisoText: el borde izquierdo se gestiona via estilo de celda TC_AvisoLeft

    # Firma / pie
    addParaStyle(doc, 'FirmaTit',    '8pt', bold=True, mb='0cm', mt='0.2cm',
                 font='Liberation Sans', color=AZUL_INS, align='center', lh='110%')
    addParaStyle(doc, 'FirmaSubt',   '9.5pt', mb='0cm', mt='0.1cm',
                 color=GRIS_META, align='center', lh='110%')
    addParaStyle(doc, 'CSVLabel',    '7.5pt', bold=False, mb='0.05cm',
                 font='Liberation Sans', color=GRIS_META, lh='110%')
    addParaStyle(doc, 'CSVCode',     '9.5pt', mb='0cm',
                 font='Liberation Mono', color='#3a4150', lh='110%')

    # Listas
    addParaStyle(doc, 'ListaBul',    '12pt', mb='0.1cm', lh='170%',
                 color=GRIS_TEXTO)
    addParaStyle(doc, 'ListaNum',    '12pt', mb='0.1cm', lh='170%',
                 color=GRIS_TEXTO)

    # Tabla markdown genérica
    addParaStyle(doc, 'MdTableHeadTxt', '10.5pt', bold=True, mb='0cm', lh='140%',
                 font='Liberation Sans', color='#ffffff')
    addParaStyle(doc, 'MdTableCellTxt', '11pt', mb='0cm', lh='150%',
                 color=GRIS_TEXTO)

    # ── estilos de texto inline ──
    addTextStyle(doc, 'Bold',         bold=True)
    addTextStyle(doc, 'Italic',       italic=True)
    addTextStyle(doc, 'BoldItalic',   bold=True, italic=True)
    addTextStyle(doc, 'FieldMarker',  bg='#FFFF00', color='#0000CC',
                 font='Liberation Mono', size='10pt')
    addTextStyle(doc, 'CodeInline',   font='Liberation Mono', size='10pt',
                 bg='#F4F4F0')
    addTextStyle(doc, 'TextBold',     bold=True, color=GRIS_TEXTO)
    addTextStyle(doc, 'TextNaranja',  bold=True,
                 color='#8a3f1c', font='Liberation Sans')
    addTextStyle(doc, 'AvisoBold',    bold=True, color='#8a3f1c',
                 font='Liberation Sans')

    # ── estilos tabla ──

    # Tabla datos (sin bordes excepto separadores horizontales)
    addTableCellStyle(doc, 'TC_Label',
                      border_bottom=f'0.4pt solid {GRIS_CLARO}',
                      padding_bottom='0.22cm', padding_top='0.22cm',
                      padding_left='0cm', padding_right='0.3cm')
    addTableCellStyle(doc, 'TC_LabelLast',
                      padding_bottom='0.22cm', padding_top='0.22cm',
                      padding_left='0cm', padding_right='0.3cm')
    addTableCellStyle(doc, 'TC_Valor',
                      border_bottom=f'0.4pt solid {GRIS_CLARO}',
                      padding_bottom='0.22cm', padding_top='0.22cm',
                      padding_left='0cm', padding_right='0cm')
    addTableCellStyle(doc, 'TC_ValorLast',
                      padding_bottom='0.22cm', padding_top='0.22cm',
                      padding_left='0cm', padding_right='0cm')

    # Tabla económica (con borde exterior)
    borde_eco = f'0.4pt solid {GRIS_CLARO}'
    addTableCellStyle(doc, 'TC_EcoLabel',
                      border_bottom=borde_eco,
                      border_top='none', border_left='none', border_right='none',
                      padding_left='0.35cm', padding_right='0.35cm',
                      padding_top='0.2cm', padding_bottom='0.2cm')
    addTableCellStyle(doc, 'TC_EcoValor',
                      border_bottom=borde_eco,
                      border_top='none', border_left='none', border_right='none',
                      padding_left='0.35cm', padding_right='0.35cm',
                      padding_top='0.2cm', padding_bottom='0.2cm')
    addTableCellStyle(doc, 'TC_EcoTotalLabel',
                      bg=GRIS_BG, border_bottom='none',
                      border_top='none', border_left='none', border_right='none',
                      padding_left='0.35cm', padding_right='0.35cm',
                      padding_top='0.25cm', padding_bottom='0.25cm')
    addTableCellStyle(doc, 'TC_EcoTotalValor',
                      bg=GRIS_BG, border_bottom='none',
                      border_top='none', border_left='none', border_right='none',
                      padding_left='0.35cm', padding_right='0.35cm',
                      padding_top='0.25cm', padding_bottom='0.25cm')

    # Cabecera institucional
    addTableCellStyle(doc, 'TC_Hdr',
                      padding_left='0cm', padding_right='0cm',
                      padding_top='0cm', padding_bottom='0.25cm',
                      border_bottom=f'2pt solid {AZUL_INS}')
    addTableCellStyle(doc, 'TC_ExpBox',
                      border_top=f'0.4pt solid {GRIS_CLARO}',
                      border_bottom=f'0.4pt solid {GRIS_CLARO}',
                      border_left=f'0.4pt solid {GRIS_CLARO}',
                      border_right=f'0.4pt solid {GRIS_CLARO}',
                      padding_left='0.3cm', padding_right='0.3cm',
                      padding_top='0cm', padding_bottom='0.2cm')
    addTableCellStyle(doc, 'TC_ExpBoxLabel',
                      bg=AZUL_INS,
                      border_top='none', border_bottom='none',
                      border_left='none', border_right='none',
                      padding_left='0.3cm', padding_right='0.3cm',
                      padding_top='0.12cm', padding_bottom='0.12cm')

    # Callout aviso
    addTableCellStyle(doc, 'TC_AvisoLeft',
                      bg=NARANJA_BG,
                      border_left=f'3pt solid {NARANJA}',
                      border_top=f'0.4pt solid #e6c9b6',
                      border_bottom=f'0.4pt solid #e6c9b6',
                      border_right=f'0.4pt solid #e6c9b6',
                      padding_left='0.35cm', padding_right='0.35cm',
                      padding_top='0.25cm', padding_bottom='0.25cm')

    # Celda firma
    addTableCellStyle(doc, 'TC_FirmaBox',
                      border_bottom=f'0.4pt solid {GRIS_CLARO}',
                      padding_left='0cm', padding_right='0cm',
                      padding_top='0cm', padding_bottom='0.2cm')
    addTableCellStyle(doc, 'TC_CSV',
                      bg=GRIS_BG,
                      border_top=f'0.4pt solid {GRIS_CLARO}',
                      border_bottom=f'0.4pt solid {GRIS_CLARO}',
                      border_left=f'0.4pt solid {GRIS_CLARO}',
                      border_right=f'0.4pt solid {GRIS_CLARO}',
                      padding_left='0.2cm', padding_right='0.2cm',
                      padding_top='0.12cm', padding_bottom='0.12cm')
    addTableCellStyle(doc, 'TC_Bare',
                      padding_left='0cm', padding_right='0cm',
                      padding_top='0cm', padding_bottom='0cm')

    # Tabla markdown genérica (grid completo)
    borde_md = f'0.4pt solid {GRIS_CLARO}'
    addTableCellStyle(doc, 'TC_MdHead',
                      bg=AZUL_INS,
                      border_top=borde_md, border_bottom=borde_md,
                      border_left=borde_md, border_right=borde_md,
                      padding_left='0.25cm', padding_right='0.25cm',
                      padding_top='0.18cm', padding_bottom='0.18cm')
    addTableCellStyle(doc, 'TC_MdCell',
                      border_top=borde_md, border_bottom=borde_md,
                      border_left=borde_md, border_right=borde_md,
                      padding_left='0.25cm', padding_right='0.25cm',
                      padding_top='0.18cm', padding_bottom='0.18cm')

    # Estilos de tabla completa
    _addTableStyle(doc, 'TBL_Datos')
    _addTableStyle(doc, 'TBL_Eco')
    _addTableStyle(doc, 'TBL_Hdr')
    _addTableStyle(doc, 'TBL_Firma')
    _addTableStyle(doc, 'TBL_Aviso')
    _addTableStyle(doc, 'TBL_Md')


def _addTableStyle(doc, name):
    s = Style(name=name, family="table")
    tp = TableProperties()
    fo(tp, 'margin-top', '0cm')
    fo(tp, 'margin-bottom', '0.2cm')
    st(tp, 'width', '16.5cm')
    s.addElement(tp)
    doc.styles.addElement(s)


def applyPageLayout(doc):
    if doc.masterstyles.childNodes:
        return
    pl = PageLayout(name="ContratoPage")
    plp = Element(qname=(STYLENS, 'page-layout-properties'))
    fo(plp, 'margin-top',    '2.2cm')
    fo(plp, 'margin-bottom', '2.2cm')
    fo(plp, 'margin-left',   '2.5cm')
    fo(plp, 'margin-right',  '2.5cm')
    fo(plp, 'page-width',    '21cm')
    fo(plp, 'page-height',   '29.7cm')
    pl.addElement(plp)
    doc.automaticstyles.addElement(pl)
    mp = MasterPage(name="Standard", pagelayoutname="ContratoPage")
    doc.masterstyles.addElement(mp)


# ─── INLINE RENDER ────────────────────────────────────────────────────────────

FIELD_RE = re.compile(r'\{\{([A-Z][A-Z0-9_]*)\}\}')


def renderInline(parent, text):
    last = 0
    for m in FIELD_RE.finditer(text):
        if m.start() > last:
            parent.addText(text[last:m.start()])
        sp = Span(stylename='FieldMarker')
        sp.addText(m.group(0))
        parent.addElement(sp)
        last = m.end()
    if last < len(text):
        parent.addText(text[last:])


def renderStyledText(parent, token):
    if isinstance(token, str):
        renderInline(parent, token)
        return
    t = token.get('type', '')
    children = token.get('children', [])
    raw = token.get('raw', '')
    if t == 'text':
        renderInline(parent, token.get('raw', ''))
    elif t == 'strong':
        sp = Span(stylename='Bold')
        for c in children: renderStyledText(sp, c)
        parent.addElement(sp)
    elif t == 'emphasis':
        sp = Span(stylename='Italic')
        for c in children: renderStyledText(sp, c)
        parent.addElement(sp)
    elif t == 'codespan':
        sp = Span(stylename='CodeInline')
        sp.addText(raw)
        parent.addElement(sp)
    elif t in ('linebreak', 'softlinebreak'):
        parent.addElement(LineBreak())
    elif t == 'link':
        for c in children: renderStyledText(parent, c)
    else:
        if children:
            for c in children: renderStyledText(parent, c)
        elif raw:
            renderInline(parent, raw)


# ─── BLOQUE MARKDOWN ──────────────────────────────────────────────────────────

def renderBlock(doc, token):
    t = token.get('type', '')
    children = token.get('children', [])
    attrs = token.get('attrs', {})
    raw = token.get('raw', '')

    if t == 'heading':
        level = attrs.get('level', 1)
        if level <= 2:
            addSeccionH2(doc, '')
            h = doc.text.lastChild
            h.childNodes.clear() if hasattr(h, 'childNodes') else None
            # regeneramos con el contenido real
            doc.text.removeChild(h)
            # usar un párrafo con estilo SeccionH2
            p = P(stylename='SeccionH2')
            for c in children: renderStyledText(p, c)
            doc.text.addElement(p)
        else:
            p = P(stylename='BodyText')
            sp = Span(stylename='Bold')
            for c in children: renderStyledText(sp, c)
            p.addElement(sp)
            doc.text.addElement(p)

    elif t == 'paragraph':
        p = P(stylename='BodyText')
        for c in children: renderStyledText(p, c)
        doc.text.addElement(p)

    elif t == 'blank_line':
        doc.text.addElement(P(stylename='BodyText'))

    elif t == 'block_code':
        for line in raw.splitlines():
            p = P(stylename='BodyText')
            sp = Span(stylename='CodeInline')
            sp.addText(line or ' ')
            p.addElement(sp)
            doc.text.addElement(p)

    elif t in ('list', 'bullet_list', 'ordered_list'):
        ordered = t == 'ordered_list' or attrs.get('ordered', False)
        for i, item in enumerate(children, 1):
            renderListItem(doc, item, ordered=ordered, num=i)

    elif t == 'list_item':
        renderListItem(doc, token)

    elif t == 'table':
        renderTable(doc, token)

    elif t == 'block_quote':
        for c in children:
            if c.get('type') == 'paragraph':
                p = P(stylename='BodyNote')
                p.addText('| ')
                for ic in c.get('children', []): renderStyledText(p, ic)
                doc.text.addElement(p)

    elif t == 'thematic_break':
        p = P(stylename='BodyText')
        p.addText('─' * 60)
        doc.text.addElement(p)

    elif t == 'html':
        clean = re.sub(r'<[^>]+>', '', raw).strip()
        if clean:
            p = P(stylename='BodyText')
            renderInline(p, clean)
            doc.text.addElement(p)


def renderTable(doc, token):
    """Renderiza un token mistune tipo 'table' (children: table_head, table_body)."""
    head = next((c for c in token.get('children', []) if c.get('type') == 'table_head'), None)
    body = next((c for c in token.get('children', []) if c.get('type') == 'table_body'), None)
    head_cells = head.get('children', []) if head else []
    body_rows = body.get('children', []) if body else []
    n_cols = len(head_cells) or max((len(r.get('children', [])) for r in body_rows), default=0)
    if n_cols == 0:
        return
    col_w = 16.5 / n_cols

    def build_rows(tbl):
        if head_cells:
            cells = []
            for hc in head_cells:
                p = P(stylename='MdTableHeadTxt')
                for ic in hc.get('children', []): renderStyledText(p, ic)
                cells.append(mkCell('TC_MdHead', [p]))
            tbl.addElement(mkRow(cells))
        for row in body_rows:
            cells = []
            for rc in row.get('children', []):
                p = P(stylename='MdTableCellTxt')
                for ic in rc.get('children', []): renderStyledText(p, ic)
                cells.append(mkCell('TC_MdCell', [p]))
            tbl.addElement(mkRow(cells))

    addTable(doc, 'TBL_Md', [col_w] * n_cols, build_rows)


def renderListItem(doc, item, ordered=False, num=1):
    children = item.get('children', [])
    p = P(stylename='ListaBul' if not ordered else 'ListaNum')
    prefix = f'{num}. ' if ordered else '• '
    p.addText(prefix)
    for c in children:
        if c.get('type') in ('paragraph', 'block_text'):
            for ic in c.get('children', []): renderStyledText(p, ic)
        elif c.get('type') == 'text':
            renderStyledText(p, c)
        elif c.get('type') in ('list', 'bullet_list', 'ordered_list'):
            doc.text.addElement(p)
            for sub in c.get('children', []):
                sp = P(stylename='ListaBul')
                sp.addText('   ◦ ')
                for sc in sub.get('children', []):
                    if sc.get('type') in ('paragraph', 'block_text'):
                        for ic in sc.get('children', []): renderStyledText(sp, ic)
                doc.text.addElement(sp)
            return
    doc.text.addElement(p)


# ─── SECCIONES ESPECÍFICAS DEL DOCUMENTO ─────────────────────────────────────

def mkP(style, text='', bold_span=False):
    """Crea un párrafo simple."""
    p = P(stylename=style)
    if text:
        if bold_span:
            sp = Span(stylename='Bold')
            sp.addText(text)
            p.addElement(sp)
        else:
            p.addText(text)
    return p


def mkCell(style, children=None):
    """Crea una TableCell con estilo."""
    tc = TableCell()
    st(tc, 'style-name', style)
    if children:
        for ch in children:
            tc.addElement(ch)
    return tc


def mkRow(cells):
    tr = TableRow()
    for c in cells:
        tr.addElement(c)
    return tr


def addTable(doc, style_name, col_widths_cm, rows_fn):
    """
    Añade una tabla al documento.
    col_widths_cm: lista de anchos en cm (ej. [5.5, 11.0])
    rows_fn: función que recibe la tabla y añade filas
    """
    tbl = Table()
    st(tbl, 'style-name', style_name)

    for w in col_widths_cm:
        col = TableColumn()
        # estilo de columna con ancho
        col_style = f'ColW_{w}'.replace('.', '_')
        if not any(getattr(s, 'getAttribute', lambda x: None)('name') == col_style
                   for s in doc.automaticstyles.childNodes):
            s = Style(name=col_style, family="table-column")
            tcp = TableColumnProperties()
            st(tcp, 'column-width', f'{w}cm')
            s.addElement(tcp)
            doc.automaticstyles.addElement(s)
        st(col, 'style-name', col_style)
        tbl.addElement(col)

    rows_fn(tbl)
    doc.text.addElement(tbl)


# ─── SECCIÓN: CABECERA INSTITUCIONAL ─────────────────────────────────────────

def addCabeceraInstitucional(doc, expediente, tipo_contrato):
    """Genera la cabecera con nombre ayuntamiento y caja expediente."""

    def build_rows(tbl):
        # fila única, 2 columnas: institución | expediente
        tc_inst = mkCell('TC_Bare', [
            mkP('InstNombre', 'AYUNTAMIENTO DE TOTANA'),
            mkP('InstSubdep', 'Negociado de Contratación'),
            mkP('InstDirec',  'Plaza de la Constitución, 1 · 30850 Totana (Murcia)'),
        ])

        # Caja expediente: label azul + número + tipo
        tc_exp_inner = mkCell('TC_ExpBoxLabel', [mkP('ExpLabel', 'EXPEDIENTE')])
        tr_label = mkRow([tc_exp_inner])

        # tabla interna para la caja
        tbl_exp = Table()
        st(tbl_exp, 'style-name', 'TBL_Datos')

        # col única
        col_exp = TableColumn()
        col_style = 'ColW_5_5'
        if not any(getattr(s, 'getAttribute', lambda x: None)('name') == col_style
                   for s in doc.automaticstyles.childNodes):
            s2 = Style(name=col_style, family="table-column")
            tcp2 = TableColumnProperties()
            st(tcp2, 'column-width', '5.5cm')
            s2.addElement(tcp2)
            doc.automaticstyles.addElement(s2)
        st(col_exp, 'style-name', col_style)
        tbl_exp.addElement(col_exp)
        tbl_exp.addElement(mkRow([mkCell('TC_ExpBoxLabel', [mkP('ExpLabel', 'EXPEDIENTE')])]))
        tbl_exp.addElement(mkRow([mkCell('TC_ExpBox', [
            mkP('ExpNumero', expediente),
            mkP('ExpTipo', tipo_contrato),
        ])]))

        tc_exp = TableCell()
        st(tc_exp, 'style-name', 'TC_Bare')
        tc_exp.addElement(tbl_exp)

        tbl.addElement(mkRow([tc_inst, tc_exp]))

    addTable(doc, 'TBL_Hdr', [10.5, 6.0], build_rows)

    # línea azul separadora bajo la cabecera
    p_rule = P(stylename='BodyText')
    # simulamos la línea con borde inferior en un párrafo vacío
    # No hay forma directa en ODT de hacer un <hr> estilizado;
    # usamos un párrafo con borde inferior
    rule_style = Style(name='HdrRule', family="paragraph")
    rule_pp = ParagraphProperties()
    fo(rule_pp, 'border-bottom', f'1.5pt solid {AZUL_INS}')
    fo(rule_pp, 'margin-bottom', '0.35cm')
    fo(rule_pp, 'margin-top', '0cm')
    fo(rule_pp, 'padding-bottom', '0.05cm')
    rule_style.addElement(rule_pp)
    # verificar que no exista ya
    exists = False
    for s in doc.styles.childNodes:
        try:
            if s.getAttribute('name') == 'HdrRule':
                exists = True
                break
        except (ValueError, AttributeError):
            continue
    if not exists:
        doc.styles.addElement(rule_style)
    p_rule = P(stylename='HdrRule')
    doc.text.addElement(p_rule)


# ─── SECCIÓN: TÍTULO PRINCIPAL ────────────────────────────────────────────────

def addTituloPrincipal(doc, title, subtitulo=None):
    if subtitulo:
        doc.text.addElement(mkP('DocSupratit', subtitulo.upper()))
    doc.text.addElement(mkP('DocTitle', title.upper()))
    # línea dorada decorativa
    doc.text.addElement(mkP('TitleRule', '━━━━━━━━'))


# ─── SECCIÓN: H2 DE SECCIÓN ───────────────────────────────────────────────────

def addSeccionH2(doc, titulo):
    p = P(stylename='SeccionH2')
    p.addText(titulo.upper() if titulo else '')
    doc.text.addElement(p)


# ─── SECCIÓN: TABLA DE DATOS (filas clave-valor) ─────────────────────────────

def addTablaDatos(doc, filas, titulo=None, col_label_pct=0.34):
    if titulo:
        addSeccionH2(doc, titulo)
        doc.text.addElement(P(stylename='BodyText'))  # pequeño espacio

    n = len(filas)
    col_label = 16.5 * col_label_pct
    col_valor = 16.5 - col_label

    def build_rows(tbl):
        for i, (label, valor) in enumerate(filas):
            is_last = (i == n - 1)
            lc = 'TC_LabelLast' if is_last else 'TC_Label'
            vc = 'TC_ValorLast' if is_last else 'TC_Valor'
            # ¿valor en negrita? (si la clave contiene "importe" o "valor")
            v_style = 'TabValorBold' if any(k in label.lower() for k in
                      ['importe', 'valor estimado', 'precio']) else 'TabValor'
            tc_l = mkCell(lc, [mkP('TabLabel', label.upper())])
            tc_v = mkCell(vc, [mkP(v_style, valor)])
            tbl.addElement(mkRow([tc_l, tc_v]))

    addTable(doc, 'TBL_Datos', [col_label, col_valor], build_rows)


# ─── SECCIÓN: TABLA ECONÓMICA ─────────────────────────────────────────────────

def addTablaEconomica(doc, filas):
    """filas: lista de [label, valor]. La fila cuyo label sea 'total'
    se renderiza con fondo azul oscuro."""

    def build_rows(tbl):
        for label, valor in filas:
            is_total = label.lower() == 'total'
            lc = 'TC_EcoTotalLabel' if is_total else 'TC_EcoLabel'
            vc = 'TC_EcoTotalValor' if is_total else 'TC_EcoValor'
            lp = 'EcoTotalLab' if is_total else 'EcoLabel'
            vp = 'EcoTotalVal' if is_total else 'EcoValor'
            tc_l = mkCell(lc, [mkP(lp, label if not is_total else 'Importe total (IVA incluido)')])
            tc_v = mkCell(vc, [mkP(vp, valor)])
            tbl.addElement(mkRow([tc_l, tc_v]))

    # borde exterior (añadir estilo tabla con bordes)
    addTable(doc, 'TBL_Eco', [10.0, 6.5], build_rows)


# ─── SECCIÓN: CALLOUT DE AVISO ────────────────────────────────────────────────

def addAviso(doc, texto, negrita_inicio=None, md_parser=None):
    """Caja de aviso con borde izquierdo naranja y fondo crema.
    Se implementa con un párrafo de estilo automático que lleva
    background-color y border-left (más fiable que celda en LibreOffice PDF)."""

    # Crear estilo automático de párrafo para el aviso
    aviso_style_name = 'AvisoParagraph'
    exists = any(getattr(s, 'getAttribute', lambda x: None)('name') == aviso_style_name
                 for s in doc.automaticstyles.childNodes)
    if not exists:
        s = Style(name=aviso_style_name, family='paragraph')
        pp = ParagraphProperties()
        fo(pp, 'background-color', NARANJA_BG)
        fo(pp, 'border-left',   f'3pt solid {NARANJA}')
        fo(pp, 'border-top',    f'0.4pt solid #e6c9b6')
        fo(pp, 'border-bottom', f'0.4pt solid #e6c9b6')
        fo(pp, 'border-right',  f'0.4pt solid #e6c9b6')
        fo(pp, 'padding-top',    '0.2cm')
        fo(pp, 'padding-bottom', '0.2cm')
        fo(pp, 'padding-left',   '0.4cm')
        fo(pp, 'padding-right',  '0.4cm')
        fo(pp, 'margin-top',     '0.3cm')
        fo(pp, 'margin-bottom',  '0.3cm')
        fo(pp, 'line-height',    '160%')
        s.addElement(pp)
        tp = TextProperties()
        fo(tp, 'font-size', '11pt')
        fo(tp, 'color', '#5a3520')
        fo(tp, 'font-family', 'Liberation Serif')
        s.addElement(tp)
        doc.automaticstyles.addElement(s)

    p = P(stylename=aviso_style_name)
    if negrita_inicio and texto.startswith(negrita_inicio):
        sp_b = Span(stylename='AvisoBold')
        sp_b.addText(negrita_inicio + ' ')
        p.addElement(sp_b)
        resto = texto[len(negrita_inicio):].strip()
    else:
        resto = texto
    _renderAvisoText(p, resto)
    doc.text.addElement(p)


def _renderAvisoText(p, texto):
    """Renderiza texto del aviso, poniendo en negrita palabras en MAYÚSCULAS."""
    # Detecta palabras todo-mayúsculas de 4+ letras
    parts = re.split(r'(\b[A-ZÁÉÍÓÚÑ]{4,}\b)', texto)
    for part in parts:
        if re.match(r'^[A-ZÁÉÍÓÚÑ]{4,}$', part):
            sp = Span(stylename='Bold')
            sp.addText(part)
            p.addElement(sp)
        else:
            p.addText(part)


# ─── SECCIÓN: PIE DE FIRMA ────────────────────────────────────────────────────

def addPieFirma(doc, lugar="Totana", cargo="El/La Responsable del Negociado de Contratación"):
    doc.text.addElement(P(stylename='BodyText'))  # espacio

    def build_rows(tbl):
        # col izquierda: CSV | col derecha: espacio firma
        tc_csv = mkCell('TC_CSV', [
            mkP('CSVLabel', 'Código Seguro de Verificación (CSV)'),
            mkP('CSVCode',  '________-____-____-____-____________'),
        ])
        tc_firma = mkCell('TC_FirmaBox', [
            mkP('BodyNote', f'{lugar}, a la fecha al margen señalada.'),
            P(stylename='BodyText'),   # espacio para la firma
            P(stylename='BodyText'),
            mkP('FirmaTit',  'Documento firmado electrónicamente'),
            mkP('FirmaSubt', cargo),
        ])
        tbl.addElement(mkRow([tc_csv, tc_firma]))

    addTable(doc, 'TBL_Firma', [7.5, 9.0], build_rows)


def _renderInlineMd(p, text, md_parser):
    """Renderiza una cadena con posible markdown inline (**bold**, _italic_) en un párrafo."""
    tokens = md_parser(text)
    for token in tokens:
        t = token.get('type', '')
        children = token.get('children', [])
        if t in ('paragraph', 'inline'):
            for c in children:
                renderStyledText(p, c)
        elif t == 'text':
            renderInline(p, token.get('raw', ''))
        else:
            if children:
                for c in children:
                    renderStyledText(p, c)
            elif token.get('raw'):
                renderInline(p, token['raw'])


# ─── MAIN ─────────────────────────────────────────────────────────────────────

def main():
    if len(sys.argv) < 3:
        print("Usage: export_odt.py <input.json> <output.odt> [template.ott]",
              file=sys.stderr)
        sys.exit(1)

    input_path  = sys.argv[1]
    output_path = sys.argv[2]
    template    = sys.argv[3] if len(sys.argv) > 3 else None

    with open(input_path, 'r', encoding='utf-8') as f:
        data = json.load(f)

    title         = data.get('title', 'DOCUMENTO')
    subtitulo     = data.get('subtitulo', '')
    expediente    = data.get('expediente', '{{EXPEDIENTE}}')
    tipo_contrato = data.get('tipo_contrato', '')
    secciones     = data.get('secciones', [])
    extra_md      = data.get('markdown', '')

    # Crear/cargar documento
    if template and os.path.exists(template):
        doc = load(template)
        for child in list(doc.text.childNodes):
            doc.text.removeChild(child)
    else:
        doc = OpenDocumentText()
        applyPageLayout(doc)

    applyAllStyles(doc)

    # ── CABECERA ──
    addCabeceraInstitucional(doc, expediente, tipo_contrato)

    # ── TÍTULO ──
    addTituloPrincipal(doc, title, subtitulo)

    # ── SECCIONES ──
    md_parser = mistune.create_markdown(renderer=None, plugins=['table'])

    for sec in secciones:
        tipo = sec.get('tipo', 'texto')

        if tipo == 'datos':
            addTablaDatos(doc, sec.get('filas', []),
                          titulo=sec.get('titulo'))

        elif tipo == 'economica':
            if sec.get('titulo'):
                addSeccionH2(doc, sec['titulo'])
                doc.text.addElement(P(stylename='BodyText'))
            addTablaEconomica(doc, sec.get('filas', []))
            if sec.get('nota'):
                p = P(stylename='BodyNote')
                p.addText(sec['nota'])
                doc.text.addElement(p)

        elif tipo == 'aviso':
            texto = sec.get('texto', '')
            negrita = sec.get('negrita_inicio')
            addAviso(doc, texto, negrita_inicio=negrita, md_parser=md_parser)

        elif tipo == 'texto':
            md_text = sec.get('markdown', sec.get('texto', ''))
            if sec.get('titulo'):
                addSeccionH2(doc, sec['titulo'])
                doc.text.addElement(P(stylename='BodyText'))
            if md_text:
                for token in md_parser(md_text):
                    renderBlock(doc, token)

        elif tipo == 'lista':
            if sec.get('titulo'):
                addSeccionH2(doc, sec['titulo'])
                doc.text.addElement(P(stylename='BodyText'))
            for item in sec.get('items', []):
                p = P(stylename='ListaBul')
                p.addText('• ')
                _renderInlineMd(p, item, md_parser)
                doc.text.addElement(p)

        elif tipo == 'lista_num':
            if sec.get('titulo'):
                addSeccionH2(doc, sec['titulo'])
                doc.text.addElement(P(stylename='BodyText'))
            for i, item in enumerate(sec.get('items', []), 1):
                p = P(stylename='ListaNum')
                p.addText(f'{i}. ')
                _renderInlineMd(p, item, md_parser)
                doc.text.addElement(p)

        elif tipo == 'nota':
            p = P(stylename='BodyNote')
            renderInline(p, sec.get('texto', ''))
            doc.text.addElement(p)

        elif tipo == 'salto_pagina':
            # párrafo con salto de página
            p = P(stylename='BodyText')
            brk = Element(qname=(TEXTNS, 'p'))
            from odf.namespaces import FONS
            pp = ParagraphProperties()
            fo(pp, 'break-before', 'page')
            s_pb = Style(name='PageBreak', family='paragraph')
            s_pb.addElement(pp)
            if not any(getattr(s, 'getAttribute', lambda x: None)('name') == 'PageBreak'
                       for s in doc.automaticstyles.childNodes):
                doc.automaticstyles.addElement(s_pb)
            doc.text.addElement(P(stylename='PageBreak'))

        elif tipo == 'firma':
            addPieFirma(doc,
                        lugar=sec.get('lugar', 'Totana'),
                        cargo=sec.get('cargo', 'El/La Responsable del Negociado de Contratación'))

    # ── MARKDOWN ADICIONAL ──
    if extra_md:
        for token in md_parser(extra_md):
            renderBlock(doc, token)

    doc.save(output_path)
    print(f"OK:{output_path}", flush=True)


if __name__ == '__main__':
    main()