const express = require('express');
const cors = require('cors');
const jwt = require('jsonwebtoken');
const bcrypt = require('bcryptjs');
const Database = require('better-sqlite3');
const path = require('path');
const fs = require('fs');
const { execFile } = require('child_process');
const multer = require('multer');
const AdmZip = require('adm-zip');

const app = express();
const PORT = process.env.PORT || 3001;
const JWT_SECRET = process.env.JWT_SECRET || 'ayuntamiento-secret-2024';
const DB_PATH = process.env.DB_PATH || '/data/acuerdos.db';
const FILES_DIR = process.env.FILES_DIR || '/data/carpetas';
const TEMPLATES_DIR = process.env.TEMPLATES_DIR || '/data/plantillas';

[path.dirname(DB_PATH), FILES_DIR, TEMPLATES_DIR].forEach(d => {
  if (!fs.existsSync(d)) fs.mkdirSync(d, { recursive: true });
});

// ─── DATABASE ─────────────────────────────────────────────────────────────────
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
    icono TEXT DEFAULT '📄',
    color TEXT DEFAULT 'blue',
    orden INTEGER DEFAULT 0,
    activa INTEGER NOT NULL DEFAULT 1,
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
  
`);

// Agregar columna si no existe (para bases de datos existentes)
try {
  db.prepare(`ALTER TABLE modelos ADD COLUMN estilo_config TEXT DEFAULT '{}'`).run();
} catch (e) {
  // Columna ya existe, ignorar
}

// ─── SEED ─────────────────────────────────────────────────────────────────────
const userCount = db.prepare('SELECT COUNT(*) as n FROM users').get();
if (userCount.n === 0) {
  const h = (p) => bcrypt.hashSync(p, 10);
  db.prepare(`INSERT INTO users (nombre,email,password_hash,rol) VALUES (?,?,?,?)`).run('Ana López','admin@ayuntamiento.es',h('admin123'),'admin');
  db.prepare(`INSERT INTO users (nombre,email,password_hash,rol) VALUES (?,?,?,?)`).run('Carlos Martín','carlos@ayuntamiento.es',h('editor123'),'editor');
  db.prepare(`INSERT INTO users (nombre,email,password_hash,rol) VALUES (?,?,?,?)`).run('María Gómez','maria@ayuntamiento.es',h('editor123'),'editor');
  db.prepare(`INSERT INTO users (nombre,email,password_hash,rol) VALUES (?,?,?,?)`).run('Pedro Ruiz','pedro@ayuntamiento.es',h('consultor123'),'consultor');
}

const catCount = db.prepare('SELECT COUNT(*) as n FROM categorias').get();
if (catCount.n === 0) {
  const cats = [
    ['Pleno','Acuerdos adoptados en sesión plenaria','🏛️','blue',1],
    ['Junta de Gobierno','Acuerdos de la Junta de Gobierno Local','👥','teal',2],
    ['Decreto de Alcaldía','Decretos y resoluciones de Alcaldía','📋','amber',3],
    ['Resolución','Resoluciones administrativas','✅','green',4],
    ['Convenio','Convenios y acuerdos de colaboración','🤝','purple',5],
  ];
  const insC = db.prepare(`INSERT INTO categorias (nombre,descripcion,icono,color,orden,created_by) VALUES (?,?,?,?,?,1)`);
  cats.forEach(c => insC.run(...c));

  const modelos = [
    [1, 'Acuerdo de Pleno — Aprobación de Presupuesto', 'activo',
     'Modelo para aprobación de presupuesto municipal en sesión plenaria ordinaria.',
     '["presupuesto","pleno","hacienda"]',
     `# ACUERDO DE PLENO — {{MUNICIPIO}}

## Sesión N.º {{NUMERO_SESION}}

En **{{MUNICIPIO}}**, siendo las doce horas del día {{FECHA_SESION}}, bajo la presidencia del Alcalde **{{ALCALDE_NOMBRE}}**, y con asistencia del Secretario **{{SECRETARIO_NOMBRE}}**, se reúne en sesión ordinaria el Pleno del Ayuntamiento.

**EXPEDIENTE NÚM. {{NUMERO_EXPEDIENTE}}**

Visto el informe del departamento de {{DEPARTAMENTO}} relativo al ejercicio {{EJERCICIO_PRESUPUESTARIO}}, y habiendo sido sometido a votación con resultado {{VOTACION_RESULTADO}}, el Pleno Municipal acuerda:

**PRIMERO.** Aprobar el presupuesto municipal por importe de {{IMPORTE}} euros para {{CONCEPTO}}.

**SEGUNDO.** Proceder a su publicación en el BOP el {{FECHA_PUBLICACION}}.

---

Lo que se hace constar para los oportunos efectos.

- El Alcalde: {{ALCALDE_NOMBRE}}
- El Secretario: {{SECRETARIO_NOMBRE}}`],
    [3, 'Decreto de Alcaldía — Contratación', 'activo',
     'Modelo de decreto para procesos de contratación.',
     '["contratación","decreto"]',
     `# DECRETO DE ALCALDÍA N.º {{NUMERO_DECRETO}}

En **{{MUNICIPIO}}**, a {{FECHA_DECRETO}}.

El Alcalde-Presidente, **{{ALCALDE_NOMBRE}}**, en uso de las atribuciones que le confiere la legislación vigente,

## RESUELVE

**PRIMERO.** Aprobar el inicio del expediente de contratación para **{{OBJETO_CONTRATO}}** con presupuesto base de licitación de {{IMPORTE}} euros.

**SEGUNDO.** Autorizar el gasto con cargo a la partida presupuestaria {{PARTIDA_PRESUPUESTARIA}}.

**TERCERO.** Contra la presente resolución podrá interponerse recurso de reposición en el plazo de un mes.

---

El Alcalde — {{ALCALDE_NOMBRE}}`],
    [5, 'Convenio de Colaboración Interadministrativa', 'borrador',
     'Plantilla base para convenios con otras administraciones.',
     '["convenio","colaboración"]',
     `# CONVENIO DE COLABORACIÓN

Entre el **Ayuntamiento de {{MUNICIPIO}}**, representado por {{ALCALDE_NOMBRE}}, y **{{ENTIDAD_COLABORADORA}}**, representada por {{REPRESENTANTE_ENTIDAD}}.

## CLÁUSULAS

**PRIMERA.** El objeto del presente convenio es {{OBJETO_CONVENIO}}.

**SEGUNDA.** La vigencia será desde {{FECHA_INICIO}} hasta {{FECHA_FIN}}.

**TERCERA.** La aportación del Ayuntamiento será de {{IMPORTE}} euros.

---

En {{MUNICIPIO}}, a {{FECHA_FIRMA}}.

- El Alcalde: {{ALCALDE_NOMBRE}}
- El Representante: {{REPRESENTANTE_ENTIDAD}}`],
  ];
  const insM = db.prepare(`INSERT INTO modelos (categoria_id,nombre,estado,descripcion,etiquetas,cuerpo,owner_id,created_by,updated_by) VALUES (?,?,?,?,?,?,1,1,1)`);
  modelos.forEach(m => insM.run(...m));
  syncFolders();
}

// ─── HELPERS ──────────────────────────────────────────────────────────────────
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

// ─── MIDDLEWARE ───────────────────────────────────────────────────────────────
app.use(cors({ origin: true, credentials: true }));
app.use(express.json({ limit: '5mb' }));

function auth(req, res, next) {
  const token = req.headers.authorization?.split(' ')[1];
  if (!token) return res.status(401).json({ error: 'No autenticado' });
  try { req.user = jwt.verify(token, JWT_SECRET); next(); }
  catch { res.status(401).json({ error: 'Token inválido' }); }
}

function role(...roles) {
  return (req, res, next) => {
    if (!roles.includes(req.user.rol)) return res.status(403).json({ error: 'Sin permisos' });
    next();
  };
}

// ─── AUTH ─────────────────────────────────────────────────────────────────────
app.post('/api/auth/login', (req, res) => {
  const { email, password } = req.body;
  const user = db.prepare('SELECT * FROM users WHERE email=? AND activo=1').get(email);
  if (!user || !bcrypt.compareSync(password, user.password_hash))
    return res.status(401).json({ error: 'Credenciales incorrectas' });
  const token = jwt.sign({ id:user.id, nombre:user.nombre, email:user.email, rol:user.rol }, JWT_SECRET, { expiresIn:'8h' });
  res.json({ token, user: { id:user.id, nombre:user.nombre, email:user.email, rol:user.rol } });
});

app.get('/api/auth/me', auth, (req, res) => {
  res.json(db.prepare('SELECT id,nombre,email,rol FROM users WHERE id=?').get(req.user.id));
});

// ─── USERS ────────────────────────────────────────────────────────────────────
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

// ─── CATEGORÍAS ───────────────────────────────────────────────────────────────
app.get('/api/categorias', auth, (req, res) => {
  res.json(db.prepare(`SELECT c.*, COUNT(m.id) as total_modelos FROM categorias c LEFT JOIN modelos m ON m.categoria_id=c.id GROUP BY c.id ORDER BY c.orden, c.nombre`).all());
});

app.post('/api/categorias', auth, role('admin'), (req, res) => {
  const { nombre, descripcion, icono, color, orden, parent_id } = req.body;
  if (!nombre) return res.status(400).json({ error: 'Nombre requerido' });
  // Solo se puede asignar modelos a subcategorías (hijos), no a raíz
  const r = db.prepare(`INSERT INTO categorias (nombre,descripcion,icono,color,orden,parent_id,created_by)
    VALUES (?,?,?,?,?,?,?)`)
    .run(nombre, descripcion||'', icono||'📄', color||'blue', orden||0, parent_id||null, req.user.id);
  res.json({ id: r.lastInsertRowid });
});

app.put('/api/categorias/:id', auth, role('admin'), (req, res) => {
  const { nombre, descripcion, icono, color, orden, activa, parent_id } = req.body;
  db.prepare(`UPDATE categorias SET nombre=?,descripcion=?,icono=?,color=?,orden=?,activa=?,parent_id=? WHERE id=?`)
    .run(nombre, descripcion||'', icono||'📄', color||'blue', orden||0, activa??1, parent_id||null, req.params.id);
  res.json({ ok: true });
});

app.delete('/api/categorias/:id', auth, role('admin'), (req, res) => {
  const cat = db.prepare('SELECT * FROM categorias WHERE id=?').get(req.params.id);
  if (!cat) return res.status(404).json({ error: 'No encontrada' });
  const n = db.prepare('SELECT COUNT(*) as n FROM modelos WHERE categoria_id=?').get(req.params.id).n;
  if (n > 0) return res.status(400).json({ error: `Tiene ${n} modelo(s). Reasígnalos primero.` });
  db.prepare('DELETE FROM categorias WHERE id=?').run(req.params.id);
  try { const d = path.join(FILES_DIR, sanitizeName(cat.nombre)); if (fs.existsSync(d)) fs.rmdirSync(d); } catch {}
  res.json({ ok: true });
});

app.get('/api/categorias/:id/archivos', auth, (req, res) => {
  const cat = db.prepare('SELECT nombre FROM categorias WHERE id=?').get(req.params.id);
  if (!cat) return res.status(404).json({ error: 'No encontrada' });
  const dir = path.join(FILES_DIR, sanitizeName(cat.nombre));
  if (!fs.existsSync(dir)) return res.json([]);
  res.json(fs.readdirSync(dir).map(f => {
    const s = fs.statSync(path.join(dir, f));
    return { nombre: f, tamaño: s.size, modificado: s.mtime };
  }));
});

// ─── PLANTILLAS ODT ───────────────────────────────────────────────────────────
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

// ─── MODELOS ──────────────────────────────────────────────────────────────────
app.get('/api/modelos', auth, (req, res) => {
  const { estado, categoria_id, q } = req.query;
  let sql = `SELECT m.*, c.nombre as categoria_nombre, c.icono as categoria_icono, c.color as categoria_color,
    u.nombre as owner_nombre, u2.nombre as updated_by_nombre
    FROM modelos m LEFT JOIN categorias c ON m.categoria_id=c.id
    LEFT JOIN users u ON m.owner_id=u.id LEFT JOIN users u2 ON m.updated_by=u2.id WHERE 1=1`;
  const p = [];
  if (estado)       { sql += ' AND m.estado=?';               p.push(estado); }
  if (categoria_id) { sql += ' AND m.categoria_id=?';         p.push(categoria_id); }
  if (q)            { sql += ' AND (m.nombre LIKE ? OR m.descripcion LIKE ?)'; p.push(`%${q}%`, `%${q}%`); }
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
  db.prepare('INSERT INTO actividad (modelo_id,user_id,accion) VALUES (?,?,?)').run(r.lastInsertRowid, req.user.id, 'creó el modelo');
  res.json({ id: r.lastInsertRowid });
});

app.put('/api/modelos/:id', auth, role('admin','editor'), (req, res) => {
  const { nombre, categoria_id, estado, descripcion, cuerpo, etiquetas } = req.body;
  db.prepare(`UPDATE modelos SET nombre=?,categoria_id=?,estado=?,descripcion=?,cuerpo=?,etiquetas=?,updated_by=?,updated_at=datetime('now') WHERE id=?`)
    .run(nombre, categoria_id||null, estado, descripcion, cuerpo, JSON.stringify(etiquetas||[]), req.user.id, req.params.id);
  db.prepare('INSERT INTO actividad (modelo_id,user_id,accion) VALUES (?,?,?)').run(req.params.id, req.user.id, 'guardó cambios');
  res.json({ ok: true });
});

app.delete('/api/modelos/:id', auth, role('admin'), (req, res) => {
  db.prepare('DELETE FROM modelos WHERE id=?').run(req.params.id);
  res.json({ ok: true });
});

// ─── EXPORT ODT (via Python) ──────────────────────────────────────────────────
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
    res.status(500).json({ error: 'Error guardando configuración' });
  }
});

app.get('/api/modelos/:id/export/odt', auth, async (req, res) => {
  const modelo = db.prepare(`SELECT m.*,c.nombre as categoria_nombre FROM modelos m
    LEFT JOIN categorias c ON m.categoria_id=c.id WHERE m.id=?`).get(req.params.id);
  if (!modelo) return res.status(404).json({ error: 'No encontrado' });

  // Determine template
  const plantillaId = req.query.plantilla_id;
  let templatePath = null;
  if (plantillaId) {
    const p = db.prepare('SELECT filename FROM plantillas WHERE id=?').get(plantillaId);
    if (p) templatePath = path.join(TEMPLATES_DIR, p.filename);
  } else {
    const def = db.prepare('SELECT filename FROM plantillas WHERE es_defecto=1 LIMIT 1').get();
    if (def) templatePath = path.join(TEMPLATES_DIR, def.filename);
  }

  // Prepare temp files
  const tmpId = `${Date.now()}_${modelo.id}`;
  const inputJson = path.join('/tmp', `${tmpId}_in.json`);
  const outputOdt = path.join('/tmp', `${tmpId}_out.odt`);

  const payload = {
    title: modelo.nombre,
    markdown: modelo.cuerpo,
    categoria: modelo.categoria_nombre || '',
    estilo_config: modelo.estilo_config ? JSON.parse(modelo.estilo_config) : {}
  };
  fs.writeFileSync(inputJson, JSON.stringify(payload));

  const args = [
    path.join(__dirname, 'scripts/export_odt.py'),
    inputJson, outputOdt
  ];
  if (templatePath && fs.existsSync(templatePath)) args.push(templatePath);

  try {
    await new Promise((resolve, reject) => {
      execFile('python3', args, { timeout: 30000 }, (err, stdout, stderr) => {
        if (err) { reject(new Error(stderr || err.message)); return; }
        resolve();
      });
    });

    const buf = fs.readFileSync(outputOdt);

    // Save copy in category folder
    if (modelo.categoria_nombre) {
      const dir = path.join(FILES_DIR, sanitizeName(modelo.categoria_nombre));
      if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(path.join(dir, `${sanitizeName(modelo.nombre)}_${Date.now()}.odt`), buf);
    }

    db.prepare('INSERT INTO actividad (modelo_id,user_id,accion) VALUES (?,?,?)').run(modelo.id, req.user.id, 'exportó a .odt');

    res.setHeader('Content-Type', 'application/vnd.oasis.opendocument.text');
    const filename = sanitizeForHeader(modelo.nombre || 'modelo') + '.odt';
    res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
    res.send(buf);
  } catch (e) {
    console.error('ODT export error:', e.message);
    res.status(500).json({ error: 'Error generando ODT: ' + e.message });
  } finally {
    [inputJson, outputOdt].forEach(f => { try { fs.unlinkSync(f); } catch {} });
  }
});

// ─── ACTIVIDAD ────────────────────────────────────────────────────────────────
app.post('/api/modelos/:id/actividad', auth, (req, res) => {
  db.prepare('INSERT INTO actividad (modelo_id,user_id,accion,detalle) VALUES (?,?,?,?)')
    .run(req.params.id, req.user.id, req.body.accion, req.body.detalle || null);
  res.json({ ok: true });
});

app.get('/api/health', (_, res) => res.json({ status: 'ok', version: '3.0.0' }));

app.listen(PORT, () => console.log(`Acuerdos API v3 — puerto ${PORT}`));
//---duplicar--------------------
app.post('/api/modelos/:id/duplicate', auth, role('admin','editor'), (req, res) => {
  const { nombre } = req.body;
  if (!nombre) return res.status(400).json({ error: 'Nombre requerido' });
  const original = db.prepare('SELECT * FROM modelos WHERE id=?').get(req.params.id);
  if (!original) return res.status(404).json({ error: 'No encontrado' });
  const r = db.prepare(`INSERT INTO modelos (nombre,categoria_id,estado,descripcion,cuerpo,etiquetas,owner_id,created_by,updated_by)
    VALUES (?,?,?,?,?,?,?,?,?)`)
    .run(nombre, original.categoria_id, 'borrador', original.descripcion,
         original.cuerpo, '[]', req.user.id, req.user.id, req.user.id);
  db.prepare('INSERT INTO actividad (modelo_id,user_id,accion,detalle) VALUES (?,?,?,?)')
    .run(r.lastInsertRowid, req.user.id, 'duplicó modelo', `desde modelo #${original.id}`);
  res.json({ id: r.lastInsertRowid });
});