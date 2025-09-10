// --- helpers ---
const B = id => document.getElementById(id);
const banner=()=>B('banner');
const normCap = c => String(c||'').trim().toUpperCase();
const trailing = s => String(s||'').match(/(\d{3})$/)?.[1]||null;

let MAP, MARKER, CURRENT_ESZ=null;
const STATUS=new Map(), DEFAULT_STATUS=new Map(), USER_CAPS=new Map();
let HILITE=null; // geojson layer for selected ESZ outline

// ESZ FeatureServer (Fire ESZ)
const ESZ_URL = 'https://fcgis.frederickcountymd.gov/server_pub/rest/services/PublicSafety/EmergencyESZ/MapServer/0';

function mutualAidEnabled(){ return B('mutualAid').checked; }
function isAvailable(u){ return (STATUS.get(u) || DATA?.UNIT_STATUS?.[u] || 'AQ') === 'AQ'; }
function effectiveCaps(u){
  const base= new Set((DATA?.UNIT_CAPS?.[u]||[]).map(normCap));
  if(USER_CAPS.has(u)) for(const c of USER_CAPS.get(u)) base.add(normCap(c));
  return [...base];
}
function isStationAllowed(st){
  if(mutualAidEnabled()) return true;
  const d=trailing(st); return d?d[0]==='9':false;
}
function stationUnits(st){
  const s=String(st||'').toUpperCase();
  const d=trailing(s);
  const a=(DATA?.STATION_UNITS?.[s])||[];
  const b=(d && DATA?.STATION_UNITS?.[d])||[];
  return [...new Set([...a,...b])];
}

function setESZ(key){
  // clear current recommendation on ESZ change
  const box=document.getElementById('rec'); if(box) box.innerHTML='';
  CURRENT_ESZ = key;
  B('esz').textContent = key || '—';
  const order = (DATA?.ESZ_ORDER?.[key]) || DATA?.GLOBAL_ORDER || [];
  B('stationOrder').textContent = order.length ? `Station order: ${order.join(' → ')}` : 'Station order: (none)';
  if(HILITE) HILITE.setStyle({color:'#3b82f6', weight:4, fillOpacity:0.1});
}

function pill(text){ const s=document.createElement('span'); s.className='pill blue'; s.textContent=text; return s; }
function row(cap, arr){ const d=document.createElement('div'); d.className='row'; const l=document.createElement('label'); l.textContent=cap; d.appendChild(l); const box=document.createElement('div'); box.className='box'; arr.forEach(t=>box.appendChild(pill(t))); d.appendChild(box); return d; }

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
      if(used.has(u)) continue;
      if(!isAvailable(u)) continue;
      const capsOfU = effectiveCaps(u);
      for(const r of want){
        if(capsOfU.includes(r)){
          out.push({unit:u, cap:r, rank:idx, st:st});
          break;
        }
      }
    }
  });
  return out;
}

function pickForCap(cap, order, used){
  const arr = buildCandidatesByOrder(order, [cap], used);
  return arr.length ? arr[0] : null;
}


function maybeAddDD(out, order, used){
  // If plan needs E and a DD is earlier than the first chosen E, add the DD and then back-fill another E.
  const firstEIndex = out.findIndex(x=>x.cap==='E');
  if(firstEIndex<0) return;
  const firstE = out[firstEIndex];
  const adds = buildCandidatesByOrder(order, ['DD'], used).filter(x=>x.rank < firstE.rank);
  for(const d of adds){
    if(!out.some(x=>x.unit===d.unit)){
      out.push(d); used.add(d.unit);
    }
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
function suppressBLSPairing(out){
  const aUnits = new Set(out.filter(x=>x.cap==='A').map(x=>x.unit));
  const sup = new Set();
  for(const u of ['B911','B924']) if(aUnits.has(u.replace('B','A'))) sup.add(u);
  for(const u of ['B910','B930']) if(aUnits.has(u.replace('B','A'))) sup.add(u);
  return out.filter(x=>!(x.cap==='BLS' && sup.has(x.unit)));
}



function runRecommend(){
  const inc=B('incident').value;
  const plan = DATA?.PLAN_STRUCT?.[inc];
  if(!plan){ banner().className='warn'; banner().textContent='No plan structure for '+inc; return; }

  const order = (DATA?.ESZ_ORDER?.[CURRENT_ESZ]) || DATA?.GLOBAL_ORDER || [];
  const used=new Set();
  const selected=[];

  // Collect picks
  for(const grp of (plan.groups||[])){
    const qty = Math.max(1, Number(grp.qty||1));
    const wantCaps = Array.isArray(grp.caps) ? grp.caps.map(normCap) : [normCap(grp.caps)];
    const cands = buildCandidatesByOrder(order, wantCaps, used);
    let have = 0;
    for(const c of cands){
      if(selected.some(x=>x.unit===c.unit)) continue;
      selected.push(c); used.add(c.unit);
      if(wantCaps.includes(c.cap)) have++;
      if(have >= qty) break;
    }
  }

  // ifCloser extras
  for(const cap of (plan.ifCloser||[])){
    const p = pickForCap(cap, order, used);
    if(p){ selected.push(p); used.add(p.unit); }
  }

  // Hydrant override plan additions
  const nonHydrant = (DATA?.NON_HYDRANT_ESZ||[]).includes(CURRENT_ESZ);
  if(nonHydrant){
    const nhPlan = DATA?.PLAN_NH_OVERRIDES?.[inc];
    if(nhPlan && Array.isArray(nhPlan.groups)){
      for(const grp of nhPlan.groups){
        const qty = Math.max(1, Number(grp.qty||1));
        const wantCaps = Array.isArray(grp.caps) ? grp.caps.map(normCap) : [normCap(grp.caps)];
        const cands = buildCandidatesByOrder(order, wantCaps, used);
        let have = 0;
        for(const c of cands){
          if(selected.some(x=>x.unit===c.unit)) continue;
          selected.push(c); used.add(c.unit);
          if(wantCaps.includes(c.cap)) have++;
          if(have >= qty) break;
        }
      }
    }
  }

  // Special rules
  maybeAddDD(selected, order, used);
  maybeAddDDK(selected, order, used);
  enforceHM33(selected, CURRENT_ESZ, used);

  // Station-pair suppression
  let filtered = suppressBLSPairing(selected);

  // Sort by: plan group's cap order, then by station rank
  const planCapOrder = [];
  for(const grp of (plan.groups||[])){
    const wantCaps = Array.isArray(grp.caps) ? grp.caps : [grp.caps];
    for(const c of wantCaps){ const C=normCap(c); if(!planCapOrder.includes(C)) planCapOrder.push(C); }
  }
  const idxOf = cap => { const C=normCap(cap); const i=planCapOrder.indexOf(C); return i<0 ? 999 : i; };
  filtered = filtered.sort((a,b)=>{
    const ai = idxOf(a.cap), bi = idxOf(b.cap);
    if(ai!==bi) return ai-bi;
    return a.rank - b.rank;
  });

  renderRecommendation(filtered);
}
function renderRecommendation(arr){
  const box=B('rec'); box.innerHTML='';
  const dbg=B('dbg'); dbg.textContent='';
  const by=new Map();
  for(const it of arr){
    const g=by.get(it.cap)||[]; g.push(`${it.unit}`); by.set(it.cap,g);
  }
  for(const [cap,list] of by){
    box.appendChild(row(cap,list));
  }
  dbg.textContent = JSON.stringify(arr,null,2);
}

function sendDispatch(){
  const units = [...document.querySelectorAll('#rec .row .box')].flatMap(div => {
    return [...div.querySelectorAll('.pill')].map(p=>p.textContent.split(' ')[0]);
  });
  if(!units.length){ banner().className='warn'; banner().textContent='No units selected'; return; }
  for(const u of units){ STATUS.set(u,'CALL'); }
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

      const sel=document.createElement('select'); ['AQ','PA','CA','CALL','OOS'].forEach(v=>{ const o=document.createElement('option'); o.value=v;o.text=v; sel.appendChild(o); });
      sel.value = STATUS.get(u)||DATA?.UNIT_STATUS?.[u]||'AQ';
      sel.onchange=()=>STATUS.set(u,sel.value);
      badge.appendChild(sel);

      const capIn=document.createElement('input'); capIn.placeholder='add cap'; capIn.size=6;
      const add=document.createElement('button'); add.className='secondary'; add.textContent='Add';
      add.onclick=()=>{ const v=normCap(capIn.value); if(v){ const s=USER_CAPS.get(u)||new Set(); s.add(v); USER_CAPS.set(u,s); capIn.value=''; renderStatusCaps(); } };
      badge.appendChild(capIn); badge.appendChild(add);

      box.appendChild(badge);
    }
  }
  renderStatusCaps();
  modal.setAttribute('aria-hidden','false');
}

function renderStatusCaps(){
  const grid=B('statusGrid');
  for(const badge of grid.querySelectorAll('.badge')){
    const u = badge.querySelector('b').textContent;
    let caps = effectiveCaps(u);
    const wrap = document.createElement('span'); wrap.className='small'; wrap.style.marginLeft='6px';
    for(const c of caps){ const t=document.createElement('span'); t.className='pill'; t.textContent=c; wrap.appendChild(t); }
    const prior = badge.querySelector('.small'); if(prior) prior.remove();
    badge.appendChild(wrap);
  }
}

function resetCaps(){ USER_CAPS.clear(); renderStatusCaps(); }

// --- ESZ selection from point (click/locate) ---
async function setESZFromPoint(lat, lon){
  try{
    const g = {"x":lon,"y":lat,"spatialReference":{"wkid":4326}};
    const params = new URLSearchParams();
    params.set('f','geojson');
    params.set('geometry', JSON.stringify(g));
    params.set('geometryType','esriGeometryPoint');
    params.set('inSR','4326');
    params.set('spatialRel','esriSpatialRelIntersects');
    params.set('outFields','ESZ,STATION,STA_NAME,EMS');
    params.set('returnGeometry','true');

    const url = ESZ_URL + '/query?' + params.toString();
    const r = await fetch(url);
    const js = await r.json();

    if(!js.features || !js.features.length){
      setESZ(null);
      if(HILITE){ MAP.removeLayer(HILITE); HILITE=null; }
      return;
    }

    const feat = js.features[0];
    const eszNum = feat.properties.ESZ;
    const eszKey = String(eszNum).padStart(4,'0');
    setESZ(eszKey);

    if(HILITE){ MAP.removeLayer(HILITE); HILITE=null; }
    HILITE = L.geoJSON(feat, {style:{color:'#3b82f6',weight:4,fillOpacity:0.1}}).addTo(MAP);
  }catch(err){
    console.error(err);
    banner().className='warn'; banner().textContent='ESZ lookup failed';
  }
}

// --- boot ---
async function boot(){
  // Load embedded DATA
  if(!window.DATA){ banner().className='warn'; banner().textContent='DATA missing'; return; }
  window.DATA = window.DATA || {};
  window.DATA.UNIT_STATUS = window.DATA.UNIT_STATUS || {};
  window.DATA.UNIT_CAPS   = window.DATA.UNIT_CAPS   || {};
  window.DATA.STATION_UNITS = window.DATA.STATION_UNITS || {};

  // Initialize status maps
  for(const u of Object.keys(DATA.UNIT_CAPS||{})){
    STATUS.set(u, DATA?.UNIT_STATUS?.[u]||'AQ');
    DEFAULT_STATUS.set(u, DATA?.UNIT_STATUS?.[u]||'AQ');
  }

  // Map
  try{
    MAP=L.map('map').setView([39.414,-77.410],11);
    // Frederick County basemap (with fallback)
    try {
      const basemap = L.esri.tiledMapLayer({
        url:'https://fcgis.frederickcountymd.gov/server_pub/rest/services/Basemap/Basemap/MapServer'
      }).addTo(MAP);
      basemap.on('tileerror', ()=>{
        // Fallback if tiles fail
        L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
          attribution: '&copy; OpenStreetMap contributors'
        }).addTo(MAP);
      });
    } catch (e) {
      // Last-resort fallback
      L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
        attribution: '&copy; OpenStreetMap contributors'
      }).addTo(MAP);
    }

    // Click to set point + ESZ
    MAP.on('click', async (e)=>{
      if(MARKER) MARKER.remove();
      MARKER=L.marker(e.latlng).addTo(MAP);
      await setESZFromPoint(e.latlng.lat, e.latlng.lng);
    });
  }catch(err){ console.warn('Map init failed',err); }

  // Incidents dropdown
  const inc=B('incident'); inc.innerHTML='';
  Object.keys(DATA.PLAN_STRUCT||{}).sort().forEach(k=>{ const o=document.createElement('option'); o.value=o.textContent=k; inc.appendChild(o); });

  // Initial ESZ: pick first known, or wait for click
  const eszList=new Set([...(Object.keys(DATA.ESZ_ORDER||{})), ...(DATA.NON_HYDRANT_ESZ||[])]);
  setESZ([...eszList][0]||'0501');

  // Buttons
  B('btnRec').onclick=()=>{ try{ runRecommend(); banner().className='ok'; banner().textContent='Ready'; }catch(err){ banner().className='warn'; banner().textContent='Recommendation failed: '+(err.message||err); } };
  B('btnDispatch').onclick=sendDispatch;
  B('btnStatus').onclick=openStatus;
  B('closeStatus').onclick=()=>B('statusModal').setAttribute('aria-hidden','true');
  B('resetCaps').onclick=resetCaps;

  // Geocode (Nominatim) scoped to Frederick County
  B('btnLocate').onclick=async ()=>{
    const mode=B('searchMode').value; let q=B('q').value.trim();
    if(!q) return;
    try{
      const url = new URL('https://nominatim.openstreetmap.org/search');
      url.searchParams.set('format','json');
      url.searchParams.set('bounded','1');
      url.searchParams.set('limit','1');
      // Frederick County bounding box (approx): west, north, east, south
      url.searchParams.set('viewbox','-77.85,39.75,-77.00,39.15');

      if(mode==='intersection'){
        const parts=q.split('&').map(s=>s.trim());
        if(parts.length>=2){ q = `${parts[0]} & ${parts[1]}, Frederick County, MD`; }
      }else{
        q = `${q}, Frederick County, MD`;
      }
      url.searchParams.set('q', q);

      const r = await fetch(url, {headers:{'Accept':'application/json'}});
      const js = await r.json();
      if(!js.length) throw new Error('not found');
      const {lat, lon} = js[0];
      if(MARKER) MARKER.remove();
      MARKER = L.marker([+lat, +lon]).addTo(MAP);
      MAP.setView([+lat, +lon], 13);
      await setESZFromPoint(+lat, +lon);
    }catch(err){
      banner().className='warn'; banner().textContent='Locate failed: '+(err.message||err);
    }
  };
}

window.addEventListener('error',e=>{ if(banner()){banner().className='warn'; banner().textContent='JS error: '+(e.message||e);}});
window.addEventListener('unhandledrejection',e=>{ if(banner()){banner().className='warn'; banner().textContent='Promise error: '+(e.reason?.message||e.reason||e);}});

boot();
