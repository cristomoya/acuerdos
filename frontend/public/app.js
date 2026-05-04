// ─── EXPORTACIÓN CON DIAGRAMAS ───────────────────────────────────────────────
// Reemplaza las funciones _doExport y doExportPdf existentes en app.js

/**
 * Convierte un SVG string a PNG base64 usando un canvas offscreen.
 * Devuelve solo la parte base64 (sin el prefijo data:image/png;base64,)
 */
function _svgToPng(svgString) {
  return new Promise((resolve) => {
    const parser = new DOMParser();
    const svgDoc = parser.parseFromString(svgString, 'image/svg+xml');
    const svgEl  = svgDoc.documentElement;

    // Intentar obtener dimensiones reales del SVG
    const vb = svgEl.getAttribute('viewBox');
    let w = parseFloat(svgEl.getAttribute('width'))  || 900;
    let h = parseFloat(svgEl.getAttribute('height')) || 450;
    if (vb) {
      const parts = vb.trim().split(/[\s,]+/);
      if (parts.length === 4) {
        w = parseFloat(parts[2]) || w;
        h = parseFloat(parts[3]) || h;
      }
    }

    // Escalar para mejor resolución en el documento
    const scale  = Math.min(2, 1800 / w);
    const canvas = document.createElement('canvas');
    canvas.width  = Math.round(w * scale);
    canvas.height = Math.round(h * scale);

    const ctx = canvas.getContext('2d');
    ctx.fillStyle = '#ffffff';
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    ctx.scale(scale, scale);

    const img  = new Image();
    const blob = new Blob([svgString], { type: 'image/svg+xml;charset=utf-8' });
    const url  = URL.createObjectURL(blob);

    img.onload = () => {
      ctx.drawImage(img, 0, 0);
      URL.revokeObjectURL(url);
      // Devolver solo base64, sin el prefijo
      resolve(canvas.toDataURL('image/png').split(',')[1]);
    };
    img.onerror = () => {
      URL.revokeObjectURL(url);
      console.warn('[diagram] No se pudo convertir SVG a PNG');
      resolve(null);
    };
    img.src = url;
  });
}

/**
 * Recorre el markdown buscando bloques ```mermaid``` y los renderiza
 * a PNG base64 usando la instancia global de mermaid.
 * Devuelve un objeto { "DIAGRAM_0": "<base64>", "DIAGRAM_1": "<base64>", ... }
 */
async function _extractDiagramsAsBase64(md) {
  const result  = {};
  const regex   = /```mermaid\n([\s\S]*?)```/g;
  let   match;
  let   idx = 0;

  while ((match = regex.exec(md)) !== null) {
    const code = match[1].trim();
    const key  = `DIAGRAM_${idx}`;
    idx++;

    try {
      const renderId = `export-mermaid-${Date.now()}-${idx}`;
      const { svg }  = await mermaid.render(renderId, code);
      const png      = await _svgToPng(svg);
      if (png) {
        result[key] = png;
      } else {
        console.warn(`[diagram] ${key}: SVG→PNG falló, se omitirá`);
      }
    } catch (e) {
      console.warn(`[diagram] ${key}: error al renderizar —`, e.message);
    }
  }

  return result;
}

/**
 * Exporta el modelo activo a .odt, incluyendo los diagramas pre-renderizados.
 * @param {number|null} plantillaId
 * @param {object}      camposObj   - Campos a sustituir
 */
async function _doExport(plantillaId, camposObj) {
  if (!activeId) return;

  const tplName = plantillaId
    ? (tpls.find(t => t.id === plantillaId)?.nombre || 'plantilla')
    : 'estilos por defecto';

  toast(`Generando .odt con ${tplName}…`, 5000);

  // 1. Renderizar todos los diagramas Mermaid del documento a PNG base64
  const md      = document.getElementById('e-body').value;
  const diagrams = await _extractDiagramsAsBase64(md);
  const nDiags  = Object.keys(diagrams).length;
  if (nDiags > 0) {
    console.log(`[diagram] ${nDiags} diagrama(s) renderizados para exportación`);
  }

  // 2. Llamar al backend
  const headers = {
    'Content-Type': 'application/json',
    ...(token ? { Authorization: `Bearer ${token}` } : {})
  };

  let res;
  try {
    res = await fetch(`/api/modelos/${activeId}/export/odt`, {
      method:  'POST',
      headers,
      body: JSON.stringify({
        plantilla_id: plantillaId,
        campos:       camposObj,
        diagrams      // ← se envían los PNG base64
      })
    });
  } catch (e) {
    toast('Error de red: ' + e.message);
    return;
  }

  if (!res.ok) {
    const err = await res.json().catch(() => ({ error: 'Error desconocido' }));
    toast('Error: ' + err.error);
    return;
  }

  const blob = await res.blob();
  const a    = document.createElement('a');
  a.href     = URL.createObjectURL(blob);
  a.download = (document.getElementById('e-name').value || 'modelo')
    .replace(/[/\\?%*:|"<>]/g, '_') + '.odt';
  a.click();
  URL.revokeObjectURL(a.href);
  toast('Exportado a .odt ✓');
  setTimeout(() => openModel(activeId), 800);
}

/**
 * Exporta el modelo activo a .pdf, incluyendo los diagramas pre-renderizados.
 * Se llama desde el botón "Generar .pdf" del modal de campos.
 */
async function doExportPdf() {
  if (!activeId) return;

  // Recoger campos del modal de exportación si está abierto
  const container = document.getElementById('ef-campos');
  const camposObj = {};
  if (container) {
    const campos = JSON.parse(container.dataset.campos || '[]');
    campos.forEach(campo => {
      const input = document.querySelector(`.ex-field[data-campo="${campo}"]`);
      if (input && input.value.trim()) camposObj[campo] = input.value.trim();
    });
  }

  toast('Generando .pdf…', 5000);

  // Renderizar diagramas
  const md      = document.getElementById('e-body').value;
  const diagrams = await _extractDiagramsAsBase64(md);

  closeModal('m-export-fields');

  const headers = {
    'Content-Type': 'application/json',
    ...(token ? { Authorization: `Bearer ${token}` } : {})
  };

  let res;
  try {
    res = await fetch(`/api/modelos/${activeId}/export/pdf`, {
      method:  'POST',
      headers,
      body: JSON.stringify({ campos: camposObj, diagrams })
    });
  } catch (e) {
    toast('Error de red: ' + e.message);
    return;
  }

  if (!res.ok) {
    const err = await res.json().catch(() => ({ error: 'Error desconocido' }));
    toast('Error PDF: ' + err.error);
    return;
  }

  const blob = await res.blob();
  const a    = document.createElement('a');
  a.href     = URL.createObjectURL(blob);
  a.download = (document.getElementById('e-name').value || 'modelo')
    .replace(/[/\\?%*:|"<>]/g, '_') + '.pdf';
  a.click();
  URL.revokeObjectURL(a.href);
  toast('Exportado a .pdf ✓');
  setTimeout(() => openModel(activeId), 800);
}
