
/* FDK Recommend – multi-file build v44 (fixes: modal z-index, plan fallback, clearer plan display) */
window.addEventListener('error', (e)=>{ const w=document.getElementById('loadWarn'); if(!w) return; w.style.display='block'; w.textContent='JavaScript error: '+(e.message||'see console'); });

const ESZ_URL = "https://fcgis.frederickcountymd.gov/server_pub/rest/services/PublicSafety/EmergencyESZ/MapServer/0";
const ADDR_URL = "https://fcgis.frederickcountymd.gov/server_pub/rest/services/Basemap/Addresses/MapServer/1";
const CENTERLINE_URL = "https://fcgis.frederickcountymd.gov/server_pub/rest/services/Basemap/Centerlines/MapServer/0";
const POI_URL = "https://fcgis.frederickcountymd.gov/server_pub/rest/services/Basemap/Basemap/MapServer/18";

let DATA=null; let map, eszLayer, pointMarker;
const $ = s => document.querySelector(s);

const STATUS_KEY   = 'unitStatus.v1';
const CAPS_OVR_KEY = 'unitCapsOverrides.v1';
let CURRENT_STATUS   = {};
let CURRENT_CAPS_OVR = {};

function setMsg(el, text, cls='small'){ if(!el) return; el.className = cls; el.textContent = text; }
function canonStationId(raw){
  const s=String(raw||'').trim().toUpperCase();
  const m=s.match(/^(FR|AC|CC|HC|WC|JC|LCF|MCF)(\d{1,2})$/);
  if(m){ return `FIRE/${m[1]}${m[2].padStart(2,'0')}`; }
  return s;
}
function trailingDigits(st){
  const m=String(st||'').match(/(\d{3})$/);
  return m ? m[1] : null;
}
  const s=String(raw||'').trim().toUpperCase();
  const m=s.match(/^(FR|AC|CC|HC|WC|JC|LCF|MCF)(\d{1,2})$/);
  if(m){ return `FIRE/${m[1]}${m[2].padStart(2,'0')}`; }
  return s; // '905', 'FIRE/WC11', etc.
}
function toEsriPoint(lng,lat){ return {x:lng,y:lat,spatialReference:{wkid:4326}}; }
async function fetchJSON(url){ const r=await fetch(url); if(!r.ok) throw new Error('HTTP '+r.status); return r.json(); }
function encodeParams(p){ return Object.entries(p).map(([k,v])=>k+'='+encodeURIComponent(v)).join('&'); }

function addPoint(latlng){ if(pointMarker) map.removeLayer(pointMarker); pointMarker=L.marker(latlng).addTo(map); }
async function fetchESZForPoint(lat,lng){
  const url = `${ESZ_URL}/query?`+encodeParams({
    geometry: JSON.stringify(toEsriPoint(lng,lat)),
    geometryType:'esriGeometryPoint', inSR:4326, spatialRel:'esriSpatialRelIntersects',
    outFields:'*', returnGeometry:true, outSR:4326, f:'json'
  });
  const data = await fetchJSON(url);
  if(!data.features?.length) throw new Error('No ESZ found here');
  return data.features[0];
}
function showESZ(feature){
  if(!eszLayer) return;
  eszLayer.clearLayers();
  const rings = (feature.geometry.rings||[]).map(r=>r.map(([x,y])=>[y,x]));
  if(rings.length){
    eszLayer.addData({type:'Feature',properties:feature.attributes,geometry:{type:'Polygon',coordinates:[rings[0].map(([lat,lng])=>[lng,lat])]}});
    try{ map.fitBounds(eszLayer.getBounds(), {padding:[20,20]}); }catch(_){}
  }
  const attrs = feature.attributes||{};
  const esz = (attrs.ESZ ?? attrs.esz ?? '').toString().padStart(4,'0');
  $('#esz').textContent = esz || '—';
  const order = DATA?.ESZ_ORDER?.[esz] || [];
  $('#order').textContent = order.length ? ('Station order: ' + order.map(v=>canonStationId(v)).join(' → ')) : 'No station order on file.';
  $('#incident').dispatchEvent(new Event('change'));
}

async function locateByAddress(q){
  const caps=q.toUpperCase();
  const where = `UPPER(ADD_FULL) LIKE '${caps.replace(/'/g,"''")}%' OR UPPER(ST_FULL) LIKE '${caps.replace(/'/g,"''")}%'`;
  const url = `${ADDR_URL}/query?`+encodeParams({where,outFields:'*',returnGeometry:true,f:'json',outSR:4326});
  const data = await fetchJSON(url);
  if(!data.features?.length) throw new Error('No matches');
  const f = data.features.find(f=>f.attributes.ST_NUM!=null) || data.features[0];
  const {x,y} = f.geometry; return [y,x];
}
async function locateByPOI(q){
  const caps=q.toUpperCase();
  const where = `UPPER(NAME) LIKE '%${caps.replace(/'/g,"''")}%'`;
  const url = `${POI_URL}/query?`+encodeParams({where,outFields:'*',returnGeometry:true,f:'json',outSR:4326});
  const data = await fetchJSON(url);
  if(!data.features?.length) throw new Error('No POI found');
  const {x,y} = data.features[0].geometry; return [y,x];
}
async function locateByIntersection(q){
  const parts = q.split(/&| and /i).map(s=>s.trim()).filter(Boolean);
  if(parts.length<2) throw new Error('Enter like "Street A & Street B"');
  const [a,b]=parts.map(s=>s.toUpperCase().replace(/'/g,"''"));
  const common="&returnGeometry=true&f=json&outSR=4326&outFields=ST_NAME";
  const [fa,fb]=await Promise.all([
    fetchJSON(`${CENTERLINE_URL}/query?where=${encodeURIComponent(`UPPER(ST_NAME) LIKE '%${a}%'`)}${common}`),
    fetchJSON(`${CENTERLINE_URL}/query?where=${encodeURIComponent(`UPPER(ST_NAME) LIKE '%${b}%'`)}${common}`)
  ]);
  if(!fa.features?.length||!fb.features?.length) throw new Error('One or both streets not found');
  const toLine = f => ({type:'Feature',properties:{},geometry:{type:'LineString',coordinates:f.geometry.paths[0].map(p=>[p[0],p[1]])}});
  const la=fa.features.map(toLine), lb=fb.features.map(toLine);
  let inter=[]; for(const ga of la){ for(const gb of lb){ const pts=turf.lineIntersect(ga,gb); if(pts.features.length) inter.push(...pts.features); } }
  if(!inter.length) throw new Error('No intersection found'); 
  const [lng,lat]=inter[0].geometry.coordinates; return [lat,lng];
}

function normCap(s){ return String(s||'').toUpperCase().replace(/[^A-Z0-9]/g,''); }
function effectiveCaps(unit){ 
  const base=(DATA?.UNIT_CAPS?.[unit]||[]);
  const over=(CURRENT_CAPS_OVR?.[unit]||null);
  const arr = Array.isArray(over)&&over.length ? over : base;
  return (arr||[]).map(normCap);
}
function hasCap(unit,cap){ return effectiveCaps(unit).includes(normCap(cap)); }
function isAvailable(unit){ const st=(CURRENT_STATUS[unit]||DATA?.UNIT_STATUS?.[unit]||'AQ').toUpperCase(); return st==='AQ'; }

const SU_PREF_STATIONS=new Set(['909','921','913']);
function stationRank(eszOrder, st){ return eszOrder.findIndex(v=>canonStationId(v)===st); }
function unitStation(unit, eszOrder){
  for(const stRaw of eszOrder){
    const st=canonStationId(stRaw);
    const d = trailingDigits(st);
    const arrA=(DATA?.STATION_UNITS?.[st])||[];
    const arrB=d ? ((DATA?.STATION_UNITS?.[d])||[]) : [];
    const arr=[...new Set([...arrA, ...arrB])];
    if(arr.includes(unit)) return st;
  }
  return null;
}

function mutualAidEnabled(){ return $('#mutualAid')?.checked === true; }
function isStationAllowed(st){
  st = canonStationId(st||'');
  if(mutualAidEnabled()) return true;
  return st && st[0]==='9'; // only 900-series when OFF
}

/* ---- FALLBACK PLANS (used only if groups missing in data.json) ---- */
const FALLBACK_PLANS = {
  "ABDOMALS": { groupsStd: [ {qty:1,caps:['A']},{qty:1,caps:['ALS']} ], ifCloserStd: {"BLS":1} },
  "HOUSE":    { groupsStd: [ {qty:6,caps:['E']},{qty:1,caps:['FS']},{qty:1,caps:['AERIAL']},{qty:1,caps:['SS']},
                              {qty:3,caps:['K']},{qty:1,caps:['A']},{qty:1,caps:['ALS']},{qty:2,caps:['BC']},{qty:1,caps:['SAF']} ],
                ifCloserStd: {} }
};

function decidePlanForESZ(esz, planEntry, key){
  const fb = FALLBACK_PLANS[key] || null;
  const isNH = (DATA?.NON_HYDRANT_ESZ||[]).includes(String(esz).padStart(4,'0'));
  const hasNH = (planEntry?.groupsNH||[]).length>0;
  let groups  = (isNH && hasNH) ? (planEntry?.groupsNH||[]) : (planEntry?.groupsStd||[]);
  let ifCloser= (isNH && hasNH) ? (planEntry?.ifCloserNH||{}) : (planEntry?.ifCloserStd||{});
  let flavor  = (isNH && hasNH) ? 'NON-HYDRAN' : 'STANDARD';
  let badge   = flavor;

  if((!groups || groups.length===0) && fb){
    groups = fb.groupsStd||[];
    ifCloser = fb.ifCloserStd||{};
    badge = flavor + '  •  using FALLBACK plan (no groups in data.json)';
  }
  return {groups, ifCloser, flavor, isNH, badge};
}

function buildCandidatesByOrder(eszOrder, capsNeeded, used){
  const cand=[]; const capsNorm=(capsNeeded||[]).map(normCap);
  for(const [idx,stRaw] of eszOrder.entries()){
    const st=canonStationId(stRaw);
    if(!isStationAllowed(st)) continue;
    const d = trailingDigits(st);
    // Merge units from exact key + trailing-3-digit key if present
    let units = [];
    const a = (DATA?.STATION_UNITS?.[st])||[];
    const b = d ? ((DATA?.STATION_UNITS?.[d])||[]) : [];
    const merged = [...new Set([...a, ...b])];
    units = merged.slice();

    const wantsOnlyBLS = capsNorm.length===1 && capsNorm[0]==='BLS';
    if(wantsOnlyBLS && SU_PREF_STATIONS.has(d||st)){
      const suFirst = units.filter(u=>/^SU\d+$/i.test(u));
      const rest = units.filter(u=>!/^SU\d+$/i.test(u));
      units = suFirst.concat(rest);
    }
    for(const u of units){
      if(used && used.has(u)) continue;
      if(!isAvailable(u)) continue;
      const capsU=effectiveCaps(u);
      for(const c of capsNorm){ if(capsU.includes(c)){ cand.push({unit:u, cap:c, st:st, rank:idx}); } }
    }
  }
  cand.sort((a,b)=>a.rank-b.rank); return cand;
}

function recommendUnitsRunCard_Additive(esz){
  const order = (DATA?.ESZ_ORDER?.[esz]||[]).map(normalizeStationId);
  const key   = $('#incident').value;
  const entry = (DATA?.PLAN_STRUCT||{})[key] || {};
  const is50  = String(esz||'').startsWith('50');

  const selPlan = decidePlanForESZ(esz, entry, key);
  const groups = selPlan.groups || [];
  const ifCloserCounts = Object.assign({}, selPlan.ifCloser||{});

  const used=new Set(); const results=[]; const respSel=[];

  function tokenExists(tok){
    const T=normCap(tok);
    for(const arr of Object.values(DATA?.STATION_UNITS||{})){
      for(const u of arr){ if(effectiveCaps(u).includes(T)) return true; }
    }
    return (T==='BC');
  }
  const unknown=new Set();
  for(const g of groups) g.caps.forEach(c=>{ if(!tokenExists(c)) unknown.add(c); });
  Object.keys(ifCloserCounts).forEach(c=>{ if(!tokenExists(c)) unknown.add(c); });
  const v=$('#vocab'); v.style.display = unknown.size ? 'block' : 'none';
  v.textContent = unknown.size ? ('Unknown capability tokens (no unit advertises: ' + Array.from(unknown).join(', ')+')') : '';

  for(const g of groups){
    for(let i=0;i<g.qty;i++){

      if(g.caps.map(normCap).includes('HM')){
        if(!is50){
          const hm33='HM33'; 
          const hmSt=unitStation(hm33, order);
          const hmRank = hmSt!=null ? stationRank(order, hmSt) : Infinity;
          if(hmSt && isStationAllowed(hmSt) && hasCap(hm33,'HM') && !used.has(hm33) && isAvailable(hm33)){
            used.add(hm33); results.push({unit:hm33, roleCap:'HM', from:'RESP', st:hmSt, rank:hmRank});
            respSel.push({unit:hm33, roleCap:'HM', st:hmSt, rank:hmRank});
          }
          const hmCands = buildCandidatesByOrder(order, ['HM'], used);
          if(hmCands.length){ const c=hmCands[0]; used.add(c.unit); results.push({unit:c.unit, roleCap:'HM', from:'RESP', st:c.st, rank:c.rank}); respSel.push({unit:c.unit, roleCap:'HM', st:c.st, rank:c.rank}); }
          else { results.push({unit:'(HM needed)', roleCap:'HM', from:'RESP'}); }
          continue;
        }else{
          const hmC = buildCandidatesByOrder(order, ['HM'], used);
          if(hmC.length){ const c=hmC[0]; used.add(c.unit); results.push({unit:c.unit, roleCap:'HM', from:'RESP', st:c.st, rank:c.rank}); respSel.push({unit:c.unit, roleCap:'HM', st:c.st, rank:c.rank}); }
          else { results.push({unit:'(HM needed)', roleCap:'HM', from:'RESP'}); }
          continue;
        }
      }

      if(g.caps.map(normCap).includes('BC')){
        const pool=(DATA.BC_UNITS||[]).filter(u=>!used.has(u) && isAvailable(u));
        let pick=null, st=null, rank=Infinity;
        for(const [idx,stRaw] of order.entries()){
          const s=canonStationId(stRaw);
          if(!isStationAllowed(s)) continue;
          const arr=(DATA.STATION_UNITS[s]||[]);
          const hit = arr.find(u => pool.includes(u));
          if(hit){ pick=hit; st=s; rank=idx; break; }
        }
        if(pick){ used.add(pick); results.push({unit:pick, roleCap:'BC', from:'RESP', st, rank}); respSel.push({unit:pick, roleCap:'BC', st, rank}); }
        else { results.push({unit:'(BC needed)', roleCap:'BC', from:'RESP'}); }
        continue;
      }

      const capsSet = new Set(g.caps.map(normCap));
      const isAorMP = capsSet.size===2 && capsSet.has('A') && capsSet.has('MP');
      const isBRorE = capsSet.size===2 && capsSet.has('BR') && capsSet.has('E');
      if(isAorMP || isBRorE){
        const pref1 = isAorMP ? 'A' : 'BR';
        const pref2 = isAorMP ? 'MP': 'E';
        const c1 = buildCandidatesByOrder(order, [pref1], used)[0]||null;
        const c2 = buildCandidatesByOrder(order, [pref2], used)[0]||null;
        let choose=null; if(c1&&c2) choose=(c1.rank<=c2.rank)?c1:c2; else choose=c1||c2;
        if(choose){ used.add(choose.unit); results.push({unit:choose.unit, roleCap:normCap(choose.cap), from:'RESP', st:choose.st, rank:choose.rank}); respSel.push({unit:choose.unit, roleCap:normCap(choose.cap), st:choose.st, rank:choose.rank}); }
        else { results.push({unit:'('+Array.from(capsSet).join(' OR ')+' needed)', roleCap:Array.from(capsSet)[0], from:'RESP'}); }
        continue;
      }

      const cands = buildCandidatesByOrder(order, g.caps, used);
      if(cands.length){ const c=cands[0]; used.add(c.unit); results.push({unit:c.unit, roleCap:normCap(c.cap), from:'RESP', st:c.st, rank:c.rank}); respSel.push({unit:c.unit, roleCap:normCap(c.cap), st:c.st, rank:c.rank}); }
      else { results.push({unit:'('+g.caps.join(' OR ')+' needed)', roleCap:normCap(g.caps[0]||'OTHER'), from:'RESP'}); }
    }
  }

  const respRanks = respSel.map(s=>s.rank).filter(r=>Number.isFinite(r));
  const baselineRank = respRanks.length ? Math.min(...respRanks) : 999999;
  for(const [capRaw,count] of Object.entries(ifCloserCounts)){
    let remaining=count;
    const adds = buildCandidatesByOrder(order, [capRaw], used);
    for(const c of adds){
      if(remaining<=0) break;
      if(c.rank < baselineRank){ used.add(c.unit); results.push({unit:c.unit, roleCap:normCap(c.cap), from:'IFC', st:c.st, rank:c.rank}); remaining--; }
    }
  }

  const planCallsForE = (groups||[]).some(g=> (g.caps||[]).map(normCap).includes('E'));
  if(planCallsForE){
    const eChosen = respSel.filter(s=>s.roleCap==='E');
    if(eChosen.length){
      const thresholdERank = Math.max(...eChosen.map(s=>Number.isFinite(s.rank)?s.rank:999999));
      const ddAll = buildCandidatesByOrder(order, ['DD'], null);
      const ddEarlier = ddAll.filter(c=>c.rank < thresholdERank && isAvailable(c.unit));
      const unique = []; const seen = new Set();
      for(const c of ddEarlier){ if(!seen.has(c.unit) && !used.has(c.unit)){ unique.push(c); seen.add(c.unit); } }
      let ddAdded=0; for(const c of unique){ used.add(c.unit); results.push({unit:c.unit, roleCap:'DD', from:'IFC', st:c.st, rank:c.rank}); ddAdded++; }
      if(ddAdded>0){
        const totalENow=results.filter(r=>r.roleCap==='E').length;
        let needE = Math.max(totalENow, ddAdded) - totalENow;
        if(needE>0){
          const eCands=buildCandidatesByOrder(order, ['E'], used);
          for(const c of eCands){ if(needE<=0) break; used.add(c.unit); results.push({unit:c.unit, roleCap:'E', from:'IFC', st:c.st, rank:c.rank}); needE--; }
        }
      }
    }
  }

  const planCallsForK = (groups||[]).some(g=> (g.caps||[]).map(normCap).includes('K'));
  if(planCallsForK){
    const kChosen = respSel.filter(s=>s.roleCap==='K');
    if(kChosen.length){
      const thresholdKRank = Math.max(...kChosen.map(s=>Number.isFinite(s.rank)?s.rank:999999));
      const ddkAll = buildCandidatesByOrder(order, ['DDK'], null);
      const ddkEarlier = ddkAll.filter(c=>c.rank < thresholdKRank && isAvailable(c.unit));
      const unique=[]; const seen=new Set();
      for(const c of ddkEarlier){ if(!seen.has(c.unit) && !used.has(c.unit)){ unique.push(c); seen.add(c.unit); } }
      let ddkAdded=0; for(const c of unique){ used.add(c.unit); results.push({unit:c.unit, roleCap:'DDK', from:'IFC', st:c.st, rank:c.rank}); ddkAdded++; }
      if(ddkAdded>0){
        const totalKNow=results.filter(r=>r.roleCap==='K').length;
        let needK = Math.max(totalKNow, ddkAdded) - totalKNow;
        if(needK>0){
          const kCands=buildCandidatesByOrder(order, ['K'], used);
          for(const c of kCands){ if(needK<=0) break; used.add(c.unit); results.push({unit:c.unit, roleCap:'K', from:'IFC', st:c.st, rank:c.rank}); needK--; }
        }
      }
    }
  }

  const ambSel = respSel.find(sel=>sel.roleCap==='A');
  if(ambSel){
    const ambSt=ambSel.st;
    if(ambSt==='924' || ambSt==='930'){
      const dropSt = ambSt==='924' ? '911' : '910';
      const kept=[];
      for(const r of results){
        const isDrop = (r.roleCap==='BLS') && ((DATA.STATION_UNITS[dropSt]||[]).includes(r.unit));
        if(!isDrop) kept.push(r);
      }
      results.length=0; results.push(...kept);
    }
  }

  window.__lastDebug = {esz, key, groups, ifCloserCounts, respSel, results};
  return results;
}

function openStatusModal(){
  const modal = $('#statusModal');
  const grid  = $('#statusGrid');
  grid.innerHTML = '';

  // Group stations by trailing digits so '612' and 'LCF/612' appear once
  const byGroup = new Map();
  for(const [k, arr] of Object.entries(DATA.STATION_UNITS||{})){
    const d = trailingDigits(k) || k; // fall back to key
    const g = byGroup.get(d) || [];
    for(const u of arr){ if(!g.includes(u)) g.push(u); }
    byGroup.set(d, g);
  }
  const stations = Array.from(byGroup.keys()).sort();
  for(const st of stations){
    const units = (byGroup.get(st)||[]).slice().sort();
    if(!units.length) continue;
    const h = document.createElement('h3'); h.textContent = `Station ${st}`; grid.appendChild(h);
    for(const u of units){
      const row = document.createElement('div'); row.className='grid';

      const uLabel = document.createElement('div'); uLabel.textContent = u; row.appendChild(uLabel);

      const capsBox = document.createElement('input'); capsBox.className='capedit';
      const effective = (CURRENT_CAPS_OVR[u] && CURRENT_CAPS_OVR[u].length) ? CURRENT_CAPS_OVR[u] : (DATA.UNIT_CAPS[u]||[]);
      capsBox.value = effective.join(' ');
      capsBox.placeholder = 'Tokens (e.g., E ALS A BLS K K3000 HM …)';
      capsBox.addEventListener('change', ()=>{
        const toks = capsBox.value.split(/\s+/).map(s=>s.trim().toUpperCase()).filter(Boolean);
        CURRENT_CAPS_OVR[u] = toks; localStorage.setItem(CAPS_OVR_KEY, JSON.stringify(CURRENT_CAPS_OVR||{}));
      });
      row.appendChild(capsBox);

      const statusDiv = document.createElement('div'); statusDiv.className='radio';
      const status = (CURRENT_STATUS[u] || DATA.UNIT_STATUS[u] || 'AQ').toUpperCase();
      ['AQ','CALL','PA'].forEach(s=>{
        const id=`${u}_${s}`;
        const lbl=document.createElement('label'); lbl.for='id';
        const r=document.createElement('input'); r.type='radio'; r.name=`st_${u}`; r.value=s; r.id=id; r.checked=(status===s);
        r.addEventListener('change', ()=>{ CURRENT_STATUS[u]=s; localStorage.setItem(STATUS_KEY, JSON.stringify(CURRENT_STATUS)); });
        lbl.appendChild(r); lbl.appendChild(document.createTextNode(' '+s));
        statusDiv.appendChild(lbl);
      });
      row.appendChild(statusDiv);

      grid.appendChild(row);
    }
    const hr=document.createElement('hr'); hr.className='sep'; grid.appendChild(hr);
  }

  $('#btnResetCaps').onclick = ()=>{ CURRENT_CAPS_OVR = {}; localStorage.setItem(CAPS_OVR_KEY, JSON.stringify(CURRENT_CAPS_OVR)); openStatusModal(); };
  $('#btnCloseStatus').onclick = ()=>{ modal.style.display='none'; modal.setAttribute('aria-hidden','true'); };
  modal.style.display='flex'; modal.setAttribute('aria-hidden','false');
}

async function boot(){
  try{
    const resp = await fetch('data.json?v=v44');
    if(!resp.ok){ throw new Error('Failed to load data.json ('+resp.status+')'); }
    DATA = await resp.json();

    try{ CURRENT_STATUS = {...(DATA?.UNIT_STATUS||{}), ...(JSON.parse(localStorage.getItem(STATUS_KEY)||'{}'))}; }catch(_){ CURRENT_STATUS={...(DATA?.UNIT_STATUS||{})}; }
    try{ CURRENT_CAPS_OVR = JSON.parse(localStorage.getItem(CAPS_OVR_KEY)||'{}'); }catch(_){ CURRENT_CAPS_OVR={}; }

    map = L.map('map').setView([39.414,-77.410], 11);
    L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png',{maxZoom:19,attribution:'© OpenStreetMap contributors'}).addTo(map);
    eszLayer = L.geoJSON(null,{style:{color:'#f59e0b',weight:3,fillOpacity:.12,fillColor:'#f59e0b'}}).addTo(map);
    map.on('click', async (e)=>{
      const latlng=[e.latlng.lat,e.latlng.lng]; addPoint(latlng); setMsg($('#geoMsg'),`Point: ${latlng[0].toFixed(6)}, ${latlng[1].toFixed(6)}`);
      try{ const f=await fetchESZForPoint(latlng[0],latlng[1]); showESZ(f); } catch(err){ setMsg($('#geoMsg'),err.message,'warn'); }
    });

    // Incident dropdown
    const sel=$('#incident'); const keys=Object.keys(DATA.PLAN_STRUCT||{}).sort();
    sel.innerHTML = keys.length? keys.map(k=>`<option value="${k}">${k}</option>`).join('') : '<option value="">(no plans)</option>';
    if(keys.length) sel.value=keys[0];

    function updatePlanView(){
      const esz=$('#esz').textContent.trim();
      const key=$('#incident').value;
      const entry=(DATA?.PLAN_STRUCT||{})[key] || {};
      const plan = decidePlanForESZ(esz, entry, key);
      const groups=plan.groups||[]; const ifc=plan.ifCloser||{};
      $('#planTxt').textContent = groups.length ? ('Plan: ' + groups.map(g=> (g.qty>1? g.qty+'× ' : '') + g.caps.join(' OR ')).join(', ')) : 'Plan:';
      const ifcList = Object.entries(ifc).map(([k,v])=> v>1? (v+'× '+k) : k).join(', ');
      $('#ifcTxt').innerHTML = ifcList ? ('If closer <b>(earlier in run card)</b>: ' + ifcList) : '';
      $('#flavor').innerHTML = plan.badge ? ('<span class="badge">'+plan.badge+'</span>') : '';
    }
    sel.addEventListener('change', updatePlanView);
    updatePlanView();

    $('#btnLocate').addEventListener('click', async ()=>{
      const mode=$('#searchMode').value; const q=$('#q').value.trim();
      if(!q){ setMsg($('#geoMsg'),'Enter a search'); return; }
      setMsg($('#geoMsg'),'Searching…');
      try{
        let latlng;
        if(mode==='address') latlng=await locateByAddress(q);
        else if(mode==='poi') latlng=await locateByPOI(q);
        else latlng=await locateByIntersection(q);
        addPoint(latlng); setMsg($('#geoMsg'),`Found: ${latlng[0].toFixed(6)}, ${latlng[1].toFixed(6)}`);
        const f=await fetchESZForPoint(latlng[0],latlng[1]); showESZ(f);
      }catch(e){ setMsg($('#geoMsg'), e.message||'Search failed', 'warn'); $('#esz').textContent='—'; $('#order').textContent=''; eszLayer.clearLayers(); }
    });

    $('#btnRec').addEventListener('click', ()=>{
      try{
        const esz=$('#esz').textContent.trim();
        const div=$('#rec');
        if(!esz || esz==='—'){ div.innerHTML='<div class="small">Locate a point first to get ESZ.</div>'; return; }
        const rows = recommendUnitsRunCard_Additive(esz);
        window.__currentRecUnits = Array.from(new Set(rows.map(r=>r.unit).filter(u => u && !u.startsWith('('))));
        const respRows = rows.filter(r => r.from === 'RESP');
        const ifcRows  = rows.filter(r => r.from === 'IFC');
        function groupRows(arr, planOrderIdx){ 
  const g={}; 
  for(const r of arr){ (g[r.roleCap]=g[r.roleCap]||[]).push(r.unit); } 
  return Object.entries(g).sort((a,b)=>{
    const ia = (planOrderIdx[a[0]] ?? 1e9);
    const ib = (planOrderIdx[b[0]] ?? 1e9);
    if(ia!==ib) return ia-ib;
    return a[0].localeCompare(b[0]);
  }); 
}
        function renderGroup(title, arr){ const wrap=document.createElement('div'); const head=document.createElement('div'); head.textContent=title; head.style.marginTop='10px'; head.style.fontWeight='700'; wrap.appendChild(head); const line=document.createElement('div'); line.className='units'; for(const u of arr){ const span=document.createElement('span'); span.className='pill rec'; span.textContent=u; line.appendChild(span);} wrap.appendChild(line); return wrap; }
        div.innerHTML='';
        const byRoleResp = groupRows(respRows); const byRoleIfc  = groupRows(ifcRows);
        for(const [cap, units] of byRoleResp){ div.appendChild(renderGroup(cap+':', units)); }
        if(byRoleIfc.length){ const sep=document.createElement('div'); sep.className='small'; sep.style.marginTop='8px'; sep.textContent='(If closer additions):'; div.appendChild(sep); for(const [cap, units] of byRoleIfc){ div.appendChild(renderGroup(cap+':', units)); } }
        const resp = rows.filter(r=>r.from==='RESP').map(r=>`${r.unit}[${r.roleCap}]@${r.st}/${r.rank}`).join(', ');
        const ifc  = rows.filter(r=>r.from==='IFC').map(r=>`${r.unit}[${r.roleCap}]@${r.st}/${r.rank}`).join(', ');
        $('#dbg').textContent = `RESP picks: ${resp}\nIFC picks: ${ifc}`;
      }catch(e){ $('#rec').innerHTML = '<div class="warn">Recommendation failed: '+(e.message||e)+'</div>'; }
    });

    $('#btnDispatch').addEventListener('click', ()=>{
      const units = window.__currentRecUnits||[];
      units.forEach(u=>{ CURRENT_STATUS[u]='CALL'; });
      localStorage.setItem(STATUS_KEY, JSON.stringify(CURRENT_STATUS));
      alert(`Toggled ${units.length} unit(s) to CALL.`);
    });

    $('#btnStatus').addEventListener('click', ()=> openStatusModal());
    $('#mutualAid')?.addEventListener('change', ()=>{ $('#btnRec').click(); });
  }catch(e){
    const w=$('#loadWarn'); w.style.display='block'; w.textContent='Startup error: '+(e.message||e);
  }
}

document.addEventListener('DOMContentLoaded', boot);


// Backward-compat alias used by older code paths
function normalizeStationId(x){ return canonStationId(x); }
