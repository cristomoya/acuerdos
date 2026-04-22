// ─── GLOBALS ──────────────────────────────────────────────────────────────────
const API = '/api';
let token = localStorage.getItem('token');
let me = null, models = [], cats = [], tpls = [], activeId = null;
let statusFilter = '', sideView = 'tree', catEditId = null, catColor = 'blue';
let selStart = 0, selEnd = 0;

const PRESETS = ['NUMERO_EXPEDIENTE','FECHA_SESION','NUMERO_SESION','ALCALDE_NOMBRE',
  'SECRETARIO_NOMBRE','IMPORTE','CONCEPTO','DEPARTAMENTO','FECHA_PUBLICACION',
  'MUNICIPIO','EJERCICIO_PRESUPUESTARIO','VOTACION_RESULTADO','NUMERO_DECRETO',
  'OBJETO_CONTRATO','PARTIDA_PRESUPUESTARIA','ENTIDAD_COLABORADORA',
  'REPRESENTANTE_ENTIDAD','OBJETO_CONVENIO','FECHA_INICIO','FECHA_FIN','FECHA_FIRMA'];

const COLORS = {blue:'#185FA5',teal:'#0F6E56',amber:'#854F0B',green:'#3B6D11',purple:'#534AB7',red:'#A32D2D'};
const COLORBG = {blue:'#E6F1FB',teal:'#E1F5EE',amber:'#FAEEDA',green:'#EAF3DE',purple:'#EEEDFE',red:'#FCEBEB'};

// ─── MARKED CONFIG ────────────────────────────────────────────────────────────
const FIELD_RE = /\{\{([A-Z][A-Z0-9_]*)\}\}/g;

function mdToHtmlPreview(md) {
  // Highlight {{FIELD}} before parsing
  const escaped = md.replace(FIELD_RE, '<span class="field-tag">{{$1}}</span>');
  return marked.parse(escaped, { breaks: true, gfm: true });
}

// ─── UTILITIES ────────────────────────────────────────────────────────────────
async function api(method, path, body) {
  const opts = { method, headers: {'Content-Type':'application/json', ...(token ? {Authorization:`Bearer ${token}`} : {})} };
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

// Close export menu on outside click
document.addEventListener('click', e => {
  if (!document.getElementById('export-wrap')?.contains(e.target))
    document.getElementById('export-menu')?.classList.remove('open');
});

// ─── AUTH ─────────────────────────────────────────────────────────────────────
async function doLogin() {
  const email = document.getElementById('l-email').value;
  const pass  = document.getElementById('l-pass').value;
  const errEl = document.getElementById('l-err');
  errEl.style.display = 'none';
  const res = await fetch(API+'/auth/login', {
    method:'POST', headers:{'Content-Type':'application/json'},
    body: JSON.stringify({email, password:pass})
  }).then(r=>r.json()).catch(()=>({error:'Error de conexión'}));
  if (res.error) { errEl.textContent=res.error; errEl.style.display='block'; return; }
  token = res.token; me = res.user;
  localStorage.setItem('token', token);
  initApp();
}
document.getElementById('l-pass').addEventListener('keydown', e => { if(e.key==='Enter') doLogin(); });

function doLogout() {
  localStorage.removeItem('token'); token=null; me=null;
  document.getElementById('login').style.display='flex';
  document.getElementById('app').style.display='none';
}

async function initApp() {
  if (!token) return;
  const user = await api('GET', '/auth/me');
  if (!user) return;
  me = user;
  document.getElementById('login').style.display = 'none';
  document.getElementById('app').style.display = 'flex';
  const ini = me.nombre.split(' ').map(w=>w[0]).join('').slice(0,2).toUpperCase();
  document.getElementById('top-av').textContent = ini;
  document.getElementById('top-name').textContent = me.nombre;
  if (me.rol === 'admin') {
    ['tab-c-btn','tab-t-btn','tab-u-btn'].forEach(id => document.getElementById(id).classList.remove('hidden'));
  }
  await Promise.all([loadCats(), loadTpls()]);
  await loadModels();
  renderMacroCode([]);
}
// Autocomplete {{CAMPO}}
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
// ─── CATS ─────────────────────────────────────────────────────────────────────
async function loadCats() {
  cats = await api('GET', '/categorias') || [];
  // Selector de categoría en editor: solo subcategorías (con parent_id)
  const sel = document.getElementById('e-cat');
  const cur = sel.value;
  const subcats = cats.filter(c => c.parent_id);
  sel.innerHTML = '<option value="">— Sin categoría —</option>' +
    subcats.map(c => {
      const parent = cats.find(p => p.id === c.parent_id);
      const label = parent ? `${parent.icono} ${parent.nombre} › ${c.icono} ${c.nombre}` : `${c.icono} ${c.nombre}`;
      return `<option value="${c.id}">${label}</option>`;
    }).join('');
  if (cur) sel.value = cur;
  // Selector de padre en modal de categoría
  const psel = document.getElementById('mc-parent');
  if (psel) {
    const roots = cats.filter(c => !c.parent_id);
    psel.innerHTML = '<option value="">— Categoría raíz —</option>' +
      roots.map(c => `<option value="${c.id}">${c.icono} ${c.nombre}</option>`).join('');
  }
}

// ─── TEMPLATES ────────────────────────────────────────────────────────────────
async function loadTpls() {
  tpls = await api('GET', '/plantillas') || [];
  renderExportMenu();
}

function renderExportMenu() {
  const el = document.getElementById('emenu-tpls');
  if (!tpls.length) {
    el.innerHTML = '<div class="emenu-item" style="color:var(--text3);font-size:12px">Sin plantillas subidas</div>';
    return;
  }
  el.innerHTML = tpls.map(t => `
    <div class="emenu-item" onclick="exportOdt(${t.id})">
      <span>📋</span>
      <span style="flex:1">${t.nombre}${t.es_defecto?'  <span class="b b-defecto" style="font-size:10px">predeterminada</span>':''}</span>
    </div>`).join('');
}

function toggleExportMenu() {
  document.getElementById('export-menu').classList.toggle('open');
}

// ─── MODELS ───────────────────────────────────────────────────────────────────
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
  document.getElementById('sbstats').textContent = `${models.length} modelo${models.length!==1?'s':''}`;
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
  el.innerHTML = models.map(m => `
    <div class="mitem ${m.id===activeId?'active':''}" onclick="openModel(${m.id})">
      <div class="micon" style="background:${COLORBG[m.categoria_color]||'#f0efe9'}">${m.categoria_icono||'📄'}</div>
      <div class="minfo">
        <div class="mname">${m.nombre}</div>
        <div class="mmeta">${m.categoria_nombre||'Sin cat.'} · <span class="b b-${m.estado}">${m.estado}</span></div>
      </div>
    </div>`).join('');
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

  // Count models per root (sum of all subcats)
  function countForRoot(root) {
    const subs = byParent[root.id] || [];
    return subs.reduce((n, s) => n + (byCat[s.id]||[]).length, 0) + (byCat[root.id]||[]).length;
  }

  const arrow = `<svg width="11" height="11" viewBox="0 0 11 11" class="catarrow" style="flex-shrink:0;transition:transform .15s"><path d="M2.5 4l3 3 3-3" stroke="currentColor" stroke-width="1.2" fill="none" stroke-linecap="round"/></svg>`;

  let html = '';
  roots.forEach(root => {
    const subs = byParent[root.id] || [];
    const total = countForRoot(root);
    html += `<div class="catrow">
      <div class="cathdr" onclick="toggleCat(this,${root.id})">
        <span class="catico">${root.icono}</span>
        <span class="catname">${root.nombre}</span>
        <span class="catcnt">${total}</span>
        ${arrow}
      </div>
      <div class="catkids" id="ck-${root.id}">`;

    if (subs.length) {
      subs.forEach(sub => {
        const ms = byCat[sub.id] || [];
        html += `<div>
          <div class="subcat-hdr" onclick="toggleSubcat(this,${sub.id})">
            <span style="font-size:13px">${sub.icono}</span>
            <span style="flex:1;font-weight:500">${sub.nombre}</span>
            <span class="catcnt">${ms.length}</span>
            ${arrow}
          </div>
          <div class="subcat-kids" id="sk-${sub.id}">
            ${ms.map(m=>`<div class="subcat-mod ${m.id===activeId?'active':''}" onclick="openModel(${m.id})">${m.nombre}</div>`).join('')}
          </div>
        </div>`;
      });
    } else {
      // Root has no subcats — show models directly
      const ms = byCat[root.id] || [];
      html += ms.map(m=>`<div class="catmod ${m.id===activeId?'active':''}" onclick="openModel(${m.id})">${m.nombre}</div>`).join('');
    }
    html += `</div></div>`;
  });

  // Models without category
  const nocat = byCat[0]||[];
  if (nocat.length) {
    html += `<div class="catrow">
      <div class="cathdr" onclick="toggleCat(this,0)">
        <span class="catico">📄</span><span class="catname">Sin categoría</span>
        <span class="catcnt">${nocat.length}</span>${arrow}
      </div>
      <div class="catkids" id="ck-0">${nocat.map(m=>`<div class="catmod ${m.id===activeId?'active':''}" onclick="openModel(${m.id})">${m.nombre}</div>`).join('')}</div>
    </div>`;
  }

  el.innerHTML = html || '<div class="empty" style="padding:24px 10px"><p>Sin modelos</p></div>';

  // Auto-expand active model's category and subcategory
  if (activeId) {
    const am = models.find(m=>m.id===activeId);
    if (am && am.categoria_id) {
      const sub = cats.find(c=>c.id===am.categoria_id);
      if (sub && sub.parent_id) {
        const ck = document.getElementById(`ck-${sub.parent_id}`);
        if (ck) ck.classList.add('open');
        const sk = document.getElementById(`sk-${sub.id}`);
        if (sk) sk.classList.add('open');
      } else {
        const ck = document.getElementById(`ck-${am.categoria_id}`);
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

// ─── OPEN MODEL ───────────────────────────────────────────────────────────────
async function openModel(id) {
  activeId = id; renderSidebar();
  const data = await api('GET', `/modelos/${id}`);
  if (!data) return;

  document.getElementById('e-empty').style.display = 'none';
  const ep = document.getElementById('e-panel'); ep.style.display = 'flex';
  document.getElementById('e-title').textContent = data.nombre;
  document.getElementById('e-meta').textContent =
    `${new Date(data.updated_at).toLocaleString('es-ES')} · ${data.updated_by_nombre||'—'}`;

  document.getElementById('e-name').value = data.nombre;
  document.getElementById('e-cat').value  = data.categoria_id || '';
  document.getElementById('e-status').value = data.estado;
  document.getElementById('e-tags').value = (data.etiquetas||[]).join(', ');
  document.getElementById('e-desc').value = data.descripcion || '';

  const body = document.getElementById('e-body');
  body.value = data.cuerpo || '';
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
  await loadModels(); await openModel(activeId);
}

async function newModel() {
  const res = await api('POST', '/modelos', {
    nombre:'Nuevo modelo', categoria_id:null, estado:'borrador',
    cuerpo:'# Título del acuerdo\n\nEscriba aquí el cuerpo del acuerdo usando Markdown.\n\nUse {{CAMPO}} para campos dinámicos.\n'
  });
  if (!res) return;
  await loadModels(); openModel(res.id);
}

async function deleteModel() {
  if (!activeId || !confirm('¿Eliminar este modelo? No se puede deshacer.')) return;
  await api('DELETE', `/modelos/${activeId}`);
  activeId = null;
  document.getElementById('e-empty').style.display = '';
  document.getElementById('e-panel').style.display = 'none';
  toast('Eliminado'); await loadModels();
}

// ─── EXPORT ───────────────────────────────────────────────────────────────────
async function exportOdt(plantillaId) {
  if (!activeId) return;
  document.getElementById('export-menu').classList.remove('open');
  const tplName = plantillaId ? (tpls.find(t=>t.id===plantillaId)?.nombre||'plantilla') : 'estilos por defecto';
  toast(`Generando .odt con ${tplName}…`, 4000);
  const url = `/api/modelos/${activeId}/export/odt${plantillaId ? `?plantilla_id=${plantillaId}` : ''}`;
  const res = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
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

// ─── MARKDOWN EDITOR ─────────────────────────────────────────────────────────
function updatePreview() {
  const md = document.getElementById('e-body').value;
  document.getElementById('e-preview').innerHTML = mdToHtmlPreview(md);
  detectFields();
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
  
  // Detectar cuando se acaban de escribir "}}"
  if (val.slice(pos-2, pos) === '}}') {
    const openPos = val.lastIndexOf('{{', pos-2);
    if (openPos !== -1) {
      const inner = val.slice(openPos+2, pos-2);
      if (inner.length > 0 && /^[A-Z0-9_\sa-z]+$/.test(inner)) {
        // Convertir a mayúsculas y reemplazar espacios por _
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
    case 'code':      replacement = `\n\`\`\`\n${sel || 'código aquí'}\n\`\`\`\n`; break;
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
      <span class="fchipname">${f}</span>
      <span class="fchiphint">insertar</span>
    </div>`).join('');
  renderMacroCode(matches);
}

function renderActivity(acts) {
  const el = document.getElementById('r-activity');
  if (!acts.length) { el.innerHTML='<span style="font-size:11px;color:var(--text3)">—</span>'; return; }
  el.innerHTML = acts.slice(0,8).map(a=>`
    <div class="aitem">
      <div class="adot"></div>
      <div>
        <div class="atext"><strong>${a.user_nombre}</strong> ${a.accion}</div>
        <div class="atime">${new Date(a.created_at).toLocaleString('es-ES',{day:'2-digit',month:'2-digit',hour:'2-digit',minute:'2-digit'})}</div>
      </div>
    </div>`).join('');
}

function renderTags(tags) {
  document.getElementById('r-tags').innerHTML = tags.length
    ? tags.map(t=>`<span class="tag">${t}</span>`).join('')
    : '<span style="font-size:11px;color:var(--text3)">Sin etiquetas</span>';
}

// ─── FIELD MODAL ─────────────────────────────────────────────────────────────
function openFieldModal() {
  saveSel();
  document.getElementById('mf-name').value = '';
  document.getElementById('mf-presets').innerHTML = PRESETS.map(p =>
    `<span class="ptag" onclick="document.getElementById('mf-name').value='${p}'">${p}</span>`
  ).join('');
  openModal('m-field');
}
function confirmField() {
  const v = document.getElementById('mf-name').value.trim().toUpperCase().replace(/\s+/g,'_');
  if (!v) return;
  closeModal('m-field'); insertFieldInEditor(v);
}
document.getElementById('mf-name').addEventListener('keydown', e => { if(e.key==='Enter') confirmField(); });

// ─── MACRO CODE ───────────────────────────────────────────────────────────────
function renderMacroCode(fields) {
  const subs = fields.length
    ? fields.map(f => {
        const varName = f.replace(/\{\{|\}\}/g,'').toLowerCase().replace(/_([a-z])/g,(m,c)=>c.toUpperCase());
        return `    ' ${f}\n    sField = "${f}"\n    sValue = "" ' <-- introduce el valor aquí\n    oSearch.SearchString = sField\n    oSearch.ReplaceString = sValue\n    oDoc.replaceAll(oSearch)`;
      }).join('\n\n')
    : '    \' Abre el documento exportado y ejecuta esta macro\n    \' Los campos detectados aparecerán aquí al guardar el modelo';

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

  MsgBox "Sustitución completada.", 64, "Acuerdos"
End Sub`;
}

function copyMacro() {
  navigator.clipboard.writeText(document.getElementById('macro-code').textContent)
    .then(() => toast('Macro copiada al portapapeles ✓'))
    .catch(() => toast('No se pudo copiar'));
}

// ─── CATEGORIES TAB ───────────────────────────────────────────────────────────
async function renderCatsTab() {
  await loadCats();
  const el = document.getElementById('catgrid');
  if (!cats.length) { el.innerHTML='<p style="color:var(--text3);font-size:13px">No hay categorías.</p>'; return; }

  const roots = cats.filter(c => !c.parent_id);
  const byParent = {};
  cats.filter(c => c.parent_id).forEach(c => {
    if (!byParent[c.parent_id]) byParent[c.parent_id] = [];
    byParent[c.parent_id].push(c);
  });

  let html = '';
  roots.forEach(root => {
    const folder = root.nombre.replace(/[<>:"/\|?*]/g,'').replace(/\s+/g,'_').trim();
    const subs = byParent[root.id] || [];
    html += `<div class="catcard" style="grid-column:1/-1;border-left:3px solid ${COLORS[root.color]||COLORS.blue}">
      <div class="catcard-top">
        <div class="catcard-ico">${root.icono}</div>
        <div style="flex:1">
          <div class="catcard-name">${root.nombre}</div>
          <div class="catcard-desc">${root.descripcion||'Sin descripción'}</div>
        </div>
        ${me.rol==='admin'?`
        <button class="btn btn-sm" onclick="openCatModal(${root.id})">✎</button>
        <button class="btn btn-sm btn-danger" onclick="deleteCat(${root.id})">✕</button>
        <button class="btn btn-sm btn-primary" onclick="openCatModal(null,${root.id})" title="Nueva subcategoría">+ Sub</button>`:''}
      </div>
      ${subs.length ? `<div style="display:flex;flex-wrap:wrap;gap:6px;padding-top:8px;border-top:0.5px solid var(--border)">
        ${subs.map(sub => {
          const sf = sub.nombre.replace(/[<>:"/\\|?*]/g,'').replace(/\s+/g,'_').trim();
          return `<div class="catcard" style="margin:0;flex:1;min-width:200px">
            <div class="catcard-top" style="margin-bottom:4px">
              <div class="catcard-ico" style="font-size:16px">${sub.icono}</div>
              <div>
                <div class="catcard-name" style="font-size:12px">${sub.nombre}</div>
              </div>
            </div>
            <div class="catcard-foot">
              <span style="color:${COLORS[sub.color]||COLORS.blue};font-weight:500">${sub.total_modelos} modelos</span>
              <span class="catcard-folder">📁 ${sf}/</span>
              ${me.rol==='admin'?`
              <button class="btn btn-sm" onclick="showCatFiles(${sub.id},'${sub.nombre.replace(/'/g,"\'")}')">📂</button>
              <button class="btn btn-sm" onclick="openCatModal(${sub.id})">✎</button>
              <button class="btn btn-sm btn-danger" onclick="deleteCat(${sub.id})">✕</button>`:''}
            </div>
          </div>`;
        }).join('')}
      </div>` : `<div style="font-size:11px;color:var(--text3);padding-top:6px">Sin subcategorías — <a href="#" onclick="openCatModal(null,${root.id});return false" style="color:var(--blue)">añadir</a></div>`}
    </div>`;
  });

  el.innerHTML = html || '<p style="color:var(--text3);font-size:13px">No hay categorías.</p>';
  if (me.rol==='admin') {
    const btn = document.querySelector('#catgrid').parentElement.previousElementSibling.querySelector('button');
    if (btn) btn.onclick = () => openCatModal();
  }
}

async function showCatFiles(id, nombre) {
  const files = await api('GET', `/categorias/${id}/archivos`) || [];
  document.getElementById('cat-files-title').textContent = `📁 ${nombre} — archivos exportados`;
  const el = document.getElementById('cat-files-list');
  el.innerHTML = files.length
    ? files.map(f=>`<div style="display:flex;align-items:center;gap:10px;padding:5px 0;border-bottom:0.5px solid var(--border)">
        <span style="font-family:monospace;font-size:12px;color:var(--text2);flex:1">${f.nombre}</span>
        <span style="font-size:11px;color:var(--text3)">${Math.round(f.tamaño/1024)} KB</span>
        <span style="font-size:11px;color:var(--text3)">${new Date(f.modificado).toLocaleDateString('es-ES')}</span>
      </div>`).join('')
    : '<p style="color:var(--text3);font-size:12px">Sin archivos exportados aún.</p>';
  document.getElementById('cat-files-card').style.display = '';
}

let catParentId = null;
function openCatModal(id, parentId) {
  catEditId = id || null; catColor = 'blue'; catParentId = parentId || null;
  document.getElementById('mcat-title').textContent = id ? 'Editar categoría' : (parentId ? 'Nueva subcategoría' : 'Nueva categoría raíz');
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
    document.getElementById('mc-icono').value = '📄';
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
    icono:document.getElementById('mc-icono').value||'📄',
    color:catColor, orden:parseInt(document.getElementById('mc-orden').value)||0, activa:1,
    parent_id
  };
  const res = catEditId ? await api('PUT',`/categorias/${catEditId}`,body) : await api('POST','/categorias',body);
  if (res?.error) { const e=document.getElementById('mc-err'); e.textContent=res.error; e.style.display='block'; return; }
  closeModal('m-cat'); toast(catEditId?'Categoría actualizada ✓':'Categoría creada ✓');
  await renderCatsTab(); await loadCats(); await loadModels();
}

async function deleteCat(id) {
  if (!confirm('¿Eliminar? Solo es posible si no tiene modelos asignados.')) return;
  const res = await api('DELETE', `/categorias/${id}`);
  if (res?.error) { alert(res.error); return; }
  toast('Eliminada'); await renderCatsTab(); await loadCats(); await loadModels();
}

// ─── TEMPLATES TAB ────────────────────────────────────────────────────────────
async function renderTplsTab() {
  await loadTpls();
  const el = document.getElementById('tpl-list');
  if (!tpls.length) {
    el.innerHTML = '<p style="font-size:13px;color:var(--text3)">No hay plantillas subidas. Sube tu primera plantilla .ott.</p>';
    return;
  }
  el.innerHTML = tpls.map(t => `
    <div class="tplcard">
      <div class="tplicon">📋</div>
      <div class="tplinfo">
        <div class="tplname">${t.nombre} ${t.es_defecto ? '<span class="b b-defecto">predeterminada</span>' : ''}</div>
        <div class="tpldesc">${t.descripcion||'Sin descripción'} · <span style="font-family:monospace;font-size:10px;color:var(--text3)">${t.filename}</span></div>
      </div>
      <div class="tplactions">
        ${!t.es_defecto ? `<button class="btn btn-sm btn-success" onclick="setDefaultTpl(${t.id})">Predeterminar</button>` : ''}
        <button class="btn btn-sm btn-danger" onclick="deleteTpl(${t.id})">✕</button>
      </div>
    </div>`).join('');
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
    document.getElementById('tpl-file-name').textContent = '📎 ' + tplFileSelected.name;
    document.getElementById('tpl-file-name').style.display = '';
    if (!document.getElementById('mt-nombre').value)
      document.getElementById('mt-nombre').value = tplFileSelected.name.replace(/\.(ott|odt)$/i,'');
  }
}

// Drag & drop on dropzone
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
  const res = await fetch(API+'/plantillas', {
    method:'POST', headers:{Authorization:`Bearer ${token}`}, body:fd
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
  if (!confirm('¿Eliminar esta plantilla?')) return;
  await api('DELETE', `/plantillas/${id}`);
  toast('Plantilla eliminada'); await renderTplsTab();
}

// ─── USERS TAB ────────────────────────────────────────────────────────────────
async function renderUsersTab() {
  const users = await api('GET', '/users') || [];
  document.getElementById('ulist').innerHTML = users.map(u => `
    <div class="urow">
      <div class="av" style="width:32px;height:32px;font-size:12px">${u.nombre.split(' ').map(w=>w[0]).join('').slice(0,2).toUpperCase()}</div>
      <div style="flex:1"><div class="uname">${u.nombre}</div><div class="uemail">${u.email}</div></div>
      <span class="b b-${u.rol}">${u.rol}</span>
      ${me.rol==='admin'?`<select style="font-size:12px;width:130px" onchange="changeRole(${u.id},this.value)">
        <option ${u.rol==='admin'?'selected':''} value="admin">admin</option>
        <option ${u.rol==='editor'?'selected':''} value="editor">editor</option>
        <option ${u.rol==='consultor'?'selected':''} value="consultor">consultor</option>
      </select>`:''}
    </div>`).join('');
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

// ─── STYLE EDITOR ─────────────────────────────────────────────────────────────
let selectedPlantillaId = null;
let availableStyles = [];

async function openStylesEditor(plantillaId) {
  if (!activeId) return;
  
  // Si no se pasa plantillaId, preguntar cuál plantilla usar (o usar la predeterminada)
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
    
    if (res?.error) {
      error.textContent = res.error;
      error.style.display = 'block';
      loading.style.display = 'none';
      return;
    }
    
    availableStyles = res.estilos || [];
    const currentConfig = res.config || {};
    
    // Crear grid de selects para h1-h6
    const grid = document.getElementById('styles-grid');
    let html = '';
    for (let i = 1; i <= 6; i++) {
      const currentStyle = currentConfig[i] || `Heading${i}`;
      const options = availableStyles.map(s => 
        `<option value="${s}" ${s === currentStyle ? 'selected' : ''}>${s}</option>`
      ).join('');
      
      html += `
        <div class="fg" style="margin:0">
          <label class="fl">Encabezado H${i}</label>
          <select id="ms-h${i}">
            <option value="">— Detectar automáticamente —</option>
            ${options}
          </select>
        </div>`;
    }
    grid.innerHTML = html;
    
    // Llenar select de cuerpo
    const bodyStyle = document.getElementById('ms-body-style');
    const currentBodyStyle = currentConfig.body_style || 'BodyText';
    bodyStyle.innerHTML = availableStyles.map(s =>
      `<option value="${s}" ${s === currentBodyStyle ? 'selected' : ''}>${s}</option>`
    ).join('');
    
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
  
  // Recopilar selecciones h1-h6
  for (let i = 1; i <= 6; i++) {
    const el = document.getElementById(`ms-h${i}`);
    if (el?.value) config[i] = el.value;
  }
  
  // Recopilar body style
  const bodyEl = document.getElementById('ms-body-style');
  if (bodyEl?.value) config['body_style'] = bodyEl.value;
  
  document.getElementById('btn-save-styles').disabled = true;
  
  const res = await api('POST', `/modelos/${activeId}/estilo-config`, { config });
  
  if (res?.error) {
    toast('Error al guardar: ' + res.error);
  } else {
    toast('Configuración de estilos guardada ✓');
    closeModal('m-styles');
  }
  
  document.getElementById('btn-save-styles').disabled = false;
}

// ─── TABS ─────────────────────────────────────────────────────────────────────
function switchTab(t) {
  const map = {editor:'tab-editor', cats:'tab-cats', tpls:'tab-tpls', users:'tab-users'};
  const btns = {editor:'tab-e-btn', cats:'tab-c-btn', tpls:'tab-t-btn', users:'tab-u-btn'};
  Object.entries(map).forEach(([k,id]) => document.getElementById(id).style.display = k===t ? 'flex' : 'none');
  Object.entries(btns).forEach(([k,id]) => { const el=document.getElementById(id); if(el) el.classList.toggle('active',k===t); });
  if (t==='cats')  renderCatsTab();
  if (t==='tpls')  renderTplsTab();
  if (t==='users') renderUsersTab();
}
function openDuplicateModal() {
  if (!activeId) return;
  const modelo = models.find(m => m.id === activeId);  // ← models no modelos
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

//___ pegar_____
// ─── PASTE FROM WORD ──────────────────────────────────────────────────────────
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

  // Eliminar párrafos vacíos y spans vacíos que Word genera
  doc.querySelectorAll('p, span, div').forEach(el => {
    if (!el.textContent.trim() && !el.querySelector('img,table,br')) {
      el.remove();
    }
  });

  // Eliminar estilos inline y clases de Word
  doc.querySelectorAll('[style],[class]').forEach(el => {
    el.removeAttribute('style');
    el.removeAttribute('class');
  });

  let md = _nodeToMd(doc.body).trim();

  // Limpiar saltos múltiples
  md = md.replace(/\n{3,}/g, '\n\n');

  // Limpiar espacios al inicio de línea (sangría de Word)
  md = md.replace(/^ +/gm, '');

  // Limpiar líneas que solo tienen espacios
  md = md.replace(/^\s+$/gm, '');

  return md;
}

function _nodeToMd(node) {
  if (node.nodeType === Node.TEXT_NODE) {
    return node.textContent;
  }
  if (node.nodeType !== Node.ELEMENT_NODE) return '';

  const tag = node.tagName.toLowerCase();
  const inner = () => Array.from(node.childNodes).map(_nodeToMd).join('');
  const block  = (prefix) => `\n\n${prefix}${inner()}\n\n`;

  switch (tag) {
    case 'h1': return `\n\n# ${inner().trim().replace(/\n+/g, ' ')}\n\n`;
    case 'h2': return `\n\n## ${inner().trim().replace(/\n+/g, ' ')}\n\n`;
    case 'h3': return `\n\n### ${inner().trim().replace(/\n+/g, ' ')}\n\n`;
    case 'h4': return `\n\n#### ${inner().trim().replace(/\n+/g, ' ')}\n\n`;
    case 'h5': return `\n\n##### ${inner().trim().replace(/\n+/g, ' ')}\n\n`;
    case 'h6': return `\n\n###### ${inner().trim().replace(/\n+/g, ' ')}\n\n`;
    case 'p': {
         const text = inner().trim().replace(/\n+/g, ' ');
         return text ? `\n\n${text}\n\n` : '';
    }
    case 'br': return ' ';
    case 'br': return '\n';
    case 'strong': case 'b': return `**${inner()}**`;
    case 'em': case 'i':     return `*${inner()}*`;
    case 'u':                return `<u>${inner()}</u>`;
    case 's': case 'strike': case 'del': return `~~${inner()}~~`;
    case 'code': return `\`${inner()}\``;
    case 'pre':  return `\n\n\`\`\`\n${node.textContent}\n\`\`\`\n\n`;
    case 'blockquote': return `\n\n> ${inner().trim().replace(/\n/g, '\n> ')}\n\n`;
    case 'hr': return '\n\n---\n\n';
    case 'a':  {
      const href = node.getAttribute('href') || '';
      const text = inner();
      return href && href !== text ? `[${text}](${href})` : text;
    }
    case 'ul': {
      return '\n\n' + Array.from(node.querySelectorAll(':scope > li'))
        .map(li => `- ${_liToMd(li)}`).join('\n') + '\n\n';
    }
    case 'ol': {
      return '\n\n' + Array.from(node.querySelectorAll(':scope > li'))
        .map((li, i) => `${i+1}. ${_liToMd(li)}`).join('\n') + '\n\n';
    }
    case 'table': return _tableToMd(node);
    case 'thead': case 'tbody': case 'tr':
    case 'div': case 'span': case 'section':
    case 'body': case 'html': case 'article':
      return inner();
    default: return inner();
  }
}

function _liToMd(li) {
  // Extraer texto del li ignorando listas anidadas
  let text = '';
  let nested = '';
  for (const child of li.childNodes) {
    if (child.nodeType === Node.ELEMENT_NODE &&
        (child.tagName === 'UL' || child.tagName === 'OL')) {
      nested += _nodeToMd(child).trim().split('\n')
        .map(l => '  ' + l).join('\n');
    } else {
      text += _nodeToMd(child);
    }
  }
  return text.trim() + (nested ? '\n' + nested : '');
}

function _tableToMd(table) {
  const rows = Array.from(table.querySelectorAll('tr'));
  if (!rows.length) return '';
  const toRow = (tr) => Array.from(tr.querySelectorAll('th,td'))
    .map(c => c.textContent.trim().replace(/\|/g, '\\|'));
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
  console.log('HTML del portapapeles:', html.slice(0,500));
  if (!html) return;
  e.preventDefault();
  const md = _htmlToMarkdown(html).replace(/\n{3,}/g, '\n\n');
  _insertMarkdown(md);
  toast('Texto convertido a Markdown ✓');
});

// ─── BOOT ─────────────────────────────────────────────────────────────────────
if (token) initApp();