#!/usr/bin/env python3
"""
export_odt.py — Genera documentos ODT de contratación municipal con el formato
institucional fijo (cabecera con membrete, caja de expediente, tablas de datos/
económica, aviso y firma). El documento se construye siempre desde cero: no se
admite ni se usa ninguna plantilla .odt/.ott externa.

Usage:
  python3 export_odt.py <input.json> <output.odt>

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
      "tipo": "aviso",           # callout azul corporativo con borde izquierdo
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

import sys, os, json, re, unicodedata
from copy import deepcopy

import mistune
from odf.opendocument import OpenDocumentText
from odf.style import (Style, TextProperties, ParagraphProperties, PageLayout,
                        MasterPage, TableCellProperties, TableProperties,
                        TableRowProperties, TableColumnProperties)
from odf.element import Element
from odf.text import P, Span, H, LineBreak
from odf.table import Table, TableRow, TableCell, TableColumn
from odf.draw import Frame, Image as DrawImage
from odf.namespaces import STYLENS, FONS, TEXTNS, OFFICENS, TABLENS

# Escudo institucional (icono recortado del logo oficial, sin el texto
# "Ayuntamiento de Totana" que ya se compone como texto enriquecido).
ASSETS_DIR  = os.path.join(os.path.dirname(os.path.abspath(__file__)), 'assets')
ESCUDO_PATH = os.path.join(ASSETS_DIR, 'escudo_icon.png')
ESCUDO_W_PX, ESCUDO_H_PX = 280, 254

# ─── COLOR PALETTE (Manual de Identidad Corporativa, Ayuntamiento de Totana) ──
# Color principal: azul corporativo #0075bf (CMYK 100 40 0 0 / RGB 0 117 191).
# Combinaciones permitidas: blanco o negro sobre azul; azul o negro sobre
# blanco (sec. 6.2). No se usan colores no corporativos (naranja, dorado...)
# en ningún acento ni callout.
AZUL_INS    = "#0075bf"   # azul corporativo (color principal)
AZUL_OSCURO = "#0f2a40"   # azul secundario (acentos oscuros, p.ej. firma)
AZUL_TINT   = "#eaf4fb"   # tinte muy claro del azul (fondos de aviso/notas)
AZUL_TINT_B = "#bfe0f3"   # tinte medio del azul (bordes de aviso/notas)
GRIS_LABEL = "#5b6470"   # etiquetas tabla
GRIS_TEXTO = "#262d3a"   # texto cuerpo (negro, sec. 7.1 "Texto párrafo: Negro")
GRIS_CLARO = "#e2e4e8"   # líneas separadoras
GRIS_BG    = "#f3f5f8"   # fondo fila total / fondo CSV
GRIS_META  = "#9aa0a8"   # texto secundario

# Tipografía corporativa (sec. 5.1): HK Grotesk, con Inter como alternativa
# (sec. 2.1.3, usada en el escudo) y fallback a fuentes del sistema.
FONT_SANS = "'HK Grotesk', Inter, Arial, sans-serif"
FONT_MONO = "'Liberation Mono', Consolas, monospace"


# ─── HELPERS DE TEXTO (para heurísticas de detección) ────────────────────────

def _plainText(node):
    """Extrae el texto plano de un token mistune (o lista de tokens), ignorando
    cualquier formato inline (negrita, cursiva, campos {{...}}, etc.)."""
    if isinstance(node, list):
        return ''.join(_plainText(n) for n in node)
    if isinstance(node, str):
        return node
    if not isinstance(node, dict):
        return ''
    if node.get('type') == 'text':
        return node.get('raw', '')
    children = node.get('children')
    if children:
        return ''.join(_plainText(c) for c in children)
    return node.get('raw', '')


def _norm(s):
    """Normaliza para comparaciones: minúsculas, sin acentos, espacios simples."""
    s = unicodedata.normalize('NFKD', s or '')
    s = ''.join(c for c in s if not unicodedata.combining(c))
    return ' '.join(s.lower().split())


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
                 font=FONT_SANS, lh="150%", weight=None,
                 color=None, border_bottom=None, text_indent=None):
    s = Style(name=name, family="paragraph")
    pp = ParagraphProperties()
    fo(pp, 'text-align', align)
    fo(pp, 'margin-bottom', mb)
    fo(pp, 'margin-top', mt)
    fo(pp, 'line-height', lh)
    if text_indent:
        fo(pp, 'text-indent', text_indent)
    if border_bottom:
        # border-bottom: grosor estilo color (ej. "0.5pt solid #1f3a5f")
        fo(pp, 'border-bottom', border_bottom)
        fo(pp, 'padding-bottom', '0.15cm')
    s.addElement(pp)
    tp = TextProperties()
    fo(tp, 'font-size', size)
    fo(tp, 'font-family', font)
    if weight: fo(tp, 'font-weight', weight)
    elif bold: fo(tp, 'font-weight', 'bold')
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
    addParaStyle(doc, 'BodyText',    '10pt', mb='0.25cm', lh='100%',
                 color=GRIS_TEXTO, text_indent='1.2cm')
    addParaStyle(doc, 'BodySmall',   '8.5pt', mb='0.2cm', lh='160%',
                 color='#5b6470')
    addParaStyle(doc, 'BodyNote',    '9pt', mb='0.15cm', lh='160%',
                 color='#5b6470')

    # Cabecera institución
    addParaStyle(doc, 'InstNombre',  '14pt', bold=True, mb='0.1cm', mt='0cm',
                 font=FONT_SANS, color=AZUL_INS, lh='110%')
    addParaStyle(doc, 'InstSubdep',  '7pt', mb='0.1cm', mt='0.1cm',
                 font=FONT_SANS, color=GRIS_LABEL, lh='110%')
    addParaStyle(doc, 'InstDirec',   '7pt', mb='0cm', font=FONT_SANS,
                 color=GRIS_META, lh='110%')

    # Expediente box
    addParaStyle(doc, 'ExpLabel',    '6pt', bold=True, mb='0cm', mt='0cm',
                 font=FONT_SANS, color='#ffffff', lh='110%')
    addParaStyle(doc, 'ExpNumero',   '15pt', bold=True, mb='0cm', mt='0.1cm',
                 font=FONT_SANS, color=AZUL_INS, lh='100%')
    addParaStyle(doc, 'ExpTipo',     '7pt', mb='0.1cm', mt='0cm',
                 font=FONT_SANS, color='#6b7280', lh='110%')

    # Título principal
    addParaStyle(doc, 'DocSupratit', '7pt', mb='0.1cm', mt='0.8cm',
                 font=FONT_SANS, color=GRIS_META, align='center',
                 lh='110%')
    addParaStyle(doc, 'DocTitle',    '20pt', weight='900', mb='0.3cm', mt='0.2cm',
                 font=FONT_SANS, color=AZUL_INS, align='center',
                 lh='110%')
    addParaStyle(doc, 'TitleRule',   '3pt', mb='0.5cm', mt='0cm',
                 align='center', color=AZUL_INS)

    # H2 sección (uppercase, borde inferior azul)
    addParaStyle(doc, 'SeccionH2',   '10pt', bold=True, mb='0.3cm', mt='0.7cm',
                 font=FONT_SANS, color=AZUL_INS, lh='110%',
                 border_bottom=f'0.75pt solid {AZUL_INS}')

    # Tabla datos — etiqueta
    addParaStyle(doc, 'TabLabel',    '7pt', bold=True, mb='0cm',
                 font=FONT_SANS, color=GRIS_LABEL, lh='130%')
    # Tabla datos — valor
    addParaStyle(doc, 'TabValor',    '9.5pt', mb='0cm', lh='150%',
                 color=GRIS_TEXTO)
    addParaStyle(doc, 'TabValorBold','9.5pt', bold=True, mb='0cm', lh='150%',
                 color=GRIS_TEXTO)
    # Tabla económica
    addParaStyle(doc, 'EcoLabel',    '9.5pt', mb='0cm', lh='140%',
                 color='#3a4150')
    addParaStyle(doc, 'EcoValor',    '9.5pt', bold=True, mb='0cm', lh='140%',
                 font=FONT_SANS, color=GRIS_TEXTO, align='end')
    addParaStyle(doc, 'EcoTotalLab', '9.5pt', bold=True, mb='0cm', lh='140%',
                 font=FONT_SANS, color=AZUL_INS)
    addParaStyle(doc, 'EcoTotalVal', '11pt', bold=True, mb='0cm', lh='140%',
                 font=FONT_SANS, color=AZUL_INS, align='end')

    # Callout aviso
    # AvisoText: el borde izquierdo se gestiona via estilo de celda TC_AvisoLeft

    # Firma / pie
    addParaStyle(doc, 'FirmaTit',    '6pt', bold=True, mb='0cm', mt='0.2cm',
                 font=FONT_SANS, color=AZUL_INS, align='center', lh='110%')
    addParaStyle(doc, 'FirmaSubt',   '7.5pt', mb='0cm', mt='0.1cm',
                 color=GRIS_META, align='center', lh='110%')
    addParaStyle(doc, 'CSVLabel',    '5.5pt', bold=False, mb='0.05cm',
                 font=FONT_SANS, color=GRIS_META, lh='110%')
    addParaStyle(doc, 'CSVCode',     '7.5pt', mb='0cm',
                 font=FONT_MONO, color='#3a4150', lh='110%')

    # Listas
    addParaStyle(doc, 'ListaBul',    '10pt', mb='0.1cm', lh='170%',
                 color=GRIS_TEXTO, text_indent='1.2cm')
    addParaStyle(doc, 'ListaNum',    '10pt', mb='0.1cm', lh='170%',
                 color=GRIS_TEXTO, text_indent='1.2cm')

    # Tabla markdown genérica
    addParaStyle(doc, 'MdTableHeadTxt', '8.5pt', bold=True, mb='0cm', lh='140%',
                 font=FONT_SANS, color='#ffffff')
    addParaStyle(doc, 'MdTableCellTxt', '9pt', mb='0cm', lh='150%',
                 color=GRIS_TEXTO)

    # ── estilos de texto inline ──
    addTextStyle(doc, 'Bold',         bold=True)
    addTextStyle(doc, 'Italic',       italic=True)
    addTextStyle(doc, 'BoldItalic',   bold=True, italic=True)
    addTextStyle(doc, 'FieldMarker',  bg='#FFFF00')
    addTextStyle(doc, 'CodeInline',   font=FONT_MONO, size='8pt',
                 bg='#F4F4F0')
    addTextStyle(doc, 'TextBold',     bold=True, color=GRIS_TEXTO)
    addTextStyle(doc, 'TextNaranja',  bold=True,
                 color=AZUL_OSCURO, font=FONT_SANS)
    addTextStyle(doc, 'AvisoBold',    bold=True, color=AZUL_OSCURO,
                 font=FONT_SANS)

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

    # Callout aviso (azul corporativo, sin colores ajenos a la marca)
    addTableCellStyle(doc, 'TC_AvisoLeft',
                      bg=AZUL_TINT,
                      border_left=f'3pt solid {AZUL_INS}',
                      border_top=f'0.4pt solid {AZUL_TINT_B}',
                      border_bottom=f'0.4pt solid {AZUL_TINT_B}',
                      border_right=f'0.4pt solid {AZUL_TINT_B}',
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
        pass

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
        quote_inline = []
        for c in children:
            if c.get('type') == 'paragraph':
                quote_inline.extend(c.get('children', []))
        plain = _plainText(quote_inline)
        # Citas que avisan de algo importante (⚠ o la palabra "IMPORTANTE")
        # se renderizan como el callout azul, no como cita genérica.
        if '⚠' in plain or 'importante' in _norm(plain):
            addAvisoFromInline(doc, quote_inline)
        else:
            for c in children:
                if c.get('type') == 'paragraph':
                    p = P(stylename='BodyNote')
                    p.addText('| ')
                    for ic in c.get('children', []): renderStyledText(p, ic)
                    doc.text.addElement(p)

    elif t == 'thematic_break':
        # restos de separadores de página del documento original (Word);
        # este formato ya tiene sus propias reglas visuales (SeccionH2, TitleRule)
        pass

    elif t == 'html':
        clean = re.sub(r'<[^>]+>', '', raw).strip()
        if clean:
            p = P(stylename='BodyText')
            renderInline(p, clean)
            doc.text.addElement(p)


def renderTable(doc, token):
    """Renderiza un token mistune tipo 'table' (children: table_head, table_body).
    Las tablas de 2 columnas (el patrón habitual «etiqueta | valor» de estos
    documentos) se renderizan con el estilo institucional de tabla de datos
    o económica (ver renderKeyValueTable); el resto usa una rejilla genérica."""
    head = next((c for c in token.get('children', []) if c.get('type') == 'table_head'), None)
    body = next((c for c in token.get('children', []) if c.get('type') == 'table_body'), None)
    head_cells = head.get('children', []) if head else []
    body_rows = body.get('children', []) if body else []
    n_cols = len(head_cells) or max((len(r.get('children', [])) for r in body_rows), default=0)
    if n_cols == 0:
        return

    if n_cols == 2 and body_rows and all(len(r.get('children', [])) >= 2 for r in body_rows):
        label_cells = [r['children'][0].get('children', []) for r in body_rows]
        value_cells = [r['children'][1].get('children', []) for r in body_rows]
        renderKeyValueTable(doc, label_cells, value_cells)
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


def renderKeyValueTable(doc, label_cells, value_cells):
    """Renderiza una tabla de 2 columnas (etiqueta/valor) detectando
    automáticamente si es una tabla económica (contiene IVA/presupuesto en
    alguna etiqueta) — con la fila de "total" destacada en azul — o una
    tabla de datos institucional normal (líneas separadoras finas, sin
    rejilla completa)."""
    n = len(label_cells)
    if n == 0:
        return
    label_norm = [_norm(_plainText(c)) for c in label_cells]
    is_economic = any(('iva' in t) or ('presupuesto' in t) for t in label_norm)

    if is_economic:
        def build_rows(tbl):
            for i in range(n):
                is_total = 'total' in label_norm[i]
                lc = 'TC_EcoTotalLabel' if is_total else 'TC_EcoLabel'
                vc = 'TC_EcoTotalValor' if is_total else 'TC_EcoValor'
                lp = 'EcoTotalLab' if is_total else 'EcoLabel'
                vp = 'EcoTotalVal' if is_total else 'EcoValor'
                p_l = P(stylename=lp)
                for c in label_cells[i]: renderStyledText(p_l, c)
                p_v = P(stylename=vp)
                for c in value_cells[i]: renderStyledText(p_v, c)
                tbl.addElement(mkRow([mkCell(lc, [p_l]), mkCell(vc, [p_v])]))
        addTable(doc, 'TBL_Eco', [10.0, 6.5], build_rows)
    else:
        def build_rows(tbl):
            for i in range(n):
                is_last = (i == n - 1)
                lc = 'TC_LabelLast' if is_last else 'TC_Label'
                vc = 'TC_ValorLast' if is_last else 'TC_Valor'
                p_l = mkP('TabLabel', _plainText(label_cells[i]).upper())
                p_v = P(stylename='TabValor')
                for c in value_cells[i]: renderStyledText(p_v, c)
                tbl.addElement(mkRow([mkCell(lc, [p_l]), mkCell(vc, [p_v])]))
        addTable(doc, 'TBL_Datos', [5.6, 10.9], build_rows)


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


def buildTable(doc, style_name, col_widths_cm, rows_fn):
    """
    Construye una tabla (sin añadirla al documento todavía).
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
    return tbl


def addTable(doc, style_name, col_widths_cm, rows_fn):
    """Construye una tabla y la añade al documento."""
    doc.text.addElement(buildTable(doc, style_name, col_widths_cm, rows_fn))


# ─── SECCIÓN: CABECERA INSTITUCIONAL ─────────────────────────────────────────

def addCabeceraInstitucional(doc, expediente, tipo_contrato,
                              institucion='AYUNTAMIENTO DE TOTANA',
                              subdep='Negociado de Contratación',
                              direccion='Plaza de la Constitución, 1 · 30850 Totana (Murcia)'):
    """Genera la cabecera con nombre ayuntamiento y caja expediente.
    Si no hay número de expediente, se omite la caja (nunca se muestra
    un placeholder literal sin resolver)."""

    inst_block = [
        mkP('InstNombre', institucion),
        mkP('InstSubdep', subdep),
        mkP('InstDirec',  direccion),
    ]

    if expediente:
        def build_rows(tbl):
            tbl_inst = buildEscudoConNombreTable(doc, inst_block,
                                                  col_icon_cm=2.0, total_w_cm=10.5)
            tc_inst = TableCell()
            st(tc_inst, 'style-name', 'TC_Bare')
            tc_inst.addElement(tbl_inst)

            # tabla interna para la caja de expediente
            tbl_exp = Table()
            st(tbl_exp, 'style-name', 'TBL_Datos')

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
    else:
        addEscudoConNombre(doc, inst_block)

    addHeaderRule(doc)


def addHeaderRule(doc):
    """Línea azul separadora bajo la cabecera institucional. No hay forma
    directa en ODT de hacer un <hr> estilizado; se simula con un párrafo
    vacío con borde inferior."""
    exists = False
    for s in doc.styles.childNodes:
        try:
            if s.getAttribute('name') == 'HdrRule':
                exists = True
                break
        except (ValueError, AttributeError):
            continue
    if not exists:
        rule_style = Style(name='HdrRule', family="paragraph")
        rule_pp = ParagraphProperties()
        fo(rule_pp, 'border-bottom', f'1.5pt solid {AZUL_INS}')
        fo(rule_pp, 'margin-bottom', '0.35cm')
        fo(rule_pp, 'margin-top', '0cm')
        fo(rule_pp, 'padding-bottom', '0.05cm')
        rule_style.addElement(rule_pp)
        doc.styles.addElement(rule_style)
    doc.text.addElement(P(stylename='HdrRule'))


def _escudoIconParagraph(doc, icon_height_cm=1.5):
    """Párrafo con el icono del escudo institucional incrustado (frame
    en línea, tamaño proporcional al recorte de assets/escudo_icon.png)."""
    href = doc.addPicture(ESCUDO_PATH)
    icon_w_cm = icon_height_cm * (ESCUDO_W_PX / ESCUDO_H_PX)
    frame = Frame(width=f'{icon_w_cm:.2f}cm', height=f'{icon_height_cm}cm',
                  anchortype='as-char')
    frame.addElement(DrawImage(href=href))
    p = P(stylename='BodyText')
    p.addElement(frame)
    return p


def buildEscudoConNombreTable(doc, nombre_paragraphs, icon_height_cm=1.5,
                               col_icon_cm=2.3, total_w_cm=16.5):
    """Construye (sin insertar en el documento) la tabla de cabecera con el
    escudo a la izquierda y el nombre de la institución (+ subdepartamento/
    dirección) a la derecha — variación "en bandera izquierda" del manual de
    identidad (sec. 2.8), la recomendada para cabeceras."""
    p_icon = _escudoIconParagraph(doc, icon_height_cm)

    def build_rows(tbl):
        tbl.addElement(mkRow([mkCell('TC_Bare', [p_icon]),
                               mkCell('TC_Bare', nombre_paragraphs)]))

    return buildTable(doc, 'TBL_Hdr', [col_icon_cm, total_w_cm - col_icon_cm],
                       build_rows)


def addEscudoConNombre(doc, nombre_paragraphs, icon_height_cm=1.5,
                        col_icon_cm=2.3, total_w_cm=16.5):
    """Añade al documento la cabecera con escudo + nombre (ver
    buildEscudoConNombreTable)."""
    doc.text.addElement(buildEscudoConNombreTable(
        doc, nombre_paragraphs, icon_height_cm, col_icon_cm, total_w_cm))


# ─── SECCIÓN: TÍTULO PRINCIPAL ────────────────────────────────────────────────

def addTituloPrincipal(doc, title, subtitulo=None):
    if subtitulo:
        doc.text.addElement(mkP('DocSupratit', subtitulo.upper()))
    doc.text.addElement(mkP('DocTitle', title.upper()))
    # línea decorativa azul
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

def _ensureAvisoStyle(doc):
    """Crea (si no existe) el estilo automático de párrafo del aviso: borde
    izquierdo y fondo en tinte de azul corporativo (sin colores ajenos a la
    marca, sec. 6.2 del manual de identidad). Devuelve el nombre del estilo."""
    aviso_style_name = 'AvisoParagraph'
    exists = any(getattr(s, 'getAttribute', lambda x: None)('name') == aviso_style_name
                 for s in doc.automaticstyles.childNodes)
    if not exists:
        s = Style(name=aviso_style_name, family='paragraph')
        pp = ParagraphProperties()
        fo(pp, 'background-color', AZUL_TINT)
        fo(pp, 'border-left',   f'3pt solid {AZUL_INS}')
        fo(pp, 'border-top',    f'0.4pt solid {AZUL_TINT_B}')
        fo(pp, 'border-bottom', f'0.4pt solid {AZUL_TINT_B}')
        fo(pp, 'border-right',  f'0.4pt solid {AZUL_TINT_B}')
        fo(pp, 'padding-top',    '0.2cm')
        fo(pp, 'padding-bottom', '0.2cm')
        fo(pp, 'padding-left',   '0.4cm')
        fo(pp, 'padding-right',  '0.4cm')
        fo(pp, 'margin-top',     '0.3cm')
        fo(pp, 'margin-bottom',  '0.3cm')
        fo(pp, 'line-height',    '160%')
        s.addElement(pp)
        tp = TextProperties()
        fo(tp, 'font-size', '9pt')
        fo(tp, 'color', AZUL_OSCURO)
        fo(tp, 'font-family', FONT_SANS)
        s.addElement(tp)
        doc.automaticstyles.addElement(s)
    return aviso_style_name


def addAviso(doc, texto, negrita_inicio=None, md_parser=None):
    """Caja de aviso con borde izquierdo y fondo en tinte de azul (modo
    estructurado: recibe texto plano)."""
    aviso_style_name = _ensureAvisoStyle(doc)
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


def addAvisoFromInline(doc, children):
    """Caja de aviso a partir de tokens inline de mistune (modo markdown):
    preserva la negrita/formato ya presente en el texto original (p.ej.
    **IMPORTANTE**, **EXCLUIDA**)."""
    aviso_style_name = _ensureAvisoStyle(doc)
    p = P(stylename=aviso_style_name)
    for c in children:
        renderStyledText(p, c)
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


# ─── CUERPO COMPLETO DESDE MARKDOWN (modo habitual, sin "secciones") ─────────

def renderDocumentBody(doc, tokens):
    """Renderiza el cuerpo completo de un modelo cuando llega como markdown
    plano (caso real de uso: server.js nunca rellena `secciones`, el
    contenido completo —cabecera, título, tablas, avisos— ya viene escrito
    por el usuario dentro del propio cuerpo). Aplica el look institucional
    directamente sobre esa estructura, sin añadir ninguna cabecera/título
    automáticos por separado (evitando así duplicarlos):

      - El primer encabezado del documento se trata como nombre de la
        institución; si le sigue un párrafo corto, se trata como
        subdepartamento. Se cierra con la línea azul separadora.
      - Dos encabezados consecutivos (sin nada entremedias) se tratan como
        título principal + subtítulo (con la línea decorativa azul).
      - El resto de encabezados de nivel 1-2 son secciones (SeccionH2).
      - Las tablas y citas de aviso se gestionan en renderTable/renderBlock.
    """
    n = len(tokens)
    i = 0
    first_heading_done = False
    while i < n:
        token = tokens[i]
        t = token.get('type', '')
        level = token.get('attrs', {}).get('level', 1)

        if t == 'heading' and level <= 2:
            if not first_heading_done:
                first_heading_done = True
                p = P(stylename='InstNombre')
                for c in token.get('children', []): renderStyledText(p, c)
                nombre_paragraphs = [p]

                j = i + 1
                if (j < n and tokens[j].get('type') == 'paragraph'
                        and len(_plainText(tokens[j])) <= 80):
                    sp = P(stylename='InstSubdep')
                    for c in tokens[j].get('children', []): renderStyledText(sp, c)
                    nombre_paragraphs.append(sp)
                    i = j + 1
                else:
                    i += 1

                addEscudoConNombre(doc, nombre_paragraphs)
                addHeaderRule(doc)
                continue

            j = i + 1
            if (j < n and tokens[j].get('type') == 'heading'
                    and tokens[j].get('attrs', {}).get('level', 1) <= 2):
                title_txt = _plainText(token.get('children', []))
                sub_txt = _plainText(tokens[j].get('children', []))
                addTituloPrincipal(doc, title_txt, sub_txt)
                i = j + 1
                continue

            p = P(stylename='SeccionH2')
            for c in token.get('children', []): renderStyledText(p, c)
            doc.text.addElement(p)
            i += 1
            continue

        renderBlock(doc, token)
        i += 1


# ─── MAIN ─────────────────────────────────────────────────────────────────────

def main():
    # Nota: no se admite ninguna plantilla .odt/.ott externa. El documento se
    # genera siempre desde cero con el formato institucional fijo (cabecera,
    # caja de expediente, tablas y firma) para garantizar un resultado
    # consistente independientemente del modelo/origen del contenido.
    if len(sys.argv) < 3:
        print("Usage: export_odt.py <input.json> <output.odt>", file=sys.stderr)
        sys.exit(1)

    input_path  = sys.argv[1]
    output_path = sys.argv[2]

    with open(input_path, 'r', encoding='utf-8') as f:
        data = json.load(f)

    title         = data.get('title', 'DOCUMENTO')
    categoria     = data.get('categoria', '')
    subtitulo     = data.get('subtitulo') or categoria
    expediente    = data.get('expediente', '')
    tipo_contrato = data.get('tipo_contrato') or categoria
    secciones     = data.get('secciones', [])
    extra_md      = data.get('markdown', '')

    doc = OpenDocumentText()
    applyPageLayout(doc)
    applyAllStyles(doc)

    md_parser = mistune.create_markdown(renderer=None, plugins=['table'])

    if not secciones:
        # Modo habitual: el cuerpo del modelo ya trae su propia cabecera,
        # título y secciones escritos como markdown (caso real de la app:
        # server.js solo envía `markdown`, nunca `secciones`). Se aplica el
        # look institucional directamente sobre esa estructura para no
        # duplicar cabecera/título.
        if extra_md:
            renderDocumentBody(doc, md_parser(extra_md))
        doc.save(output_path)
        print(f"OK:{output_path}", flush=True)
        return

    # ── Modo estructurado (compatibilidad con el contrato JSON documentado
    # al inicio de este archivo): cabecera y título explícitos por separado
    # de las `secciones`. ──
    addCabeceraInstitucional(doc, expediente, tipo_contrato)
    addTituloPrincipal(doc, title, subtitulo)

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