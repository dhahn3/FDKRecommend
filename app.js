
// --- helpers ---
const B = id => document.getElementById(id);
const banner=()=>B('banner');
const normCap = c => String(c||'').trim().toUpperCase();
const trailing = s => String(s||'').match(/(\d{3})$/)?.[1]||null;

let MAP, MARKER, CURRENT_ESZ=null;
const STATUS=new Map(), DEFAULT_STATUS=new Map(), USER_CAPS=new Map(), REMOVED_CAPS=new Map();
let HILITE=null; // ESZ outline

// ESZ FeatureServer
const ESZ_URL = 'https://fcgis.frederickcountymd.gov/server_pub/rest/services/PublicSafety/EmergencyESZ/MapServer/0';

function mutualAidEnabled(){ return B('mutualAid').checked; }
function isAvailable(u){ return (STATUS.get(u) || DATA?.UNIT_STATUS?.[u] || 'AQ') === 'AQ'; }
function effectiveCaps(u){
  const base= new Set((DATA?.UNIT_CAPS?.[u]||[]).map(normCap));
  if(USER_CAPS.has(u)) for(const c of USER_CAPS.get(u)) base.add(normCap(c));
  if(REMOVED_CAPS.has(u)) for(const c of REMOVED_CAPS.get(u)) base.delete(normCap(c));
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
  CURRENT_ESZ = key;
  B('esz').textContent = key || '—';
  const order = (DATA?.ESZ_ORDER?.[key]) || DATA?.GLOBAL_ORDER || [];
  B('stationOrder').textContent = order.length ? `Station order: ${order.join(' → ')}` : 'Station order: (none)';
  if(HILITE) HILITE.setStyle({color:'#3b82f6', weight:4, fillOpacity:0.1});
  const box=B('rec'); if(box) box.innerHTML=''; // clear recommendations
}

function pill(text){ const s=document.createElement('span'); s.className='pill blue'; s.textContent=text; return s; }
function row(cap, arr){ const d=document.createElement('div'); d.className='row'; const l=document.createElement('label'); l.textContent=cap; d.appendChild(l); const box=document.createElement('div'); box.className='box'; arr.forEach(t=>box.appendChild(pill(t))); d.appendChild(box); return d; }

// SU preference for BLS at 909, 921, 913
const SU_PREF = new Set(['909','921','913']);

function buildCandidatesByOrder(order, caps, used){
  const want = (caps||[]).map(normCap);
  const out=[];
  order.forEach((st, idx)=>{
    if(!isStationAllowed(st)) return;
    let units = stationUnits(st);
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

// If BLS is only in ifCloser (not in required groups), apply cross-pair suppression
function suppressBLSPairing(out, plan){
  let blsInGroups=false;
  for(const grp of (plan?.groups||[])){
    const want = Array.isArray(grp.caps) ? grp.caps.map(normCap) : [normCap(grp.caps)];
    if(want.includes('BLS')) blsInGroups=true;
  }
  const blsIfCloser = (plan?.ifCloser||[]).map(normCap).includes('BLS');
  if(!(blsIfCloser && !blsInGroups)) return out;

  const aUnits = new Set(out.filter(x=>x.cap==='A').map(x=>String(x.unit).toUpperCase()));
  const suppress = new Set();
  if (aUnits.has('A924')) suppress.add('B911');
  if (aUnits.has('A930')) suppress.add('B910');
  return out.filter(x => !(x.cap==='BLS' && suppress.has(String(x.unit).toUpperCase())));
}

// Add ALL earlier DD/DDK before the latest selected E/K (Option B)
function addAllEarlierSubsExtra(selected, order, used, planCaps, primaryCap, subCap){
  if(!planCaps.has(primaryCap)) return;
  const chosenPrim = selected.filter(x=>x.cap===primaryCap);
  if(!chosenPrim.length) return;
  const latestPrimRank = Math.max(...chosenPrim.map(x=>x.rank));
  const subs = buildCandidatesByOrder(order, [subCap], used).filter(x=>x.rank < latestPrimRank)
                .sort((a,b)=>a.rank - b.rank);
  for(const s of subs){
    if(!selected.some(x=>x.unit===s.unit)){
      selected.push(s); used.add(s.unit);
    }
  }
}

function runRecommend(){
  const inc=B('incident').value;
  const basePlan = DATA?.PLAN_STRUCT?.[inc];
  if(!basePlan){ banner().className='warn'; banner().textContent='No plan structure for '+inc; return; }
  const isNH = (DATA?.NON_HYDRANT_ESZ||[]).includes(CURRENT_ESZ);
  const nhPlan = DATA?.PLAN_NH_OVERRIDES?.[inc];
  const plan = (isNH && nhPlan) ? nhPlan : basePlan;

  const order = (DATA?.ESZ_ORDER?.[CURRENT_ESZ]) || DATA?.GLOBAL_ORDER || [];
  const used=new Set();
  const res=[];
  const dbg=[];

  // Required groups
  for(const grp of (plan.groups||[])){
    const qty = Math.max(1, Number(grp.qty||1));
    const wantCaps = Array.isArray(grp.caps) ? grp.caps.map(normCap) : [normCap(grp.caps)];
    const cands = buildCandidatesByOrder(order, wantCaps, used);
    let have=0;
    for(const c of cands){
      if(res.some(x=>x.unit===c.unit)) continue;
      res.push(c); used.add(c.unit);
      if(wantCaps.includes(c.cap)) have++;
      if(have>=qty) break;
    }
    if(have<qty) dbg.push(`(need ${qty-have} of ${wantCaps.join('/')})`);
  }

  // IfCloser additions (only if earlier than earliest selected)
  const minRank = res.length ? Math.min(...res.map(x=>x.rank)) : Infinity;
  const aSet = new Set(res.filter(x=>x.cap==='A').map(x=>String(x.unit).toUpperCase()));
  for(const cap of (plan.ifCloser||[]).map(normCap)){
    const add = pickForCap(cap, order, used);
    if(!add){ dbg.push(`(ifCloser need ${cap})`); continue; }
    if(add.rank >= minRank){ dbg.push(`(ifCloser ${cap} not earlier)`); continue; }
    // Special rule for BLS cross-pair
    if(cap==='BLS'){
      const u = String(add.unit).toUpperCase();
      if( (aSet.has('A924') && u==='B911') || (aSet.has('A930') && u==='B910') ){
        dbg.push(`ifCloser BLS suppressed (${u}) due to A924/A930 rule`);
        continue;
      }
    }
    res.push(add); used.add(add.unit); dbg.push(`ifCloser ${cap}: ${add.unit}`);
  }

  // DD/DDK extras, HM33
  const planCaps = new Set();
  for(const grp of (plan.groups||[])){
    const want = Array.isArray(grp.caps) ? grp.caps : [grp.caps];
    for(const c of want) planCaps.add(normCap(c));
  }
  addAllEarlierSubsExtra(res, order, used, planCaps, 'E', 'DD');
  addAllEarlierSubsExtra(res, order, used, planCaps, 'K', 'DDK');
  enforceHM33(res, CURRENT_ESZ, used);

  const filtered = suppressBLSPairing(res, plan);

  // Render
  const box=B('rec'); box.innerHTML='';
  const debug=B('dbg'); debug.textContent=dbg.join('\n');
  const by=new Map();
  for(const it of filtered){
    const g=by.get(it.cap)||[]; g.push(`${it.unit}`); by.set(it.cap,g);
  }
  const capOrder = Array.from(by.keys()).sort((a,b)=>{
    // group by typical order
    const order = ['E','FS','AERIAL','SS','K','A','ALS','BC','SAF','DD','BR','MP','HM','BLS'];
    const ia = order.indexOf(a); const ib = order.indexOf(b);
    return (ia<0?999:ia)-(ib<0?999:ib);
  });
  for(const cap of capOrder){
    const list = by.get(cap);
    box.appendChild(row(cap, list));
  }
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
  // controls
  const controls=document.createElement('div'); controls.className='row';
  const expAll=document.createElement('button'); expAll.className='secondary'; expAll.textContent='Expand all';
  const colAll=document.createElement('button'); colAll.className='secondary'; colAll.textContent='Collapse all';
  controls.appendChild(expAll); controls.appendChild(colAll); grid.appendChild(controls);
  expAll.onclick=()=>{ for(const d of grid.querySelectorAll('details')) d.open=true; };
  colAll.onclick=()=>{ for(const d of grid.querySelectorAll('details')) d.open=false; };

  const stations=[...by.keys()].sort((a,b)=>(a+b).localeCompare(b+a,undefined,{numeric:true}));
  for(const st of stations){
    const wrap=document.createElement('details'); wrap.open=false; wrap.className='station';
    const sum=document.createElement('summary'); sum.textContent='Station '+st; wrap.appendChild(sum);
    const box=document.createElement('div'); box.className='station-body'; wrap.appendChild(box);
    grid.appendChild(wrap);
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
    let caps = effectiveCaps(u).sort();
    // Build pill row with remove buttons
    let wrap = badge.querySelector('.capwrap');
    if(!wrap){ wrap=document.createElement('span'); wrap.className='small capwrap'; wrap.style.marginLeft='6px'; badge.appendChild(wrap); }
    wrap.innerHTML='';
    for(const c of caps){
      const pill=document.createElement('span'); pill.className='pill';
      const label=document.createElement('span'); label.textContent=c; pill.appendChild(label);
      const x=document.createElement('button'); x.type='button'; x.className='pillx'; x.textContent='×';
      x.title='Remove capability';
      x.onclick=()=>{
        const addSet = USER_CAPS.get(u);
        if(addSet && addSet.has(c)){
          addSet.delete(c);
          if(addSet.size===0) USER_CAPS.delete(u);
        }else{
          const rem = REMOVED_CAPS.get(u) || new Set();
          rem.add(c);
          REMOVED_CAPS.set(u, rem);
        }
        renderStatusCaps();
      };
      pill.appendChild(x);
      wrap.appendChild(pill);
    }
  }
}

function resetCaps(){ USER_CAPS.clear(); REMOVED_CAPS.clear(); renderStatusCaps(); }

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
  // Ensure DATA present
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
    // Frederick County basemap w/ fallback
    try{
      const basemap=L.esri.tiledMapLayer({url:'https://fcgis.frederickcountymd.gov/server_pub/rest/services/Basemap/Basemap/MapServer'}).addTo(MAP);
      basemap.on('tileerror',()=>{
        L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png',{attribution:'&copy; OpenStreetMap'}).addTo(MAP);
      });
    }catch(_){
      L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png',{attribution:'&copy; OpenStreetMap'}).addTo(MAP);
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

  // Initial ESZ: first known, else wait for click
  const eszList=new Set([...(Object.keys(DATA.ESZ_ORDER||{})), ...(DATA.NON_HYDRANT_ESZ||[])]);
  setESZ([...eszList][0]||null);

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
      url.searchParams.set('format','json'); url.searchParams.set('bounded','1'); url.searchParams.set('limit','1');
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

window.addEventListener('DOMContentLoaded', boot);
