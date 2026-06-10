const express = require('express');
const cors = require('cors');
const jwt = require('jsonwebtoken');
const bcrypt = require('bcryptjs');
const Database = require('better-sqlite3');
const os = require('os');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const { execFile } = require('child_process');
const multer = require('multer');
const AdmZip = require('adm-zip');
const archiver = require('archiver');

const app = express();
const PORT = process.env.PORT || 3001;
const JWT_SECRET = process.env.JWT_SECRET || crypto.randomBytes(32).toString('hex');
const DB_PATH = process.env.DB_PATH || path.join(__dirname, 'data', 'acuerdos.db');
const FILES_DIR = process.env.FILES_DIR || path.join(__dirname, 'data', 'carpetas');
const TEMPLATES_DIR = process.env.TEMPLATES_DIR || path.join(__dirname, 'data', 'plantillas');
const LOGIN_WINDOW_MS = 15 * 60 * 1000;
const LOGIN_MAX_ATTEMPTS = 5;
const LOGIN_LOCK_MS = 15 * 60 * 1000;
const FIELD_RE = /\{\{([A-Z][A-Z0-9_]*)\}\}/g;

if (!process.env.JWT_SECRET) {
  console.warn('[WARN] JWT_SECRET no definido. Se ha generado uno aleatorio para esta instancia; define JWT_SECRET en produccion.');
}

[path.dirname(DB_PATH), FILES_DIR, TEMPLATES_DIR].forEach(d => {
  if (!fs.existsSync(d)) fs.mkdirSync(d, { recursive: true });
});

// ??? DATABASE ?????????????????????????????????????????????????????????????????
const db = new Database(DB_PATH);
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

db.exec(`
  CREATE TABLE IF NOT EXISTS users (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    nombre TEXT NOT NULL,
    email TEXT UNIQUE NOT NULL,
    password_hash TEXT NOT NULL,
    rol TEXT NOT NULL DEFAULT 'editor' CHECK(rol IN ('admin','editor','consultor')),
    activo INTEGER NOT NULL DEFAULT 1,
    created_at TEXT DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS categorias (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    nombre TEXT UNIQUE NOT NULL,
    descripcion TEXT,
    icono TEXT DEFAULT '??',
    color TEXT DEFAULT 'blue',
    orden INTEGER DEFAULT 0,
    activa INTEGER NOT NULL DEFAULT 1,
    parent_id INTEGER REFERENCES categorias(id) ON DELETE CASCADE,
    total_modelos INTEGER DEFAULT 0,
    created_by INTEGER REFERENCES users(id),
    created_at TEXT DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS modelos (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    nombre TEXT NOT NULL,
    categoria_id INTEGER REFERENCES categorias(id) ON DELETE SET NULL,
    estado TEXT NOT NULL DEFAULT 'borrador' CHECK(estado IN ('activo','borrador','archivado')),
    descripcion TEXT,
    cuerpo TEXT NOT NULL DEFAULT '',
    etiquetas TEXT DEFAULT '[]',
    estilo_config TEXT DEFAULT '{}',
    owner_id INTEGER REFERENCES users(id),
    created_by INTEGER REFERENCES users(id),
    updated_by INTEGER REFERENCES users(id),
    created_at TEXT DEFAULT (datetime('now')),
    updated_at TEXT DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS plantillas (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    nombre TEXT NOT NULL,
    descripcion TEXT,
    filename TEXT NOT NULL,
    es_defecto INTEGER DEFAULT 0,
    created_by INTEGER REFERENCES users(id),
    created_at TEXT DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS actividad (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    modelo_id INTEGER REFERENCES modelos(id) ON DELETE CASCADE,
    user_id INTEGER REFERENCES users(id),
    accion TEXT NOT NULL,
    detalle TEXT,
    created_at TEXT DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS modelo_versiones (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    modelo_id INTEGER REFERENCES modelos(id) ON DELETE CASCADE,
    user_id INTEGER REFERENCES users(id),
    cuerpo TEXT NOT NULL,
    nombre TEXT,
    descripcion TEXT,
    etiquetas TEXT,
    created_at TEXT DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS expedientes (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER REFERENCES users(id),
    clave TEXT NOT NULL,
    campos TEXT NOT NULL DEFAULT '{}',
    updated_at TEXT DEFAULT (datetime('now'))
  );
  CREATE UNIQUE INDEX IF NOT EXISTS idx_exp_user_clave ON expedientes(user_id, clave);

  CREATE TABLE IF NOT EXISTS campo_tipos (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    modelo_id INTEGER REFERENCES modelos(id) ON DELETE CASCADE,
    campo TEXT NOT NULL,
    tipo TEXT NOT NULL DEFAULT 'texto' CHECK(tipo IN ('texto','fecha','importe','lista','numero','booleano')),
    config TEXT DEFAULT '{}',
    UNIQUE(modelo_id, campo)
  );

  CREATE TABLE IF NOT EXISTS campo_catalogo (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    clave TEXT UNIQUE NOT NULL,
    nombre TEXT NOT NULL DEFAULT '',
    tipo TEXT NOT NULL DEFAULT 'texto' CHECK(tipo IN ('texto','fecha','importe','lista','numero','booleano')),
    descripcion TEXT DEFAULT '',
    valor_defecto TEXT DEFAULT '',
    created_at TEXT DEFAULT (datetime('now')),
    updated_at TEXT DEFAULT (datetime('now'))
  );
  
`);

// Agregar columna si no existe (para bases de datos existentes)
try {
  db.prepare(`ALTER TABLE modelos ADD COLUMN estilo_config TEXT DEFAULT '{}'`).run();
} catch (e) {
  // Columna ya existe, ignorar
}

function extractFieldNames(text) {
  return [...new Set((String(text || '').match(FIELD_RE) || []).map(f => f.slice(2, -2)))];
}

function humanizeFieldName(clave) {
  return String(clave || '')
    .replace(/_/g, ' ')
    .toLowerCase()
    .replace(/^\w/, c => c.toUpperCase());
}

function syncGlobalField(clave, data = {}) {
  const key = String(clave || '').trim().toUpperCase();
  if (!key) return;
  const tipo = ['texto', 'fecha', 'importe', 'lista', 'numero', 'booleano'].includes(data.tipo) ? data.tipo : 'texto';
  const nombre = String(data.nombre || '').trim() || humanizeFieldName(key);
  const descripcion = String(data.descripcion || '').trim();
  const valorDefecto = String(data.valor_defecto || '').trim();
  const existing = db.prepare('SELECT id, nombre, tipo, descripcion, valor_defecto FROM campo_catalogo WHERE clave=?').get(key);
  if (existing) {
    db.prepare(`UPDATE campo_catalogo
      SET nombre=?, tipo=?, descripcion=?, valor_defecto=?, updated_at=datetime('now')
      WHERE clave=?`).run(
        data.nombre ? nombre : existing.nombre || nombre,
        data.tipo ? tipo : existing.tipo || tipo,
        data.descripcion !== undefined ? descripcion : existing.descripcion || '',
        data.valor_defecto !== undefined ? valorDefecto : existing.valor_defecto || '',
        key
      );
  } else {
    db.prepare(`INSERT INTO campo_catalogo (clave,nombre,tipo,descripcion,valor_defecto)
      VALUES (?,?,?,?,?)`).run(key, nombre, tipo, descripcion, valorDefecto);
  }
}

function syncGlobalFieldsFromText(text, tipoByField = {}) {
  const fields = extractFieldNames(text);
  fields.forEach(clave => syncGlobalField(clave, { tipo: tipoByField[clave] }));
}

function syncGlobalFieldsFromModel(modeloId, cuerpo) {
  const tipos = Object.fromEntries(
    db.prepare('SELECT campo,tipo FROM campo_tipos WHERE modelo_id=?').all(modeloId).map(r => [r.campo, r.tipo])
  );
  syncGlobalFieldsFromText(cuerpo, tipos);
  Object.entries(tipos).forEach(([campo, tipo]) => syncGlobalField(campo, { tipo }));
}

function seedGlobalFieldCatalog() {
  const modelos = db.prepare('SELECT id, cuerpo FROM modelos').all();
  modelos.forEach(m => syncGlobalFieldsFromModel(m.id, m.cuerpo || ''));
}

function seedContractFieldCatalog() {
  const fields = [
    { clave: 'EXPEDIENTE',          nombre: 'Número / referencia del expediente', tipo: 'texto'   },
    { clave: 'OBJETO',              nombre: 'Objeto del contrato',                 tipo: 'texto'   },
    { clave: 'DESCRIPCION',         nombre: 'Descripción del proyecto',            tipo: 'texto'   },
    { clave: 'ORGANISMO',           nombre: 'Organismo contratante',               tipo: 'texto'   },
    { clave: 'NIF',                 nombre: 'NIF del organismo',                   tipo: 'texto'   },
    { clave: 'EMAIL',               nombre: 'Email de contacto',                   tipo: 'texto'   },
    { clave: 'TELEFONO',            nombre: 'Teléfono de contacto',                tipo: 'texto'   },
    { clave: 'DIRECCION',           nombre: 'Dirección postal',                    tipo: 'texto'   },
    { clave: 'TIPO_CONTRATO',       nombre: 'Tipo de contrato',                    tipo: 'lista'   },
    { clave: 'PROCEDIMIENTO',       nombre: 'Procedimiento de licitación',         tipo: 'lista'   },
    { clave: 'TRAMITACION',         nombre: 'Tramitación',                         tipo: 'lista'   },
    { clave: 'CPV',                 nombre: 'Código CPV',                          tipo: 'texto'   },
    { clave: 'PRESUPUESTO_BASE',    nombre: 'Presupuesto base sin IVA',            tipo: 'importe' },
    { clave: 'PRESUPUESTO_IVA',     nombre: 'Presupuesto total con IVA',           tipo: 'importe' },
    { clave: 'VALOR_ESTIMADO',      nombre: 'Valor estimado del contrato',         tipo: 'importe' },
    { clave: 'PLAZO',               nombre: 'Plazo de ejecución',                  tipo: 'texto'   },
    { clave: 'FECHA_PUBLICACION',   nombre: 'Fecha de publicación',                tipo: 'fecha'   },
    { clave: 'FECHA_LIMITE',        nombre: 'Fecha límite de presentación',        tipo: 'fecha'   },
    { clave: 'GARANTIA',            nombre: 'Garantía definitiva (%)',             tipo: 'numero'  },
    { clave: 'ADJUDICATARIO',       nombre: 'Nombre del adjudicatario',            tipo: 'texto'   },
    { clave: 'NIF_ADJUDICATARIO',   nombre: 'NIF del adjudicatario',               tipo: 'texto'   },
    { clave: 'IMPORTE_ADJUDICACION',nombre: 'Importe de adjudicación',             tipo: 'importe' },
    { clave: 'FECHA_ADJUDICACION',  nombre: 'Fecha de adjudicación',               tipo: 'fecha'   },
    { clave: 'FINANCIACION_UE',     nombre: 'Programa de financiación UE',         tipo: 'texto'   },
    { clave: 'SERIE_DOCUMENTAL',    nombre: 'Serie documental',                    tipo: 'texto'   },
    { clave: 'FECHA',               nombre: 'Fecha del documento',                 tipo: 'fecha'   },
  ];
  fields.forEach(f => syncGlobalField(f.clave, { nombre: f.nombre, tipo: f.tipo }));
}

seedGlobalFieldCatalog();
seedContractFieldCatalog();

// ??? SEED ?????????????????????????????????????????????????????????????????????
const userCount = db.prepare('SELECT COUNT(*) as n FROM users').get();
if (userCount.n === 0) {
  const h = (p) => bcrypt.hashSync(p, 10);
  db.prepare(`INSERT INTO users (nombre,email,password_hash,rol) VALUES (?,?,?,?)`).run('Ana Lopez','admin@ayuntamiento.es',h('admin123'),'admin');
  db.prepare(`INSERT INTO users (nombre,email,password_hash,rol) VALUES (?,?,?,?)`).run('Carlos Martin','carlos@ayuntamiento.es',h('editor123'),'editor');
  db.prepare(`INSERT INTO users (nombre,email,password_hash,rol) VALUES (?,?,?,?)`).run('Maria Gomez','maria@ayuntamiento.es',h('editor123'),'editor');
  db.prepare(`INSERT INTO users (nombre,email,password_hash,rol) VALUES (?,?,?,?)`).run('Pedro Ruiz','pedro@ayuntamiento.es',h('consultor123'),'consultor');
}

const catCount = db.prepare('SELECT COUNT(*) as n FROM categorias').get();
if (catCount.n === 0) {
  const cats = [
    ['Pleno','Acuerdos adoptados en sesion plenaria','???','blue',1],
    ['Junta de Gobierno','Acuerdos de la Junta de Gobierno Local','??','teal',2],
    ['Decreto de Alcaldia','Decretos y resoluciones de Alcaldia','??','amber',3],
    ['Resolucion','Resoluciones administrativas','?','green',4],
    ['Convenio','Convenios y acuerdos de colaboracion','??','purple',5],
  ];
  const insC = db.prepare(`INSERT INTO categorias (nombre,descripcion,icono,color,orden,created_by) VALUES (?,?,?,?,?,1)`);
  cats.forEach(c => insC.run(...c));

  const modelos = [
    [1, 'Acuerdo de Pleno - Aprobacin de Presupuesto', 'activo',
     'Modelo para aprobacin de presupuesto municipal en sesion plenaria ordinaria.',
     '["presupuesto","pleno","hacienda"]',
     `# ACUERDO DE PLENO - {{ORGANISMO}}

## Sesin N. {{NUMERO_SESION}}

En **{{ORGANISMO}}**, siendo las doce horas del da {{FECHA_SESION}}, bajo la presidencia del Alcalde **{{ALCALDE_NOMBRE}}**, y con asistencia del Secretario **{{SECRETARIO_NOMBRE}}**, se rene en sesion ordinaria el Pleno del Ayuntamiento.

**EXPEDIENTE NM. {{EXPEDIENTE}}**

Visto el informe del departamento de {{DEPARTAMENTO}} relativo al ejercicio {{EJERCICIO_PRESUPUESTARIO}}, y habiendo sido sometido a votacin con resultado {{VOTACION_RESULTADO}}, el Pleno Municipal acuerda:

**PRIMERO.** Aprobar el presupuesto municipal por importe de {{PRESUPUESTO_BASE}} euros para {{OBJETO}}.

**SEGUNDO.** Proceder a su publicacin en el BOP el {{FECHA_PUBLICACION}}.

---

Lo que se hace constar para los oportunos efectos.

- El Alcalde: {{ALCALDE_NOMBRE}}
- El Secretario: {{SECRETARIO_NOMBRE}}`],
    [3, 'Decreto de Alcaldia - Contratacin', 'activo',
     'Modelo de decreto para procesos de contratacion.',
     '["contratacion","decreto"]',
     `# DECRETO DE ALCALDA N. {{NUMERO_DECRETO}}

En **{{ORGANISMO}}**, a {{FECHA}}.

El Alcalde-Presidente, **{{ALCALDE_NOMBRE}}**, en uso de las atribuciones que le confiere la legislacin vigente,

## RESUELVE

**PRIMERO.** Aprobar el inicio del expediente de contratacion **{{EXPEDIENTE}}** para **{{OBJETO}}** con presupuesto base de licitacion de {{PRESUPUESTO_BASE}} euros (IVA no incluido), siendo el presupuesto total con IVA de {{PRESUPUESTO_IVA}} euros.

**SEGUNDO.** El tipo de contrato es {{TIPO_CONTRATO}}, tramitado por procedimiento {{PROCEDIMIENTO}} con tramitacin {{TRAMITACION}}.

**TERCERO.** Autorizar el gasto con cargo a la partida presupuestaria {{PARTIDA_PRESUPUESTARIA}}.

**CUARTO.** Contra la presente resolucin podr interponerse recurso de reposicin en el plazo de un mes.

---

El Alcalde - {{ALCALDE_NOMBRE}}`],
    [5, 'Convenio de Colaboracin Interadministrativa', 'borrador',
     'Plantilla base para convenios con otras administraciones.',
     '["convenio","colaboracion"]',
     `# CONVENIO DE COLABORACIN

Entre el **{{ORGANISMO}}**, representado por {{ALCALDE_NOMBRE}}, y **{{ENTIDAD_COLABORADORA}}**, representada por {{REPRESENTANTE_ENTIDAD}}.

**Expediente:** {{EXPEDIENTE}}

## CLUSULAS

**PRIMERA.** El objeto del presente convenio es {{OBJETO}}.

**SEGUNDA.** La vigencia ser desde {{FECHA_INICIO}} hasta {{FECHA_FIN}}.

**TERCERA.** La aportacin del {{ORGANISMO}} ser de {{PRESUPUESTO_BASE}} euros.

---

En {{ORGANISMO}}, a {{FECHA}}.

- El Alcalde: {{ALCALDE_NOMBRE}}
- El Representante: {{REPRESENTANTE_ENTIDAD}}`],
  ];
  const insM = db.prepare(`INSERT INTO modelos (categoria_id,nombre,estado,descripcion,etiquetas,cuerpo,owner_id,created_by,updated_by) VALUES (?,?,?,?,?,?,1,1,1)`);
  modelos.forEach(m => insM.run(...m));
  syncFolders();
}

// ??? HELPERS ??????????????????????????????????????????????????????????????????
function sanitizeName(name) {
  // Remove invalid filesystem characters
  return name.replace(/[<>:"/\\|?*\x00-\x1f]/g, '').replace(/\s+/g, '_').trim();
}

function sanitizeForHeader(name) {
  // Convert to ASCII-only for HTTP headers (removes accents, special chars)
  let normalized = name.normalize('NFD').replace(/[\u0300-\u036f]/g, '');
  // Keep only alphanumeric, dash, underscore, dot
  return normalized.replace(/[^\w\-\.]/g, '_').replace(/\s+/g, '_').trim() || 'archivo';
}

function syncFolders() {
  db.prepare('SELECT nombre FROM categorias WHERE activa=1').all().forEach(c => {
    const d = path.join(FILES_DIR, sanitizeName(c.nombre));
    if (!fs.existsSync(d)) fs.mkdirSync(d, { recursive: true });
  });
}

// ??? MIDDLEWARE ???????????????????????????????????????????????????????????????
app.use(cors({ origin: true, credentials: true }));
app.use(express.json({ limit: '5mb' }));
app.set('trust proxy', 1);

function parseCookies(header) {
  return (header || '').split(';').reduce((acc, part) => {
    const idx = part.indexOf('=');
    if (idx === -1) return acc;
    const key = part.slice(0, idx).trim();
    const value = part.slice(idx + 1).trim();
    if (key) acc[key] = decodeURIComponent(value);
    return acc;
  }, {});
}

function setAuthCookie(res, token) {
  const secure = process.env.NODE_ENV === 'production';
  const parts = [
    `auth_token=${encodeURIComponent(token)}`,
    'Path=/',
    'HttpOnly',
    'SameSite=Lax',
    `Max-Age=${8 * 60 * 60}`,
  ];
  if (secure) parts.push('Secure');
  res.setHeader('Set-Cookie', parts.join('; '));
}

function clearAuthCookie(res) {
  const secure = process.env.NODE_ENV === 'production';
  const parts = [
    'auth_token=',
    'Path=/',
    'HttpOnly',
    'SameSite=Lax',
    'Max-Age=0',
  ];
  if (secure) parts.push('Secure');
  res.setHeader('Set-Cookie', parts.join('; '));
}

const loginAttempts = new Map();

function loginKeys(req, email) {
  const ip = req.ip || 'unknown';
  const identity = String(email || '').toLowerCase().trim();
  return identity ? [ip, `${ip}::${identity}`] : [ip];
}

function cleanupLoginAttempts() {
  const now = Date.now();
  for (const [key, data] of loginAttempts.entries()) {
    if ((data.blockedUntil || 0) <= now && (data.lastAttempt || 0) + LOGIN_WINDOW_MS < now) {
      loginAttempts.delete(key);
    }
  }
}

function getBlockedLoginState(keys) {
  const now = Date.now();
  for (const key of keys) {
    const data = loginAttempts.get(key);
    if (data && data.blockedUntil && data.blockedUntil > now) return data;
  }
  return null;
}

function recordLoginFailure(keys) {
  const now = Date.now();
  for (const key of keys) {
    const data = loginAttempts.get(key) || { attempts: 0, firstAttempt: now, lastAttempt: now, blockedUntil: 0 };
    if ((data.firstAttempt || 0) + LOGIN_WINDOW_MS < now) {
      data.attempts = 0;
      data.firstAttempt = now;
    }
    data.attempts += 1;
    data.lastAttempt = now;
    if (data.attempts >= LOGIN_MAX_ATTEMPTS) {
      data.blockedUntil = now + LOGIN_LOCK_MS;
    }
    loginAttempts.set(key, data);
  }
}

function clearLoginAttempts(keys) {
  keys.forEach(key => loginAttempts.delete(key));
}

setInterval(cleanupLoginAttempts, LOGIN_WINDOW_MS).unref?.();

function auth(req, res, next) {
  const bearer = req.headers.authorization?.split(' ')[1];
  const token = bearer || parseCookies(req.headers.cookie).auth_token;
  if (!token) return res.status(401).json({ error: 'No autenticado' });
  try { req.user = jwt.verify(token, JWT_SECRET); next(); }
  catch { res.status(401).json({ error: 'Token invlido' }); }
}

function role(...roles) {
  return (req, res, next) => {
    if (!roles.includes(req.user.rol)) return res.status(403).json({ error: 'Sin permisos' });
    next();
  };
}

// ??? AUTH ?????????????????????????????????????????????????????????????????????
app.post('/api/auth/login', (req, res) => {
  const { email, password } = req.body;
  const keys = loginKeys(req, email);
  const blocked = getBlockedLoginState(keys);
  if (blocked && blocked.blockedUntil && blocked.blockedUntil > Date.now()) {
    const remaining = Math.ceil((blocked.blockedUntil - Date.now()) / 1000);
    return res.status(429).json({ error: `Demasiados intentos. Prueba de nuevo en ${remaining}s.` });
  }
  const user = db.prepare('SELECT * FROM users WHERE email=? AND activo=1').get(email);
  if (!user || !bcrypt.compareSync(password, user.password_hash)) {
    recordLoginFailure(keys);
    return res.status(401).json({ error: 'Credenciales incorrectas' });
  }
  clearLoginAttempts(keys);
  const token = jwt.sign({ id:user.id, nombre:user.nombre, email:user.email, rol:user.rol }, JWT_SECRET, { expiresIn:'8h' });
  setAuthCookie(res, token);
  res.json({ token, user: { id:user.id, nombre:user.nombre, email:user.email, rol:user.rol } });
});

app.post('/api/auth/logout', (req, res) => {
  clearAuthCookie(res);
  res.json({ ok: true });
});

app.get('/api/auth/me', auth, (req, res) => {
  res.json(db.prepare('SELECT id,nombre,email,rol FROM users WHERE id=?').get(req.user.id));
});

// ??? USERS ????????????????????????????????????????????????????????????????????
app.get('/api/users', auth, (req, res) => {
  res.json(db.prepare('SELECT id,nombre,email,rol,activo,created_at FROM users ORDER BY nombre').all());
});

app.post('/api/users', auth, role('admin'), (req, res) => {
  const { nombre, email, password, rol } = req.body;
  if (!nombre || !email || !password) return res.status(400).json({ error: 'Faltan campos' });
  try {
    const r = db.prepare('INSERT INTO users (nombre,email,password_hash,rol) VALUES (?,?,?,?)')
      .run(nombre, email, bcrypt.hashSync(password, 10), rol || 'editor');
    res.json({ id: r.lastInsertRowid, nombre, email, rol: rol || 'editor' });
  } catch { res.status(400).json({ error: 'El email ya existe' }); }
});

app.put('/api/users/:id', auth, role('admin'), (req, res) => {
  const { nombre, rol, activo } = req.body;
  db.prepare('UPDATE users SET nombre=?,rol=?,activo=? WHERE id=?').run(nombre, rol, activo ? 1 : 0, req.params.id);
  res.json({ ok: true });
});

// ??? CATEGORAS ???????????????????????????????????????????????????????????????
// Devuelve los ids de una categoria y todos sus descendientes (a cualquier profundidad)
function getCategorySubtreeIds(rootId) {
  const all = db.prepare('SELECT id, parent_id FROM categorias').all();
  const byParent = {};
  all.forEach(c => { (byParent[c.parent_id] = byParent[c.parent_id] || []).push(c.id); });
  const ids = [];
  const stack = [rootId];
  while (stack.length) {
    const id = stack.pop();
    ids.push(id);
    (byParent[id] || []).forEach(childId => stack.push(childId));
  }
  return ids;
}

app.get('/api/categorias', auth, (req, res) => {
  res.json(db.prepare(`SELECT c.*, COUNT(m.id) as total_modelos FROM categorias c LEFT JOIN modelos m ON m.categoria_id=c.id GROUP BY c.id ORDER BY c.orden, c.nombre`).all());
});

app.post('/api/categorias', auth, role('admin'), (req, res) => {
  const { nombre, descripcion, icono, color, orden, parent_id } = req.body;
  if (!nombre) return res.status(400).json({ error: 'Nombre requerido' });
  if (parent_id) {
    const parent = db.prepare('SELECT id FROM categorias WHERE id=?').get(parent_id);
    if (!parent) return res.status(400).json({ error: 'Categoria padre no encontrada' });
  }
  const r = db.prepare(`INSERT INTO categorias (nombre,descripcion,icono,color,orden,parent_id,created_by)
    VALUES (?,?,?,?,?,?,?)`)
    .run(nombre, descripcion||'', icono||'*', color||'blue', orden||0, parent_id||null, req.user.id);
  res.json({ id: r.lastInsertRowid });
});

app.put('/api/categorias/:id', auth, role('admin'), (req, res) => {
  const { nombre, descripcion, icono, color, orden, activa, parent_id } = req.body;
  const id = Number(req.params.id);
  if (parent_id) {
    if (Number(parent_id) === id) return res.status(400).json({ error: 'Una categoria no puede ser su propio padre' });
    if (getCategorySubtreeIds(id).includes(Number(parent_id))) {
      return res.status(400).json({ error: 'No se puede mover una categoria dentro de si misma o de sus subcategorias' });
    }
  }
  db.prepare(`UPDATE categorias SET nombre=?,descripcion=?,icono=?,color=?,orden=?,activa=?,parent_id=? WHERE id=?`)
    .run(nombre, descripcion||'', icono||'*', color||'blue', orden||0, activa ?? 1, parent_id||null, id);
  res.json({ ok: true });
});

app.delete('/api/categorias/:id', auth, role('admin'), (req, res) => {
  const cat = db.prepare('SELECT * FROM categorias WHERE id=?').get(req.params.id);
  if (!cat) return res.status(404).json({ error: 'No encontrada' });
  const subtreeIds = getCategorySubtreeIds(cat.id);
  const placeholders = subtreeIds.map(() => '?').join(',');
  const n = db.prepare(`SELECT COUNT(*) as n FROM modelos WHERE categoria_id IN (${placeholders})`).get(...subtreeIds).n;
  if (n > 0) return res.status(400).json({ error: `Tiene ${n} modelo(s) en esta categoria o sus subcategorias. Reasignalos primero.` });
  const cats = db.prepare(`SELECT id, nombre FROM categorias WHERE id IN (${placeholders})`).all(...subtreeIds);
  db.prepare('DELETE FROM categorias WHERE id=?').run(req.params.id);
  cats.forEach(c => {
    try { const d = path.join(FILES_DIR, sanitizeName(c.nombre)); if (fs.existsSync(d)) fs.rmdirSync(d); } catch {}
  });
  res.json({ ok: true });
});

app.get('/api/categorias/:id/archivos', auth, (req, res) => {
  const cat = db.prepare('SELECT nombre FROM categorias WHERE id=?').get(req.params.id);
  if (!cat) return res.status(404).json({ error: 'No encontrada' });
  const dir = path.join(FILES_DIR, sanitizeName(cat.nombre));
  if (!fs.existsSync(dir)) return res.json([]);
  res.json(fs.readdirSync(dir).map(f => {
    const s = fs.statSync(path.join(dir, f));
    return { nombre: f, tamao: s.size, modificado: s.mtime };
  }));
});

// ??? PLANTILLAS ODT ???????????????????????????????????????????????????????????
const templateUpload = multer({
  storage: multer.diskStorage({
    destination: TEMPLATES_DIR,
    filename: (req, file, cb) => cb(null, `${Date.now()}_${sanitizeName(file.originalname)}`)
  }),
  fileFilter: (req, file, cb) => {
    const ok = /\.(ott|odt)$/i.test(file.originalname);
    cb(ok ? null : new Error('Solo se permiten archivos .ott o .odt'), ok);
  },
  limits: { fileSize: 10 * 1024 * 1024 }
});

app.get('/api/plantillas', auth, (req, res) => {
  res.json(db.prepare('SELECT id,nombre,descripcion,filename,es_defecto,created_at FROM plantillas ORDER BY es_defecto DESC, nombre').all());
});

app.post('/api/plantillas', auth, role('admin'), templateUpload.single('file'), (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'Archivo requerido' });
  const { nombre, descripcion } = req.body;
  const r = db.prepare('INSERT INTO plantillas (nombre,descripcion,filename,created_by) VALUES (?,?,?,?)')
    .run(nombre || req.file.originalname, descripcion || '', req.file.filename, req.user.id);
  res.json({ id: r.lastInsertRowid, nombre, filename: req.file.filename });
});

app.put('/api/plantillas/:id/defecto', auth, role('admin'), (req, res) => {
  db.prepare('UPDATE plantillas SET es_defecto=0').run();
  db.prepare('UPDATE plantillas SET es_defecto=1 WHERE id=?').run(req.params.id);
  res.json({ ok: true });
});

app.delete('/api/plantillas/:id', auth, role('admin'), (req, res) => {
  const p = db.prepare('SELECT * FROM plantillas WHERE id=?').get(req.params.id);
  if (!p) return res.status(404).json({ error: 'No encontrada' });
  try { fs.unlinkSync(path.join(TEMPLATES_DIR, p.filename)); } catch {}
  db.prepare('DELETE FROM plantillas WHERE id=?').run(req.params.id);
  res.json({ ok: true });
});

// ??? MODELOS ??????????????????????????????????????????????????????????????????
app.get('/api/modelos', auth, (req, res) => {
  const { estado, categoria_id, q } = req.query;
  let sql = `SELECT m.*, c.nombre as categoria_nombre, c.icono as categoria_icono, c.color as categoria_color,
    u.nombre as owner_nombre, u2.nombre as updated_by_nombre
    FROM modelos m LEFT JOIN categorias c ON m.categoria_id=c.id
    LEFT JOIN users u ON m.owner_id=u.id LEFT JOIN users u2 ON m.updated_by=u2.id WHERE 1=1`;
  const p = [];
  if (estado)       { sql += ' AND m.estado=?';               p.push(estado); }
  if (categoria_id) { sql += ' AND m.categoria_id=?';         p.push(categoria_id); }
  if (q)            { sql += ' AND (m.nombre LIKE ? OR m.descripcion LIKE ? OR m.cuerpo LIKE ?)'; p.push(`%${q}%`, `%${q}%`, `%${q}%`); }
  sql += ' ORDER BY m.updated_at DESC';
  res.json(db.prepare(sql).all(...p));
});

app.get('/api/modelos/:id', auth, (req, res) => {
  const m = db.prepare(`SELECT m.*, c.nombre as categoria_nombre, c.icono as categoria_icono,
    u.nombre as owner_nombre, u2.nombre as updated_by_nombre
    FROM modelos m LEFT JOIN categorias c ON m.categoria_id=c.id
    LEFT JOIN users u ON m.owner_id=u.id LEFT JOIN users u2 ON m.updated_by=u2.id WHERE m.id=?`).get(req.params.id);
  if (!m) return res.status(404).json({ error: 'No encontrado' });
  m.etiquetas = JSON.parse(m.etiquetas || '[]');
  const actividad = db.prepare(`SELECT a.*,u.nombre as user_nombre FROM actividad a
    LEFT JOIN users u ON a.user_id=u.id WHERE a.modelo_id=? ORDER BY a.created_at DESC LIMIT 20`).all(req.params.id);
  res.json({ ...m, actividad });
});

app.post('/api/modelos', auth, role('admin','editor'), (req, res) => {
  const { nombre, categoria_id, estado, descripcion, cuerpo, etiquetas } = req.body;
  if (!nombre) return res.status(400).json({ error: 'Nombre requerido' });
  const r = db.prepare(`INSERT INTO modelos (nombre,categoria_id,estado,descripcion,cuerpo,etiquetas,owner_id,created_by,updated_by) VALUES (?,?,?,?,?,?,?,?,?)`)
    .run(nombre, categoria_id||null, estado||'borrador', descripcion||'', cuerpo||'', JSON.stringify(etiquetas||[]), req.user.id, req.user.id, req.user.id);
  syncGlobalFieldsFromModel(r.lastInsertRowid, cuerpo || '');
  db.prepare('INSERT INTO actividad (modelo_id,user_id,accion) VALUES (?,?,?)').run(r.lastInsertRowid, req.user.id, 'cre el modelo');
  res.json({ id: r.lastInsertRowid });
});

app.put('/api/modelos/:id', auth, role('admin','editor'), (req, res) => {
  const { nombre, categoria_id, estado, descripcion, cuerpo, etiquetas } = req.body;
  const prev = db.prepare('SELECT cuerpo,nombre,descripcion,etiquetas FROM modelos WHERE id=?').get(req.params.id);
  if (prev) {
    db.prepare(`INSERT INTO modelo_versiones (modelo_id,user_id,cuerpo,nombre,descripcion,etiquetas) VALUES (?,?,?,?,?,?)`)
      .run(req.params.id, req.user.id, prev.cuerpo, prev.nombre, prev.descripcion, prev.etiquetas);
    db.prepare(`DELETE FROM modelo_versiones WHERE modelo_id=? AND id NOT IN (SELECT id FROM modelo_versiones WHERE modelo_id=? ORDER BY id DESC LIMIT 20)`).run(req.params.id, req.params.id);
  }
  db.prepare(`UPDATE modelos SET nombre=?,categoria_id=?,estado=?,descripcion=?,cuerpo=?,etiquetas=?,updated_by=?,updated_at=datetime('now') WHERE id=?`)
    .run(nombre, categoria_id||null, estado, descripcion, cuerpo, JSON.stringify(etiquetas||[]), req.user.id, req.params.id);
  syncGlobalFieldsFromModel(req.params.id, cuerpo || '');
  db.prepare('INSERT INTO actividad (modelo_id,user_id,accion) VALUES (?,?,?)').run(req.params.id, req.user.id, 'guard cambios');
  res.json({ ok: true });
});

app.delete('/api/modelos/:id', auth, role('admin'), (req, res) => {
  db.prepare('DELETE FROM modelos WHERE id=?').run(req.params.id);
  res.json({ ok: true });
});

// ??? EXPORT ODT (via Python) ??????????????????????????????????????????????????
// Get available styles from template
app.get('/api/modelos/:id/plantilla-estilos', auth, (req, res) => {
  const plantillaId = req.query.plantilla_id;
  if (!plantillaId) {
    return res.json({ estilos: [], config: {} });
  }

  try {
    const p = db.prepare('SELECT filename FROM plantillas WHERE id=?').get(plantillaId);
    if (!p) {
      return res.json({ estilos: [], config: {} });
    }

    const templatePath = path.join(TEMPLATES_DIR, p.filename);
    const estilos = [];

    // Extract styles from template's styles.xml
    const zip = new AdmZip(templatePath);
    const stylesEntry = zip.getEntry('styles.xml');
    
    if (stylesEntry) {
      const stylesXml = stylesEntry.getData().toString('utf-8');
      const matches = stylesXml.matchAll(/style:name="([^"]+)"/g);
      for (const match of matches) {
        estilos.push(match[1]);
      }
    }

    // Get current config for this model
    const modelo = db.prepare('SELECT estilo_config FROM modelos WHERE id=?').get(req.params.id);
    const config = modelo && modelo.estilo_config ? JSON.parse(modelo.estilo_config) : {};

    res.json({ estilos: [...new Set(estilos)].sort(), config });
  } catch (e) {
    console.error('Error extracting styles:', e);
    res.status(500).json({ error: 'No se pudieron obtener los estilos' });
  }
});

// Save style configuration
app.post('/api/modelos/:id/estilo-config', auth, (req, res) => {
  const { config } = req.body;
  const modelo = db.prepare('SELECT id FROM modelos WHERE id=?').get(req.params.id);
  
  if (!modelo) {
    return res.status(404).json({ error: 'Modelo no encontrado' });
  }

  try {
    db.prepare(`UPDATE modelos SET estilo_config=?, updated_at=datetime('now') WHERE id=?`)
      .run(JSON.stringify(config), req.params.id);
    res.json({ success: true });
  } catch (e) {
    res.status(500).json({ error: 'Error guardando configuracin' });
  }
});

// ─── ODT EXPORT HELPERS ──────────────────────────────────────────────────────

function _buildTipoMap(modeloId) {
  const map = {};
  try {
    db.prepare('SELECT campo, tipo FROM campo_tipos WHERE modelo_id=?').all(modeloId)
      .forEach(r => { map[r.campo] = r.tipo; });
    db.prepare('SELECT clave, tipo FROM campo_catalogo WHERE tipo IS NOT NULL').all()
      .forEach(r => { if (!map[r.clave]) map[r.clave] = r.tipo; });
  } catch {}
  return map;
}

function _formatFieldValue(valor, tipo) {
  if (!valor || !tipo) return valor;
  const v = String(valor).trim();
  if (tipo === 'fecha') {
    const m = v.match(/^(\d{4})-(\d{2})-(\d{2})$/);
    if (m) {
      const MESES = ['enero','febrero','marzo','abril','mayo','junio',
                     'julio','agosto','septiembre','octubre','noviembre','diciembre'];
      return `${parseInt(m[3])} de ${MESES[parseInt(m[2])-1]} de ${m[1]}`;
    }
    return v;
  }
  if (tipo === 'importe') {
    const n = parseFloat(v.replace(/\./g, '').replace(',', '.'));
    if (!isNaN(n)) return n.toLocaleString('es-ES', { minimumFractionDigits: 2, maximumFractionDigits: 2 }) + ' €';
    return v;
  }
  if (tipo === 'numero') {
    const n = parseFloat(v.replace(/\./g, '').replace(',', '.'));
    if (!isNaN(n)) return Number.isInteger(n) ? n.toLocaleString('es-ES') : n.toLocaleString('es-ES', { minimumFractionDigits: 2 });
    return v;
  }
  return v;
}

function _buildOdtFilename(modeloNombre, camposObj) {
  const expClave = camposObj && (camposObj['NUMERO_EXPEDIENTE'] || camposObj['EXPEDIENTE'] || '');
  const fechaStr = new Date().toISOString().slice(0, 10).replace(/-/g, '');
  const base = sanitizeForHeader(modeloNombre || 'modelo');
  const expPart = expClave ? sanitizeName(String(expClave)).slice(0, 40) : '';
  return [base, expPart, fechaStr].filter(Boolean).join('_') + '.odt';
}

async function _generateOdtBuffer(modelo, camposObj, plantillaId, styleMode = 'oficial') {
  let templatePath = null;
  if (plantillaId) {
    const p = db.prepare('SELECT filename FROM plantillas WHERE id=?').get(plantillaId);
    if (p) templatePath = path.join(TEMPLATES_DIR, p.filename);
  } else {
    const def = db.prepare('SELECT filename FROM plantillas WHERE es_defecto=1 LIMIT 1').get();
    if (def) templatePath = path.join(TEMPLATES_DIR, def.filename);
  }

  const tipoMap = _buildTipoMap(modelo.id);
  let cuerpo = modelo.cuerpo || '';
  if (camposObj && typeof camposObj === 'object') {
    for (const [campo, valor] of Object.entries(camposObj)) {
      if (valor && String(valor).trim()) {
        const formatted = _formatFieldValue(String(valor).trim(), tipoMap[campo]);
        const re = new RegExp(`\\{\\{${campo.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\}\\}`, 'g');
        cuerpo = cuerpo.replace(re, formatted);
      }
    }
  }

  const tmpId = `${Date.now()}_${modelo.id}_${Math.random().toString(36).slice(2, 7)}`;
  const tmpDir = os.tmpdir();
  const inputJson = path.join(tmpDir, `${tmpId}_in.json`);
  const outputOdt = path.join(tmpDir, `${tmpId}_out.odt`);

  const payload = {
    title: modelo.nombre,
    markdown: cuerpo,
    style_mode: ['oficial', 'moderno', 'mixto'].includes(styleMode) ? styleMode : 'oficial',
    categoria: modelo.categoria_nombre || '',
    estilo_config: modelo.estilo_config ? JSON.parse(modelo.estilo_config) : {},
    meta: {
      title: modelo.nombre,
      creator: 'Gestión de Modelos',
      subject: modelo.categoria_nombre || ''
    }
  };
  fs.writeFileSync(inputJson, JSON.stringify(payload));

  const args = [path.join(__dirname, 'scripts/export_odt.py'), inputJson, outputOdt];
  if (templatePath && fs.existsSync(templatePath)) args.push(templatePath);

  try {
    const pythonBin = process.env.PYTHON_BIN || (process.platform === 'win32' ? 'python' : 'python3');
    await new Promise((resolve, reject) => {
      execFile(pythonBin, args, { timeout: 30000 }, (err, _stdout, stderr) => {
        if (err) { reject(new Error(stderr || err.message)); return; }
        resolve();
      });
    });
    return fs.readFileSync(outputOdt);
  } finally {
    [inputJson, outputOdt].forEach(f => { try { fs.unlinkSync(f); } catch {} });
  }
}

// ??? Helper compartido para generar ODT ???????????????????????????????????????
async function _doExportOdt(req, res, plantillaId, camposObj, styleMode) {
  const modelo = db.prepare(`SELECT m.*,c.nombre as categoria_nombre FROM modelos m
    LEFT JOIN categorias c ON m.categoria_id=c.id WHERE m.id=?`).get(req.params.id);
  if (!modelo) return res.status(404).json({ error: 'No encontrado' });

  try {
    const buf = await _generateOdtBuffer(modelo, camposObj, plantillaId, styleMode);

    // Save copy in category folder
    if (modelo.categoria_nombre) {
      const dir = path.join(FILES_DIR, sanitizeName(modelo.categoria_nombre));
      if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(path.join(dir, `${sanitizeName(modelo.nombre)}_${Date.now()}.odt`), buf);
    }

    db.prepare('INSERT INTO actividad (modelo_id,user_id,accion) VALUES (?,?,?)').run(modelo.id, req.user.id, 'export a .odt');

    res.setHeader('Content-Type', 'application/vnd.oasis.opendocument.text');
    const filename = _buildOdtFilename(modelo.nombre, camposObj);
    res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
    res.send(buf);
  } catch (e) {
    console.error('ODT export error:', e.message);
    res.status(500).json({ error: 'Error generando ODT: ' + e.message });
  }
}

// GET: exportar sin sustitucion de campos (compatibilidad)
app.get('/api/modelos/:id/export/odt', auth, async (req, res) => {
  const plantillaId = req.query.plantilla_id || null;
  const styleMode = req.query.style_mode || 'oficial';
  await _doExportOdt(req, res, plantillaId, null, styleMode);
});

// POST: exportar con sustitucion de campos {{ }} por valores del formulario
app.post('/api/modelos/:id/export/odt', auth, async (req, res) => {
  const { plantilla_id, campos, style_mode } = req.body;
  await _doExportOdt(req, res, plantilla_id || null, campos || {}, style_mode || 'oficial');
});

// POST: exportar múltiples modelos como ZIP de ODTs
app.post('/api/export/batch-odt', auth, async (req, res) => {
  const { ids, campos, plantilla_id, style_mode } = req.body;
  if (!Array.isArray(ids) || ids.length === 0)
    return res.status(400).json({ error: 'Se requiere al menos un modelo' });
  if (ids.length > 50)
    return res.status(400).json({ error: 'Máximo 50 modelos por lote' });

  res.setHeader('Content-Type', 'application/zip');
  const dateStr = new Date().toISOString().slice(0, 10);
  res.setHeader('Content-Disposition', `attachment; filename="modelos_${dateStr}.zip"`);

  const archive = archiver('zip', { zlib: { level: 6 } });
  archive.on('error', err => { console.error('Archiver error:', err); });
  archive.pipe(res);

  const usedNames = new Set();
  for (const id of ids) {
    try {
      const modelo = db.prepare(`SELECT m.*, c.nombre as categoria_nombre FROM modelos m
        LEFT JOIN categorias c ON m.categoria_id=c.id WHERE m.id=?`).get(id);
      if (!modelo) continue;
      const buf = await _generateOdtBuffer(modelo, campos || {}, plantilla_id || null, style_mode || 'oficial');
      let filename = _buildOdtFilename(modelo.nombre, campos || {});
      // Ensure unique filenames within the ZIP
      if (usedNames.has(filename)) {
        filename = filename.replace('.odt', `_${modelo.id}.odt`);
      }
      usedNames.add(filename);
      archive.append(buf, { name: filename });
      db.prepare('INSERT INTO actividad (modelo_id,user_id,accion) VALUES (?,?,?)')
        .run(modelo.id, req.user.id, 'export batch .odt');
    } catch (e) {
      console.error(`Batch ODT error model ${id}:`, e.message);
    }
  }

  await archive.finalize().catch(err => console.error('Archiver finalize error:', err));
});

// ??? ACTIVIDAD ????????????????????????????????????????????????????????????????
app.post('/api/modelos/:id/actividad', auth, (req, res) => {
  db.prepare('INSERT INTO actividad (modelo_id,user_id,accion,detalle) VALUES (?,?,?,?)')
    .run(req.params.id, req.user.id, req.body.accion, req.body.detalle || null);
  res.json({ ok: true });
});

// ??? AUTOSAVE ??????????????????????????????????????????????????????????????????
app.post('/api/modelos/:id/autosave', auth, role('admin','editor'), (req, res) => {
  const { cuerpo } = req.body;
  db.prepare(`UPDATE modelos SET cuerpo=?, updated_by=?, updated_at=datetime('now') WHERE id=?`)
    .run(cuerpo || '', req.user.id, req.params.id);
  syncGlobalFieldsFromModel(req.params.id, cuerpo || '');
  res.json({ ok: true });
});

// ??? VERSIONES ????????????????????????????????????????????????????????????????
app.get('/api/modelos/:id/versiones', auth, (req, res) => {
  const rows = db.prepare(`SELECT v.*, u.nombre as user_nombre FROM modelo_versiones v LEFT JOIN users u ON v.user_id=u.id WHERE v.modelo_id=? ORDER BY v.id DESC LIMIT 20`).all(req.params.id);
  res.json(rows);
});

app.post('/api/modelos/:id/restore', auth, role('admin','editor'), (req, res) => {
  const { version_id } = req.body;
  const v = db.prepare('SELECT * FROM modelo_versiones WHERE id=? AND modelo_id=?').get(version_id, req.params.id);
  if (!v) return res.status(404).json({ error: 'Version no encontrada' });
  const prev = db.prepare('SELECT cuerpo,nombre,descripcion,etiquetas FROM modelos WHERE id=?').get(req.params.id);
  if (prev) {
    db.prepare(`INSERT INTO modelo_versiones (modelo_id,user_id,cuerpo,nombre,descripcion,etiquetas) VALUES (?,?,?,?,?,?)`)
      .run(req.params.id, req.user.id, prev.cuerpo, prev.nombre, prev.descripcion, prev.etiquetas);
  }
  db.prepare(`UPDATE modelos SET cuerpo=?, nombre=?, descripcion=?, etiquetas=?, updated_by=?, updated_at=datetime('now') WHERE id=?`)
    .run(v.cuerpo, v.nombre, v.descripcion, v.etiquetas, req.user.id, req.params.id);
  syncGlobalFieldsFromModel(req.params.id, v.cuerpo || '');
  db.prepare('INSERT INTO actividad (modelo_id,user_id,accion,detalle) VALUES (?,?,?,?)')
    .run(req.params.id, req.user.id, 'restaur version', `version #${v.id}`);
  res.json({ ok: true });
});

// ??? PREVIEW ???????????????????????????????????????????????????????????????????
app.post('/api/modelos/:id/preview', auth, (req, res) => {
  const modelo = db.prepare(`SELECT m.*,c.nombre as categoria_nombre FROM modelos m LEFT JOIN categorias c ON m.categoria_id=c.id WHERE m.id=?`).get(req.params.id);
  if (!modelo) return res.status(404).json({ error: 'No encontrado' });
  let cuerpo = modelo.cuerpo || '';
  const camposObj = req.body.campos || {};
  if (camposObj && typeof camposObj === 'object') {
    for (const [campo, valor] of Object.entries(camposObj)) {
      if (valor && String(valor).trim()) {
        const re = new RegExp(`\\{\\{${campo.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\}\\}`, 'g');
        cuerpo = cuerpo.replace(re, String(valor).trim());
      }
    }
  }
  res.json({ cuerpo, nombre: modelo.nombre, categoria: modelo.categoria_nombre || '' });
});

// ??? EXPORT PDF ????????????????????????????????????????????????????????????????
async function _doExportPdf(req, res, camposObj) {
  const modelo = db.prepare(`SELECT m.*,c.nombre as categoria_nombre FROM modelos m LEFT JOIN categorias c ON m.categoria_id=c.id WHERE m.id=?`).get(req.params.id);
  if (!modelo) return res.status(404).json({ error: 'No encontrado' });
  let cuerpo = modelo.cuerpo || '';
  if (camposObj && typeof camposObj === 'object') {
    for (const [campo, valor] of Object.entries(camposObj)) {
      if (valor && String(valor).trim()) {
        const re = new RegExp(`\\{\\{${campo.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\}\\}`, 'g');
        cuerpo = cuerpo.replace(re, String(valor).trim());
      }
    }
  }
  const tmpId = `${Date.now()}_${modelo.id}`;
  const tmpDir = os.tmpdir();
  const inputJson = path.join(tmpDir, `${tmpId}_in.json`);
  const outputPdf = path.join(tmpDir, `${tmpId}_out.pdf`);
  const payload = {
    title: modelo.nombre,
    markdown: cuerpo,
    categoria: modelo.categoria_nombre || ''
  };
  fs.writeFileSync(inputJson, JSON.stringify(payload));
  try {
    const pythonBin = process.env.PYTHON_BIN || (process.platform === 'win32' ? 'python' : 'python3');
    await new Promise((resolve, reject) => {
      execFile(pythonBin, [
        path.join(__dirname, 'scripts/export_pdf.py'),
        inputJson, outputPdf
      ], { timeout: 30000 }, (err, stdout, stderr) => {
        if (err) { reject(new Error(stderr || err.message)); return; }
        resolve();
      });
    });
    const buf = fs.readFileSync(outputPdf);
    db.prepare('INSERT INTO actividad (modelo_id,user_id,accion) VALUES (?,?,?)').run(modelo.id, req.user.id, 'export a .pdf');
    res.setHeader('Content-Type', 'application/pdf');
    const filename = sanitizeForHeader(modelo.nombre || 'modelo') + '.pdf';
    res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
    res.send(buf);
  } catch (e) {
    console.error('PDF export error:', e.message);
    res.status(500).json({ error: 'Error generando PDF: ' + e.message });
  } finally {
    [inputJson, outputPdf].forEach(f => { try { fs.unlinkSync(f); } catch {} });
  }
}

app.post('/api/modelos/:id/export/pdf', auth, async (req, res) => {
  await _doExportPdf(req, res, req.body.campos || {});
});

// ??? EXPEDIENTES BD ???????????????????????????????????????????????????????????
app.get('/api/expedientes', auth, (req, res) => {
  const rows = db.prepare(`SELECT clave, campos, updated_at FROM expedientes WHERE user_id=? ORDER BY updated_at DESC LIMIT 50`).all(req.user.id);
  res.json(rows.map(r => ({ clave: r.clave, campos: JSON.parse(r.campos || '{}'), updated_at: r.updated_at })));
});

app.post('/api/expedientes', auth, (req, res) => {
  const { clave, campos } = req.body;
  if (!clave || !clave.trim()) return res.status(400).json({ error: 'Clave requerida' });
  const existing = db.prepare('SELECT id FROM expedientes WHERE user_id=? AND clave=?').get(req.user.id, clave.trim());
  if (existing) {
    db.prepare(`UPDATE expedientes SET campos=?, updated_at=datetime('now') WHERE id=?`).run(JSON.stringify(campos || {}), existing.id);
  } else {
    db.prepare(`INSERT INTO expedientes (user_id,clave,campos) VALUES (?,?,?)`).run(req.user.id, clave.trim(), JSON.stringify(campos || {}));
  }
  res.json({ ok: true });
});

app.delete('/api/expedientes/:clave', auth, (req, res) => {
  db.prepare('DELETE FROM expedientes WHERE user_id=? AND clave=?').run(req.user.id, req.params.clave);
  res.json({ ok: true });
});

// Biblioteca global de campos reutilizables
app.get('/api/campos-globales', auth, (req, res) => {
  const rows = db.prepare(`
    SELECT clave,nombre,tipo,descripcion,valor_defecto,updated_at
    FROM campo_catalogo
    ORDER BY clave
  `).all();
  res.json(rows);
});

app.post('/api/campos-globales', auth, role('admin','editor'), (req, res) => {
  const { clave, nombre, tipo, descripcion, valor_defecto } = req.body;
  if (!clave) return res.status(400).json({ error: 'Clave requerida' });
  syncGlobalField(clave, { nombre, tipo, descripcion, valor_defecto });
  res.json({ ok: true });
});

// ??? CAMPO TIPOS ???????????????????????????????????????????????????????????????
app.get('/api/modelos/:id/campo-tipos', auth, (req, res) => {
  const rows = db.prepare('SELECT campo,tipo,config FROM campo_tipos WHERE modelo_id=?').all(req.params.id);
  res.json(rows.map(r => ({ campo: r.campo, tipo: r.tipo, config: JSON.parse(r.config || '{}') })));
});

app.post('/api/modelos/:id/campo-tipos', auth, role('admin','editor'), (req, res) => {
  const { campo, tipo, config } = req.body;
  if (!campo || !tipo) return res.status(400).json({ error: 'Campo y tipo requeridos' });
  const existing = db.prepare('SELECT id FROM campo_tipos WHERE modelo_id=? AND campo=?').get(req.params.id, campo);
  if (existing) {
    db.prepare('UPDATE campo_tipos SET tipo=?, config=? WHERE id=?').run(tipo, JSON.stringify(config || {}), existing.id);
  } else {
    db.prepare('INSERT INTO campo_tipos (modelo_id,campo,tipo,config) VALUES (?,?,?,?)').run(req.params.id, campo, tipo, JSON.stringify(config || {}));
  }
  syncGlobalField(campo, { tipo });
  res.json({ ok: true });
});

// Análisis de campos: frecuencia, tipos y documentos que los usan
app.get('/api/analisis-campos', auth, role('admin', 'editor'), (req, res) => {
  const CAMPO_RE = /\{\{([A-Z][A-Z0-9_]*)\}\}/g;
  const modelos = db.prepare(`
    SELECT m.id, m.nombre, m.estado, m.cuerpo, c.nombre as cat_nombre
    FROM modelos m
    LEFT JOIN categorias c ON c.id = m.categoria_id
    WHERE m.cuerpo IS NOT NULL AND m.cuerpo != ''
  `).all();

  const fieldMap = {};
  modelos.forEach(m => {
    const vistos = new Set();
    CAMPO_RE.lastIndex = 0;
    let match;
    while ((match = CAMPO_RE.exec(m.cuerpo)) !== null) vistos.add(match[1]);
    vistos.forEach(campo => {
      if (!fieldMap[campo]) fieldMap[campo] = { campo, count: 0, modelos: [] };
      fieldMap[campo].count++;
      fieldMap[campo].modelos.push({ id: m.id, nombre: m.nombre, estado: m.estado, categoria: m.cat_nombre || 'Sin categoría' });
    });
  });

  const catalog = db.prepare('SELECT clave, nombre, tipo FROM campo_catalogo').all();
  const catalogMap = Object.fromEntries(catalog.map(c => [c.clave, c]));

  const resultado = Object.values(fieldMap)
    .sort((a, b) => b.count - a.count)
    .map(f => ({
      ...f,
      tipo: catalogMap[f.campo]?.tipo || null,
      nombre_legible: catalogMap[f.campo]?.nombre || humanizeFieldName(f.campo),
      en_catalogo: !!catalogMap[f.campo],
    }));

  res.json({ total_campos: resultado.length, total_modelos: modelos.length, campos: resultado });
});

// Renombra un campo en campo_tipos evitando UNIQUE constraint
function renameCampoTipo(modeloId, from, to) {
  const exists = db.prepare('SELECT id FROM campo_tipos WHERE modelo_id=? AND campo=?').get(modeloId, to);
  if (exists) {
    // El destino ya existe: sólo borra el origen para evitar duplicado
    db.prepare('DELETE FROM campo_tipos WHERE modelo_id=? AND campo=?').run(modeloId, from);
  } else {
    db.prepare('UPDATE campo_tipos SET campo=? WHERE modelo_id=? AND campo=?').run(to, modeloId, from);
  }
}

// POST /api/admin/rename-campo  { old: 'MUNICIPIO', new: 'ORGANISMO' }
app.post('/api/admin/rename-campo', auth, role('admin'), (req, res) => {
  const { old: oldCampo, new: newCampo } = req.body || {};
  if (!oldCampo || !newCampo) return res.status(400).json({ error: 'Faltan old y new' });
  const from = String(oldCampo).trim().toUpperCase();
  const to   = String(newCampo).trim().toUpperCase();
  if (from === to) return res.json({ actualizados: 0, mensaje: 'Los campos son iguales' });

  const re = new RegExp(`\\{\\{${from}\\}\\}`, 'g');
  const modelos = db.prepare('SELECT id, cuerpo FROM modelos').all();
  const update  = db.prepare('UPDATE modelos SET cuerpo=?, updated_at=datetime(\'now\') WHERE id=?');

  let actualizados = 0;
  db.transaction(() => {
    for (const m of modelos) {
      const nuevo = (m.cuerpo || '').replace(re, `{{${to}}}`);
      if (nuevo !== m.cuerpo) {
        update.run(nuevo, m.id);
        renameCampoTipo(m.id, from, to);
        actualizados++;
      }
    }
    syncGlobalField(to, {});
  })();

  res.json({ actualizados, from, to });
});

// POST /api/admin/migrar-campos  — aplica el mapa completo old→new de contratación
app.post('/api/admin/migrar-campos', auth, role('admin'), (req, res) => {
  const mapa = {
    MUNICIPIO:          'ORGANISMO',
    NUMERO_EXPEDIENTE:  'EXPEDIENTE',
    OBJETO_CONTRATO:    'OBJETO',
    OBJETO_CONVENIO:    'OBJETO',
    IMPORTE:            'PRESUPUESTO_BASE',
    FECHA_DECRETO:      'FECHA',
    FECHA_FIRMA:        'FECHA',
  };

  const modelos = db.prepare('SELECT id, cuerpo FROM modelos').all();
  const update  = db.prepare('UPDATE modelos SET cuerpo=?, updated_at=datetime(\'now\') WHERE id=?');

  const resumen = {};
  db.transaction(() => {
    for (const m of modelos) {
      let cuerpo = m.cuerpo || '';
      let modificado = false;
      for (const [from, to] of Object.entries(mapa)) {
        const re    = new RegExp(`\\{\\{${from}\\}\\}`, 'g');
        const nuevo = cuerpo.replace(re, `{{${to}}}`);
        if (nuevo !== cuerpo) {
          resumen[from] = (resumen[from] || 0) + 1;
          renameCampoTipo(m.id, from, to);
          cuerpo = nuevo;
          modificado = true;
        }
      }
      if (modificado) update.run(cuerpo, m.id);
    }
    seedContractFieldCatalog();
  })();

  res.json({ mapa, sustitucionesRealizadas: resumen, modelos_total: modelos.length });
});

app.get('/api/health', (_, res) => res.json({ status: 'ok', version: '3.1.0' }));
// ═══════════════════════════════════════════════════════════════════════════════
// PARCHE server_ia_patch.js — Generación IA + multi-PDF + export directo ODT
// Pegar en server.js ANTES de app.listen()
//
// Variables de entorno necesarias:
//   ANTHROPIC_API_KEY=sk-ant-...
//
// pip3 install pypdf --break-system-packages  (añadir al Dockerfile)
// ═══════════════════════════════════════════════════════════════════════════════

// ─── MULTER PARA PDFs ─────────────────────────────────────────────────────────
const pdfUpload = multer({
  storage: multer.diskStorage({
    destination: os.tmpdir(),
    filename: (req, file, cb) => cb(null, `${Date.now()}_${Math.random().toString(36).slice(2)}.pdf`)
  }),
  fileFilter: (req, file, cb) => {
    const ok = /\.pdf$/i.test(file.originalname) || file.mimetype === 'application/pdf';
    cb(ok ? null : new Error('Solo se permiten PDFs'), ok);
  },
  limits: { fileSize: 20 * 1024 * 1024 }
});

// ─── HELPER: Extraer texto + firmas de varios PDFs ────────────────────────────
async function _extractPdfData(pdfPaths) {
  const tmpOut = path.join(os.tmpdir(), `${Date.now()}_extracted.json`);
  const pythonBin = process.env.PYTHON_BIN || (process.platform === 'win32' ? 'python' : 'python3');
  const scriptPath = path.join(__dirname, 'scripts/extract_pdf_text.py');
  const args = [...pdfPaths, tmpOut];
  try {
    await new Promise((resolve, reject) => {
      execFile(pythonBin, [scriptPath, ...args], { timeout: 60000 }, (err, _out, stderr) => {
        if (err) reject(new Error(stderr || err.message));
        else resolve();
      });
    });
    return JSON.parse(fs.readFileSync(tmpOut, 'utf8'));
  } finally {
    try { fs.unlinkSync(tmpOut); } catch {}
  }
}

// ─── HELPER: Llamar a Claude Haiku ────────────────────────────────────────────
async function _llamarClaude(systemPrompt, userMessage) {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) throw new Error('ANTHROPIC_API_KEY no configurada en el servidor');

  const response = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': apiKey,
      'anthropic-version': '2023-06-01',
    },
    body: JSON.stringify({
      model: 'claude-haiku-4-5-20251001',
      max_tokens: 4096,
      system: systemPrompt,
      messages: [{ role: 'user', content: userMessage }],
    }),
  });
  if (!response.ok) {
    const err = await response.json().catch(() => ({}));
    throw new Error(`Claude API ${response.status}: ${err.error?.message || 'error desconocido'}`);
  }
  const data = await response.json();
  return data.content?.[0]?.text || '';
}

// ─── RUTA 1: Extraer texto + firmas de uno o varios PDFs ─────────────────────
// POST /api/ia/extraer-pdf
// Campos multipart: "pdfs" (múltiples archivos)
app.post('/api/ia/extraer-pdf', auth, pdfUpload.array('pdfs', 10), async (req, res) => {
  const archivos = req.files || [];
  if (!archivos.length) return res.status(400).json({ error: 'Se requiere al menos un PDF' });

  const pdfPaths = archivos.map(f => f.path);
  try {
    const datos = await _extractPdfData(pdfPaths);

    // Normalizar respuesta: si es un solo PDF o varios
    const esSolo = archivos.length === 1;
    const texto = esSolo ? datos.texto : datos.texto_combinado;
    const firmas = esSolo ? (datos.firmas || []) : (datos.firmas_combinadas || []);
    const paginas = esSolo ? datos.paginas : datos.total_paginas;

    const textoPreview = texto.length > 8000
      ? texto.slice(0, 8000) + '\n\n[... texto truncado para previsualización ...]'
      : texto;

    res.json({
      texto,
      texto_preview: textoPreview,
      paginas,
      firmas,                        // [{ firmante, fecha, nif, rol, fuente, documento? }]
      documentos: esSolo ? null : datos.documentos,
      metodo: esSolo ? datos.metodo : 'multi',
      n_archivos: archivos.length,
    });
  } catch (e) {
    console.error('Error extrayendo PDFs:', e.message);
    res.status(500).json({ error: 'No se pudo extraer el texto: ' + e.message });
  } finally {
    pdfPaths.forEach(p => { try { fs.unlinkSync(p); } catch {} });
  }
});

// ─── RUTA 2: Generar acuerdo con IA ──────────────────────────────────────────
app.post('/api/modelos/:id/generar-ia', auth, async (req, res) => {
  const modelo = db.prepare(`
    SELECT m.*, c.nombre as categoria_nombre, c.descripcion as categoria_desc
    FROM modelos m LEFT JOIN categorias c ON m.categoria_id=c.id WHERE m.id=?
  `).get(req.params.id);
  if (!modelo) return res.status(404).json({ error: 'Modelo no encontrado' });

  const { texto_antecedentes = '', firmas = [], instrucciones_adicionales = '' } = req.body;
  if (!texto_antecedentes.trim())
    return res.status(400).json({ error: 'Se requiere el texto de antecedentes' });

  const camposPlantilla = extractFieldNames(modelo.cuerpo || '');

  console.log('CUERPO MODELO:', modelo.cuerpo?.slice(0, 200));
  console.log('CAMPOS:', camposPlantilla);

  const firmasStr = firmas.length
    ? '\nFIRMAS ELECTRÓNICAS DETECTADAS EN LOS DOCUMENTOS:\n' +
      firmas.map(f => {
        const partes = [`- ${f.firmante}`];
        if (f.fecha)     partes.push(`Fecha: ${f.fecha}`);
        if (f.rol)       partes.push(`Cargo: ${f.rol}`);
        if (f.nif)       partes.push(`NIF: ${f.nif}`);
        if (f.documento) partes.push(`Documento: ${f.documento}`);
        return partes.join(' | ');
      }).join('\n')
    : '';

  const systemPrompt = `Eres un asistente de la Secretaría del Ayuntamiento de Totana (Murcia).

Tu tarea es EXCLUSIVAMENTE sustituir los campos {{CAMPO}} de la plantilla por los valores que encuentres en los documentos aportados. No redactes, no reescribas, no reorganices. Devuelve la plantilla íntegra con los campos rellenados.

CAMPOS A RELLENAR:
${camposPlantilla.map(c => `• {{${c}}}`).join('\n')}

REGLAS:
1. Devuelve el texto de la plantilla COMPLETO y SIN MODIFICAR, únicamente con los {{CAMPOS}} sustituidos.
2. Si no encuentras el valor de un campo en los documentos, déjalo exactamente como {{NOMBRE_CAMPO}}.
3. No añadas, elimines ni muevas ninguna frase, título, sección ni punto de la plantilla.
4. Formatos obligatorios:
   - Fechas: "DD de [mes] de YYYY"  →  "15 de marzo de 2024"
   - Importes: cifra con separador de miles y dos decimales  →  "12.500,00 €"
   - Nombres: APELLIDO1 APELLIDO2, Nombre  →  "GARCÍA LÓPEZ, Juan"
5. Las firmas electrónicas identifican cargo (Alcalde, Secretario, Interventor…); úsalas para los campos de persona correspondientes.`;

  const mensajeUsuario = `PLANTILLA (devuélvela completa con los campos sustituidos):
---
${modelo.cuerpo}
---

DOCUMENTOS PDF (fuente de los valores):
---
${texto_antecedentes.slice(0, 5000)}${texto_antecedentes.length > 5000 ? '\n[... texto adicional omitido ...]' : ''}
---
${firmasStr}
${instrucciones_adicionales.trim() ? '\nINSTRUCCIONES ADICIONALES:\n' + instrucciones_adicionales : ''}`;

  console.log('MENSAJE USUARIO LONGITUD:', mensajeUsuario.length);
  console.log('MENSAJE USUARIO INICIO:', mensajeUsuario.slice(0, 300));

  try {
    const acuerdoMarkdown = await _llamarClaude(systemPrompt, mensajeUsuario);
    db.prepare('INSERT INTO actividad (modelo_id,user_id,accion,detalle) VALUES (?,?,?,?)')
      .run(modelo.id, req.user.id, 'generó acuerdo con IA', `${firmas.length} firmante(s)`);
    res.json({ acuerdo_markdown: acuerdoMarkdown });
  } catch (e) {
    console.error('Error Claude:', e.message);
    res.status(500).json({ error: 'Error al generar el acuerdo: ' + e.message });
  }
});
// ─── RUTA 3: Generar + exportar ODT directamente ──────────────────────────────
// POST /api/modelos/:id/ia-export-odt
// Body: { acuerdo_markdown, plantilla_id, campos }
// Devuelve el .odt directamente para descarga
app.post('/api/modelos/:id/ia-export-odt', auth, async (req, res) => {
  const modelo = db.prepare(`
    SELECT m.*, c.nombre as categoria_nombre
    FROM modelos m LEFT JOIN categorias c ON m.categoria_id=c.id WHERE m.id=?
  `).get(req.params.id);
  if (!modelo) return res.status(404).json({ error: 'Modelo no encontrado' });

  const { acuerdo_markdown, plantilla_id, campos = {} } = req.body;
  if (!acuerdo_markdown || !acuerdo_markdown.trim())
    return res.status(400).json({ error: 'Se requiere el texto del acuerdo' });

  // Crear un modelo temporal en memoria para reutilizar _generateOdtBuffer
  const modeloTmp = {
    ...modelo,
    cuerpo: acuerdo_markdown,
    nombre: modelo.nombre,
  };

  try {
    const buf = await _generateOdtBuffer(modeloTmp, campos, plantilla_id || null, {});

    // Guardar copia en carpeta de la categoría
    if (modelo.categoria_nombre) {
      const dir = path.join(FILES_DIR, sanitizeName(modelo.categoria_nombre));
      if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(path.join(dir, `${sanitizeName(modelo.nombre)}_IA_${Date.now()}.odt`), buf);
    }

    db.prepare('INSERT INTO actividad (modelo_id,user_id,accion) VALUES (?,?,?)')
      .run(modelo.id, req.user.id, 'exportó acuerdo IA a .odt');

    res.setHeader('Content-Type', 'application/vnd.oasis.opendocument.text');
    res.setHeader('Content-Disposition',
      `attachment; filename="${sanitizeForHeader(modelo.nombre)}_IA.odt"`);
    res.send(buf);
  } catch (e) {
    console.error('IA ODT export error:', e.message);
    res.status(500).json({ error: 'Error generando ODT: ' + e.message });
  }
});

// ─── RUTA 4: Estado de la IA ──────────────────────────────────────────────────
app.get('/api/ia/status', auth, (req, res) => {
  res.json({ disponible: !!process.env.ANTHROPIC_API_KEY, modelo: 'claude-haiku-4-5-20251001' });
});
app.post('/api/modelos/:id/duplicate', auth, role('admin','editor'), (req, res) => {
  const { nombre } = req.body;
  if (!nombre) return res.status(400).json({ error: 'Nombre requerido' });
  const original = db.prepare('SELECT * FROM modelos WHERE id=?').get(req.params.id);
  if (!original) return res.status(404).json({ error: 'No encontrado' });
  const r = db.prepare(`INSERT INTO modelos (nombre,categoria_id,estado,descripcion,cuerpo,etiquetas,owner_id,created_by,updated_by)
      VALUES (?,?,?,?,?,?,?,?,?)`)
      .run(nombre, original.categoria_id, 'borrador', original.descripcion,
      original.cuerpo, '[]', req.user.id, req.user.id, req.user.id);
  syncGlobalFieldsFromModel(r.lastInsertRowid, original.cuerpo || '');
  db.prepare('INSERT INTO actividad (modelo_id,user_id,accion,detalle) VALUES (?,?,?,?)')
      .run(r.lastInsertRowid, req.user.id, 'duplicó modelo', `desde modelo #${original.id}`);
  res.json({ id: r.lastInsertRowid });
});

app.listen(PORT, () => console.log(`Acuerdos API v3 - puerto ${PORT}`));
