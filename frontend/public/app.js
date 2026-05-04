// "?"?"? GLOBALS "?"?"?"?"?"?"?"?"?"?"?"?"?"?"?"?"?"?"?"?"?"?"?"?"?"?"?"?"?"?"?"?"?"?"?"?"?"?"?"?"?"?"?"?"?"?"?"?"?"?"?"?"?"?"?"?"?"?"?"?"?"?"?"?"?"?
const API = '/api';
let token = null;
let me = null, models = [], cats = [], tpls = [], activeId = null;
let statusFilter = '', sideView = 'tree', catEditId = null, catColor = 'blue';
let batchMode = false, batchSelected = new Set();
let selStart = 0, selEnd = 0;
let campoGlobalesCache = [];

const PRESETS = ['NUMERO_EXPEDIENTE','FECHA_SESION','NUMERO_SESION','ALCALDE_NOMBRE',
  'SECRETARIO_NOMBRE','IMPORTE','CONCEPTO','DEPARTAMENTO','FECHA_PUBLICACION',
  'MUNICIPIO','EJERCICIO_PRESUPUESTARIO','VOTACION_RESULTADO','NUMERO_DECRETO',
  'OBJETO_CONTRATO','PARTIDA_PRESUPUESTARIA','ENTIDAD_COLABORADORA',
  'REPRESENTANTE_ENTIDAD','OBJETO_CONVENIO','FECHA_INICIO','FECHA_FIN','FECHA_FIRMA'];

const COLORS = {blue:'#185FA5',teal:'#0F6E56',amber:'#854F0B',green:'#3B6D11',purple:'#534AB7',red:'#A32D2D'};
const COLORBG = {blue:'#E6F1FB',teal:'#E1F5EE',amber:'#FAEEDA',green:'#EAF3DE',purple:'#EEEDFE',red:'#FCEBEB'};

// "?"?"? MARKED CONFIG "?"?"?"?"?"?"?"?"?"?"?"?"?"?"?"?"?"?"?"?"?"?"?"?"?"?"?"?"?"?"?"?"?"?"?"?"?"?"?"?"?"?"?"?"?"?"?"?"?"?"?"?"?"?"?"?"?"?"?"?
const FIELD_RE = /\{\{([A-Z][A-Z0-9_]*)\}\}/g;
// ─── MERMAID INIT ──────────────────────────────────────────────────────────
mermaid.initialize({
  startOnLoad: false,
  theme: 'neutral',
  securityLevel: 'loose',
  fontFamily: 'Segoe UI, system-ui, sans-serif',
});
let _mermaidCounter = 0;

function escapeHtml(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function sanitizePreviewHtml(html) {
  const parser = new DOMParser();
  const doc = parser.parseFromString(`<div id="root">${html}</div>`, 'text/html');
  const root = doc.getElementById('root');
  const allowedTags = new Set([
    'A','B','BLOCKQUOTE','BR','CODE','DIV','EM','H1','H2','H3','H4','H5','H6',
    'HR','I','LI','OL','P','PRE','S','STRONG','SPAN','TABLE','TBODY','TD','TH',
    'THEAD','TR','U','UL'
  ]);

  const clean = (node) => {
    [...node.children].forEach(child => {
      if (!allowedTags.has(child.tagName)) {
        child.remove();
        return;
      }

      [...child.attributes].forEach(attr => {
        const name = attr.name.toLowerCase();
        const value = attr.value;
        if (name.startsWith('on') || name === 'style') {
          child.removeAttribute(attr.name);
          return;
        }
        if (child.tagName === 'A' && name === 'href') {
          const safe = /^(https?:|mailto:|tel:|\/|#)/i.test(value.trim());
          if (!safe) child.removeAttribute(attr.name);
          return;
        }
        if (child.tagName === 'SPAN' && !(name === 'class' && value === 'field-tag')) {
          child.removeAttribute(attr.name);
          return;
        }
        if (name !== 'class' && name !== 'href') {
          child.removeAttribute(attr.name);
        }
      });

      clean(child);
    });
  };

  clean(root);
  return root.innerHTML;
}

function mdToHtmlPreview(md) {
  // Extraer bloques mermaid antes del escape
  const mermaidBlocks = [];
  const mdProcessed = md.replace(/```mermaid\n([\s\S]*?)```/g, (_, code) => {
    const idx = mermaidBlocks.length;
    mermaidBlocks.push(code.trim());
    return `%%MERMAID_BLOCK_${idx}%%`;
  });

  const escaped = mdProcessed.replace(FIELD_RE, '<span class="field-tag">{{$1}}</span>');
  let html = sanitizePreviewHtml(marked.parse(escaped, { breaks: true, gfm: true }));

  // Reemplazar placeholders con divs mermaid
  mermaidBlocks.forEach((code, idx) => {
    const escapedCode = escapeHtml(code);
    html = html.replace(
      `%%MERMAID_BLOCK_${idx}%%`,
      `<div class="mermaid-block" data-mermaid="${escapedCode}"><div class="mermaid-render">Cargando diagrama…</div></div>`
    );
    // También puede quedar envuelto en <p> por marked
    html = html.replace(
      `<p>%%MERMAID_BLOCK_${idx}%%</p>`,
      `<div class="mermaid-block" data-mermaid="${escapedCode}"><div class="mermaid-render">Cargando diagrama…</div></div>`
    );
  });

  return html;
}
async function renderMermaidBlocks(container) {
  const blocks = container.querySelectorAll('.mermaid-block[data-mermaid]');
  for (const block of blocks) {
    const code = block.getAttribute('data-mermaid');
    const renderEl = block.querySelector('.mermaid-render');
    if (!renderEl || !code) continue;
    try {
      const id = `mermaid-${++_mermaidCounter}`;
      const { svg } = await mermaid.render(id, code);
      renderEl.innerHTML = svg;
    } catch (e) {
      renderEl.innerHTML = `<div class="mermaid-error">⚠ Error en diagrama: ${escapeHtml(e.message || 'Sintaxis inválida')}</div>`;
    }
  }
}
// "?"?"? UTILITIES "?"?"?"?"?"?"?"?"?"?"?"?"?"?"?"?"?"?"?"?"?"?"?"?"?"?"?"?"?"?"?"?"?"?"?"?"?"?"?"?"?"?"?"?"?"?"?"?"?"?"?"?"?"?"?"?"?"?"?"?"?"?"?"?
async function api(method, path, body) {
  const opts = { method, credentials: 'same-origin', headers: {'Content-Type':'application/json', ...(token ? {Authorization:`Bearer ${token}`} : {})} };
  if (body) opts.body = JSON.stringify(body);
  const r = await fetch(API + path, opts);
  if (r.status === 401) { doLogout(); return null; }
  return r.json();
}

function toast(msg, duration=2500) {
  const el = document.getElementById('toast');
  el.textContent = msg; el.classList.add('show');
  setTimeout(() => el.classList.remove('show'), duration);
}

function openModal(id) { document.getElementById(id).classList.add('open'); }
function closeModal(id) { document.getElementById(id).classList.remove('open'); }
document.querySelectorAll('.overlay').forEach(o => o.addEventListener('click', e => { if (e.target===o) o.classList.remove('open'); }));

document.addEventListener('click', e => {
  if (!document.getElementById('export-wrap')?.contains(e.target))
    document.getElementById('export-menu')?.classList.remove('open');
});

// "?"?"? AUTH "?"?"?"?"?"?"?"?"?"?"?"?"?"?"?"?"?"?"?"?"?"?"?"?"?"?"?"?"?"?"?"?"?"?"?"?"?"?"?"?"?"?"?"?"?"?"?"?"?"?"?"?"?"?"?"?"?"?"?"?"?"?"?"?"?"?"?"?"?
async function doLogin() {
  const email = document.getElementById('l-email').value;
  const pass  = document.getElementById('l-pass').value;
  const errEl = document.getElementById('l-err');
  errEl.style.display = 'none';
  const res = await fetch(API+'/auth/login', {
    method:'POST', headers:{'Content-Type':'application/json'},
    body: JSON.stringify({email, password:pass})
  }).then(r=>r.json()).catch(()=>({error:'Error de conexion'}));
  if (res.error) { errEl.textContent=res.error; errEl.style.display='block'; return; }
  token = res.token || null;
  me = res.user;
  initApp();
}
document.getElementById('l-pass').addEventListener('keydown', e => { if(e.key==='Enter') doLogin(); });

async function doLogout() {
  try {
    await fetch(API + '/auth/logout', { method: 'POST', credentials: 'same-origin' });
  } catch {}
  token=null; me=null;
  document.getElementById('login').style.display='flex';
  document.getElementById('app').style.display='none';
}

async function initApp() {
  const user = await api('GET', '/auth/me');
  if (!user) return;
  me = user;
  document.getElementById('login').style.display = 'none';
  document.getElementById('app').style.display = 'flex';
  const ini = me.nombre.split(' ').map(w=>w[0]).join('').slice(0,2).toUpperCase();
  document.getElementById('top-av').textContent = ini;
  document.getElementById('top-name').textContent = me.nombre;
  if (me.rol === 'admin' || me.rol === 'editor') {
    document.getElementById('tab-campos-btn').classList.remove('hidden');
  }
  if (me.rol === 'admin') {
    ['tab-c-btn','tab-t-btn','tab-u-btn'].forEach(id => document.getElementById(id).classList.remove('hidden'));
  }
  await Promise.all([loadCats(), loadTpls(), loadGlobalFields()]);
  await loadModels();
  renderMacroCode([]);
}

document.getElementById('e-body').addEventListener('keyup', function(e) {
  if (e.key !== '}') return;
  const ta = this;
  const pos = ta.selectionStart;
  const val = ta.value;
  if (val.slice(pos-2, pos) !== '}}') return;
  const openPos = val.lastIndexOf('{{', pos-2);
  if (openPos === -1) return;
  const inner = val.slice(openPos+2, pos-2).trim();
  if (!inner) return;
  const fieldName = inner.toUpperCase().replace(/\s+/g, '_').replace(/[^A-Z0-9_]/g, '');
  if (!fieldName) return;
  const newField = `{{${fieldName}}}`;
  ta.value = val.slice(0, openPos) + newField + val.slice(pos);
  ta.selectionStart = ta.selectionEnd = openPos + newField.length;
  updatePreview();
});

// "?"?"? CATS "?"?"?"?"?"?"?"?"?"?"?"?"?"?"?"?"?"?"?"?"?"?"?"?"?"?"?"?"?"?"?"?"?"?"?"?"?"?"?"?"?"?"?"?"?"?"?"?"?"?"?"?"?"?"?"?"?"?"?"?"?"?"?"?"?"?"?"?"?
async function loadCats() {
  cats = await api('GET', '/categorias') || [];
  const sel = document.getElementById('e-cat');
  const cur = sel.value;
  const subcats = cats.filter(c => c.parent_id);
  sel.innerHTML = '<option value="">?" Sin categoria ?"</option>' +
    subcats.map(c => {
      const parent = cats.find(p => p.id === c.parent_id);
      const label = parent ? `${parent.icono} ${parent.nombre} ? ${c.icono} ${c.nombre}` : `${c.icono} ${c.nombre}`;
      return `<option value="${c.id}">${escapeHtml(label)}</option>`;
    }).join('');
  if (cur) sel.value = cur;
  const psel = document.getElementById('mc-parent');
  if (psel) {
    const roots = cats.filter(c => !c.parent_id);
    psel.innerHTML = '<option value="">?" Categoria raiz ?"</option>' +
      roots.map(c => `<option value="${c.id}">${escapeHtml(`${c.icono} ${c.nombre}`)}</option>`).join('');
  }
}

// "?"?"? TEMPLATES "?"?"?"?"?"?"?"?"?"?"?"?"?"?"?"?"?"?"?"?"?"?"?"?"?"?"?"?"?"?"?"?"?"?"?"?"?"?"?"?"?"?"?"?"?"?"?"?"?"?"?"?"?"?"?"?"?"?"?"?"?"?"?"?
async function loadTpls() {
  tpls = await api('GET', '/plantillas') || [];
  renderExportMenu();
}

async function loadGlobalFields() {
  campoGlobalesCache = await api('GET', '/campos-globales') || [];
  renderGlobalFields();
  renderFieldModalPresets();
}

function renderExportMenu() {
  const el = document.getElementById('emenu-tpls');
  if (!tpls.length) {
    el.innerHTML = '<div class="emenu-item" style="color:var(--text3);font-size:12px">Sin plantillas subidas</div>';
    return;
  }
  el.innerHTML = tpls.map(t => `
    <div class="emenu-item" onclick="openExportFieldsModal(${t.id})">
      <span>Y"<</span>
      <span style="flex:1">${escapeHtml(t.nombre)}${t.es_defecto?'  <span class="b b-defecto" style="font-size:10px">predeterminada</span>':''}</span>
    </div>`).join('');
}

function _fieldTypeFor(campo) {
  return (campoTiposCache[campo] && campoTiposCache[campo].tipo)
    || (campoGlobalesCache.find(f => f.clave === campo)?.tipo)
    || 'texto';
}

function _fieldLabelFor(campo) {
  return campoGlobalesCache.find(f => f.clave === campo)?.nombre
    || campo.replace(/_/g, ' ').toLowerCase();
}

function renderGlobalFields() {
  const el = document.getElementById('r-global-fields');
  if (!el) return;
  const q = (document.getElementById('field-search')?.value || '').trim().toLowerCase();
  const items = campoGlobalesCache.filter(f => {
    if (!q) return true;
    return f.clave.toLowerCase().includes(q)
      || (f.nombre || '').toLowerCase().includes(q)
      || (f.descripcion || '').toLowerCase().includes(q);
  }).slice(0, 40);

  if (!items.length) {
    el.innerHTML = '<span style="font-size:11px;color:var(--text3)">No hay campos guardados</span>';
    return;
  }

  el.innerHTML = items.map(f => `
    <div class="fchip" onclick="insertFieldInEditor('${f.clave}')" title="${escapeHtml(f.descripcion || '')}">
      <span class="fchipname">${escapeHtml(f.clave)}</span>
      <span class="fchiphint">${escapeHtml(f.tipo || 'texto')}</span>
    </div>`).join('');
}

function renderFieldModalPresets() {
  const el = document.getElementById('mf-global-presets');
  if (!el) return;
  if (!campoGlobalesCache.length) {
    el.innerHTML = '<span style="font-size:11px;color:var(--text3)">Aun no hay campos reutilizables</span>';
    return;
  }
  el.innerHTML = campoGlobalesCache.slice(0, 24).map(f =>
    `<span class="ptag" onclick="document.getElementById('mf-name').value='${f.clave}'" title="${escapeHtml(f.nombre || '')}">${escapeHtml(f.clave)}</span>`
  ).join('');
}

function toggleExportMenu() {
  document.getElementById('export-menu').classList.toggle('open');
}

// "?"?"? MODELS "?"?"?"?"?"?"?"?"?"?"?"?"?"?"?"?"?"?"?"?"?"?"?"?"?"?"?"?"?"?"?"?"?"?"?"?"?"?"?"?"?"?"?"?"?"?"?"?"?"?"?"?"?"?"?"?"?"?"?"?"?"?"?"?"?"?"?
async function loadModels() {
  const q = document.getElementById('sq').value;
  let url = '/modelos'; const p = [];
  if (statusFilter) p.push(`estado=${statusFilter}`);
  if (q) p.push(`q=${encodeURIComponent(q)}`);
  if (p.length) url += '?' + p.join('&');
  models = await api('GET', url) || [];
  renderSidebar();
}

function renderSidebar() {
  sideView === 'list' ? renderList() : renderTree();
  if (batchMode) _updateBatchFooter();
  else document.getElementById('sbstats').textContent = `${models.length} modelo${models.length!==1?'s':''}`;
}

function setView(v) {
  sideView = v;
  document.getElementById('vl-btn').className = 'btn btn-sm vtbtn' + (v==='list'?' btn-primary':'');
  document.getElementById('vt-btn').className = 'btn btn-sm vtbtn' + (v==='tree'?' btn-primary':'');
  renderSidebar();
}

function renderList() {
  document.getElementById('view-list').style.display = '';
  document.getElementById('view-tree').style.display = 'none';
  const el = document.getElementById('view-list');
  if (!models.length) { el.innerHTML='<div class="empty" style="padding:24px 10px"><p>Sin resultados</p></div>'; return; }
  el.innerHTML = models.map(m => {
    const id = Number(m.id);
    if (batchMode) {
      const checked = batchSelected.has(id);
      return `<div class="mitem ${checked?'active':''}" onclick="toggleBatchSelect(${id})" style="cursor:pointer">
        <input type="checkbox" ${checked?'checked':''} onclick="event.stopPropagation();toggleBatchSelect(${id})" style="margin:0 6px 0 4px;flex-shrink:0">
        <div class="micon" style="background:${COLORBG[m.categoria_color]||'#f0efe9'}">${escapeHtml(m.categoria_icono||'📁')}</div>
        <div class="minfo">
          <div class="mname">${escapeHtml(m.nombre)}</div>
          <div class="mmeta">${escapeHtml(m.categoria_nombre||'Sin cat.')} · <span class="b b-${escapeHtml(m.estado)}">${escapeHtml(m.estado)}</span></div>
        </div>
      </div>`;
    }
    return `<div class="mitem ${id===activeId?'active':''}" onclick="openModel(${id})">
      <div class="micon" style="background:${COLORBG[m.categoria_color]||'#f0efe9'}">${escapeHtml(m.categoria_icono||'📁')}</div>
      <div class="minfo">
        <div class="mname">${escapeHtml(m.nombre)}</div>
        <div class="mmeta">${escapeHtml(m.categoria_nombre||'Sin cat.')} · <span class="b b-${escapeHtml(m.estado)}">${escapeHtml(m.estado)}</span></div>
      </div>
    </div>`;
  }).join('');
}

function renderTree() {
  document.getElementById('view-list').style.display = 'none';
  document.getElementById('view-tree').style.display = '';
  const el = document.getElementById('view-tree');
  const byCat = {};
  models.forEach(m => { const k = m.categoria_id||0; if(!byCat[k]) byCat[k]=[]; byCat[k].push(m); });

  const roots  = cats.filter(c => !c.parent_id);
  const byParent = {};
  cats.filter(c => c.parent_id).forEach(c => {
    if (!byParent[c.parent_id]) byParent[c.parent_id] = [];
    byParent[c.parent_id].push(c);
  });

  function countForRoot(root) {
    const subs = byParent[root.id] || [];
    return subs.reduce((n, s) => n + (byCat[s.id]||[]).length, 0) + (byCat[root.id]||[]).length;
  }

  const arrow = `<svg width="11" height="11" viewBox="0 0 11 11" class="catarrow" style="flex-shrink:0;transition:transform .15s"><path d="M2.5 4l3 3 3-3" stroke="currentColor" stroke-width="1.2" fill="none" stroke-linecap="round"/></svg>`;

  let html = '';
  roots.forEach(root => {
    const rootId = Number(root.id);
    const subs = byParent[root.id] || [];
    const total = countForRoot(root);
    html += `<div class="catrow">
      <div class="cathdr" onclick="toggleCat(this,${rootId})">
        <span class="catico">${escapeHtml(root.icono)}</span>
        <span class="catname">${escapeHtml(root.nombre)}</span>
        <span class="catcnt">${total}</span>
        ${arrow}
      </div>
      <div class="catkids" id="ck-${rootId}">`;

    if (subs.length) {
      subs.forEach(sub => {
        const subId = Number(sub.id);
        const ms = byCat[sub.id] || [];
        html += `<div>
          <div class="subcat-hdr" onclick="toggleSubcat(this,${subId})">
            <span style="font-size:13px">${escapeHtml(sub.icono)}</span>
            <span style="flex:1;font-weight:500">${escapeHtml(sub.nombre)}</span>
            <span class="catcnt">${ms.length}</span>
            ${arrow}
          </div>
          <div class="subcat-kids" id="sk-${subId}">
            ${ms.map(m=>{ const mid=Number(m.id); return `<div class="subcat-mod ${mid===activeId?'active':''}" onclick="openModel(${mid})">${escapeHtml(m.nombre)}</div>`; }).join('')}
          </div>
        </div>`;
      });
    } else {
      const ms = byCat[root.id] || [];
      html += ms.map(m=>{ const mid=Number(m.id); return `<div class="catmod ${mid===activeId?'active':''}" onclick="openModel(${mid})">${escapeHtml(m.nombre)}</div>`; }).join('');
    }
    html += `</div></div>`;
  });

  const nocat = byCat[0]||[];
  if (nocat.length) {
    html += `<div class="catrow">
      <div class="cathdr" onclick="toggleCat(this,0)">
        <span class="catico">📁</span><span class="catname">Sin categoria</span>
        <span class="catcnt">${nocat.length}</span>${arrow}
      </div>
      <div class="catkids" id="ck-0">${nocat.map(m=>{ const mid=Number(m.id); return `<div class="catmod ${mid===activeId?'active':''}" onclick="openModel(${mid})">${escapeHtml(m.nombre)}</div>`; }).join('')}</div>
    </div>`;
  }

  el.innerHTML = html || '<div class="empty" style="padding:24px 10px"><p>Sin modelos</p></div>';

  if (activeId) {
    const am = models.find(m=>m.id===activeId);
    if (am && am.categoria_id) {
      const sub = cats.find(c=>c.id===am.categoria_id);
      if (sub && sub.parent_id) {
        const ck = document.getElementById(`ck-${Number(sub.parent_id)}`);
        if (ck) ck.classList.add('open');
        const sk = document.getElementById(`sk-${Number(sub.id)}`);
        if (sk) sk.classList.add('open');
      } else {
        const ck = document.getElementById(`ck-${Number(am.categoria_id)}`);
        if (ck) ck.classList.add('open');
      }
    }
  }
}

function toggleSubcat(hdr, id) {
  const kids = document.getElementById(`sk-${id}`);
  if (!kids) return;
  kids.classList.toggle('open');
  const arr = hdr.querySelector('.catarrow');
  if (arr) arr.style.transform = kids.classList.contains('open') ? 'rotate(0deg)' : 'rotate(-90deg)';
}

function toggleCat(hdr, id) {
  const kids = document.getElementById(`ck-${id}`);
  if (!kids) return;
  kids.classList.toggle('open');
  const arr = hdr.querySelector('.catarrow');
  if (arr) arr.style.transform = kids.classList.contains('open') ? 'rotate(0deg)' : 'rotate(-90deg)';
}

document.getElementById('filters').addEventListener('click', e => {
  if (!e.target.classList.contains('chip')) return;
  document.querySelectorAll('#filters .chip').forEach(c=>c.classList.remove('active'));
  e.target.classList.add('active');
  statusFilter = e.target.dataset.f;
  loadModels();
});

// "?"?"? OPEN MODEL "?"?"?"?"?"?"?"?"?"?"?"?"?"?"?"?"?"?"?"?"?"?"?"?"?"?"?"?"?"?"?"?"?"?"?"?"?"?"?"?"?"?"?"?"?"?"?"?"?"?"?"?"?"?"?"?"?"?"?"?"?"?"?
async function openModel(id) {
  activeId = id; renderSidebar();
  const data = await api('GET', `/modelos/${id}`);
  if (!data) return;

  document.getElementById('e-empty').style.display = 'none';
  const ep = document.getElementById('e-panel'); ep.style.display = 'flex';
  document.getElementById('e-title').textContent = data.nombre;
  document.getElementById('e-meta').textContent =
    `${new Date(data.updated_at).toLocaleString('es-ES')} . ${data.updated_by_nombre||'?"'}`;

  document.getElementById('e-name').value = data.nombre;
  document.getElementById('e-cat').value  = data.categoria_id || '';
  document.getElementById('e-status').value = data.estado;
  document.getElementById('e-tags').value = (data.etiquetas||[]).join(', ');
  document.getElementById('e-desc').value = data.descripcion || '';

  const body = document.getElementById('e-body');
  body.value = data.cuerpo || '';
  lastSavedBody = body.value;
  const ro = me.rol === 'consultor';
  body.readOnly = ro;
  body.style.opacity = ro ? '0.75' : '1';
  document.getElementById('btn-save').style.display = ro ? 'none' : '';
  document.getElementById('btn-del').style.display  = me.rol==='admin' ? '' : 'none';

  updatePreview();
  detectFields();
  renderActivity(data.actividad||[]);
  renderTags(data.etiquetas||[]);
  renderMacroCode([...new Set((data.cuerpo||'').match(/\{\{[A-Z][A-Z0-9_]*\}\}/g)||[])]);
  startAutosave();
  loadCampoTipos(activeId);
  renderGlobalFields();
}

async function saveModel() {
  if (!activeId) return;
  const tags = document.getElementById('e-tags').value.split(',').map(t=>t.trim()).filter(Boolean);
  await api('PUT', `/modelos/${activeId}`, {
    nombre:      document.getElementById('e-name').value,
    categoria_id:document.getElementById('e-cat').value || null,
    estado:      document.getElementById('e-status').value,
    descripcion: document.getElementById('e-desc').value,
    cuerpo:      document.getElementById('e-body').value,
    etiquetas:   tags
  });
  toast('Guardado ✓');
  await loadGlobalFields();
  await loadModels();
  await openModel(activeId);
}

async function newModel() {
  const res = await api('POST', '/modelos', {
    nombre:'Nuevo modelo', categoria_id:null, estado:'borrador',
    cuerpo:'# Titulo del acuerdo\n\nEscriba aqui el cuerpo del acuerdo usando Markdown.\n\nUse {{CAMPO}} para campos dinamicos.\n'
  });
  if (!res) return;
  await loadModels(); openModel(res.id);
}

async function deleteModel() {
  if (!activeId || !confirm('?Eliminar este modelo? No se puede deshacer.')) return;
  await api('DELETE', `/modelos/${activeId}`);
  activeId = null;
  document.getElementById('e-empty').style.display = '';
  document.getElementById('e-panel').style.display = 'none';
  toast('Eliminado'); await loadModels();
}

// "?"?"? MEMORIA DE EXPEDIENTES "?"?"?"?"?"?"?"?"?"?"?"?"?"?"?"?"?"?"?"?"?"?"?"?"?"?"?"?"?"?"?"?"?"?"?"?"?"?"?"?"?"?"?"?"?"?"?"?"?"?"?
// Estructura: { "2024/EXP/001": { campos: { ALCALDE: "...", ... }, updated: "ISO" } }
const EXP_STORAGE_KEY = 'acuerdos_expedientes';
const EXP_MAX = 50;

function _expLoad() {
  try { return JSON.parse(localStorage.getItem(EXP_STORAGE_KEY) || '{}'); }
  catch { return {}; }
}

function _expSave(data) {
  try { localStorage.setItem(EXP_STORAGE_KEY, JSON.stringify(data)); }
  catch(e) { console.error('Error guardando expedientes:', e); }
}

// Guarda los valores de un expediente (los campos van en .campos, separados de metadatos)
function _expSaveValues(numExp, camposObj) {
  if (!numExp || !numExp.trim()) return;
  const data = _expLoad();
  const prev = data[numExp] || {};
  data[numExp] = {
    campos: { ...(prev.campos || {}), ...camposObj },
    updated: new Date().toISOString()
  };
  // Recortar si supera el maximo (eliminar los mas antiguos)
  const entries = Object.entries(data);
  if (entries.length > EXP_MAX) {
    entries
      .sort(([,a],[,b]) => (a.updated||'') < (b.updated||'') ? -1 : 1)
      .slice(0, entries.length - EXP_MAX)
      .forEach(([k]) => delete data[k]);
  }
  _expSave(data);
}

// Devuelve solo los campos guardados para un expediente (o {} si no existe)
function _expGetCampos(numExp) {
  if (!numExp || !numExp.trim()) return {};
  const entry = _expLoad()[numExp.trim()];
  return entry ? (entry.campos || {}) : {};
}

// Lista expedientes recientes ordenados por fecha desc (mas reciente primero)
function _expRecientes() {
  const data = _expLoad();
  return Object.entries(data)
    .sort(([,a],[,b]) => (b.updated||'') > (a.updated||'') ? 1 : -1)
    .map(([num]) => num);
}

// Detecta el campo "clave de expediente": busca cualquier campo que contenga EXPEDIENTE
function _expFindClave(campos) {
  return campos.find(c => c === 'NUMERO_EXPEDIENTE')
      || campos.find(c => c.includes('EXPEDIENTE'))
      || null;
}

let autosaveTimer = null;
let lastSavedBody = '';
let campoTiposCache = {};
const EXP_DB_STORAGE_KEY = 'acuerdos_expedientes_db';

async function loadExpedientesDB() {
  try {
    const rows = await api('GET', '/expedientes');
    const dbExp = {};
    (rows || []).forEach(r => { if (r.clave) dbExp[r.clave] = r.campos || {}; });
    const legacyDb = JSON.parse(localStorage.getItem('expedientes') || '{}');
    const localDb = JSON.parse(localStorage.getItem(EXP_DB_STORAGE_KEY) || '{}');
    const recentExp = Object.fromEntries(
      Object.entries(_expLoad()).map(([clave, entry]) => [clave, entry?.campos || entry || {}])
    );
    const mergedLocal = { ...legacyDb, ...localDb, ...recentExp };
    for (const [clave, campos] of Object.entries(mergedLocal)) {
      if (!dbExp[clave]) {
        await api('POST', '/expedientes', { clave, campos });
      }
    }
    return { ...dbExp, ...mergedLocal };
  } catch (e) {
    const legacyDb = JSON.parse(localStorage.getItem('expedientes') || '{}');
    const localDb = JSON.parse(localStorage.getItem(EXP_DB_STORAGE_KEY) || '{}');
    const recentExp = Object.fromEntries(
      Object.entries(_expLoad()).map(([clave, entry]) => [clave, entry?.campos || entry || {}])
    );
    return { ...legacyDb, ...localDb, ...recentExp };
  }
}

async function saveExpedienteDB(clave, campos) {
  const legacyDb = JSON.parse(localStorage.getItem('expedientes') || '{}');
  const localDb = JSON.parse(localStorage.getItem(EXP_DB_STORAGE_KEY) || '{}');
  const merged = { ...legacyDb, ...localDb, [clave]: campos };
  localStorage.setItem('expedientes', JSON.stringify(merged));
  localStorage.setItem(EXP_DB_STORAGE_KEY, JSON.stringify(merged));
  try { await api('POST', '/expedientes', { clave, campos }); } catch (e) {}
}

async function deleteExpedienteDB(clave) {
  const legacyDb = JSON.parse(localStorage.getItem('expedientes') || '{}');
  const localDb = JSON.parse(localStorage.getItem(EXP_DB_STORAGE_KEY) || '{}');
  delete legacyDb[clave];
  delete localDb[clave];
  localStorage.setItem('expedientes', JSON.stringify(legacyDb));
  localStorage.setItem(EXP_DB_STORAGE_KEY, JSON.stringify(localDb));
  try { await api('DELETE', `/expedientes/${encodeURIComponent(clave)}`); } catch (e) {}
}

function startAutosave() {
  if (autosaveTimer) clearInterval(autosaveTimer);
  autosaveTimer = setInterval(() => {
    if (!activeId || !token) return;
    const el = document.getElementById('e-body');
    if (!el) return;
    const body = el.value;
    if (body === lastSavedBody) return;
    api('POST', `/modelos/${activeId}/autosave`, { cuerpo: body }).then(() => {
      lastSavedBody = body;
      loadGlobalFields().catch(() => {});
      const badge = document.getElementById('autosave-indicator');
      if (badge) {
        badge.textContent = 'Guardado automaticamente';
        badge.style.opacity = '1';
        setTimeout(() => { badge.style.opacity = '0'; }, 2000);
      }
    }).catch(() => {});
  }, 30000);
}

async function openPreview() {
  if (!activeId) return;
  const expediente = document.getElementById('ex-clave')?.value?.trim();
  const inputs = document.querySelectorAll('.ex-field');
  const campos = {};
  inputs.forEach(inp => { if (inp.value.trim()) campos[inp.dataset.campo] = inp.value.trim(); });
  if (expediente) {
    const all = typeof loadExpedientesDB === 'function'
      ? await loadExpedientesDB()
      : JSON.parse(localStorage.getItem(EXP_STORAGE_KEY) || '{}');
    if (all[expediente]) Object.assign(campos, all[expediente].campos || all[expediente]);
  }
  const res = await api('POST', `/modelos/${activeId}/preview`, { campos });
  if (!res) return;
  document.getElementById('preview-title').textContent = 'Vista previa: ' + (res.nombre || '');
  document.getElementById('preview-content').innerHTML = mdToHtmlPreview(res.cuerpo || '');
  openModal('preview-modal');
}
async function _extractDiagramsAsBase64(md) {
  // Renderiza cada bloque mermaid a SVG y lo convierte a dataURL PNG via canvas
  const diagrams = [];
  const regex = /```mermaid\n([\s\S]*?)```/g;
  let match;
  let idx = 0;
  while ((match = regex.exec(md)) !== null) {
    const code = match[1].trim();
    try {
      const id = `export-mermaid-${Date.now()}-${idx++}`;
      const { svg } = await mermaid.render(id, code);
      // Convertir SVG a PNG via canvas
      const png = await _svgToPng(svg);
      diagrams.push({ placeholder: match[0], base64: png, svg });
    } catch (e) {
      diagrams.push({ placeholder: match[0], base64: null, svg: null, error: e.message });
    }
  }
  return diagrams;
}

function _svgToPng(svgString) {
  return new Promise((resolve) => {
    // Extraer width/height del SVG para dimensionar el canvas
    const parser = new DOMParser();
    const svgDoc = parser.parseFromString(svgString, 'image/svg+xml');
    const svgEl = svgDoc.documentElement;
    const vb = svgEl.getAttribute('viewBox');
    let w = parseFloat(svgEl.getAttribute('width')) || 800;
    let h = parseFloat(svgEl.getAttribute('height')) || 400;
    if (vb) {
      const parts = vb.split(/[\s,]+/);
      if (parts.length === 4) { w = parseFloat(parts[2]) || w; h = parseFloat(parts[3]) || h; }
    }
    // Escalar al doble para mejor resolución
    const scale = Math.min(2, 1600 / w);
    const canvas = document.createElement('canvas');
    canvas.width = w * scale;
    canvas.height = h * scale;
    const ctx = canvas.getContext('2d');
    ctx.fillStyle = '#ffffff';
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    ctx.scale(scale, scale);
    const img = new Image();
    const blob = new Blob([svgString], { type: 'image/svg+xml;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    img.onload = () => {
      ctx.drawImage(img, 0, 0);
      URL.revokeObjectURL(url);
      resolve(canvas.toDataURL('image/png').split(',')[1]); // solo la parte base64
    };
    img.onerror = () => { URL.revokeObjectURL(url); resolve(null); };
    img.src = url;
  });
}
async function _doExport(plantillaId, camposObj) {
  if (!activeId) return;
  const tplName = plantillaId ? (tpls.find(t=>t.id===plantillaId)?.nombre||'plantilla') : 'estilos por defecto';
  toast(`Generando .odt con ${tplName}…`, 4000);

  // Renderizar diagramas Mermaid a base64
  const md = document.getElementById('e-body').value;
  const diagrams = await _extractDiagramsAsBase64(md);
  const diagramsMap = {};
  diagrams.forEach((d, i) => {
    if (d.base64) diagramsMap[`DIAGRAM_${i}`] = d.base64;
  });

  const headers = { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) };
  const res = await fetch(`/api/modelos/${activeId}/export/odt`, {
    method: 'POST',
    headers,
    body: JSON.stringify({ plantilla_id: plantillaId, campos: camposObj, diagrams: diagramsMap })
  });

  if (!res.ok) {
    const err = await res.json().catch(()=>({error:'Error desconocido'}));
    toast('Error: ' + err.error); return;
  }

  const blob = await res.blob();
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = (document.getElementById('e-name').value||'modelo').replace(/[/\\?%*:|"<>]/g,'_') + '.odt';
  a.click(); URL.revokeObjectURL(a.href);
  toast('Exportado a .odt ✓');
  setTimeout(() => openModel(activeId), 800);
}
async function loadCampoTipos(modeloId) {
  try {
    const rows = await api('GET', `/modelos/${modeloId}/campo-tipos`);
    campoTiposCache = {};
    (rows || []).forEach(r => { campoTiposCache[r.campo] = r; });
    renderGlobalFields();
  } catch (e) {}
}

async function saveCampoTipo(campo, tipo, config) {
  if (!activeId) return;
  await api('POST', `/modelos/${activeId}/campo-tipos`, { campo, tipo, config });
  campoTiposCache[campo] = { campo, tipo, config };
  await loadGlobalFields();
  toast(`Campo ${campo} configurado como ${tipo}`);
}

function renderCampoTipoSelect(campo) {
  const ct = campoTiposCache[campo] || { tipo: _fieldTypeFor(campo), config: {} };
  return `<select style="font-size:11px;width:90px" onchange="saveCampoTipo('${campo.replace(/'/g, "\\'")}', this.value, {})">
    <option ${ct.tipo === 'texto' ? 'selected' : ''} value="texto">Texto</option>
    <option ${ct.tipo === 'fecha' ? 'selected' : ''} value="fecha">Fecha</option>
    <option ${ct.tipo === 'importe' ? 'selected' : ''} value="importe">Importe</option>
    <option ${ct.tipo === 'numero' ? 'selected' : ''} value="numero">Numero</option>
    <option ${ct.tipo === 'lista' ? 'selected' : ''} value="lista">Lista</option>
    <option ${ct.tipo === 'booleano' ? 'selected' : ''} value="booleano">Si/No</option>
  </select>`;
}

function renderFieldInput(campo, val, tipo) {
  const escCampo = campo.replace(/"/g, '&quot;');
  const value = (val || '').replace(/"/g, '&quot;');
  if (tipo === 'fecha') return `<input type="date" class="ex-field" data-campo="${escCampo}" value="${value}" style="font-size:13px;padding:6px 8px;border:0.5px solid var(--border);border-radius:6px;width:100%;box-sizing:border-box">`;
  if (tipo === 'booleano') return `<select class="ex-field" data-campo="${escCampo}" style="font-size:13px;padding:6px 8px;border:0.5px solid var(--border);border-radius:6px;width:100%;box-sizing:border-box"><option value="">--</option><option ${val==='Si'?'selected':''} value="Si">Si</option><option ${val==='No'?'selected':''} value="No">No</option></select>`;
  if (tipo === 'importe') return `<input type="text" inputmode="decimal" class="ex-field" data-campo="${escCampo}" value="${value}" placeholder="0,00" style="font-size:13px;padding:6px 8px;border:0.5px solid var(--border);border-radius:6px;width:100%;box-sizing:border-box">`;
  if (tipo === 'numero') return `<input type="number" class="ex-field" data-campo="${escCampo}" value="${value}" style="font-size:13px;padding:6px 8px;border:0.5px solid var(--border);border-radius:6px;width:100%;box-sizing:border-box">`;
  return `<input type="text" class="ex-field" data-campo="${escCampo}" value="${value}" style="font-size:13px;padding:6px 8px;border:0.5px solid var(--border);border-radius:6px;width:100%;box-sizing:border-box">`;
}

async function openVersions() {
  if (!activeId) return;
  const versions = await api('GET', `/modelos/${activeId}/versiones`);
  const list = document.getElementById('versions-list');
  if (!versions || !versions.length) {
    list.innerHTML = '<p style="color:var(--text3)">Sin historial de versiones.</p>';
  } else {
    list.innerHTML = versions.map((v, idx) => {
      const date = v.created_at ? new Date(v.created_at).toLocaleString('es-ES') : '';
      const isCurrent = idx === 0;
      return `<div class="version-row ${isCurrent ? 'version-current' : ''}" style="padding:10px;border-bottom:0.5px solid var(--border);display:flex;gap:10px;align-items:center">
        <div style="flex:1">
          <div style="font-weight:600;font-size:13px">${isCurrent ? 'Version actual' : `Version #${v.id}`}</div>
          <div style="font-size:11px;color:var(--text3)">${date} · ${v.user_nombre || 'Sistema'}</div>
        </div>
        ${!isCurrent ? `<button class="btn btn-sm" onclick="restoreVersion(${v.id})">Restaurar</button>` : '<span class="b b-borrador">actual</span>'}
      </div>`;
    }).join('');
  }
  openModal('versions-modal');
}

async function restoreVersion(versionId) {
  if (!confirm('Se sobrescribira el modelo actual con la version seleccionada. Continuar?')) return;
  await api('POST', `/modelos/${activeId}/restore`, { version_id: versionId });
  toast('Version restaurada');
  closeModal('versions-modal');
  loadModels();
  openModel(activeId);
}

// "?"?"? EXPORT CON FORMULARIO DE CAMPOS "?"?"?"?"?"?"?"?"?"?"?"?"?"?"?"?"?"?"?"?"?"?"?"?"?"?"?"?"?"?"?"?"?"?"?"?"?"?"?"?"?
let _exportPlantillaId = null;

function openExportFieldsModal(plantillaId) {
  if (!activeId) return;
  document.getElementById('export-menu').classList.remove('open');
  _exportPlantillaId = plantillaId;

  // Badge de plantilla
  const tplName = plantillaId
    ? (tpls.find(t => t.id === plantillaId)?.nombre || 'Plantilla')
    : 'Sin plantilla (estilos por defecto)';
  document.getElementById('ef-tpl-name').textContent = tplName;

  // Detectar campos del markdown actual
  const md = document.getElementById('e-body').value;
  const campos = [...new Set((md.match(/\{\{[A-Z][A-Z0-9_]*\}\}/g)||[]))].map(f => f.slice(2,-2));

  const container = document.getElementById('ef-campos');
  container.dataset.campos = JSON.stringify(campos);

  if (!campos.length) {
    container.innerHTML = `<div style="text-align:center;padding:24px 0;color:var(--text3);font-size:13px">
      Este modelo no tiene campos dinamicos.<br>Se exportara tal como esta.
    </div>`;
    openModal('m-export-fields');
    return;
  }

  _renderExportForm(campos, {});
  openModal('m-export-fields');

  // Focus al campo clave de expediente si existe, sino al primero
  setTimeout(() => {
    const clave = _expFindClave(campos);
    const expInput = clave ? document.getElementById(`ef-${clave}`) : null;
    const first = container.querySelector('input[type="text"]');
    (expInput || first)?.focus();
  }, 80);
}

function _renderExportForm(campos, valores) {
  const container = document.getElementById('ef-campos');
  const recientes = _expRecientes();
  const clave = _expFindClave(campos);

  let html = '';

  if (recientes.length) {
    html += `<div style="margin-bottom:14px">
      <label class="fl" style="margin-bottom:4px;display:block">📂 Cargar expediente guardado</label>
      <div style="display:flex;gap:6px">
        <select id="ef-recientes" style="flex:1;font-size:12px">
          <option value="">Seleccionar expediente</option>
          ${recientes.map(n => `<option value="${n.replace(/"/g,'&quot;')}">${n}</option>`).join('')}
        </select>
        <button class="btn btn-sm btn-primary" onclick="_onExpCargar()">Cargar</button>
        <button class="btn btn-sm btn-danger" onclick="_onExpBorrar()" title="Borrar seleccionado">🗑</button>
      </div>
    </div>
    <div style="height:0.5px;background:var(--border);margin-bottom:14px"></div>`;
  }

  const ordenados = clave ? [clave, ...campos.filter(c => c !== clave)] : campos;

  html += ordenados.map(campo => {
    const val = valores[campo] || '';
    const esClave = campo === clave;
    const tipo = _fieldTypeFor(campo);
    return `<div class="fg" style="margin-bottom:10px">
      <label class="fl" style="font-size:11px;font-weight:600;color:var(--blue);font-family:monospace;display:flex;align-items:center;gap:6px;justify-content:space-between">
        <span>{{${campo}}} ${esClave ? '<span style="font-size:10px;background:var(--blue-bg);color:var(--blue);padding:1px 5px;border-radius:99px;font-family:sans-serif;font-weight:400">clave del expediente</span>' : ''}</span>
        ${typeof renderCampoTipoSelect !== 'undefined' ? renderCampoTipoSelect(campo) : ''}
      </label>
      ${typeof renderFieldInput !== 'undefined' ? renderFieldInput(campo, val, tipo) : `<input type="text" class="ex-field" data-campo="${campo.replace(/"/g,'&quot;')}" value="${val.replace(/"/g,'&quot;')}" style="font-size:13px;padding:6px 8px;border:0.5px solid var(--border);border-radius:6px;width:100%;box-sizing:border-box">`}
    </div>`;
  }).join('');

  container.innerHTML = html;
  container.dataset.campos = JSON.stringify(campos);
  container.dataset.clave  = clave || '';

  ordenados.forEach(campo => {
    const input = document.querySelector(`.ex-field[data-campo="${campo}"]`);
    if (!input) return;
    input.addEventListener('keydown', e => {
      if (e.key === 'Enter') { e.preventDefault(); _focusNextExportField(input); }
    });
    if (campo === clave) {
      input.addEventListener('input', () => _onNumExpInput(input.value));
    }
  });

  if (clave && recientes.length) {
    const claveInput = document.querySelector(`.ex-field[data-campo="${clave}"]`);
    if (claveInput) {
      const dl = document.createElement('datalist');
      dl.id = 'ef-exp-datalist';
      dl.innerHTML = recientes.map(n => `<option value="${n.replace(/"/g,'&quot;')}"></option>`).join('');
      container.appendChild(dl);
      claveInput.setAttribute('list', 'ef-exp-datalist');
      claveInput.placeholder = 'Escribe o elige del historial…';
    }
  }
}

function _expPlaceholder(campo) {
  const map = {
    NUMERO_EXPEDIENTE: 'ej. 2024/CONT/001',
    EXPEDIENTE: 'ej. 2024/CONT/001',
    FECHA_SESION: 'ej. 15 de enero de 2025',
    NUMERO_SESION: 'ej. 3/2025',
    ALCALDE_NOMBRE: 'Nombre completo',
    SECRETARIO_NOMBRE: 'Nombre completo',
    IMPORTE: 'ej. 12.500,00',
    MUNICIPIO: 'ej. Ayuntamiento de ...',
    FECHA_PUBLICACION: 'ej. 20 de enero de 2025',
    NUMERO_DECRETO: 'ej. 45/2025',
  };
  return map[campo] || campo.toLowerCase().replace(/_/g, ' ');
}

// Al escribir en el campo clave: autorellenar el resto si hay datos guardados
async function _onNumExpInput(numExp) {
  const trimmed = numExp.trim();
  if (!trimmed) return;
  const all = await (typeof loadExpedientesDB !== 'undefined' ? loadExpedientesDB() : Promise.resolve(_expGetCampos(trimmed)));
  const guardados = all[trimmed] || {};
  if (!Object.keys(guardados).length) return;
  const container = document.getElementById('ef-campos');
  const clave = container.dataset.clave;
  const campos = JSON.parse(container.dataset.campos || '[]');
  campos.forEach(campo => {
    if (campo === clave) return;
    const input = document.querySelector(`.ex-field[data-campo="${campo}"]`);
    if (input && guardados[campo] !== undefined && guardados[campo] !== '') {
      input.value = guardados[campo];
      input.style.background = 'var(--green-bg)';
      setTimeout(() => { input.style.background = ''; }, 700);
    }
  });
}

// Boton "Cargar" del desplegable de recientes
async function _onExpCargar() {
  const sel = document.getElementById('ef-recientes');
  const numExp = sel?.value;
  if (!numExp) { toast('Selecciona un expediente de la lista'); return; }

  const container = document.getElementById('ef-campos');
  const campos = JSON.parse(container.dataset.campos || '[]');
  const clave  = container.dataset.clave;
  const all = (typeof loadExpedientesDB !== 'undefined') ? await loadExpedientesDB() : {};
  const guardados = all[numExp] || _expGetCampos(numExp);

  if (clave) {
    const claveInput = document.querySelector(`.ex-field[data-campo="${clave}"]`);
    if (claveInput) claveInput.value = numExp;
  }

  campos.forEach(campo => {
    if (campo === clave) return;
    const input = document.querySelector(`.ex-field[data-campo="${campo}"]`);
    if (input && guardados[campo] !== undefined) {
      input.value = guardados[campo];
      input.style.background = 'var(--green-bg)';
      setTimeout(() => { input.style.background = ''; }, 600);
    }
  });

  sel.value = '';
  toast(`Expediente "${numExp}" cargado ✓`);
}

// Boton Y-' del desplegable de recientes
async function _onExpBorrar() {
  const sel = document.getElementById('ef-recientes');
  const num = sel?.value;
  if (!num) { toast('Selecciona primero un expediente para borrar'); return; }
  if (!confirm(`Eliminar los datos guardados de "${num}"?`)) return;
  if (typeof deleteExpedienteDB !== 'undefined') await deleteExpedienteDB(num);
  const data = _expLoad();
  delete data[num];
  _expSave(data);
  toast(`Expediente "${num}" eliminado`);
  const container = document.getElementById('ef-campos');
  const campos = JSON.parse(container.dataset.campos || '[]');
  _renderExportForm(campos, {});
}

function _focusNextExportField(current) {
  const inputs = [...document.querySelectorAll('#ef-campos .ex-field')];
  const idx = inputs.indexOf(current);
  if (idx >= 0 && idx < inputs.length - 1) {
    inputs[idx + 1].focus();
  } else {
    confirmExportFields();
  }
}

async function confirmExportFields() {
  const container = document.getElementById('ef-campos');
  const campos = JSON.parse(container.dataset.campos || '[]');
  const clave  = container.dataset.clave;

  const camposObj = {};
  campos.forEach(campo => {
    const input = document.querySelector(`.ex-field[data-campo="${campo}"]`);
    camposObj[campo] = input ? input.value.trim() : '';
  });

  const vacios = campos.filter(c => !camposObj[c]);
  if (vacios.length) {
    const ok = confirm(
      'Los siguientes campos quedaran sin rellenar:' + '\n\n' + vacios.map(c=>'  {{'+c+'}}').join('\n') + '\n\nContinuar de todos modos?'
    );
    if (!ok) return;
  }

  const numExp = clave ? (camposObj[clave] || '') : '';
  if (numExp) {
    _expSaveValues(numExp, camposObj);
    if (typeof saveExpedienteDB !== 'undefined') await saveExpedienteDB(numExp, camposObj);
  }

  closeModal('m-export-fields');
  await _doExport(_exportPlantillaId, camposObj);
}

async function _doExport(plantillaId, camposObj) {
  if (!activeId) return;
  const tplName = plantillaId ? (tpls.find(t=>t.id===plantillaId)?.nombre||'plantilla') : 'estilos por defecto';
  toast(`Generando .odt con ${tplName}?`, 4000);

  const headers = { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) };
  const res = await fetch(`/api/modelos/${activeId}/export/odt`, {
    method: 'POST',
    headers,
    body: JSON.stringify({ plantilla_id: plantillaId, campos: camposObj })
  });

  if (!res.ok) {
    const err = await res.json().catch(()=>({error:'Error desconocido'}));
    toast('Error: ' + err.error); return;
  }

  const blob = await res.blob();
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = (document.getElementById('e-name').value||'modelo').replace(/[/\\?%*:|"<>]/g,'_') + '.odt';
  a.click(); URL.revokeObjectURL(a.href);
  toast('Exportado a .odt ✓');
  setTimeout(() => openModel(activeId), 800);
}

function exportOdt(plantillaId) {
  openExportFieldsModal(plantillaId);
}

// "?"?"? BATCH EXPORT "?"?"?"?"?"?"?"?"?"?"?"?"?"?"?"?"?"?"?"?"?"?"?"?"?"?"?"?"?"?"?"?"?"?"?"?"?"?"?"?"?"?"?"?"?"?"?"?"?"?"?"?"?"?"?"?"?"?"?

function toggleBatchMode() {
  batchMode = !batchMode;
  batchSelected.clear();
  const btn = document.getElementById('batch-toggle-btn');
  if (btn) {
    btn.className = 'btn btn-sm' + (batchMode ? ' btn-primary' : '');
    btn.title = batchMode ? 'Salir del modo selección' : 'Seleccionar modelos para exportar en lote';
  }
  if (batchMode) setView('list');
  else renderSidebar();
  _updateBatchFooter();
}

function toggleBatchSelect(id) {
  id = Number(id);
  if (batchSelected.has(id)) batchSelected.delete(id);
  else batchSelected.add(id);
  renderSidebar();
}

function _updateBatchFooter() {
  const foot = document.getElementById('sbstats');
  if (!foot) return;
  if (batchMode) {
    const n = batchSelected.size;
    foot.innerHTML = n
      ? `<button class="btn btn-sm btn-success" style="width:100%;margin-top:4px" onclick="openBatchExportModal()">⬇ Exportar ${n} seleccionado${n!==1?'s':''}</button>`
      : `<span style="color:var(--text3);font-size:12px">Selecciona modelos de la lista</span>`;
  } else {
    foot.textContent = `${models.length} modelo${models.length!==1?'s':''}`;
  }
}

async function openBatchExportModal() {
  if (!batchSelected.size) { toast('Selecciona al menos un modelo'); return; }
  const ids = [...batchSelected];
  // Collect union of all fields from selected models
  const fieldSet = new Set();
  for (const id of ids) {
    const m = models.find(x => Number(x.id) === id);
    if (m && m.cuerpo) {
      (m.cuerpo.match(/\{\{[A-Z][A-Z0-9_]*\}\}/g) || []).forEach(f => fieldSet.add(f.slice(2, -2)));
    }
  }
  // If cuerpos not in list, fetch from server for first model
  if (!fieldSet.size) {
    for (const id of ids.slice(0, 3)) {
      try {
        const data = await api('GET', `/modelos/${id}`);
        if (data?.cuerpo) {
          (data.cuerpo.match(/\{\{[A-Z][A-Z0-9_]*\}\}/g) || []).forEach(f => fieldSet.add(f.slice(2, -2)));
        }
      } catch {}
    }
  }

  const container = document.getElementById('bf-campos');
  const campos = fieldSet.size ? [...fieldSet].sort() : PRESETS.slice(0, 6);
  container.dataset.campos = JSON.stringify(campos);
  container.innerHTML = campos.map(campo => {
    const tipo = _fieldTypeFor ? _fieldTypeFor(campo) : '';
    return `<div class="fg" style="margin-bottom:8px">
      <label class="fl" style="font-size:11px;font-weight:600;color:var(--blue);font-family:monospace">{{${campo}}}</label>
      <input type="text" class="bf-field" data-campo="${campo.replace(/"/g,'&quot;')}" placeholder="${_expPlaceholder(campo)}" style="font-size:13px;padding:5px 8px;border:0.5px solid var(--border);border-radius:6px;width:100%;box-sizing:border-box">
    </div>`;
  }).join('');

  document.getElementById('bf-title').textContent = `Exportar ${ids.length} modelo${ids.length!==1?'s':''} como ZIP`;
  openModal('m-export-batch');
  setTimeout(() => container.querySelector('input')?.focus(), 80);
}

async function confirmBatchExport() {
  const container = document.getElementById('bf-campos');
  const campos = JSON.parse(container.dataset.campos || '[]');
  const camposObj = {};
  campos.forEach(campo => {
    const input = document.querySelector(`.bf-field[data-campo="${campo}"]`);
    if (input && input.value.trim()) camposObj[campo] = input.value.trim();
  });

  closeModal('m-export-batch');
  toast(`Generando ZIP con ${batchSelected.size} modelo(s)…`, 8000);

  const ids = [...batchSelected];
  const headers = { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) };
  try {
    const res = await fetch('/api/export/batch-odt', {
      method: 'POST',
      headers,
      body: JSON.stringify({ ids, campos: camposObj })
    });
    if (!res.ok) {
      const err = await res.json().catch(() => ({ error: 'Error desconocido' }));
      toast('Error: ' + err.error); return;
    }
    const blob = await res.blob();
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = `modelos_${new Date().toISOString().slice(0,10)}.zip`;
    a.click(); URL.revokeObjectURL(a.href);
    toast(`ZIP con ${ids.length} modelo(s) descargado ✓`);
    toggleBatchMode();
  } catch (e) {
    toast('Error exportando: ' + e.message);
  }
}

// "?"?"? MARKDOWN EDITOR "?"?"?"?"?"?"?"?"?"?"?"?"?"?"?"?"?"?"?"?"?"?"?"?"?"?"?"?"?"?"?"?"?"?"?"?"?"?"?"?"?"?"?"?"?"?"?"?"?"?"?"?"?"?"?"?"?
function updatePreview() {
  const md = document.getElementById('e-body').value;
  const previewEl = document.querySelector('.md-preview-body');
  if (previewEl) {
    previewEl.innerHTML = mdToHtmlPreview(md);
    renderMermaidBlocks(previewEl);
  }
  detectFields();
}

function openQuickPreview() {
  if (!activeId) return;
  const md = document.getElementById('e-body').value;
  const nombre = document.getElementById('e-name')?.value || '';
  document.getElementById('preview-title').textContent = 'Vista previa: ' + nombre;
  const contentEl = document.getElementById('preview-content');
  contentEl.innerHTML = mdToHtmlPreview(md);
  renderMermaidBlocks(contentEl);
  openModal('preview-modal');
}

function saveSel() {
  const ta = document.getElementById('e-body');
  selStart = ta.selectionStart; selEnd = ta.selectionEnd;
}

function handleTab(e) {
  if (e.key !== 'Tab') return;
  e.preventDefault();
  const ta = document.getElementById('e-body');
  const s = ta.selectionStart, en = ta.selectionEnd;
  ta.value = ta.value.substring(0,s) + '  ' + ta.value.substring(en);
  ta.selectionStart = ta.selectionEnd = s + 2;
}

document.getElementById('e-body').addEventListener('input', function(e) {
  const ta = this;
  const pos = ta.selectionStart;
  const val = ta.value;
  if (val.slice(pos-2, pos) === '}}') {
    const openPos = val.lastIndexOf('{{', pos-2);
    if (openPos !== -1) {
      const inner = val.slice(openPos+2, pos-2);
      if (inner.length > 0 && /^[A-Z0-9_\sa-z]+$/.test(inner)) {
        const fieldName = inner.trim().toUpperCase().replace(/\s+/g, '_');
        const newField = `{{${fieldName}}}`;
        ta.value = val.slice(0, openPos) + newField + val.slice(pos);
        ta.selectionStart = ta.selectionEnd = openPos + newField.length;
        updatePreview();
      }
    }
  }
});

function mdFmt(type) {
  const ta = document.getElementById('e-body');
  ta.focus();
  const s = ta.selectionStart, e = ta.selectionEnd;
  const sel = ta.value.substring(s, e) || 'texto';
  let replacement = '';
  const before = ta.value.substring(0, s);
  const after = ta.value.substring(e);
  const lineStart = before.lastIndexOf('\n') + 1;
  const lineContent = ta.value.substring(lineStart, e);

  switch(type) {
    case 'bold':      replacement = `**${sel}**`; break;
    case 'italic':    replacement = `*${sel}*`; break;
    case 'strikethrough': replacement = `~~${sel}~~`; break;
    case 'underline': replacement = `<u>${sel}</u>`; break;
    case 'heading1':  ta.value = before.substring(0,lineStart)+'# '+lineContent+after; ta.selectionStart=ta.selectionEnd=lineStart+2+lineContent.length; updatePreview(); return;
    case 'heading2':  ta.value = before.substring(0,lineStart)+'## '+lineContent+after; ta.selectionStart=ta.selectionEnd=lineStart+3+lineContent.length; updatePreview(); return;
    case 'heading3':  ta.value = before.substring(0,lineStart)+'### '+lineContent+after; ta.selectionStart=ta.selectionEnd=lineStart+4+lineContent.length; updatePreview(); return;
    case 'heading4':  ta.value = before.substring(0,lineStart)+'#### '+lineContent+after; ta.selectionStart=ta.selectionEnd=lineStart+5+lineContent.length; updatePreview(); return;
    case 'ul':        replacement = `\n- ${sel}\n`; break;
    case 'ol':        replacement = `\n1. ${sel}\n2. elemento 2\n3. elemento 3\n`; break;
    case 'blockquote': replacement = `\n> ${sel}\n`; break;
    case 'code':      replacement = `\n\`\`\`\n${sel || 'codigo aqui'}\n\`\`\`\n`; break;
    case 'table':
      replacement = `\n| Encabezado 1 | Encabezado 2 | Encabezado 3 |\n|---|---|---|\n| Celda 1 | Celda 2 | Celda 3 |\n| Celda 4 | Celda 5 | Celda 6 |\n`;
      break;
    case 'hr':        replacement = '\n\n---\n\n'; break;
    default: return;
  }
  ta.value = before + replacement + after;
  ta.selectionStart = s;
  ta.selectionEnd = s + replacement.length;
  updatePreview();
}

function insertFieldInEditor(name) {
  const ta = document.getElementById('e-body');
  ta.focus();
  const s = selStart || ta.selectionStart;
  const e = selEnd   || ta.selectionEnd;
  const field = `{{${name}}}`;
  ta.value = ta.value.substring(0,s) + field + ta.value.substring(e);
  ta.selectionStart = ta.selectionEnd = s + field.length;
  selStart = selEnd = ta.selectionStart;
  updatePreview();
}

function detectFields() {
  const md = document.getElementById('e-body').value;
  const matches = [...new Set((md.match(/\{\{[A-Z][A-Z0-9_]*\}\}/g)||[]))];
  const el = document.getElementById('r-fields');
  if (!matches.length) { el.innerHTML='<span style="font-size:11px;color:var(--text3)">Sin campos</span>'; return; }
  el.innerHTML = matches.map(f => `
    <div class="fchip" onclick="insertFieldInEditor('${f.slice(2,-2)}')">
      <span class="fchipname">${escapeHtml(f)}</span>
      <span class="fchiphint">insertar</span>
    </div>`).join('');
  renderMacroCode(matches);
  renderGlobalFields();
}

function renderActivity(acts) {
  const el = document.getElementById('r-activity');
  if (!acts.length) { el.innerHTML='<span style="font-size:11px;color:var(--text3)">?"</span>'; return; }
  el.innerHTML = acts.slice(0,8).map(a=>`
    <div class="aitem">
      <div class="adot"></div>
      <div>
        <div class="atext"><strong>${escapeHtml(a.user_nombre)}</strong> ${escapeHtml(a.accion)}</div>
        <div class="atime">${new Date(a.created_at).toLocaleString('es-ES',{day:'2-digit',month:'2-digit',hour:'2-digit',minute:'2-digit'})}</div>
      </div>
    </div>`).join('');
}

function renderTags(tags) {
  document.getElementById('r-tags').innerHTML = tags.length
    ? tags.map(t=>`<span class="tag">${escapeHtml(t)}</span>`).join('')
    : '<span style="font-size:11px;color:var(--text3)">Sin etiquetas</span>';
}

// "?"?"? FIELD MODAL "?"?"?"?"?"?"?"?"?"?"?"?"?"?"?"?"?"?"?"?"?"?"?"?"?"?"?"?"?"?"?"?"?"?"?"?"?"?"?"?"?"?"?"?"?"?"?"?"?"?"?"?"?"?"?"?"?"?"?"?"?
function openFieldModal() {
  saveSel();
  document.getElementById('mf-name').value = '';
  document.getElementById('mf-presets').innerHTML = PRESETS.map(p =>
    `<span class="ptag" onclick="document.getElementById('mf-name').value='${p}'">${escapeHtml(p)}</span>`
  ).join('');
  renderFieldModalPresets();
  openModal('m-field');
}
async function confirmField() {
  const v = document.getElementById('mf-name').value.trim().toUpperCase().replace(/\s+/g,'_');
  if (!v) return;
  closeModal('m-field');
  insertFieldInEditor(v);
  try {
    await api('POST', '/campos-globales', { clave: v, nombre: _fieldLabelFor(v) });
    await loadGlobalFields();
  } catch (e) {}
}
document.getElementById('mf-name').addEventListener('keydown', e => { if(e.key==='Enter') confirmField(); });

// "?"?"? MACRO CODE "?"?"?"?"?"?"?"?"?"?"?"?"?"?"?"?"?"?"?"?"?"?"?"?"?"?"?"?"?"?"?"?"?"?"?"?"?"?"?"?"?"?"?"?"?"?"?"?"?"?"?"?"?"?"?"?"?"?"?"?"?"?"?
function renderMacroCode(fields) {
  const subs = fields.length
    ? fields.map(f => {
        return `    ' ${f}\n    sField = "${f}"\n    sValue = "" ' <-- introduce el valor aqui\n    oSearch.SearchString = sField\n    oSearch.ReplaceString = sValue\n    oDoc.replaceAll(oSearch)`;
      }).join('\n\n')
    : '    \' Abre el documento exportado y ejecuta esta macro\n    \' Los campos detectados apareceran aqui al guardar el modelo';

  document.getElementById('macro-code').textContent =
`Sub SustituirCampos()
  Dim oDoc As Object
  Dim oSearch As Object
  Dim sField As String
  Dim sValue As String

  oDoc = ThisComponent
  oSearch = oDoc.createSearchDescriptor()
  oSearch.SearchRegularExpression = False
  oSearch.SearchWords = False

${subs}

  MsgBox "Sustitucion completada.", 64, "Acuerdos"
End Sub`;
}

function copyMacro() {
  navigator.clipboard.writeText(document.getElementById('macro-code').textContent)
    .then(() => toast('Macro copiada al portapapeles ✓'))
    .catch(() => toast('No se pudo copiar'));
}

// "?"?"? CATEGORIES TAB "?"?"?"?"?"?"?"?"?"?"?"?"?"?"?"?"?"?"?"?"?"?"?"?"?"?"?"?"?"?"?"?"?"?"?"?"?"?"?"?"?"?"?"?"?"?"?"?"?"?"?"?"?"?"?"?"?"?"?
async function renderCatsTab() {
  await loadCats();
  const el = document.getElementById('catgrid');
  if (!cats.length) { el.innerHTML='<p style="color:var(--text3);font-size:13px">No hay categorias.</p>'; return; }

  const roots = cats.filter(c => !c.parent_id);
  const byParent = {};
  cats.filter(c => c.parent_id).forEach(c => {
    if (!byParent[c.parent_id]) byParent[c.parent_id] = [];
    byParent[c.parent_id].push(c);
  });

  let html = '';
  roots.forEach(root => {
    const rootId = Number(root.id);
    const folder = root.nombre.replace(/[<>:"/\|?*]/g,'').replace(/\s+/g,'_').trim();
    const subs = byParent[root.id] || [];
    html += `<div class="catcard" style="grid-column:1/-1;border-left:3px solid ${COLORS[root.color]||COLORS.blue}">
      <div class="catcard-top">
        <div class="catcard-ico">${escapeHtml(root.icono)}</div>
        <div style="flex:1">
          <div class="catcard-name">${escapeHtml(root.nombre)}</div>
          <div class="catcard-desc">${escapeHtml(root.descripcion||'Sin descripcin')}</div>
        </div>
        ${me.rol==='admin'?`
        <button class="btn btn-sm" onclick="openCatModal(${rootId})">Edit</button>
        <button class="btn btn-sm btn-danger" onclick="deleteCat(${rootId})">Delete</button>
        <button class="btn btn-sm btn-primary" onclick="openCatModal(null,${rootId})" title="Nueva subcategoria">+ Sub</button>`:''}
      </div>
      ${subs.length ? `<div style="display:flex;flex-wrap:wrap;gap:6px;padding-top:8px;border-top:0.5px solid var(--border)">
        ${subs.map(sub => {
          const subId = Number(sub.id);
          const sf = sub.nombre.replace(/[<>:"\/\|?*]/g,'').replace(/\s+/g,'_').trim();
          return `<div class="catcard" style="margin:0;flex:1;min-width:200px">
            <div class="catcard-top" style="margin-bottom:4px">
              <div class="catcard-ico" style="font-size:16px">${escapeHtml(sub.icono)}</div>
              <div>
                <div class="catcard-name" style="font-size:12px">${escapeHtml(sub.nombre)}</div>
              </div>
            </div>
            <div class="catcard-foot">
              <span style="color:${COLORS[sub.color]||COLORS.blue};font-weight:500">${sub.total_modelos} modelos</span>
              <span class="catcard-folder">DIR ${sf}/</span>
              ${me.rol==='admin'?`
              <button class="btn btn-sm" onclick="showCatFiles(${subId},${JSON.stringify(sub.nombre)})">Open</button>
              <button class="btn btn-sm" onclick="openCatModal(${subId})">Edit</button>
              <button class="btn btn-sm btn-danger" onclick="deleteCat(${subId})">Delete</button>`:''}
            </div>
          </div>`;
        }).join('')}
      </div>` : `<div style="font-size:11px;color:var(--text3);padding-top:6px">Sin subcategorias - <a href="#" onclick="openCatModal(null,${rootId});return false" style="color:var(--blue)">anadir</a></div>`}
    </div>`;
  });

  el.innerHTML = html || '<p style="color:var(--text3);font-size:13px">No hay categorias.</p>';
}

async function showCatFiles(id, nombre) {
  const files = await api('GET', `/categorias/${id}/archivos`) || [];
  document.getElementById('cat-files-title').textContent = `Folder ${nombre} - archivos exportados`;
  const el = document.getElementById('cat-files-list');
  el.innerHTML = files.length
    ? files.map(f=>`<div style="display:flex;align-items:center;gap:10px;padding:5px 0;border-bottom:0.5px solid var(--border)">
        <span style="font-family:monospace;font-size:12px;color:var(--text2);flex:1">${escapeHtml(f.nombre)}</span>
        <span style="font-size:11px;color:var(--text3)">${Math.round((f.tamano ?? f.size ?? 0)/1024)} KB</span>
        <span style="font-size:11px;color:var(--text3)">${new Date(f.modificado).toLocaleDateString('es-ES')}</span>
      </div>`).join('')
    : '<p style="color:var(--text3);font-size:12px">Sin archivos exportados aun.</p>';
  document.getElementById('cat-files-card').style.display = '';
}

let catParentId = null;
function openCatModal(id, parentId) {
  catEditId = id || null; catColor = 'blue'; catParentId = parentId || null;
  document.getElementById('mcat-title').textContent = id ? 'Editar categoria' : (parentId ? 'Nueva subcategoria' : 'Nueva categoria raiz');
  document.querySelectorAll('.sw').forEach(s => s.classList.toggle('sel', s.dataset.c==='blue'));
  const psel = document.getElementById('mc-parent');
  if (id) {
    const c = cats.find(x=>x.id===id); if(!c) return;
    document.getElementById('mc-nombre').value = c.nombre;
    document.getElementById('mc-icono').value  = c.icono;
    document.getElementById('mc-desc').value   = c.descripcion||'';
    document.getElementById('mc-orden').value  = c.orden;
    catColor = c.color || 'blue';
    catParentId = c.parent_id || null;
    document.querySelectorAll('.sw').forEach(s => s.classList.toggle('sel', s.dataset.c===catColor));
    if (psel) psel.value = c.parent_id || '';
  } else {
    ['mc-nombre','mc-icono','mc-desc'].forEach(i=>document.getElementById(i).value='');
    document.getElementById('mc-icono').value = '📁';
    document.getElementById('mc-orden').value = '0';
    if (psel) psel.value = parentId || '';
  }
  document.getElementById('mc-err').style.display = 'none';
  openModal('m-cat');
}

function selColor(c) {
  catColor = c;
  document.querySelectorAll('.sw').forEach(s => s.classList.toggle('sel', s.dataset.c===c));
}

async function saveCat() {
  const nombre = document.getElementById('mc-nombre').value.trim();
  if (!nombre) { const e=document.getElementById('mc-err'); e.textContent='Nombre obligatorio'; e.style.display='block'; return; }
  const psel = document.getElementById('mc-parent');
  const parent_id = psel ? (psel.value ? parseInt(psel.value) : null) : catParentId;
  const body = {
    nombre, descripcion:document.getElementById('mc-desc').value,
    icono:document.getElementById('mc-icono').value||'📁',
    color:catColor, orden:parseInt(document.getElementById('mc-orden').value)||0, activa:1,
    parent_id
  };
  const res = catEditId ? await api('PUT',`/categorias/${catEditId}`,body) : await api('POST','/categorias',body);
  if (res?.error) { const e=document.getElementById('mc-err'); e.textContent=res.error; e.style.display='block'; return; }
  closeModal('m-cat'); toast(catEditId?'Categoria actualizada ✓':'Categoria creada ✓');
  await renderCatsTab(); await loadCats(); await loadModels();
}

async function deleteCat(id) {
  if (!confirm('?Eliminar? Solo es posible si no tiene modelos asignados.')) return;
  const res = await api('DELETE', `/categorias/${id}`);
  if (res?.error) { alert(res.error); return; }
  toast('Eliminada'); await renderCatsTab(); await loadCats(); await loadModels();
}

// "?"?"? TEMPLATES TAB "?"?"?"?"?"?"?"?"?"?"?"?"?"?"?"?"?"?"?"?"?"?"?"?"?"?"?"?"?"?"?"?"?"?"?"?"?"?"?"?"?"?"?"?"?"?"?"?"?"?"?"?"?"?"?"?"?"?"?"?
async function renderTplsTab() {
  await loadTpls();
  const el = document.getElementById('tpl-list');
  if (!tpls.length) {
    el.innerHTML = '<p style="font-size:13px;color:var(--text3)">No hay plantillas subidas. Sube tu primera plantilla .ott.</p>';
    return;
  }
  el.innerHTML = tpls.map(t => {
    const tid = Number(t.id);
    return `<div class="tplcard">
      <div class="tplicon">Y"<</div>
      <div class="tplinfo">
        <div class="tplname">${escapeHtml(t.nombre)} ${t.es_defecto ? '<span class="b b-defecto">predeterminada</span>' : ''}</div>
        <div class="tpldesc">${escapeHtml(t.descripcion||'Sin descripcin')} . <span style="font-family:monospace;font-size:10px;color:var(--text3)">${escapeHtml(t.filename)}</span></div>
      </div>
      <div class="tplactions">
        ${!t.es_defecto ? `<button class="btn btn-sm btn-success" onclick="setDefaultTpl(${tid})">Predeterminar</button>` : ''}
        <button class="btn btn-sm btn-danger" onclick="deleteTpl(${tid})">Delete</button>
      </div>
    </div>`;
  }).join('');
}

function openTplUpload() {
  document.getElementById('mt-nombre').value = '';
  document.getElementById('mt-desc').value   = '';
  document.getElementById('mt-err').style.display = 'none';
  document.getElementById('tpl-file-name').style.display = 'none';
  document.getElementById('tpl-file').value = '';
  openModal('m-tpl');
}

let tplFileSelected = null;
function handleTplFile(input) {
  tplFileSelected = input.files[0];
  if (tplFileSelected) {
    document.getElementById('tpl-file-name').textContent = 'Y"Z ' + tplFileSelected.name;
    document.getElementById('tpl-file-name').style.display = '';
    if (!document.getElementById('mt-nombre').value)
      document.getElementById('mt-nombre').value = tplFileSelected.name.replace(/\.(ott|odt)$/i,'');
  }
}

const dz = document.getElementById('tpl-dropzone');
dz.addEventListener('dragover', e => { e.preventDefault(); dz.classList.add('dragover'); });
dz.addEventListener('dragleave', () => dz.classList.remove('dragover'));
dz.addEventListener('drop', e => {
  e.preventDefault(); dz.classList.remove('dragover');
  const f = e.dataTransfer.files[0];
  if (f) { document.getElementById('tpl-file').files = e.dataTransfer.files; handleTplFile(document.getElementById('tpl-file')); }
});

async function uploadTpl() {
  if (!tplFileSelected) { const e=document.getElementById('mt-err'); e.textContent='Selecciona un archivo'; e.style.display='block'; return; }
  const fd = new FormData();
  fd.append('file', tplFileSelected);
  fd.append('nombre', document.getElementById('mt-nombre').value || tplFileSelected.name);
  fd.append('descripcion', document.getElementById('mt-desc').value);
  const headers = token ? { Authorization: `Bearer ${token}` } : {};
  const res = await fetch(API+'/plantillas', {
    method:'POST', headers, body:fd
  }).then(r=>r.json()).catch(()=>({error:'Error de red'}));
  if (res.error) { const e=document.getElementById('mt-err'); e.textContent=res.error; e.style.display='block'; return; }
  tplFileSelected = null;
  closeModal('m-tpl'); toast('Plantilla subida ✓');
  await renderTplsTab();
}

async function setDefaultTpl(id) {
  await api('PUT', `/plantillas/${id}/defecto`, {});
  toast('Plantilla predeterminada ✓'); await renderTplsTab();
}

async function deleteTpl(id) {
  if (!confirm('?Eliminar esta plantilla?')) return;
  await api('DELETE', `/plantillas/${id}`);
  toast('Plantilla eliminada'); await renderTplsTab();
}

// "?"?"? USERS TAB "?"?"?"?"?"?"?"?"?"?"?"?"?"?"?"?"?"?"?"?"?"?"?"?"?"?"?"?"?"?"?"?"?"?"?"?"?"?"?"?"?"?"?"?"?"?"?"?"?"?"?"?"?"?"?"?"?"?"?"?"?"?"?"?
async function renderUsersTab() {
  const users = await api('GET', '/users') || [];
  document.getElementById('ulist').innerHTML = users.map(u => {
    const uid = Number(u.id);
    return `<div class="urow">
      <div class="av" style="width:32px;height:32px;font-size:12px">${escapeHtml(u.nombre.split(' ').map(w=>w[0]).join('').slice(0,2).toUpperCase())}</div>
      <div style="flex:1"><div class="uname">${escapeHtml(u.nombre)}</div><div class="uemail">${escapeHtml(u.email)}</div></div>
      <span class="b b-${escapeHtml(u.rol)}">${escapeHtml(u.rol)}</span>
      ${me.rol==='admin'?`<select style="font-size:12px;width:130px" onchange="changeRole(${uid},this.value)">
        <option ${u.rol==='admin'?'selected':''} value="admin">admin</option>
        <option ${u.rol==='editor'?'selected':''} value="editor">editor</option>
        <option ${u.rol==='consultor'?'selected':''} value="consultor">consultor</option>
      </select>`:''}
    </div>`;
  }).join('');
}

async function changeRole(id, rol) {
  const users = await api('GET', '/users');
  const u = users.find(x=>x.id===id); if(!u) return;
  await api('PUT', `/users/${id}`, {nombre:u.nombre, rol, activo:u.activo});
  toast('Rol actualizado ✓');
}

function openUserModal() {
  ['mu-nombre','mu-email','mu-pass'].forEach(id=>document.getElementById(id).value='');
  document.getElementById('mu-err').style.display='none';
  openModal('m-user');
}
async function createUser() {
  const res = await api('POST','/users',{
    nombre:document.getElementById('mu-nombre').value,
    email: document.getElementById('mu-email').value,
    password:document.getElementById('mu-pass').value,
    rol:document.getElementById('mu-rol').value
  });
  if (res?.error) { const e=document.getElementById('mu-err'); e.textContent=res.error; e.style.display='block'; return; }
  closeModal('m-user'); toast('Usuario creado ✓'); renderUsersTab();
}

// "?"?"? STYLE EDITOR "?"?"?"?"?"?"?"?"?"?"?"?"?"?"?"?"?"?"?"?"?"?"?"?"?"?"?"?"?"?"?"?"?"?"?"?"?"?"?"?"?"?"?"?"?"?"?"?"?"?"?"?"?"?"?"?"?"?"?"?"?
let selectedPlantillaId = null;
let availableStyles = [];

async function openStylesEditor(plantillaId) {
  if (!activeId) return;
  if (!plantillaId) {
    const defaultTpl = tpls.find(t => t.es_defecto);
    if (!defaultTpl) {
      toast('No hay plantilla seleccionada. El editor de estilos requiere una plantilla.');
      return;
    }
    plantillaId = defaultTpl.id;
  }
  selectedPlantillaId = plantillaId;
  openModal('m-styles');
  await loadTemplateStyles(plantillaId);
}

async function loadTemplateStyles(plantillaId) {
  const loading = document.getElementById('styles-loading');
  const content = document.getElementById('styles-content');
  const error = document.getElementById('styles-error');
  loading.style.display = '';
  content.style.display = 'none';
  error.style.display = 'none';
  try {
    const res = await api('GET', `/modelos/${activeId}/plantilla-estilos?plantilla_id=${plantillaId}`);
    if (res?.error) { error.textContent = res.error; error.style.display = 'block'; loading.style.display = 'none'; return; }
    availableStyles = res.estilos || [];
    const currentConfig = res.config || {};
    const grid = document.getElementById('styles-grid');
    let html = '';
    for (let i = 1; i <= 6; i++) {
      const currentStyle = currentConfig[i] || `Heading${i}`;
      const options = availableStyles.map(s => `<option value="${escapeHtml(s)}" ${s === currentStyle ? 'selected' : ''}>${escapeHtml(s)}</option>`).join('');
      html += `<div class="fg" style="margin:0"><label class="fl">Encabezado H${i}</label><select id="ms-h${i}"><option value="">?" Detectar automaticamente ?"</option>${options}</select></div>`;
    }
    grid.innerHTML = html;
    const bodyStyle = document.getElementById('ms-body-style');
    const currentBodyStyle = currentConfig.body_style || 'BodyText';
    bodyStyle.innerHTML = availableStyles.map(s => `<option value="${escapeHtml(s)}" ${s === currentBodyStyle ? 'selected' : ''}>${escapeHtml(s)}</option>`).join('');
    loading.style.display = 'none';
    content.style.display = 'flex';
  } catch (err) {
    error.textContent = 'Error al cargar estilos: ' + err.message;
    error.style.display = 'block';
    loading.style.display = 'none';
  }
}

async function saveStyleConfig() {
  if (!activeId || !selectedPlantillaId) return;
  const config = {};
  for (let i = 1; i <= 6; i++) {
    const el = document.getElementById(`ms-h${i}`);
    if (el?.value) config[i] = el.value;
  }
  const bodyEl = document.getElementById('ms-body-style');
  if (bodyEl?.value) config['body_style'] = bodyEl.value;
  document.getElementById('btn-save-styles').disabled = true;
  const res = await api('POST', `/modelos/${activeId}/estilo-config`, { config });
  if (res?.error) { toast('Error al guardar: ' + res.error); }
  else { toast('Configuracion de estilos guardada ✓'); closeModal('m-styles'); }
  document.getElementById('btn-save-styles').disabled = false;
}

// "?"?"? TABS "?"?"?"?"?"?"?"?"?"?"?"?"?"?"?"?"?"?"?"?"?"?"?"?"?"?"?"?"?"?"?"?"?"?"?"?"?"?"?"?"?"?"?"?"?"?"?"?"?"?"?"?"?"?"?"?"?"?"?"?"?"?"?"?"?"?"?"?"?
function switchTab(t) {
  const map = {editor:'tab-editor', cats:'tab-cats', tpls:'tab-tpls', campos:'tab-campos', users:'tab-users'};
  const btns = {editor:'tab-e-btn', cats:'tab-c-btn', tpls:'tab-t-btn', campos:'tab-campos-btn', users:'tab-u-btn'};
  Object.entries(map).forEach(([k,id]) => document.getElementById(id).style.display = k===t ? 'flex' : 'none');
  Object.entries(btns).forEach(([k,id]) => { const el=document.getElementById(id); if(el) el.classList.toggle('active',k===t); });
  if (t==='cats')   renderCatsTab();
  if (t==='tpls')   renderTplsTab();
  if (t==='users')  renderUsersTab();
  if (t==='campos') loadAnalisisCampos();
}

let _analisisCamposData = [];

async function loadAnalisisCampos() {
  document.getElementById('campos-tabla').innerHTML = '<p style="color:var(--text3);font-size:13px">Analizando documentos…</p>';
  const data = await api('GET', '/analisis-campos');
  if (!data) return;
  _analisisCamposData = data.campos || [];
  document.getElementById('campos-stats').textContent =
    `${data.total_campos} campos únicos · ${data.total_modelos} documentos analizados`;
  renderAnalisisCampos(_analisisCamposData);
}

function filterAnalisisCampos() {
  const q = (document.getElementById('campos-search')?.value || '').trim().toLowerCase();
  const filtered = q
    ? _analisisCamposData.filter(f =>
        f.campo.toLowerCase().includes(q) || f.nombre_legible.toLowerCase().includes(q))
    : _analisisCamposData;
  renderAnalisisCampos(filtered);
}

function renderAnalisisCampos(campos) {
  const el = document.getElementById('campos-tabla');
  if (!campos.length) {
    el.innerHTML = '<p style="color:var(--text3);font-size:13px">Sin resultados.</p>';
    return;
  }
  const tipoColor = { fecha:'var(--amber)', importe:'var(--teal)', numero:'var(--purple)',
    lista:'var(--blue)', booleano:'var(--red)', texto:'var(--text3)' };
  const tipoBg = { fecha:'var(--amber-bg)', importe:'var(--teal-bg)', numero:'var(--purple-bg)',
    lista:'var(--blue-bg)', booleano:'var(--red-bg)', texto:'var(--surface2)' };
  el.innerHTML = `
    <div style="overflow-x:auto">
    <table style="width:100%;border-collapse:collapse;font-size:12px">
      <thead>
        <tr style="background:var(--surface2);border-bottom:0.5px solid var(--border2)">
          <th style="text-align:left;padding:8px 12px;font-size:11px;font-weight:600;color:var(--text2);white-space:nowrap">Campo</th>
          <th style="text-align:left;padding:8px 12px;font-size:11px;font-weight:600;color:var(--text2)">Nombre legible</th>
          <th style="text-align:center;padding:8px 12px;font-size:11px;font-weight:600;color:var(--text2)">Tipo</th>
          <th style="text-align:center;padding:8px 12px;font-size:11px;font-weight:600;color:var(--text2)">Docs</th>
          <th style="text-align:left;padding:8px 12px;font-size:11px;font-weight:600;color:var(--text2)">Documentos que lo usan</th>
        </tr>
      </thead>
      <tbody>
        ${campos.map((f, i) => {
          const tc = tipoColor[f.tipo] || 'var(--text3)';
          const tb = tipoBg[f.tipo] || 'var(--surface2)';
          const docs = f.modelos.map(m =>
            `<span onclick="switchTab('editor');openModel(${m.id})"
              style="font-size:10px;padding:2px 7px;border-radius:99px;background:var(--surface2);border:0.5px solid var(--border);cursor:pointer;color:var(--text2);white-space:nowrap;display:inline-block;margin:1px"
              title="${escapeHtml(m.categoria)}">${escapeHtml(m.nombre)}</span>`
          ).join('');
          return `<tr style="border-bottom:0.5px solid var(--border);${i%2===1?'background:var(--surface2)':''}">
            <td style="padding:7px 12px;font-family:monospace;font-size:11px;color:var(--blue);white-space:nowrap">
              ${f.en_catalogo ? '' : '<span title="No está en el catálogo" style="color:var(--amber);margin-right:4px">⚠</span>'}{{${escapeHtml(f.campo)}}}
            </td>
            <td style="padding:7px 12px;color:var(--text2);font-size:12px">${escapeHtml(f.nombre_legible)}</td>
            <td style="padding:7px 12px;text-align:center">
              ${f.tipo
                ? `<span style="font-size:10px;padding:2px 7px;border-radius:99px;background:${tb};color:${tc};font-weight:500">${f.tipo}</span>`
                : `<span style="font-size:10px;color:var(--text3)">—</span>`}
            </td>
            <td style="padding:7px 12px;text-align:center;font-weight:700;font-size:13px;color:${f.count >= 3 ? 'var(--green)' : f.count === 1 ? 'var(--text3)' : 'var(--text)'}">${f.count}</td>
            <td style="padding:7px 12px">${docs}</td>
          </tr>`;
        }).join('')}
      </tbody>
    </table>
    </div>`;
}

function openDuplicateModal() {
  if (!activeId) return;
  const modelo = models.find(m => m.id === activeId);
  const input = document.getElementById('dup-nombre');
  input.value = modelo ? `Copia de ${modelo.nombre}` : '';
  document.getElementById('dup-err').style.display = 'none';
  openModal('m-duplicate');
  setTimeout(() => { input.select(); }, 100);
}

async function confirmDuplicate() {
  const nombre = document.getElementById('dup-nombre').value.trim();
  if (!nombre) {
    const e = document.getElementById('dup-err');
    e.textContent = 'El nombre es obligatorio';
    e.style.display = 'block';
    return;
  }
  const res = await api('POST', `/modelos/${activeId}/duplicate`, { nombre });
  if (res?.error) {
    const e = document.getElementById('dup-err');
    e.textContent = res.error;
    e.style.display = 'block';
    return;
  }
  closeModal('m-duplicate');
  toast('Modelo duplicado ✓');
  await loadModels();
  await openModel(res.id);
}

// "?"?"? PASTE FROM WORD "?"?"?"?"?"?"?"?"?"?"?"?"?"?"?"?"?"?"?"?"?"?"?"?"?"?"?"?"?"?"?"?"?"?"?"?"?"?"?"?"?"?"?"?"?"?"?"?"?"?"?"?"?"?"?"?"?"?
function triggerPasteFromWord() {
  openModal('m-paste-word');
  setTimeout(() => document.getElementById('paste-input').focus(), 100);
}

function confirmPasteWord() {
  const div = document.getElementById('paste-input');
  const html = div.innerHTML;
  if (!html.trim()) { closeModal('m-paste-word'); return; }
  const md = _htmlToMarkdown(html).replace(/\n{3,}/g, '\n\n').trim();
  _insertMarkdown(md);
  div.innerHTML = '';
  closeModal('m-paste-word');
  toast('Texto pegado ✓');
}

function _insertMarkdown(md) {
  const ta = document.getElementById('e-body');
  const s = ta.selectionStart;
  const e = ta.selectionEnd;
  ta.value = ta.value.slice(0, s) + md + ta.value.slice(e);
  ta.selectionStart = ta.selectionEnd = s + md.length;
  updatePreview();
}

function _htmlToMarkdown(html) {
  const parser = new DOMParser();
  const doc = parser.parseFromString(html, 'text/html');
  doc.querySelectorAll('p, span, div').forEach(el => {
    if (!el.textContent.trim() && !el.querySelector('img,table,br')) el.remove();
  });
  doc.querySelectorAll('[style],[class]').forEach(el => {
    el.removeAttribute('style'); el.removeAttribute('class');
  });
  let md = _nodeToMd(doc.body).trim();
  md = md.replace(/\n{3,}/g, '\n\n');
  md = md.replace(/^ +/gm, '');
  md = md.replace(/^\s+$/gm, '');
  return md;
}
function insertDiagram() {
  const templates = {
    flowchart: `\`\`\`mermaid\nflowchart LR\n    A[Inicio] --> B{¿Condición?}\n    B -- Sí --> C[Acción A]\n    B -- No --> D[Acción B]\n    C --> E[Fin]\n    D --> E\n\`\`\``,
    sequence: `\`\`\`mermaid\nsequenceDiagram\n    Ayuntamiento->>Contratista: Resolución adjudicación\n    Contratista-->>Ayuntamiento: Acuse de recibo\n    Ayuntamiento->>Contratista: Formalización contrato\n\`\`\``,
    gantt: `\`\`\`mermaid\ngantt\n    title Planificación del contrato\n    dateFormat  YYYY-MM-DD\n    section Licitación\n    Publicación BOP     :2024-01-01, 15d\n    Plazo ofertas       :15d\n    section Ejecución\n    Adjudicación        :2024-02-01, 10d\n    Ejecución obras     :60d\n\`\`\``,
    pie: `\`\`\`mermaid\npie title Distribución presupuestaria\n    "Personal" : 42\n    "Inversiones" : 28\n    "Servicios" : 18\n    "Otros" : 12\n\`\`\``,
  };

  // Pequeño selector de tipo
  const type = prompt(
    'Tipo de diagrama:\n1) Flujo (flowchart)\n2) Secuencia\n3) Gantt\n4) Tarta (pie)\n\nEscribe el número:',
    '1'
  );
  const map = { '1': 'flowchart', '2': 'sequence', '3': 'gantt', '4': 'pie' };
  const chosen = map[type?.trim()] || 'flowchart';
  _insertMarkdown('\n' + templates[chosen] + '\n');
}
function _nodeToMd(node) {
  if (node.nodeType === Node.TEXT_NODE) return node.textContent;
  if (node.nodeType !== Node.ELEMENT_NODE) return '';
  const tag = node.tagName.toLowerCase();
  const inner = () => Array.from(node.childNodes).map(_nodeToMd).join('');
  switch (tag) {
    case 'h1': return `\n\n# ${inner().trim().replace(/\n+/g, ' ')}\n\n`;
    case 'h2': return `\n\n## ${inner().trim().replace(/\n+/g, ' ')}\n\n`;
    case 'h3': return `\n\n### ${inner().trim().replace(/\n+/g, ' ')}\n\n`;
    case 'h4': return `\n\n#### ${inner().trim().replace(/\n+/g, ' ')}\n\n`;
    case 'h5': return `\n\n##### ${inner().trim().replace(/\n+/g, ' ')}\n\n`;
    case 'h6': return `\n\n###### ${inner().trim().replace(/\n+/g, ' ')}\n\n`;
    case 'p': { const text = inner().trim().replace(/\n+/g, ' '); return text ? `\n\n${text}\n\n` : ''; }
    case 'br': return '\n';
    case 'strong': case 'b': return `**${inner()}**`;
    case 'em': case 'i':     return `*${inner()}*`;
    case 'u':                return `<u>${inner()}</u>`;
    case 's': case 'strike': case 'del': return `~~${inner()}~~`;
    case 'code': return `\`${inner()}\``;
    case 'pre':  return `\n\n\`\`\`\n${node.textContent}\n\`\`\`\n\n`;
    case 'blockquote': return `\n\n> ${inner().trim().replace(/\n/g, '\n> ')}\n\n`;
    case 'hr': return '\n\n---\n\n';
    case 'a': { const href = node.getAttribute('href') || ''; const text = inner(); return href && href !== text ? `[${text}](${href})` : text; }
    case 'ul': return '\n\n' + Array.from(node.querySelectorAll(':scope > li')).map(li => `- ${_liToMd(li)}`).join('\n') + '\n\n';
    case 'ol': return '\n\n' + Array.from(node.querySelectorAll(':scope > li')).map((li, i) => `${i+1}. ${_liToMd(li)}`).join('\n') + '\n\n';
    case 'table': return _tableToMd(node);
    default: return inner();
  }
}

function _liToMd(li) {
  let text = ''; let nested = '';
  for (const child of li.childNodes) {
    if (child.nodeType === Node.ELEMENT_NODE && (child.tagName === 'UL' || child.tagName === 'OL')) {
      nested += _nodeToMd(child).trim().split('\n').map(l => '  ' + l).join('\n');
    } else { text += _nodeToMd(child); }
  }
  return text.trim() + (nested ? '\n' + nested : '');
}

function _tableToMd(table) {
  const rows = Array.from(table.querySelectorAll('tr'));
  if (!rows.length) return '';
  const toRow = (tr) => Array.from(tr.querySelectorAll('th,td')).map(c => c.textContent.trim().replace(/\|/g, '\\|'));
  const header = toRow(rows[0]);
  const sep = header.map(() => '---');
  const body = rows.slice(1).map(toRow);
  const fmt = (cols) => '| ' + cols.join(' | ') + ' |';
  return '\n\n' + [fmt(header), fmt(sep), ...body.map(fmt)].join('\n') + '\n\n';
}

document.addEventListener('paste', function(e) {
  const ta = document.getElementById('e-body');
  if (!ta._wordPasteNext) return;
  ta._wordPasteNext = false;
  const html = e.clipboardData.getData('text/html');
  if (!html) return;
  e.preventDefault();
  const md = _htmlToMarkdown(html).replace(/\n{3,}/g, '\n\n');
  _insertMarkdown(md);
  toast('Texto convertido a Markdown ✓');
});

// "?"?"? BOOT "?"?"?"?"?"?"?"?"?"?"?"?"?"?"?"?"?"?"?"?"?"?"?"?"?"?"?"?"?"?"?"?"?"?"?"?"?"?"?"?"?"?"?"?"?"?"?"?"?"?"?"?"?"?"?"?"?"?"?"?"?"?"?"?"?"?"?"?"?
initApp();
