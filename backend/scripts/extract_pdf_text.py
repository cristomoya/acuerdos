#!/usr/bin/env python3
"""
extract_pdf_text.py — Extrae texto y firmas electrónicas de PDFs de la administración española.

Detecta firmas de: AutoFirma, @firma (MINHAP), Adobe Sign, FNMT, DNIe,
portafirmas autonómicos, CSV (Código Seguro de Verificación).

Uso:  python3 extract_pdf_text.py <input.pdf> <output.json>
      python3 extract_pdf_text.py file1.pdf file2.pdf ... <output.json>
"""

import sys, json, re
from pathlib import Path

MESES_ES = {
    'enero':1,'febrero':2,'marzo':3,'abril':4,'mayo':5,'junio':6,
    'julio':7,'agosto':8,'septiembre':9,'octubre':10,'noviembre':11,'diciembre':12,
    'january':1,'february':2,'march':3,'april':4,'may':5,'june':6,
    'july':7,'august':8,'september':9,'october':10,'november':11,'december':12,
}
PALABRAS_RUIDO = {
    'DE','DEL','LA','LAS','LOS','EL','Y','EN','CON','POR','PARA','SOBRE',
    'SIN','NIF','DNI','NIE','CIF','FECHA','HORA','CLASE','CA','OU','CN',
    'CSV','TS','SELLO','TIEMPO','AND','THE',
}

# ─── EXTRACCIÓN DE TEXTO ──────────────────────────────────────────────────────

def extraer_texto_pdf(pdf_path):
    try:
        import pypdf
        reader = pypdf.PdfReader(pdf_path)
        paginas = len(reader.pages)
        partes = [page.extract_text() or '' for page in reader.pages]
        texto_meta = ''
        try:
            meta = reader.metadata
            if meta:
                texto_meta = '\n'.join(str(v) for v in meta.values() if v and isinstance(v,str) and len(str(v))>5)
        except Exception:
            pass
        return {'texto': '\n\n'.join(partes), 'texto_meta': texto_meta, 'paginas': paginas, 'metodo': 'pypdf'}
    except ImportError:
        pass
    try:
        from pdfminer.high_level import extract_text as pm_extract
        return {'texto': pm_extract(pdf_path) or '', 'texto_meta': '', 'paginas': 0, 'metodo': 'pdfminer'}
    except ImportError:
        pass
    with open(pdf_path,'rb') as f:
        raw = f.read()
    partes = re.findall(rb'[\x20-\x7e\xc0-\xff]{4,}', raw)
    return {'texto': '\n'.join(p.decode('latin-1','ignore') for p in partes), 'texto_meta': '', 'paginas': 0, 'metodo': 'raw'}

# ─── NORMALIZACIÓN ────────────────────────────────────────────────────────────

def normalizar_fecha(texto):
    if not texto:
        return None
    texto = str(texto).strip()
    m = re.search(r"D:(\d{4})(\d{2})(\d{2})", texto)
    if m: return f"{m.group(3)}/{m.group(2)}/{m.group(1)}"
    m = re.search(r'(\d{4})[.\-/](\d{2})[.\-/](\d{2})', texto)
    if m: return f"{m.group(3)}/{m.group(2)}/{m.group(1)}"
    m = re.search(r'(\d{1,2})[/\-\.](\d{1,2})[/\-\.](\d{4})', texto)
    if m: return f"{m.group(1).zfill(2)}/{m.group(2).zfill(2)}/{m.group(3)}"
    m = re.search(r'(\d{1,2})\s+de\s+([a-záéíóúüña-z]+)\s+(?:de\s+)?(\d{4})', texto, re.IGNORECASE)
    if m:
        mes = MESES_ES.get(m.group(2).lower())
        if mes: return f"{m.group(1).zfill(2)}/{str(mes).zfill(2)}/{m.group(3)}"
    return None

def limpiar_nombre(raw):
    if not raw: return None
    raw = re.sub(r'\s+(?:en\s+fecha|el\s+\d|NIF|DNI|NIE|C=ES|OU=|O=|fecha|date).*', '', raw, flags=re.IGNORECASE)
    raw = raw.strip().strip('-').strip(',').strip('()').strip()
    palabras_raw = raw.split()
    resultado = []
    for p in palabras_raw:
        pu = p.upper()
        if pu in PALABRAS_RUIDO and resultado:
            resultado.append(p.lower())
        elif re.match(r'^[A-ZÁÉÍÓÚÜÑA-Za-záéíóúüñ\-\.]+$', p) and len(p) >= 2:
            resultado.append(p.capitalize())
    return ' '.join(resultado) if len(resultado) >= 2 else None

def extraer_nif(ctx):
    m = re.search(r'(?:NIF|DNI|NIE|CIF)\s*:?\s*([0-9XYZ][0-9]{6,7}[A-Z])', ctx, re.IGNORECASE)
    return m.group(1).upper() if m else None

def extraer_rol(ctx):
    roles = [
        r'ALCALD[EA](?:\s*[-–]\s*PRESIDENT[EA])?',
        r'SECRETARI[OA](?:\s+MUNICIPAL)?(?:\s+GENERAL)?',
        r'INTERVENTOR[A]',r'TESORERO?[A]?',
        r'CONCEJAL(?:A)?(?:\s+DELEGAD[OA])?',
        r'JEFE\s+DE\s+SERVICIO',r'T[EÉ]CNICO\s+MUNICIPAL',
        r'DIRECTOR[A](?:\s+GENERAL)?',r'GERENTE',
    ]
    for rol_pat in roles:
        m = re.search(rol_pat, ctx, re.IGNORECASE)
        if m: return m.group(0).strip().title()
    return None

# ─── PATRONES DE FIRMA ────────────────────────────────────────────────────────

PATRONES_FIRMA = [
    # CN= (certificados FNMT/DNIe)
    {'pat': re.compile(r'CN=([A-ZÁÉÍÓÚÜÑ][A-ZÁÉÍÓÚÜÑ\s]{6,60}?)(?:,|\s+OU=|\s+O=|$)', re.IGNORECASE),
     'g_nombre':1, 'fuente':'fnmt'},
    # FIRMADO POR: NOMBRE - NIF: X - FECHA: Y (AutoFirma)
    {'pat': re.compile(r'FIRMADO\s+POR\s*:?\s*([A-ZÁÉÍÓÚÜÑ][A-ZÁÉÍÓÚÜÑ\s]{6,60}?)(?:\s*-\s*NIF\s*:?\s*([0-9XYZ][0-9]{6,7}[A-Z]))?(?:\s*-\s*FECHA\s*:?\s*([\d/\-\.:\s\'T+]+))?', re.IGNORECASE),
     'g_nombre':1, 'g_nif':2, 'g_fecha':3, 'fuente':'autofirma'},
    # Firmado digitalmente por NOMBRE
    {'pat': re.compile(r'[Ff]irmado\s+(?:digitalmente\s+)?(?:electr[oó]nicamente\s+)?por\s+([A-ZÁÉÍÓÚÜÑ][A-ZÁÉÍÓÚÜÑ\s]{6,60}?)(?:\s*\n|\s*Fecha|\s*-|\s*,)', re.IGNORECASE),
     'g_nombre':1, 'fuente':'firmado_por'},
    # Firmante: NOMBRE
    {'pat': re.compile(r'[Ff]irmante\s*:?\s*([A-ZÁÉÍÓÚÜÑ][A-ZÁÉÍÓÚÜÑ\s]{6,60}?)(?:\s*\n|\s*Fecha|\s*-)', re.IGNORECASE),
     'g_nombre':1, 'fuente':'firmante'},
    # Signed by: (Adobe)
    {'pat': re.compile(r'[Ss]igned\s+by\s*:?\s*([A-ZÁÉÍÓÚÜÑ][A-ZÁÉÍÓÚÜÑ\s]{6,60}?)(?:\s*\n|\s*Date)', re.IGNORECASE),
     'g_nombre':1, 'fuente':'adobe'},
    # Portafirmas: N de M - ROL - ENTIDAD - FECHA
    {'pat': re.compile(r'\d+\s+de\s+\d+\s*[-–]\s*([A-ZÁÉÍÓÚÜÑ\s]{4,40}?)\s*[-–]\s*([A-ZÁÉÍÓÚÜÑ\s]{4,40}?)\s*[-–]\s*([\d/\-\.\s:]+)', re.IGNORECASE),
     'g_nombre':2, 'g_rol_raw':1, 'g_fecha':3, 'fuente':'portafirmas'},
    # CSV + firmante
    {'pat': re.compile(r'CSV\s*:?\s*[A-Z0-9\-]+.*?(?:firmado\s+por|Firmante)\s*:?\s*([A-ZÁÉÍÓÚÜÑ][A-ZÁÉÍÓÚÜÑ\s]{6,60}?)\s+en\s+fecha\s+([\d/\-\.]+)', re.IGNORECASE|re.DOTALL),
     'g_nombre':1, 'g_fecha':2, 'fuente':'csv'},
    # /Name (NOMBRE) en diccionarios PDF
    {'pat': re.compile(r'/Name\s*\(([A-ZÁÉÍÓÚÜÑA-Za-záéíóúüñ\s,\.]{6,80}?)\)'),
     'g_nombre':1, 'fuente':'pdf_dict'},
]

PATRONES_FECHA_CTX = [
    re.compile(r"D:(\d{4}\d{2}\d{2}[\d:'+-]*)"),
    re.compile(r'[Ff]echa\s*(?:y\s+hora\s*)?(?:de\s+(?:la\s+)?firma)?\s*:?\s*([\d/\-\.:\s\'T+]{8,30})'),
    re.compile(r'[Dd]ate\s*:?\s*([\d/\-\.:\s\'T+]{8,30})'),
    re.compile(r'(\d{1,2}[/\-\.]\d{1,2}[/\-\.]\d{4})'),
    re.compile(r'(\d{4}[.\-]\d{2}[.\-]\d{2})'),
    re.compile(r'(\d{1,2}\s+de\s+\w+\s+de\s+\d{4})', re.IGNORECASE),
]

PAT_CSV = re.compile(r'CSV\s*:?\s*([A-Z0-9\-]{8,40})', re.IGNORECASE)

def _fecha_en_contexto(texto, pos, ventana=300):
    frag = texto[max(0,pos-50):min(len(texto),pos+ventana)]
    for pat in PATRONES_FECHA_CTX:
        m = pat.search(frag)
        if m:
            f = normalizar_fecha(m.group(1) if m.lastindex else m.group(0))
            if f: return f
    return None

def detectar_firmas(texto, texto_meta=''):
    total = texto + '\n' + texto_meta
    firmas = []
    vistas = set()
    for cfg in PATRONES_FIRMA:
        pat = cfg['pat']
        for m in pat.finditer(total):
            gi = cfg['g_nombre']
            nombre_raw = m.group(gi) if m.lastindex and m.lastindex >= gi else ''
            nombre = limpiar_nombre(nombre_raw)
            if not nombre: continue
            key = re.sub(r'\s+','',nombre).upper()
            if key in vistas: continue
            vistas.add(key)

            fecha = None
            if 'g_fecha' in cfg and m.lastindex and m.lastindex >= cfg['g_fecha']:
                fecha = normalizar_fecha((m.group(cfg['g_fecha']) or '').strip())
            if not fecha:
                fecha = _fecha_en_contexto(total, m.start())

            nif = None
            if 'g_nif' in cfg and m.lastindex and m.lastindex >= cfg['g_nif']:
                nif = m.group(cfg['g_nif'])
            if not nif:
                nif = extraer_nif(total[max(0,m.start()-50):min(len(total),m.end()+150)])

            ctx_rol = total[max(0,m.start()-100):min(len(total),m.end()+200)]
            rol = None
            if 'g_rol_raw' in cfg and m.lastindex and m.lastindex >= cfg['g_rol_raw']:
                rol = m.group(cfg['g_rol_raw']).strip().title()
            if not rol:
                rol = extraer_rol(ctx_rol)

            firmas.append({'firmante': nombre, 'fecha': fecha, 'nif': nif, 'rol': rol, 'fuente': cfg['fuente']})

    firmas.sort(key=lambda f: (f['fecha'] is None, f['firmante']))
    return firmas

def _firmas_desde_bytes(raw):
    firmas = []
    vistas = set()
    for m in re.finditer(rb'/Name\s*\(([^\)]{5,80})\)', raw):
        try:
            nombre = limpiar_nombre(m.group(1).decode('latin-1','ignore').strip())
            if not nombre: continue
            key = re.sub(r'\s+','',nombre).upper()
            if key in vistas: continue
            vistas.add(key)
            ctx = raw[max(0,m.start()-20):min(len(raw),m.end()+200)]
            fecha = None
            mf = re.search(rb"/M\s*\(D:(\d{14}[^\)]*)\)", ctx)
            if mf:
                fecha = normalizar_fecha(mf.group(1).decode('ascii','ignore'))
            firmas.append({'firmante':nombre,'fecha':fecha,'nif':None,'rol':None,'fuente':'pdf_bytes'})
        except Exception:
            continue
    return firmas

# ─── MAIN ─────────────────────────────────────────────────────────────────────

def procesar_pdf(pdf_path):
    if not Path(pdf_path).exists():
        return {'error': f'No encontrado: {pdf_path}', 'texto':'','firmas':[],'paginas':0,'archivo':Path(pdf_path).name}
    r = extraer_texto_pdf(pdf_path)
    firmas = detectar_firmas(r['texto'], r.get('texto_meta',''))
    if not firmas:
        try:
            with open(pdf_path,'rb') as f: raw=f.read()
            firmas = _firmas_desde_bytes(raw)
        except Exception:
            pass
    csv_code = PAT_CSV.search(r['texto'])
    return {
        'texto': r['texto'],
        'paginas': r['paginas'],
        'firmas': firmas,
        'csv': csv_code.group(1).strip() if csv_code else None,
        'metodo': r['metodo'],
        'archivo': Path(pdf_path).name,
    }

def main():
    if len(sys.argv) < 3:
        print('Uso: extract_pdf_text.py <pdf1> [pdf2 ...] <output.json>', file=sys.stderr)
        sys.exit(1)
    output_path = sys.argv[-1]
    pdf_paths = sys.argv[1:-1]

    if len(pdf_paths) == 1:
        datos = procesar_pdf(pdf_paths[0])
        with open(output_path,'w',encoding='utf-8') as f:
            json.dump(datos, f, ensure_ascii=False, indent=2)
        print(f"OK: {output_path} ({datos['paginas']} págs, {len(datos['firmas'])} firma(s))")
    else:
        resultados = [procesar_pdf(p) for p in pdf_paths]
        vistas = set()
        firmas_unicas = []
        for r in resultados:
            for firma in r['firmas']:
                key = re.sub(r'\s+','',firma['firmante']).upper()
                if key not in vistas:
                    vistas.add(key)
                    firma['documento'] = r['archivo']
                    firmas_unicas.append(firma)
        combinado = {
            'documentos': resultados,
            'texto_combinado': '\n\n---DOCUMENTO: '.join(
                f"{r['archivo']} ---\n{r['texto']}" for r in resultados
            ),
            'firmas_combinadas': firmas_unicas,
            'total_paginas': sum(r['paginas'] for r in resultados),
        }
        with open(output_path,'w',encoding='utf-8') as f:
            json.dump(combinado, f, ensure_ascii=False, indent=2)
        print(f"OK: {len(pdf_paths)} docs, {len(firmas_unicas)} firmante(s) únicos")

if __name__ == '__main__':
    main()
