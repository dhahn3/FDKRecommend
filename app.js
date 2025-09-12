
const B = id => document.getElementById(id);
const banner=()=>B('banner');
const normCap = c => String(c||'').trim().toUpperCase();
const trailing = s => String(s||'').match(/(\d{3})$/)?.[1]||null;


// Cross-staffing groups: only one in a group may be staffed at a time
const CROSS_STAFF_GROUPS = [
  ['E11','TW1'], // Station 901 cross-staff
];

function partnerUnits(u){
  for(const g of CROSS_STAFF_GROUPS){
    if(g.includes(u)) return g.filter(x=>x!==u);
  }
  return [];
}

function updateCrossStaffStatuses(){
  for(const g of CROSS_STAFF_GROUPS){
    const anyCall = g.some(u => (STATUS.get(u) || DATA?.UNIT_STATUS?.[u] || 'AQ') === 'CALL');
    if(anyCall){
      g.forEach(u => {
        const st = STATUS.get(u) || DATA?.UNIT_STATUS?.[u] || 'AQ';
        if(st !== 'CALL'){ STATUS.set(u, 'US'); }
      });
    }else{
      g.forEach(u => {
        const def = DEFAULT_STATUS.get(u) || DATA?.UNIT_STATUS?.[u] || 'AQ';
        const st = STATUS.get(u) || def;
        if(st === 'US'){ STATUS.set(u, def); }
      });
    }
  }
  // reflect in status UI if open
  try{
    document.querySelectorAll('#statusGrid select[data-unit]').forEach(sel=>{
      const u = sel.dataset.unit;
      sel.value = STATUS.get(u) || DATA?.UNIT_STATUS?.[u] || 'AQ';
    });
  }catch(e){}
}
let DATA=null, MAP, MARKER, CURRENT_ESZ=null;
const STATUS=new Map(), DEFAULT_STATUS=new Map(), USER_CAPS=new Map();

window.addEventListener('error',e=>{ if(banner()){banner().className='warn'; banner().textContent='JS error: '+(e.message||e);}});
window.addEventListener('unhandledrejection',e=>{ if(banner()){banner().className='warn'; banner().textContent='Promise error: '+(e.reason?.message||e.reason||e);}});

function mutualAidEnabled(){ return B('mutualAid').checked; }
function isAvailable(u){
  const st = (STATUS.get(u) || DATA?.UNIT_STATUS?.[u] || 'AQ');
  if(st !== 'AQ') return false;
  // partner on call => unavailable staffing
  for(const p of partnerUnits(u)){
    const pst = (STATUS.get(p) || DATA?.UNIT_STATUS?.[p] || 'AQ');
    if(pst === 'CALL') return false;
  }
  return true;
}
function effectiveCaps(u){ const base= new Set((DATA?.UNIT_CAPS?.[u]||[]).map(normCap)); if(USER_CAPS.has(u)) for(const c of USER_CAPS.get(u)) base.add(normCap(c)); return [...base]; }
function isStationAllowed(st){ if(mutualAidEnabled()) return true; const d=trailing(st); return d?d[0]==='9':false; }
function stationUnits(st){ const s=String(st||'').toUpperCase(); const d=trailing(s); const a=(DATA?.STATION_UNITS?.[s])||[]; const b=d?((DATA?.STATION_UNITS?.[d])||[]):[]; return [...new Set([...a,...b])]; }

function setESZ(key){
  CURRENT_ESZ = key;
  B('esz').textContent = key || '—';
  const order = (DATA?.ESZ_ORDER?.[key]) || DATA?.GLOBAL_ORDER || [];
  B('stationOrder').textContent = order.length ? `Station order: ${order.join(' → ')}` : 'Station order: (none)';
}

function pill(text){ const s=document.createElement('span'); s.className='pill blue'; s.textContent=text; return s; }
function row(cap, arr){ const d=document.createElement('div'); d.style.margin='10px 0'; const h=document.createElement('div'); h.textContent = cap+':'; d.appendChild(h); const box=document.createElement('div'); box.className='pills'; arr.forEach(t=>box.appendChild(pill(t))); d.appendChild(box); return d; }

// SU preference only for BLS at stations 909, 921, 913
const SU_PREF = new Set(['909','921','913']);

function buildCandidatesByOrder(order, caps, used){
  const want = (caps||[]).map(normCap);
  const out=[];
  order.forEach((st, idx)=>{
    if(!isStationAllowed(st)) return;
    let units = stationUnits(st);
    // Prefer SU for BLS in specific stations
    const onlyBLS = want.length===1 && want[0]==='BLS';
    const d = trailing(st);
    if(onlyBLS && SU_PREF.has(d||st)){
      const su = units.filter(u=>/^SU\d+$/i.test(u));
      const rest = units.filter(u=>!/^SU\d+$/i.test(u));
      units = su.concat(rest);
    }
    for(const u of units){
      if(used?.has(u)) continue;
      if(!isAvailable(u)) continue;
      const capsU = effectiveCaps(u);
      for(const c of want){ if(capsU.includes(c)){ out.push({unit:u, cap:c, rank:idx, st}); } }
    }
  });
  out.sort((a,b)=>a.rank-b.rank);
  return out;
}
function pickForCap(cap, order, used){ return buildCandidatesByOrder(order, [cap], used)[0] || null; }

// Add DDK for K and DD for E (if earlier than first K/E) and backfill an extra K/E
function maybeAddDD(out, order, used){
  const ix = out.findIndex(x=>x.cap==='E');
  if(ix<0) return;
  const first = out[ix];
  const adds = buildCandidatesByOrder(order, ['DD'], used).filter(x=>x.rank<first.rank);
  for(const d of adds){
    if(!out.some(x=>x.unit===d.unit)){ out.push(d); used.add(d.unit); }
    const next = pickForCap('E', order, used);
    if(next){ out.push(next); used.add(next.unit); }
  }
}
function maybeAddDDK(out, order, used){
  const ix = out.findIndex(x=>x.cap==='K');
  if(ix<0) return;
  const first = out[ix];
  const adds = buildCandidatesByOrder(order, ['DDK'], used).filter(x=>x.rank<first.rank);
  for(const d of adds){
    if(!out.some(x=>x.unit===d.unit)){ out.push(d); used.add(d.unit); }
    const next = pickForCap('K', order, used);
    if(next){ out.push(next); used.add(next.unit); }
  }
}

// HM33 rule (skip for ESZ "50xx" unless need >1 HM)
function enforceHM33(out, eszKey, used){
  const needHM = out.some(x=>x.cap==='HM');
  if(!needHM) return;
  if(String(eszKey||'').startsWith('50')) return;
  if(DATA?.UNIT_CAPS?.HM33 && isAvailable('HM33') && effectiveCaps('HM33').includes('HM')){
    if(!out.some(x=>x.unit==='HM33')){
      out.push({unit:'HM33', cap:'HM', rank:-1, st:'FIRE/033'});
      used.add('HM33');
    }
  }
}

// 911/924 and 910/930 BLS suppression

function enforceCrossStaffOnResult(list, sequence){
  for(const g of CROSS_STAFF_GROUPS){
    const picks = list.filter(it => g.includes(it.unit));
    if(picks.length >= 2){
      picks.sort((a,b)=>{
        const ia = sequence.indexOf(normCap(a.cap));
        const ib = sequence.indexOf(normCap(b.cap));
        if(ia !== ib) return ia - ib;
        return (a.rank||999) - (b.rank||999);
      });
      for(const p of picks.slice(1)){
        const i = list.indexOf(p);
        if(i >= 0) list.splice(i,1);
      }
    }
  }
  return list;
}
function suppressBLSPairing(out){
  const aUnits = new Set(out.filter(x=>x.cap==='A').map(x=>x.unit));
  const sup = new Set();
  if([...aUnits].some(u=>/^(A)?924|^A?29/.test(u))) sup.add('911');
  if([...aUnits].some(u=>/^(A)?930|^A?30/.test(u))) sup.add('910');
  if(!sup.size) return out;
  return out.filter(x=>!(x.cap==='BLS' && [...sup].some(s=>x.unit.includes(s))));
}

function runRecommend(){
  const dbg=[]; const res=[]; const used=new Set();
  const planKey = B('incident').value;
  const basePlan = DATA?.PLAN_STRUCT?.[planKey];
  const eszKey = CURRENT_ESZ || Object.keys(DATA.ESZ_ORDER||{})[0];
  let plan = basePlan;
  if((DATA?.NON_HYDRANT_ESZ||[]).includes(eszKey) && DATA?.PLAN_NH_OVERRIDES?.[planKey]){
    plan = DATA.PLAN_NH_OVERRIDES[planKey];
    dbg.push('(NON‑HYDRAN) using override plan');
  }
  if(!plan){ throw new Error('No plan for '+planKey); }
  const order = (DATA?.ESZ_ORDER?.[eszKey]) || DATA?.GLOBAL_ORDER || [];
  if(!order.length){ throw new Error('No station order for ESZ '+eszKey); }

  // Expand the plan into a capability sequence in the given order
  const sequence=[];
  (plan.groups||[]).forEach(g=>{
    const wants=(g.caps||[]).map(normCap);
    for(let i=0;i<(Number(g.qty)||1);i++){
      // OR: choose earlier-in-order
      if(wants.length>1){
        const cands = buildCandidatesByOrder(order, wants, used);
        const best = cands[0];
        sequence.push(best?best.cap:wants[0]);
      }else{
        sequence.push(wants[0]);
      }
    }
  });

  // Base picks
  for(const cap of sequence){
    const pick = pickForCap(cap, order, used);
    if(pick){ res.push(pick); used.add(pick.unit); dbg.push(`pick ${cap}: ${pick.unit} @ ${pick.st}`); }
    else dbg.push(`(need ${cap})`);
  }
  // IfCloser additions (add-on, not replacement)
  for(const cap of (plan.ifCloser||[]).map(normCap)){
    const add = pickForCap(cap, order, used);
    if(add){ res.push(add); used.add(add.unit); dbg.push(`ifCloser ${cap}: ${add.unit}`); }
    else dbg.push(`(ifCloser need ${cap})`);
  }

  // Special add-ons & filters
  maybeAddDD(res, order, used);
  maybeAddDDK(res, order, used);
  enforceHM33(res, eszKey, used);
  let res2 = suppressBLSPairing(res);
  res2 = enforceCrossStaffOnResult(res2, sequence);

  // Group by capability in plan order for display
  const groupsDisplay = {};
  sequence.concat((plan.ifCloser||[]).map(normCap)).forEach(c=>{groupsDisplay[c]=groupsDisplay[c]||[];});
  for(const r of res2){ (groupsDisplay[r.cap]=groupsDisplay[r.cap]||[]).push(r.unit); }

  B('rec').innerHTML='';
  B('planTxt').textContent = 'Plan: '+(plan.groups||[]).map(g=>`${g.qty}× ${g.caps.join(' OR ')}`).join(', ')+((plan.ifCloser||[]).length?` — If closer: ${(plan.ifCloser||[]).join(', ')}`:'');
  Object.entries(groupsDisplay).forEach(([cap,units])=>{ if(units?.length) B('rec').appendChild(row(cap,units)); });
  B('dbg').textContent = dbg.join('\n');
}

function sendDispatch(){
  const units = [...document.querySelectorAll('#rec .pill')].map(el=>el.textContent);
  for(const u of units){ STATUS.set(u,'CALL'); }
  updateCrossStaffStatuses();
  const b=banner(); if(b){ b.className='ok'; b.textContent='Dispatch sent: '+units.join(', '); }
}

function openStatus(){
  const modal=B('statusModal'); const grid=B('statusGrid'); grid.innerHTML='';
  const by=new Map();
  for(const [k,arr] of Object.entries(DATA.STATION_UNITS||{})){
    const d=trailing(k)||k; const g=by.get(d)||[];
    for(const u of arr){ if(!g.includes(u)) g.push(u); }
    by.set(d,g);
  }
  const stations=[...by.keys()].sort((a,b)=>(a+b).localeCompare(b+a,undefined,{numeric:true}));
  for(const st of stations){
    const h=document.createElement('h3'); h.textContent='Station '+st; grid.appendChild(h);
    const box=document.createElement('div'); grid.appendChild(box);
    for(const u of (by.get(st)||[])){
      const badge=document.createElement('span'); badge.className='badge';
      const name=document.createElement('b'); name.textContent=u; badge.appendChild(name);

      const sel=document.createElement('select'); ['AQ','PA','CALL'].forEach(v=>{ const o=document.createElement('option'); o.value=v;o.text=v; sel.appendChild(o); });
      sel.value = STATUS.get(u)||DATA?.UNIT_STATUS?.[u]||'AQ'; sel.setAttribute('data-unit', u);
      sel.onchange=()=>{ STATUS.set(u,sel.value); updateCrossStaffStatuses(); };
      badge.appendChild(sel);

      const capIn=document.createElement('input'); capIn.placeholder='add cap'; capIn.size=6;
      const add=document.createElement('button'); add.className='secondary'; add.textContent='Add';
      add.onclick=()=>{ const v=normCap(capIn.value); if(v){ const s=new Set(USER_CAPS.get(u)||effectiveCaps(u)); s.add(v); USER_CAPS.set(u,[...s]); capIn.value=''; renderStatusCaps(); } };
      badge.appendChild(capIn); badge.appendChild(add);

      const span=document.createElement('span'); span.className='cap'; span.dataset.unit=u; badge.appendChild(span);
      box.appendChild(badge);
    }
  }
  renderStatusCaps();
  modal.setAttribute('aria-hidden','false');
}
function renderStatusCaps(){
  document.querySelectorAll('.badge .cap').forEach(el=>{
    const u=el.dataset.unit; el.textContent=' '+effectiveCaps(u).join(', ');
  });
}

function closeStatus(){ B('statusModal').setAttribute('aria-hidden','true'); }
function resetCaps(){ USER_CAPS.clear(); STATUS.clear(); for(const [u,v] of Object.entries(DATA.UNIT_STATUS||{})) STATUS.set(u,v||'AQ'); openStatus(); }

async function boot(){
  DATA = window.DATA || DATA;
  if(!DATA){ try{ const r=await fetch('data.json?v=55'); DATA=await r.json(); }catch(e){ console.warn('No data.json; using embedded DATA'); } }
  // Initialize status maps
  for(const u of Object.keys(DATA.UNIT_CAPS||{})){ STATUS.set(u, DATA?.UNIT_STATUS?.[u]||'AQ'); DEFAULT_STATUS.set(u, DATA?.UNIT_STATUS?.[u]||'AQ'); }
  // Map
  try{
    MAP=L.map('map').setView([39.414,-77.410],11);
    L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png',{maxZoom:19,attribution:'© OpenStreetMap contributors'}).addTo(MAP);
    MAP.on('click',e=>{ if(MARKER) MARKER.remove(); MARKER=L.marker(e.latlng).addTo(MAP); });
  }catch(err){ console.warn('Map init failed',err); }
  // Incidents dropdown
  const inc=B('incident'); inc.innerHTML='';
  Object.keys(DATA.PLAN_STRUCT||{}).sort().forEach(k=>{ const o=document.createElement('option'); o.value=o.textContent=k; inc.appendChild(o); });
  // ESZ dropdown (fallback: union of ESZ_ORDER keys and NON_HYDRANT_ESZ)
  const eszSel=B('eszSelect'); eszSel.innerHTML='';
  const eszList=new Set([...(Object.keys(DATA.ESZ_ORDER||{})), ...(DATA.NON_HYDRANT_ESZ||[])]);
  [...eszList].sort().forEach(k=>{ const o=document.createElement('option'); o.value=o.textContent=k; eszSel.appendChild(o); });
  setESZ([...eszList][0]||'0501');

  // Buttons
  B('btnRec').onclick=()=>{ try{ runRecommend(); banner().className='ok'; banner().textContent='Ready'; } catch(err){ banner().className='warn'; banner().textContent='Recommendation failed: '+(err.message||err); } };
  B('btnDispatch').onclick=sendDispatch;
  B('btnStatus').onclick=openStatus;
  B('closeStatus').onclick=closeStatus;
  B('resetCaps').onclick=resetCaps;
  B('setEsz').onclick=()=>setESZ(B('eszSelect').value||null);

  // Simple Nominatim locate
  B('btnLocate').onclick=async ()=>{
    const mode=B('searchMode').value; const q=B('q').value.trim();
    if(!q) return;
    try{
      const url = new URL('https://nominatim.openstreetmap.org/search');
      url.searchParams.set('format','json'); url.searchParams.set('q',q);
      const r = await fetch(url, {headers:{'Accept':'application/json'}});
      const js = await r.json();
      if(!js.length) throw new Error('not found');
      const m = js[0]; const lat=+m.lat, lon=+m.lon;
      if(MARKER) MARKER.remove(); MARKER=L.marker([lat,lon]).addTo(MAP); MAP.setView([lat,lon],13);
    }catch(err){ banner().className='warn'; banner().textContent='Locate failed: '+(err.message||err); }
  };

  // Importers
  B('btnImport').onclick=()=>B('importModal').setAttribute('aria-hidden','false');
  B('closeImport').onclick=()=>B('importModal').setAttribute('aria-hidden','true');
  B('filePick').addEventListener('change', async (e)=>{
    const files=[...e.target.files]; const log=[];
    for(const f of files){
      try{
        const buf = await f.arrayBuffer();
        if(f.name.match(/\.xlsx$/i)){
          const wb = XLSX.read(buf); const ws = wb.Sheets[wb.SheetNames[0]]; const rows = XLSX.utils.sheet_to_json(ws);
          if(rows[0]?.ESZ && rows[0]?.Type){ // Non-hydrant
            const set = new Set();
            rows.forEach(r=>{ if(String(r.Type).toUpperCase().includes('NON')) set.add(String(r.ESZ).split('.')[0]); });
            DATA.NON_HYDRANT_ESZ = [...set];
            log.push(`Loaded NON-HYDRAN ESZ (${set.size}) from ${f.name}`);
          }else{
            log.push(`${f.name}: xlsx not recognized`);
          }
        }else{ // CSV
          const text = new TextDecoder().decode(buf);
          // heuristic by header
          if(/Incident Type/i.test(text) && /Response/i.test(text)){
            // IRP
            const lines = text.trim().split(/\r?\n/);
            const [h,...rest]=lines; const hdr=h.split(',');
            const idxType=hdr.findIndex(x=>/Incident Type/i.test(x));
            const idxResp=hdr.findIndex(x=>/^Response$/i.test(x));
            const idxIfC=hdr.findIndex(x=>/^If Closer$/i.test(x));
            const idxNH=hdr.findIndex(x=>/NON-HYDRAN/i.test(x));
            const map={};
            const nhmap={};
            function parsePlan(str){ if(!str) return []; str=str.replace(/×/g,'x'); const tokens=str.trim().split(/\s+/); const groups=[]; for(let i=0;i<tokens.length;i++){ const t=tokens[i]; const m=t.match(/(?:(\d+)x)?(\d+)?([A-Za-z0-9]+)/); if(!m) continue; const qty=+(m[1]||m[2]||1); const cap=m[3].toUpperCase(); if(tokens[i+1]==='OR' && tokens[i+2]){ const m2=tokens[i+2].match(/(?:(\d+)x)?(\d+)?([A-Za-z0-9]+)/); if(m2){ const cap2=m2[3].toUpperCase(); groups.push({qty, caps:[cap,cap2]}); i+=2; continue; } } groups.push({qty, caps:[cap]}); } return groups; }
            for(const line of rest){ const cols=line.split(','); const key=(cols[idxType]||'').trim().toUpperCase(); if(!key) continue; map[key] = {groups: parsePlan(cols[idxResp]||''), ifCloser: (parsePlan(cols[idxIfC]||'').flatMap(g=>g.caps))}; const nh=cols[idxNH]||''; if(nh.trim()) nhmap[key]={groups:parsePlan(nh), ifCloser:[]}; }
            DATA.PLAN_STRUCT = map; DATA.PLAN_NH_OVERRIDES = nhmap;
            log.push(`Loaded Incident Plans (${Object.keys(map).length}) from ${f.name}`);
            // refresh dropdown
            const inc=B('incident'); inc.innerHTML=''; Object.keys(DATA.PLAN_STRUCT||{}).sort().forEach(k=>{ const o=document.createElement('option'); o.value=o.textContent=k; inc.appendChild(o); });
          }else if(/Station/i.test(text) && /Unit/i.test(text) && /Capabilities/i.test(text)){
            // Capability file
            const lines=text.trim().split(/\r?\n/); const [h,...rest]=lines; const hdr=h.split(',');
            const idxSt=hdr.findIndex(x=>/^Station$/i.test(x));
            const idxU=hdr.findIndex(x=>/^Unit$/i.test(x));
            const idxC=hdr.findIndex(x=>/^Capabilities$/i.test(x));
            const idxS=hdr.findIndex(x=>/^Default Status$/i.test(x));
            const stationUnits=new Map(), capsMap={}, statMap={};
            for(const line of rest){ const cols=line.split(','); const st=(cols[idxSt]||'').trim(); const u=(cols[idxU]||'').trim().toUpperCase(); if(!st||!u) continue; const caps=(cols[idxC]||'').split(',').map(x=>x.trim().toUpperCase()).filter(Boolean); capsMap[u]=caps; statMap[u]=(cols[idxS]||'AQ').trim().toUpperCase(); const arr=stationUnits.get(st)||[]; arr.push(u); stationUnits.set(st,arr); }
            DATA.UNIT_CAPS=capsMap; DATA.UNIT_STATUS=statMap; DATA.STATION_UNITS=Object.fromEntries([...stationUnits.entries()].map(([k,v])=>[k,v.sort()]));
            // reset internal maps
            USER_CAPS.clear(); STATUS.clear(); for(const [u,v] of Object.entries(DATA.UNIT_STATUS||{})) STATUS.set(u,v||'AQ');
            log.push(`Loaded Unit capabilities (${Object.keys(capsMap).length} units) from ${f.name}`);
          }else if(/ESZ/i.test(text) && /Order/i.test(text)){
            // ESZ order file
            const lines=text.trim().split(/\r?\n/); const [h,...rest]=lines; const hdr=h.split(',');
            const idxE=hdr.findIndex(x=>/^ESZ$/i.test(x)); const idxO=hdr.findIndex(x=>/^Order$/i.test(x));
            const esz={}; for(const line of rest){ const cols=line.split(','); const key=(cols[idxE]||'').trim(); const ord=(cols[idxO]||'').replace(/[>]/g,','); const arr=ord.split(/[,]/).map(x=>x.trim()).filter(Boolean); if(key && arr.length) esz[key]=arr; }
            DATA.ESZ_ORDER = esz;
            // refresh ESZ dropdown
            const eszSel=B('eszSelect'); eszSel.innerHTML=''; Object.keys(DATA.ESZ_ORDER||{}).sort().forEach(k=>{ const o=document.createElement('option'); o.value=o.textContent=k; eszSel.appendChild(o); });
            setESZ(Object.keys(DATA.ESZ_ORDER)[0]);
            log.push(`Loaded ESZ run‑card order (${Object.keys(esz).length} beats) from ${f.name}`);
          }else{
            log.push(`${f.name}: CSV not recognized`);
          }
        }
      }catch(err){ log.push(`${f.name}: ${err.message||err}`); }
    }
    B('importLog').textContent = log.join('\n');
  });
}

boot();
