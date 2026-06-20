/* ia-generator.js — Generación de acuerdo con IA (multi-PDF + export ODT)
   Requiere: app.js cargado antes (para las funciones token, api, toast,
   openModal, closeModal, activeId, tpls, updatePreview, openModel)
*/

// ─── ESTADO ───────────────────────────────────────────────────────────────────
const IA = {
  pdfTexto: '',
  pdfTextoPreview: '',
  firmas: [],           // [{ firmante, fecha, nif, rol, fuente, documento? }]
  nArchivos: 0,
  acuerdoGenerado: '',
  iaDisponible: false,
  cargando: false,
  _archivos: [],        // File[] pendientes de subir
};

// ─── INICIALIZACIÓN ───────────────────────────────────────────────────────────

async function iaInit() {
  try {
    const r = await fetch('/api/auth/me', {
      credentials: 'include'
    });

    if (!r.ok) return;

    IA.iaDisponible = true;

    const btn = document.getElementById('btn-ia');
    if (btn) btn.style.display = '';
  } catch (e) {
    console.error(e);
  }
}

iaInit();

// ─── ABRIR MODAL ──────────────────────────────────────────────────────────────
function abrirModalIA() {
  if (!activeId) { toast('Selecciona un modelo primero'); return; }
  _iaReset();
  openModal('m-ia-generator');
  _iaInitDragDrop();
}

// ─── RESET ────────────────────────────────────────────────────────────────────
function _iaReset() {
  Object.assign(IA, { pdfTexto:'', pdfTextoPreview:'', firmas:[], nArchivos:0, acuerdoGenerado:'', cargando:false, _archivos:[] });
  _iaSetStep(1);
  const ids = ['ia-instrucciones','ia-resultado'];
  ids.forEach(id => { const el = document.getElementById(id); if (el) el.value = ''; });
  const el = document.getElementById('ia-pdf-preview');
  if (el) el.textContent = '';
  const meta = document.getElementById('ia-pdf-meta');
  if (meta) meta.innerHTML = '';
  const fw = document.getElementById('ia-firmas-wrap');
  if (fw) fw.style.display = 'none';
  const rl = document.getElementById('ia-resultado-loading');
  if (rl) rl.style.display = 'none';
  const ra = document.getElementById('ia-resultado-actions');
  if (ra) ra.style.display = 'none';
  _iaLimpiarListaArchivos();
  const btn = document.getElementById('ia-btn-extraer');
  if (btn) btn.disabled = true;
}

// ─── STEPPER ──────────────────────────────────────────────────────────────────
function _iaSetStep(step) {
  [1,2,3].forEach(s => {
    const panel = document.getElementById(`ia-step-${s}`);
    if (panel) panel.style.display = s === step ? 'flex' : 'none';
    const dot = document.getElementById(`ia-dot-${s}`);
    if (!dot) return;
    dot.className = s < step ? 'ia-dot ia-dot-done'
                  : s === step ? 'ia-dot ia-dot-active'
                  : 'ia-dot';
    if (s < step) dot.textContent = '';
    else if (s !== step) dot.textContent = String(s);
    else dot.textContent = String(s);
    const lbl = document.getElementById(`ia-label-${s}`);
    if (lbl) lbl.className = s === step ? 'ia-step-label active' : 'ia-step-label';
  });
}

// ─── DRAG & DROP + SELECCIÓN DE ARCHIVOS ─────────────────────────────────────
function _iaInitDragDrop() {
  const dz = document.getElementById('ia-dropzone');
  if (!dz || dz._iaReady) return;
  dz._iaReady = true;
  dz.addEventListener('dragover', e => { e.preventDefault(); dz.classList.add('dragover'); });
  dz.addEventListener('dragleave', () => dz.classList.remove('dragover'));
  dz.addEventListener('drop', e => {
    e.preventDefault(); dz.classList.remove('dragover');
    _iaAnadirArchivos(Array.from(e.dataTransfer.files));
  });
}

function iaOnFileChange(input) {
  if (input.files.length) _iaAnadirArchivos(Array.from(input.files));
  input.value = '';
}

function _iaAnadirArchivos(files) {
  const pdfs = files.filter(f => f.name.toLowerCase().endsWith('.pdf') || f.type === 'application/pdf');
  if (!pdfs.length) { toast('Solo se admiten archivos PDF'); return; }
  const grandes = pdfs.filter(f => f.size > 20 * 1024 * 1024);
  if (grandes.length) { toast(`${grandes.length} archivo(s) superan los 20 MB`); return; }
  // Añadir sin duplicar por nombre
  const nombresActuales = new Set(IA._archivos.map(f => f.name));
  pdfs.forEach(f => { if (!nombresActuales.has(f.name)) IA._archivos.push(f); });
  _iaRenderListaArchivos();
}

function _iaRenderListaArchivos() {
  const lista = document.getElementById('ia-lista-archivos');
  if (!lista) return;
  lista.innerHTML = '';
  IA._archivos.forEach((f, i) => {
    const row = document.createElement('div');
    row.className = 'ia-file-row';
    row.innerHTML = `
      <span class="ia-file-ico">📄</span>
      <span class="ia-file-name">${_escHtml(f.name)}</span>
      <span class="ia-file-size">${(f.size/1024).toFixed(0)} KB</span>
      <button class="ia-file-rm" onclick="iaQuitarArchivo(${i})" title="Quitar">✕</button>`;
    lista.appendChild(row);
  });
  const btn = document.getElementById('ia-btn-extraer');
  if (btn) btn.disabled = IA._archivos.length === 0;
  const dz = document.getElementById('ia-dropzone');
  if (dz) dz.classList.toggle('loaded', IA._archivos.length > 0);
  const cnt = document.getElementById('ia-archivo-count');
  if (cnt) cnt.textContent = IA._archivos.length
    ? `${IA._archivos.length} archivo(s) seleccionado(s)`
    : 'Sin archivos';
}

function _iaLimpiarListaArchivos() {
  IA._archivos = [];
  _iaRenderListaArchivos();
}

function iaQuitarArchivo(i) {
  IA._archivos.splice(i, 1);
  _iaRenderListaArchivos();
}

// ─── PASO 1 → 2: EXTRAER PDF(s) ──────────────────────────────────────────────
async function iaExtraerPDF() {
  if (!IA._archivos.length) { toast('Selecciona al menos un PDF'); return; }
  if (IA.cargando) return;
  IA.cargando = true;
  const btn = document.getElementById('ia-btn-extraer');
  if (btn) { btn.disabled = true; btn.textContent = '⏳ Extrayendo...'; }

  try {
    const fd = new FormData();
    IA._archivos.forEach(f => fd.append('pdfs', f));
    const headers = token ? { Authorization: `Bearer ${token}` } : {};
    const res = await fetch('/api/ia/extraer-pdf', { method: 'POST', headers, body: fd });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || 'Error extrayendo PDF');

    IA.pdfTexto        = data.texto        || '';
    IA.pdfTextoPreview = data.texto_preview || data.texto || '';
    IA.firmas          = data.firmas        || [];
    IA.nArchivos       = data.n_archivos    || IA._archivos.length;

    _iaRellenarStep2(data);
    _iaSetStep(2);
  } catch (e) {
    toast('Error: ' + e.message, 5000);
    if (btn) { btn.disabled = false; btn.textContent = '→ Extraer texto'; }
  } finally {
    IA.cargando = false;
    if (btn) { btn.disabled = false; btn.textContent = '→ Extraer texto'; }
  }
}

function _iaRellenarStep2(data) {
  // Meta badges
  const meta = document.getElementById('ia-pdf-meta');
  if (meta) {
    const items = [];
    if (data.paginas)   items.push(`${data.paginas} páginas`);
    if (data.n_archivos > 1) items.push(`${data.n_archivos} documentos`);
    items.push(`${(IA.pdfTexto.length/1000).toFixed(1)} KB texto`);
    meta.innerHTML = items.map(t => `<span class="ia-badge">${_escHtml(t)}</span>`).join(' ');
  }

  // Preview texto
  const prev = document.getElementById('ia-pdf-preview');
  if (prev) prev.textContent = IA.pdfTextoPreview || '(no se pudo extraer texto)';

  // Firmas detectadas
  const fw = document.getElementById('ia-firmas-wrap');
  const fl = document.getElementById('ia-firmas-lista');
  if (fw && fl) {
    if (IA.firmas.length) {
      fw.style.display = '';
      fl.innerHTML = IA.firmas.map(f => {
        const parts = [`<strong>${_escHtml(f.firmante)}</strong>`];
        if (f.fecha) parts.push(`📅 ${_escHtml(f.fecha)}`);
        if (f.rol)   parts.push(`🏷 ${_escHtml(f.rol)}`);
        if (f.nif)   parts.push(`ID: ${_escHtml(f.nif)}`);
        if (f.documento && IA.nArchivos > 1) parts.push(`📄 ${_escHtml(f.documento)}`);
        return `<div class="ia-firma-card">${parts.join(' &nbsp;·&nbsp; ')}</div>`;
      }).join('');
    } else {
      fw.style.display = 'none';
    }
  }

  // Copiar instrucciones del step 1 al step 2
  const i1 = document.getElementById('ia-instrucciones');
  const i2 = document.getElementById('ia-instrucciones-2');
  if (i1 && i2) i2.value = i1.value;
}

// ─── PASO 2 → 3: GENERAR CON CLAUDE ──────────────────────────────────────────
async function iaGenerarAcuerdo() {
  if (!IA.pdfTexto) { toast('Primero extrae el texto del PDF'); return; }
  if (!activeId)    { toast('No hay modelo activo'); return; }
  if (IA.cargando)  return;

  IA.cargando = true;
  const btn = document.getElementById('ia-btn-generar');
  if (btn) { btn.disabled = true; btn.textContent = '⏳ Generando...'; }

  _iaSetStep(3);
  const rl = document.getElementById('ia-resultado-loading');
  const ra = document.getElementById('ia-resultado-actions');
  if (rl) rl.style.display = '';
  if (ra) ra.style.display = 'none';
  const ta = document.getElementById('ia-resultado');
  if (ta) ta.value = '';

  try {
    const instrucciones = (document.getElementById('ia-instrucciones-2') || document.getElementById('ia-instrucciones'))?.value?.trim() || '';
    const headers = { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) };
    const res = await fetch(`/api/modelos/${activeId}/generar-ia`, {
      method: 'POST', headers,
      body: JSON.stringify({ texto_antecedentes: IA.pdfTexto, firmas: IA.firmas, instrucciones_adicionales: instrucciones }),
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || 'Error generando acuerdo');

    IA.acuerdoGenerado = data.acuerdo_markdown || '';
    if (ta) ta.value = IA.acuerdoGenerado;
    if (rl) rl.style.display = 'none';
    if (ra) ra.style.display = '';
  } catch (e) {
    if (rl) rl.style.display = 'none';
    toast('Error: ' + e.message, 5000);
    _iaSetStep(2);
  } finally {
    IA.cargando = false;
    if (btn) { btn.disabled = false; btn.textContent = '✨ Generar acuerdo'; }
  }
}

// ─── ACCIONES SOBRE EL RESULTADO ──────────────────────────────────────────────
function _iaGetTextoActual() {
  const ta = document.getElementById('ia-resultado');
  return ta ? ta.value.trim() : IA.acuerdoGenerado.trim();
}

function iaInsertarEnEditor() {
  const texto = _iaGetTextoActual();
  if (!texto) { toast('No hay texto generado'); return; }
  const ta = document.getElementById('e-body');
  if (!ta) return;
  const ok = !ta.value.trim() || confirm('¿Reemplazar el contenido actual del editor con el texto generado por IA?');
  if (!ok) return;
  ta.value = texto;
  if (typeof updatePreview === 'function') updatePreview();
  closeModal('m-ia-generator');
  toast('Texto insertado en el editor ✓');
}

function iaAnadirAlEditor() {
  const texto = _iaGetTextoActual();
  if (!texto) { toast('No hay texto generado'); return; }
  const ta = document.getElementById('e-body');
  if (!ta) return;
  ta.value = (ta.value.trimEnd() ? ta.value.trimEnd() + '\n\n' : '') + texto;
  if (typeof updatePreview === 'function') updatePreview();
  closeModal('m-ia-generator');
  toast('Texto añadido al editor ✓');
}

function iaCopiarTexto() {
  const texto = _iaGetTextoActual();
  navigator.clipboard.writeText(texto)
    .then(() => toast('Copiado al portapapeles ✓'))
    .catch(() => toast('No se pudo copiar'));
}

// ─── EXPORTAR DIRECTAMENTE A ODT ──────────────────────────────────────────────
// El .odt se genera siempre con el formato institucional fijo del backend
// (cabecera, expediente, tablas y firma): no se usa ninguna plantilla .odt/.ott.
async function iaExportarOdt() {
  const texto = _iaGetTextoActual();
  if (!texto) { toast('No hay texto generado'); return; }
  if (!activeId) { toast('No hay modelo activo'); return; }

  toast('Generando .odt…', 6000);

  try {
    const headers = { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) };
    const res = await fetch(`/api/modelos/${activeId}/ia-export-odt`, {
      method: 'POST', headers,
      body: JSON.stringify({ acuerdo_markdown: texto, campos: {} }),
    });

    if (!res.ok) {
      const err = await res.json().catch(() => ({}));
      throw new Error(err.error || 'Error generando ODT');
    }

    const blob = await res.blob();
    const nombre = (document.getElementById('e-name')?.value || 'acuerdo_ia')
      .replace(/[/\\?%*:|"<>]/g, '_');
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = nombre + '_IA.odt';
    a.click();
    URL.revokeObjectURL(a.href);
    toast('Exportado a .odt ✓');
    closeModal('m-ia-generator');
    if (typeof openModel === 'function') setTimeout(() => openModel(activeId), 800);
  } catch (e) {
    toast('Error: ' + e.message, 5000);
  }
}

// ─── NAVEGACIÓN ───────────────────────────────────────────────────────────────
function iaVolver(step) { _iaSetStep(step); }

// ─── UTILS ───────────────────────────────────────────────────────────────────
function _escHtml(s) {
  return String(s || '').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
}