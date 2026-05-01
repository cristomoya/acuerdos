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

// ─── Helper compartido para generar ODT ───────────────────────────────────────
async function _doExportOdt(req, res, plantillaId, camposObj) {
  const modelo = db.prepare(`SELECT m.*,c.nombre as categoria_nombre FROM modelos m
    LEFT JOIN categorias c ON m.categoria_id=c.id WHERE m.id=?`).get(req.params.id);
  if (!modelo) return res.status(404).json({ error: 'No encontrado' });

  // Determine template
  let templatePath = null;
  if (plantillaId) {
    const p = db.prepare('SELECT filename FROM plantillas WHERE id=?').get(plantillaId);
    if (p) templatePath = path.join(TEMPLATES_DIR, p.filename);
  } else {
    const def = db.prepare('SELECT filename FROM plantillas WHERE es_defecto=1 LIMIT 1').get();
    if (def) templatePath = path.join(TEMPLATES_DIR, def.filename);
  }

  // Sustituir campos {{CAMPO}} por los valores proporcionados
  let cuerpo = modelo.cuerpo || '';
  if (camposObj && typeof camposObj === 'object') {
    for (const [campo, valor] of Object.entries(camposObj)) {
      if (valor && String(valor).trim()) {
        const re = new RegExp(`\\{\\{${campo.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\}\\}`, 'g');
        cuerpo = cuerpo.replace(re, String(valor).trim());
      }
    }
  }

  // Prepare temp files
  const tmpId = `${Date.now()}_${modelo.id}`;
  const inputJson = path.join('/tmp', `${tmpId}_in.json`);
  const outputOdt = path.join('/tmp', `${tmpId}_out.odt`);

  const payload = {
    title: modelo.nombre,
    markdown: cuerpo,
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
}

// GET: exportar sin sustitución de campos (compatibilidad)
app.get('/api/modelos/:id/export/odt', auth, async (req, res) => {
  const plantillaId = req.query.plantilla_id || null;
  await _doExportOdt(req, res, plantillaId, null);
});

// POST: exportar con sustitución de campos {{ }} por valores del formulario
app.post('/api/modelos/:id/export/odt', auth, async (req, res) => {
  const { plantilla_id, campos } = req.body;
  await _doExportOdt(req, res, plantilla_id || null, campos || {});
});
