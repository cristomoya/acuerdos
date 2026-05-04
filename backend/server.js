// ─── ODT / PDF EXPORT HELPERS ────────────────────────────────────────────────
// Sustituye TODA la sección de export en server.js
// (desde "_buildTipoMap" hasta el final de las rutas de export)

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

/**
 * Genera el buffer ODT para un modelo dado.
 * @param {object} modelo    - Fila del modelo con categoria_nombre
 * @param {object} camposObj - Mapa campo→valor para sustitución
 * @param {*}      plantillaId
 * @param {object} diagrams  - Mapa {"DIAGRAM_0": "<base64png>", ...}
 */
async function _generateOdtBuffer(modelo, camposObj, plantillaId, diagrams = {}) {
  // Resolver ruta de plantilla
  let templatePath = null;
  if (plantillaId) {
    const p = db.prepare('SELECT filename FROM plantillas WHERE id=?').get(plantillaId);
    if (p) templatePath = path.join(TEMPLATES_DIR, p.filename);
  } else {
    const def = db.prepare('SELECT filename FROM plantillas WHERE es_defecto=1 LIMIT 1').get();
    if (def) templatePath = path.join(TEMPLATES_DIR, def.filename);
  }

  // Sustituir campos con formato
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

  // Ficheros temporales
  const tmpId = `${Date.now()}_${modelo.id}_${Math.random().toString(36).slice(2, 7)}`;
  const tmpDir = os.tmpdir();
  const inputJson = path.join(tmpDir, `${tmpId}_in.json`);
  const outputOdt = path.join(tmpDir, `${tmpId}_out.odt`);

  const payload = {
    title:        modelo.nombre,
    markdown:     cuerpo,
    categoria:    modelo.categoria_nombre || '',
    estilo_config: modelo.estilo_config ? JSON.parse(modelo.estilo_config) : {},
    diagrams:     diagrams || {},   // ← diagramas pre-renderizados desde el cliente
    meta: {
      title:   modelo.nombre,
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

/**
 * Handler compartido para exportar un modelo a ODT y enviarlo como respuesta.
 */
async function _doExportOdt(req, res, plantillaId, camposObj, diagrams = {}) {
  const modelo = db.prepare(`
    SELECT m.*, c.nombre as categoria_nombre
    FROM modelos m
    LEFT JOIN categorias c ON m.categoria_id = c.id
    WHERE m.id = ?
  `).get(req.params.id);

  if (!modelo) return res.status(404).json({ error: 'No encontrado' });

  try {
    const buf = await _generateOdtBuffer(modelo, camposObj, plantillaId, diagrams);

    // Guardar copia en carpeta de categoría
    if (modelo.categoria_nombre) {
      const dir = path.join(FILES_DIR, sanitizeName(modelo.categoria_nombre));
      if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(path.join(dir, `${sanitizeName(modelo.nombre)}_${Date.now()}.odt`), buf);
    }

    db.prepare('INSERT INTO actividad (modelo_id,user_id,accion) VALUES (?,?,?)')
      .run(modelo.id, req.user.id, 'exportó a .odt');

    res.setHeader('Content-Type', 'application/vnd.oasis.opendocument.text');
    res.setHeader('Content-Disposition', `attachment; filename="${_buildOdtFilename(modelo.nombre, camposObj)}"`);
    res.send(buf);
  } catch (e) {
    console.error('ODT export error:', e.message);
    res.status(500).json({ error: 'Error generando ODT: ' + e.message });
  }
}

// ─── RUTAS DE EXPORTACIÓN ────────────────────────────────────────────────────

// GET: compatibilidad — sin campos ni diagramas
app.get('/api/modelos/:id/export/odt', auth, async (req, res) => {
  const plantillaId = req.query.plantilla_id || null;
  await _doExportOdt(req, res, plantillaId, {}, {});
});

// POST: con campos y diagramas pre-renderizados
app.post('/api/modelos/:id/export/odt', auth, async (req, res) => {
  const { plantilla_id, campos, diagrams } = req.body;
  await _doExportOdt(req, res, plantilla_id || null, campos || {}, diagrams || {});
});

// POST: exportar a PDF con campos y diagramas
app.post('/api/modelos/:id/export/pdf', auth, async (req, res) => {
  const { campos, diagrams } = req.body;
  await _doExportPdf(req, res, campos || {}, diagrams || {});
});

// POST: exportar múltiples modelos como ZIP de ODTs
app.post('/api/export/batch-odt', auth, async (req, res) => {
  const { ids, campos, plantilla_id, diagrams } = req.body;
  if (!Array.isArray(ids) || ids.length === 0)
    return res.status(400).json({ error: 'Se requiere al menos un modelo' });
  if (ids.length > 50)
    return res.status(400).json({ error: 'Máximo 50 modelos por lote' });

  res.setHeader('Content-Type', 'application/zip');
  const dateStr = new Date().toISOString().slice(0, 10);
  res.setHeader('Content-Disposition', `attachment; filename="modelos_${dateStr}.zip"`);

  const archive = archiver('zip', { zlib: { level: 6 } });
  archive.on('error', err => console.error('Archiver error:', err));
  archive.pipe(res);

  const usedNames = new Set();
  for (const id of ids) {
    try {
      const modelo = db.prepare(`
        SELECT m.*, c.nombre as categoria_nombre
        FROM modelos m
        LEFT JOIN categorias c ON m.categoria_id = c.id
        WHERE m.id = ?
      `).get(id);
      if (!modelo) continue;

      // En batch no hay diagramas pre-renderizados por el cliente;
      // se pasan los recibidos en el body (pueden ser vacíos)
      const buf = await _generateOdtBuffer(modelo, campos || {}, plantilla_id || null, diagrams || {});
      let filename = _buildOdtFilename(modelo.nombre, campos || {});
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

// ─── EXPORT PDF (helper) ──────────────────────────────────────────────────────

async function _doExportPdf(req, res, camposObj, diagrams = {}) {
  const modelo = db.prepare(`
    SELECT m.*, c.nombre as categoria_nombre
    FROM modelos m
    LEFT JOIN categorias c ON m.categoria_id = c.id
    WHERE m.id = ?
  `).get(req.params.id);

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
    title:    modelo.nombre,
    markdown: cuerpo,
    categoria: modelo.categoria_nombre || '',
    diagrams:  diagrams || {}    // ← diagramas pre-renderizados
  };
  fs.writeFileSync(inputJson, JSON.stringify(payload));

  try {
    const pythonBin = process.env.PYTHON_BIN || (process.platform === 'win32' ? 'python' : 'python3');
    await new Promise((resolve, reject) => {
      execFile(pythonBin, [
        path.join(__dirname, 'scripts/export_pdf.py'),
        inputJson, outputPdf
      ], { timeout: 30000 }, (err, _stdout, stderr) => {
        if (err) { reject(new Error(stderr || err.message)); return; }
        resolve();
      });
    });

    const buf = fs.readFileSync(outputPdf);
    db.prepare('INSERT INTO actividad (modelo_id,user_id,accion) VALUES (?,?,?)')
      .run(modelo.id, req.user.id, 'exportó a .pdf');
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `attachment; filename="${sanitizeForHeader(modelo.nombre || 'modelo')}.pdf"`);
    res.send(buf);
  } catch (e) {
    console.error('PDF export error:', e.message);
    res.status(500).json({ error: 'Error generando PDF: ' + e.message });
  } finally {
    [inputJson, outputPdf].forEach(f => { try { fs.unlinkSync(f); } catch {} });
  }
}
