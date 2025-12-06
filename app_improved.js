
// app_improved.js - Enhanced BC3 parser: preserves record order, builds T-tree, attaches C records in original order,
// parses M records and associates mediciones, evaluates simple arithmetic expressions safely for quantities,
// and exports CSV with partidas including computed totals.

const fileInput = document.getElementById('fileInput');
const status = document.getElementById('status');
const treeContainer = document.getElementById('treeContainer');
const summary = document.getElementById('summary');
const treeSection = document.getElementById('tree');
const detailSection = document.getElementById('detail');
const detailContent = document.getElementById('detailContent');
const backTree = document.getElementById('backTree');
const exampleBtn = document.getElementById('exampleBtn');
const exportCsvBtn = document.getElementById('exportCsv');

let lastParsed = null;

fileInput.addEventListener('change', async (e) => {
  const f = e.target.files[0];
  if (!f) return;
  status.textContent = `Leyendo ${f.name}...`;
  const buf = await f.arrayBuffer();
  let text;
  try {
    text = new TextDecoder('utf-8').decode(buf);
    if (!text.includes('~')) throw 'no-tilde';
  } catch(_) {
    text = new TextDecoder('iso-8859-1').decode(buf);
  }
  parseBC3(text);
});

function parseBC3(text) {
  // Normalize newlines
  text = text.replace(/\r\n/g,'\n').replace(/\r/g,'\n');
  const lines = text.split('\n');
  // Group into logical records: start with ~, include following lines starting with backslash or not starting with ~
  const records = [];
  let current = null;
  for (let i=0;i<lines.length;i++) {
    const ln = lines[i];
    if (ln.startsWith('~')) {
      if (current) records.push(current);
      current = ln;
    } else {
      if (current === null) {
        if (ln.trim()==='') continue;
        current = ln;
      } else {
        current += '\n' + ln;
      }
    }
  }
  if (current) records.push(current);

  // parse records into objects with tag, fields array and raw text, keep original index
  const parsed = records.map((r, idx) => {
    const m = r.match(/^~([A-Z0-9_]+)\|(.*)$/s);
    if (!m) return {tag: null, fields: [], raw: r, index: idx};
    const tag = m[1];
    const rest = m[2];
    const fields = rest.split('|');
    return {tag, fields, raw: r, index: idx};
  });

  // Build lists preserving order
  const Tlist = parsed.filter(p => p.tag==='T');
  const Clist = parsed.filter(p => p.tag==='C');
  const Llist = parsed.filter(p => p.tag==='L');
  const Mlist = parsed.filter(p => p.tag==='M');
  const Dlist = parsed.filter(p => p.tag==='D');

  // Build T-tree preserving Tlist order
  const Tnodes = Tlist.map(t => {
    const code = (t.fields[0]||'').trim();
    const title = (t.fields[1]||'').trim();
    return {code, title, children: [], partidas: [], _index: t.index};
  });

  const norm = s => s ? s.replace('#','').trim() : s;
  // attach children for dotted codes
  for (let i=0;i<Tnodes.length;i++) {
    const node = Tnodes[i];
    const nodeCode = norm(node.code);
    if (nodeCode.includes('.')) {
      const parentPrefix = nodeCode.substring(0, nodeCode.lastIndexOf('.'));
      for (let j=i-1;j>=0;j--) {
        if (norm(Tnodes[j].code) === parentPrefix) {
          Tnodes[j].children.push(node);
          node._parent = Tnodes[j];
          break;
        }
      }
    }
  }
  const roots = Tnodes.filter(n => !n._parent);

  const Tlookup = {};
  for (const n of Tnodes) Tlookup[norm(n.code)] = n;

  // Prepare partidas in file order
  const partidas = Clist.map(c => {
    const code = (c.fields[0]||'').trim();
    const unidad = (c.fields[1]||'').trim();
    const descripcion = (c.fields[2]||'').trim();
    const precio = (c.fields[3]||'').trim();
    return {code, unidad, descripcion, precio, mediciones: [], _index: c.index};
  });

  // Attachment strategy
  function numericPrefix(s) {
    const m = s.match(/^[0-9]+(\.[0-9]+)*/);
    return m? m[0] : null;
  }

  for (const p of partidas) {
    let attached = false;
    const pCode = p.code;
    if (Tlookup[pCode]) {
      Tlookup[pCode].partidas.push(p);
      attached = true;
    } else {
      let best = null, bestLen = 0;
      for (const t of Tnodes) {
        const tcode = norm(t.code);
        if (!tcode) continue;
        if (pCode.startsWith(tcode) && tcode.length>bestLen) {
          best = t; bestLen = tcode.length;
        }
      }
      if (best) { best.partidas.push(p); attached = true; }
      else {
        const pnum = numericPrefix(pCode);
        if (pnum) {
          for (const t of Tnodes) {
            const tnum = numericPrefix(norm(t.code)||'');
            if (tnum && pCode.startsWith(tnum)) { t.partidas.push(p); attached = true; break; }
          }
        }
      }
    }
    if (!attached) {
      roots.push({code: p.code, title: p.descripcion||p.code, children: [], partidas: [p], _index: p._index});
    }
  }

  // associate M records
  const partidaCodes = partidas.map(p=>p.code).sort((a,b)=>b.length-a.length);
  for (const m of Mlist) {
    const raw = m.raw;
    let found = null;
    for (const pc of partidaCodes) {
      if (pc && raw.includes(pc)) { found = pc; break; }
    }
    if (!found) {
      for (const f of m.fields) {
        for (const pc of partidaCodes) {
          if (f.includes(pc)) { found = pc; break; }
        }
        if (found) break;
      }
    }
    if (!found) continue;
    // find numeric-like tokens and simple expressions
    const exprMatches = raw.match(/(?:\d+[.,]?\d*(?:\*\d+[.,]?\d*)+(?:\/\d+[.,]?\d*)?)/g) || [];
    const numMatches = raw.match(/[-+]?\d+[.,]?\d*/g) || [];
    let candidate = null;
    function evalSafe(s) {
      const safe = s.replace(',', '.').replace(/[^0-9\.\*\+\/\-\(\)]/g, '');
      try { const fn = new Function('return ('+safe+')'); const v = fn(); if (typeof v==='number' && isFinite(v)) return v; } catch(e){}
      return null;
    }
    if (exprMatches.length) {
      for (const ex of exprMatches) {
        const v = evalSafe(ex);
        if (v!==null) { candidate = v; break; }
      }
    }
    if (candidate===null && numMatches.length) {
      const last = numMatches[numMatches.length-1].replace(',','.');
      candidate = parseFloat(last);
    }
    // also check fields for numeric
    if ((candidate===null) && m.fields) {
      for (const f of m.fields) {
        const fn = f.replace(',','.').trim();
        if (/^-?\d+(\.\d+)?$/.test(fn)) { candidate = parseFloat(fn); break; }
      }
    }
    if (candidate===null) continue;
    const partidaObj = partidas.find(p=>p.code===found);
    if (partidaObj) partidaObj.mediciones.push({raw:m.raw,total:candidate,fields:m.fields});
    else {
      for (const r of roots) {
        for (const p of r.partidas) {
          if (p.code===found) { p.mediciones.push({raw:m.raw,total:candidate,fields:m.fields}); break; }
        }
      }
    }
  }

  lastParsed = {roots, counts:{T:Tlist.length, C:Clist.length, M:Mlist.length}};
  renderTree();
  status.textContent = `Parseado: ${lastParsed.counts.C} partidas, ${lastParsed.counts.T} títulos.`;
}

function renderTree() {
  treeSection.classList.remove('hidden'); detailSection.classList.add('hidden');
  treeContainer.innerHTML = ''; summary.innerHTML = `<div class="sectionCard">Resumen: ${lastParsed.counts.C} partidas • ${lastParsed.counts.T} títulos</div>`;
  lastParsed.roots.sort((a,b)=>(a._index||0)-(b._index||0));
  for (const ch of lastParsed.roots) {
    const el = document.createElement('div'); el.className='node';
    const left = document.createElement('div');
    left.innerHTML = `<strong>${ch.title || ch.code}</strong><div><small class="codeTag">${ch.code}</small> · ${ch.children.length} sub · ${ch.partidas.length} partidas</div>`;
    const right = document.createElement('div');
    const view = document.createElement('button'); view.textContent='Ver'; view.className='button'; view.onclick=()=>showChapter(ch);
    right.appendChild(view); el.appendChild(left); el.appendChild(right); treeContainer.appendChild(el);
  }
}

function showChapter(ch) {
  treeSection.classList.add('hidden'); detailSection.classList.remove('hidden');
  detailContent.innerHTML = `<h2>${ch.title || ch.code}</h2>`;
  if (ch.children && ch.children.length) {
    const h = document.createElement('h3'); h.textContent='Subcapítulos'; detailContent.appendChild(h);
    for (const s of ch.children) {
      const node = document.createElement('div'); node.className='node';
      node.innerHTML = `<div><strong>${s.title}</strong><div><small class="codeTag">${s.code}</small> · ${s.partidas.length} partidas</div></div>`;
      node.onclick = ()=> showChapter(s); detailContent.appendChild(node);
    }
  }
  if (ch.partidas && ch.partidas.length) {
    const h2 = document.createElement('h3'); h2.textContent='Partidas'; detailContent.appendChild(h2);
    ch.partidas.sort((a,b)=>(a._index||0)-(b._index||0));
    for (const p of ch.partidas) {
      const node = document.createElement('div'); node.className='node';
      node.innerHTML = `<div><strong>${p.descripcion || p.code}</strong><div><small class="codeTag">${p.code}</small> · ${p.unidad || ''} · Precio: ${p.precio || ''}</div></div><div><button class="button">Detalle</button></div>`;
      node.querySelector('button').onclick = (ev)=>{ ev.stopPropagation(); showPartida(p); };
      detailContent.appendChild(node);
    }
  }
  if (exportCsvBtn) exportCsvBtn.onclick = ()=> exportCSVForChapter(ch);
}

function showPartida(p) {
  detailContent.innerHTML = `<button id="backToChapter" class="backlink">← Volver</button><h2>${p.descripcion||p.code}</h2>`;
  let html = `<div class="sectionCard"><strong>Código:</strong> <span class="codeTag">${p.code}</span><br>`;
  html += `<strong>Unidad:</strong> ${p.unidad||''}<br><strong>Precio:</strong> ${p.precio||''}<br>`;
  const total = (p.mediciones||[]).reduce((s,m)=>s+(m.total||0),0);
  html += `<strong>Cantidad total:</strong> ${total}<br>`;
  const precioNum = parseFloat((p.precio||'').replace(',','.'))||0;
  html += `<strong>Importe estimado:</strong> ${ (precioNum && total)? ( (precioNum*total).toFixed(2) ) : 'N/D' }</div>`;
  if (p.mediciones && p.mediciones.length) {
    html += `<h3>Mediciones</h3>`;
    for (const m of p.mediciones) {
      html += `<div class="node"><div><strong>Detalle</strong><div><small class="codeTag">total: ${m.total} — campos: ${m.fields.slice(0,5).join(', ')}</small></div></div></div>`;
    }
  }
  detailContent.innerHTML += html;
  document.getElementById('backToChapter').onclick = ()=>{ renderTree(); detailSection.classList.add('hidden'); treeSection.classList.remove('hidden'); };
}

function exportCSVForChapter(ch) {
  const rows = [];
  rows.push(['Capítulo','CódigoCapítulo','CódigoPartida','Descripción','Unidad','CantidadTotal','PrecioUnitario','ImporteEstimado']);
  for (const p of (ch.partidas||[])) {
    const total = (p.mediciones||[]).reduce((s,m)=>s+(m.total||0),0);
    const precioNum = parseFloat((p.precio||'').replace(',','.'))||0;
    const importe = (precioNum && total)? (precioNum*total).toFixed(2) : '';
    rows.push([ch.title||'', ch.code||'', p.code||'', p.descripcion||'', p.unidad||'', total, precioNum||'', importe]);
  }
  const csv = rows.map(r=>r.map(cell=>`"${String(cell).replace(/"/g,'""')}"`).join(',')).join('\r\n');
  const blob = new Blob([csv], {type:'text/csv;charset=utf-8;'});
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `bc3_partidas_${(ch.code||'chapter')}.csv`;
  document.body.appendChild(a); a.click(); a.remove();
  URL.revokeObjectURL(url);
}

backTree.addEventListener('click', ()=>{ detailSection.classList.add('hidden'); treeSection.classList.remove('hidden'); });
exampleBtn.addEventListener('click', ()=>{ if (!lastParsed) { status.textContent='Carga un .bc3 primero.'; return; } renderTree(); });
