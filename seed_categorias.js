/**
 * seed_categorias.js
 * Inserta la jerarquía de categorías para contratación administrativa.
 * Uso: node seed_categorias.js
 */

const Database = require('better-sqlite3');
const DB_PATH = process.env.DB_PATH || '/data/acuerdos.db';
const db = new Database(DB_PATH);

db.pragma('foreign_keys = ON');

const insertCat = db.prepare(`
  INSERT INTO categorias (nombre, descripcion, icono, color, orden, parent_id, activa, created_by)
  VALUES (@nombre, @descripcion, @icono, @color, @orden, @parent_id, 1, 1)
`);

function addRoot(nombre, descripcion, icono, color, orden) {
  return insertCat.run({ nombre, descripcion, icono, color, orden, parent_id: null }).lastInsertRowid;
}

function addSub(nombre, descripcion, icono, color, orden, parent_id) {
  return insertCat.run({ nombre, descripcion, icono, color, orden, parent_id }).lastInsertRowid;
}

const insert = db.transaction(() => {

  // ── 1. EXPEDIENTE DE CONTRATACIÓN ─────────────────────────────────────────
  const r1 = addRoot('Expediente de contratación',
    'Documentos de inicio y tramitación del expediente', '📁', 'blue', 1);
  addSub('Inicio y necesidad',      'Informes de necesidad, memorias justificativas y DNSH', '🚀', 'blue', 1, r1);
  addSub('Pliegos',                 'PCAP, PPT y documentos rectores del contrato',          '📄', 'blue', 2, r1);
  addSub('Licitación',              'Anuncios, convocatorias y documentos de la licitación', '🔔', 'blue', 3, r1);
  addSub('Adjudicación',            'Propuesta de adjudicación, informes de valoración y resolución', '✅', 'blue', 4, r1);
  addSub('Formalización',           'Contrato, acta de formalización y garantía definitiva', '✍️', 'blue', 5, r1);

  // ── 2. EJECUCIÓN DEL CONTRATO ─────────────────────────────────────────────
  const r2 = addRoot('Ejecución del contrato',
    'Documentos durante la ejecución del contrato', '⚙️', 'teal', 2);
  addSub('Inicio de la ejecución',  'Comprobación de replanteo, acta de inicio y programa de trabajos', '▶️', 'teal', 1, r2);
  addSub('Certificaciones',         'Certificaciones de obra, facturas e informes de conformidad',      '📊', 'teal', 2, r2);
  addSub('Modificaciones',          'Modificados, adicionales y complementarios',                       '🔄', 'teal', 3, r2);
  addSub('Prórrogas',               'Solicitudes y resoluciones de prórroga',                           '⏳', 'teal', 4, r2);
  addSub('Subcontratación',         'Autorizaciones y comunicaciones de subcontratación',               '👥', 'teal', 5, r2);

  // ── 3. FINALIZACIÓN ───────────────────────────────────────────────────────
  const r3 = addRoot('Finalización del contrato',
    'Recepción, liquidación y garantías', '🏁', 'green', 3);
  addSub('Recepción',               'Actas de recepción y conformidad',                  '📋', 'green', 1, r3);
  addSub('Liquidación',             'Informe de liquidación y liquidación económica',    '💶', 'green', 2, r3);
  addSub('Devolución de garantías', 'Solicitudes y resoluciones de devolución',          '🔓', 'green', 3, r3);

  // ── 4. INCIDENCIAS ────────────────────────────────────────────────────────
  const r4 = addRoot('Incidencias',
    'Documentos ante situaciones excepcionales durante el contrato', '⚠️', 'amber', 4);
  addSub('Fuerza mayor',            'Informes, actas y resoluciones de indemnización por fuerza mayor', '🌪️', 'amber', 1, r4);
  addSub('Penalidades',             'Informes de incumplimiento y resoluciones de penalidad',           '🚫', 'amber', 2, r4);
  addSub('Suspensión',              'Actas de suspensión y reanudación del contrato',                   '⏸️', 'amber', 3, r4);
  addSub('Resolución del contrato', 'Expedientes y resoluciones de resolución anticipada',              '❌', 'amber', 4, r4);

  // ── 5. RECURSOS Y RECLAMACIONES ───────────────────────────────────────────
  const r5 = addRoot('Recursos y reclamaciones',
    'Recursos especiales, reclamaciones y cuestiones de nulidad', '⚖️', 'purple', 5);
  addSub('Recurso especial',        'Recursos especiales en materia de contratación (TACRC/TACPA)',     '📨', 'purple', 1, r5);
  addSub('Reclamaciones',           'Reclamaciones de daños, perjuicios e indemnizaciones',             '📩', 'purple', 2, r5);
  addSub('Cuestiones de nulidad',   'Expedientes de nulidad contractual',                              '🔴', 'purple', 3, r5);

  // ── 6. DOCUMENTACIÓN TRANSVERSAL ──────────────────────────────────────────
  const r6 = addRoot('Documentación transversal',
    'Documentos comunes a cualquier tipo o fase del contrato', '📜', 'red', 6);
  addSub('Informes jurídicos',      'Informes de la asesoría jurídica',                  '⚖️', 'red', 1, r6);
  addSub('Informes técnicos',       'Informes del director de obra o responsable técnico','🔧', 'red', 2, r6);
  addSub('Notificaciones',          'Notificaciones a contratistas e interesados',        '📬', 'red', 3, r6);
  addSub('Actas',                   'Actas de reuniones, mesas de contratación y juntas', '📝', 'red', 4, r6);
  addSub('Decretos y resoluciones', 'Decretos de alcaldía y resoluciones administrativas','🏛️', 'red', 5, r6);

});

try {
  insert();
  const total = db.prepare('SELECT COUNT(*) as n FROM categorias').get();
  console.log(`✓ Categorías insertadas. Total en BD: ${total.n}`);
  
  // Show summary
  const roots = db.prepare(`SELECT c.nombre, COUNT(s.id) as subs 
    FROM categorias c LEFT JOIN categorias s ON s.parent_id = c.id 
    WHERE c.parent_id IS NULL GROUP BY c.id ORDER BY c.orden`).all();
  roots.forEach(r => console.log(`  ${r.nombre}: ${r.subs} subcategorías`));
} catch(e) {
  console.error('Error:', e.message);
}
