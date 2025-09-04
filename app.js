
const ESZ_URL = "https://fcgis.frederickcountymd.gov/server_pub/rest/services/PublicSafety/EmergencyESZ/MapServer/0";
const ADDR_URL = "https://fcgis.frederickcountymd.gov/server_pub/rest/services/Basemap/Addresses/MapServer/1";
const CENTERLINE_URL = "https://fcgis.frederickcountymd.gov/server_pub/rest/services/Basemap/Centerlines/MapServer/0";
const POI_URL = "https://fcgis.frederickcountymd.gov/server/rest/services/Basemap/Basemap/MapServer/18";

let DATA = null;
let map, pointMarker, eszLayer;

// Live unit status (overrides defaults). Persisted in localStorage.
const STATUS_KEY = 'unitStatus.v1';
let CURRENT_STATUS = {}; // {unit: 'AQ'|'PA'|'CALL'}

// Unit capability overrides (per unit). Persisted in localStorage.
const CAP_OVR_KEY = 'unitCapsOverrides.v1';
let CURRENT_CAP_OVR = {}; // {unit: ['E','K','...']}

const $ = (s)=>document.querySelector(s);
function setMsg(el, text, cls='muted'){ el.className = cls; el.textContent = text; }
function toEsriPoint(lng, lat){ return {x:lng, y:lat, spatialReference:{wkid:4326}}; }
async function fetchJSON(url){ const r = await fetch(url); if(!r.ok) throw new Error('HTTP '+r.status); return r.json(); }
function encodeParams(p){ return Object.entries(p).map(([k,v])=>k+'='+encodeURIComponent(v)).join('&'); }
function addPoint(latlng){ if(pointMarker) map.removeLayer(pointMarker); pointMarker=L.marker(latlng).addTo(map); }
function normalizeStationId(id){ const s=String(id||''); const m=s.match(/(\d{3})$/); return m?m[1]:s; }
function toast(msg){ const t=document.createElement('div'); t.className='toast'; t.textContent=msg; document.body.appendChild(t); setTimeout(()=>{t.remove();}, 2600); }

// Decide plan flavor (STANDARD vs NON-HYDRAN), and whether a NH variant is present for this incident
function decidePlanForESZ(esz, planEntry){
  const isNH = (DATA?.NON_HYDRANT_ESZ||[]).includes(String(esz).padStart(4,'0'));
  const hasNH = (planEntry?.groupsNH||[]).length>0;
  return {
    groups: (isNH && hasNH) ? (planEntry.groupsNH||[]) : (planEntry.groupsStd||[]),
    ifCloser: (isNH && hasNH) ? (planEntry.ifCloserNH||{}) : (planEntry.ifCloserStd||{}),
    flavor: (isNH && hasNH) ? 'NON-HYDRAN' : 'STANDARD',
    isNH
  };
}

// Capability helpers
function normCap(s){ return String(s||'').toUpperCase().replace(/[^A-Z0-9]/g,''); }
function effectiveCaps(unit){
  const base = (DATA?.UNIT_CAPS?.[unit]||[]);
  const over = (CURRENT_CAP_OVR?.[unit]||null);
  const list = Array.isArray(over) && over.length ? over : base;
  return (list||[]).map(normCap);
}
function hasCap(unit, cap){
  const caps = effectiveCaps(unit);
  return caps.includes(normCap(cap));
}
function isAvailable(unit){
  const st = (CURRENT_STATUS[unit] || DATA?.UNIT_STATUS?.[unit] || 'AQ').toUpperCase();
  return st === 'AQ'; // 'PA' and 'CALL' are not available
}
const SU_PREF_STATIONS = new Set(['909','921','913']); // BLS-only preference for SUxx

// Geocoders
async function locateByAddress(q){
  const caps = q.toUpperCase();
  const where = `UPPER(ADD_FULL) LIKE '${caps.replace(/'/g,"''")}%' OR UPPER(ST_FULL) LIKE '${caps.replace(/'/g,"''")}%'`;
  const url = `${ADDR_URL}/query?` + encodeParams({ where, outFields:'*', returnGeometry:true, f:'json', outSR:4326 });
  const data = await fetchJSON(url);
  if(!data.features?.length) throw new Error('No matches');
  const f = data.features.find(f=>f.attributes.ST_NUM!=null) || data.features[0];
  const {x,y} = f.geometry; return [y,x];
}
async function locateByPOI(q){
  const caps = q.toUpperCase();
  const where = `UPPER(NAME) LIKE '%${caps.replace(/'/g,"''")}%'`;
  const url = `${POI_URL}/query?` + encodeParams({ where, outFields:'*', returnGeometry:true, f:'json', outSR:4326 });
  const data = await fetchJSON(url);
  if(!data.features?.length) throw new Error('No POI found');
  const {x,y} = data.features[0].geometry; return [y,x];
}
async function locateByIntersection(q){
  const parts = q.split(/&| and /i).map(s=>s.trim()).filter(Boolean);
  if(parts.length<2) throw new Error('Enter like "Street A & Street B"');
  const [a,b] = parts.map(s=>s.toUpperCase().replace(/'/g,"''"));
  const common = "&returnGeometry=true&f=json&outSR=4326&outFields=ST_NAME";
  const [fa,fb] = await Promise.all([
    fetchJSON(`${CENTERLINE_URL}/query?where=${encodeURIComponent(`UPPER(ST_NAME) LIKE '%${a}%'`)}${common}`),
    fetchJSON(`${CENTERLINE_URL}/query?where=${encodeURIComponent(`UPPER(ST_NAME) LIKE '%${b}%'`)}${common}`)
  ]);
  if(!fa.features?.length || !fb.features?.length) throw new Error('One or both streets not found');
  const toLine = f => ({type:'Feature', properties:{name:f.attributes.ST_NAME}, geometry:{type:'LineString', coordinates:f.geometry.paths[0].map(p=>[p[0],p[1]])}});
  const la=fa.features.map(toLine), lb=fb.features.map(toLine);
  let intersections = [];
  for(const ga of la){ for(const gb of lb){ const pts=turf.lineIntersect(ga,gb); if(pts.features.length) intersections.push(...pts.features); } }
  if(!intersections.length) throw new Error('No line intersection found');
  const [lng,lat] = intersections[0].geometry.coordinates; return [lat,lng];
}

// ESZ fetch+draw
async function fetchESZForPoint(lat,lng){
  const geom = JSON.stringify(toEsriPoint(lng,lat));
  const url = `${ESZ_URL}/query?`+encodeParams({
    geometry:geom, geometryType:'esriGeometryPoint', inSR:4326, spatialRel:'esriSpatialRelIntersects',
    outFields:'*', returnGeometry:true, outSR:4326, f:'json'
  });
  const data = await fetchJSON(url);
  if(!data.features?.length) throw new Error('No ESZ found at that location');
  return data.features[0];
}
function showESZ(feature){
  if(!eszLayer) return;
  eszLayer.clearLayers();
  const rings = feature.geometry.rings.map(r=>r.map(([x,y])=>[x,y]));
  eszLayer.addData({type:'Feature', properties:feature.attributes, geometry:{type:'Polygon', coordinates:rings}});
  map.fitBounds(eszLayer.getBounds(), {padding:[20,20]});
  const attrs = feature.attributes||{};
  const esz = (attrs.ESZ ?? attrs.esz ?? '').toString().padStart(4,'0');
  $('#eszInfo').textContent = esz || '—';
  const order = DATA?.ESZ_ORDER?.[esz] || [];
  $('#eszOrder').textContent = order.length ? ('Station order: ' + order.map(v=>normalizeStationId(v)).join(' → ')) : 'No station order on file.';
  const selEl = document.querySelector('#incidentSelect'); if(selEl) selEl.dispatchEvent(new Event('change'));
}

// Selection helpers
function stationRank(eszOrder, st){ return eszOrder.findIndex(v => normalizeStationId(v)===st); }
function unitStation(unit, eszOrder){
  for(const stRaw of eszOrder){
    const st = normalizeStationId(stRaw);
    const arr = (DATA?.STATION_UNITS?.[st])||[];
    if(arr.includes(unit)) return st;
  }
  return null;
}
function buildCandidatesByOrder(eszOrder, capsNeeded, used){
  const cand = [];
  const capsNeededNorm = (capsNeeded||[]).map(normCap);
  for(const [idx, stRaw] of eszOrder.entries()){
    const st = normalizeStationId(stRaw);
    let units = ((DATA?.STATION_UNITS?.[st])||[]).slice();
    const wantsOnlyBLS = capsNeededNorm.length===1 && capsNeededNorm[0]==='BLS';
    if(wantsOnlyBLS && SU_PREF_STATIONS.has(st)){
      const suFirst = units.filter(u=>/^SU\d+$/i.test(u));
      const rest = units.filter(u=>!/^SU\d+$/i.test(u));
      units = suFirst.concat(rest);
    }
    for(const u of units){
      if(used.has(u)) continue;
      if(!isAvailable(u)) continue;
      const capsNorm = effectiveCaps(u);
      for(const cap of capsNeededNorm){
        if(capsNorm.includes(cap)){
          cand.push({unit:u, cap:cap, st:st, rank:idx});
        }
      }
    }
  }
  cand.sort((a,b)=> a.rank - b.rank);
  return cand;
}

// Core recommender
function decidePlanForIncident(esz, incidentKey){
  const planEntry = DATA?.PLAN_STRUCT?.[incidentKey];
  if(!planEntry) return null;
  return decidePlanForESZ(esz, planEntry);
}
function recommendUnitsRunCard_Additive(esz){
  const order = (DATA?.ESZ_ORDER?.[esz]||[]).map(normalizeStationId);
  const isESZ50 = (esz && String(esz).startsWith('50'));
  const incidentKey = $('#incidentSelect').value;
  const selPlan = decidePlanForIncident(esz, incidentKey);
  if(!selPlan) return [];
  const groups = selPlan.groups || [];
  const ifCloserCounts = Object.assign({}, selPlan.ifCloser || {});
  const used = new Set();
  const results = [];
  const responseSelections = [];

  const tokenExists = (tok)=>{
    const T = normCap(tok);
    for(const arr of Object.values(DATA?.STATION_UNITS||{})){
      for(const u of arr){
        const caps = ((DATA?.UNIT_CAPS?.[u])||[]).map(normCap);
        if(caps.includes(T)) return true;
      }
    }
    return (T==='BC');
  };
  const unknown = new Set();
  for(const g of groups) g.caps.forEach(c => { if(!tokenExists(c)) unknown.add(c); });
  Object.keys(ifCloserCounts||{}).forEach(c => { if(!tokenExists(c)) unknown.add(c); });
  $('#vocabWarn').style.display = unknown.size ? 'block' : 'none';
  $('#vocabWarn').textContent = unknown.size ? ('Unknown capability tokens (no unit advertises: ' + Array.from(unknown).join(', ')+')') : '';

  for(const g of groups){
    for(let i=0;i<g.qty;i++){
      if (g.caps.map(x => String(x).toUpperCase()).includes('HM') && i===0 && !isESZ50) {
        const hm33 = 'HM33';
        const hmCands = buildCandidatesByOrder(order, ['HM'], used);
        let hm33Added = false;
        const hm33St = unitStation(hm33, order);
        if (hm33St && hasCap(hm33,'HM') && !used.has(hm33) && isAvailable(hm33)) {
          const hm33Rank = stationRank(order, hm33St);
          used.add(hm33);
          results.push({unit:hm33, roleCap:'HM', from:'RESP', st:hm33St, rank:hm33Rank});
          responseSelections.push({unit:hm33, roleCap:'HM', st:hm33St, rank:hm33Rank});
          hm33Added = true;
        }
        let taken = hm33Added ? 1 : 0;
        for (const c of hmCands) {
          if (taken >= g.qty) break;
          if (c.unit === 'HM33') continue;
          if (used.has(c.unit)) continue;
          used.add(c.unit);
          results.push({unit:c.unit, roleCap:'HM', from:'RESP', st:c.st, rank:c.rank});
          responseSelections.push({unit:c.unit, roleCap:'HM', st:c.st, rank:c.rank});
          taken += 1;
        }
        const hm33Sel = responseSelections.find(r => r.unit==='HM33' && r.roleCap==='HM');
        if (hm33Sel && Number.isFinite(hm33Sel.rank)) {
          const closer = hmCands.find(c => c.unit!=='HM33' && !used.has(c.unit) && c.rank < hm33Sel.rank);
          if (closer) {
            used.add(closer.unit);
            results.push({unit:closer.unit, roleCap:'HM', from:'RESP', st:closer.st, rank:closer.rank});
            responseSelections.push({unit:closer.unit, roleCap:'HM', st:closer.st, rank:closer.rank});
          }
        }
        i = g.qty; continue;
      }

      if(g.caps.includes('BC')){
        const bcUnits = (DATA.BC_UNITS||[]).filter(u=>!used.has(u) && isAvailable(u));
        let picked=null, pickedSt=null, pickedRank=Infinity;
        for(const [idx, stRaw] of order.entries()){
          const st = normalizeStationId(stRaw);
          const units = (DATA.STATION_UNITS[st] || []);
          const present = units.find(u => bcUnits.includes(u));
          if(present){ picked=present; pickedSt=st; pickedRank=idx; break; }
        }
        if(picked){
          used.add(picked); results.push({unit:picked, roleCap:'BC', from:'RESP', st:pickedSt, rank:pickedRank});
          responseSelections.push({unit:picked, roleCap:'BC', st:pickedSt, rank:pickedRank});
        } else {
          results.push({unit:'(BC needed)', roleCap:'BC', from:'RESP', st:null, rank:Infinity});
        }
        continue;
      }

      const caps = g.caps.slice();
      const capsN = caps.map(normCap);
      const setKey = new Set(capsN);
      const isAorMP = setKey.size===2 && setKey.has('A') && setKey.has('MP');
      const isBRorE = setKey.size===2 && setKey.has('BR') && setKey.has('E');

      if (isAorMP || isBRorE) {
        const pref1 = isAorMP ? 'A' : 'BR';
        const pref2 = isAorMP ? 'MP' : 'E';
        const pick1 = buildCandidatesByOrder(order, [pref1], used)[0] || null;
        const pick2 = buildCandidatesByOrder(order, [pref2], used)[0] || null;
        let choose = null;
        if (pick1 && pick2) choose = (pick1.rank <= pick2.rank) ? pick1 : pick2;
        else choose = pick1 || pick2;
        if (choose) {
          used.add(choose.unit);
          results.push({unit:choose.unit, roleCap:normCap(choose.cap), from:'RESP', st:choose.st, rank:choose.rank});
          responseSelections.push({unit:choose.unit, roleCap:normCap(choose.cap), st:choose.st, rank:choose.rank});
        } else {
          results.push({unit:'(' + caps.join(' OR ') + ' needed)', roleCap:normCap(caps[0]||'OTHER'), from:'RESP', st:null, rank:Infinity});
        }
        continue;
      }

      const cands = buildCandidatesByOrder(order, caps, used);
      if(cands.length){
        const chosen = cands[0];
        used.add(chosen.unit);
        results.push({unit:chosen.unit, roleCap:normCap(chosen.cap), from:'RESP', st:chosen.st, rank:chosen.rank});
        responseSelections.push({unit:chosen.unit, roleCap:normCap(chosen.cap), st:chosen.st, rank:chosen.rank});
      } else {
        results.push({unit:'(' + caps.join(' OR ') + ' needed)', roleCap:normCap(caps[0]||'OTHER'), from:'RESP', st:null, rank:Infinity});
      }
    }
  }

  const ambResponses = responseSelections.filter(sel => hasCap(sel.unit,'A'));
  let baselineRank = ambResponses.length ? Math.min(...ambResponses.map(s=>s.rank)) : Infinity;
  if(baselineRank===Infinity){
    for(const sel of responseSelections){ if(sel.rank < baselineRank) baselineRank = sel.rank; }
  }

  for(const [capRaw, count] of Object.entries(ifCloserCounts)){
    let remaining = count;
    const addCands = buildCandidatesByOrder(order, [capRaw], used);
    for(const c of addCands){
      if(remaining<=0) break;
      if(c.rank < baselineRank){
        used.add(c.unit);
        results.push({unit:c.unit, roleCap:normCap(c.cap), from:'IFC', st:c.st, rank:c.rank});
        remaining -= 1;
      }
    }
  }

  const ambSel = ambResponses[0] || null;
  if(ambSel){
    const ambSt = ambSel.st;
    if(ambSt === '924' || ambSt === '930'){
      const dropSt = ambSt==='924' ? '911' : '910';
      const kept=[];
      for(const r of results){
        const isBLSfromDropStation = (r.roleCap === 'BLS') && (DATA.STATION_UNITS[dropSt]||[]).includes(r.unit);
        if(!isBLSfromDropStation) kept.push(r);
      }
      results.length=0; results.push(...kept);
    }
  }

  window.__lastDebug = {esz, incident: $('#incidentSelect').value, selections: responseSelections, all: results, planFlavor: selPlan.flavor};
  return results;
}

// STATUS MODAL
function loadCapOverrides(){
  try{ CURRENT_CAP_OVR = JSON.parse(localStorage.getItem(CAP_OVR_KEY) || '{}'); }
  catch(_){ CURRENT_CAP_OVR = {}; }
}
function saveCapOverrides(){
  localStorage.setItem(CAP_OVR_KEY, JSON.stringify(CURRENT_CAP_OVR||{}));
}
function loadStatus(){
  const defaults = DATA?.UNIT_STATUS || {};
  let saved = {};
  try{ saved = JSON.parse(localStorage.getItem(STATUS_KEY) || '{}'); }catch(_){ saved = {}; }
  CURRENT_STATUS = {...defaults, ...saved};
}
function saveStatus(){
  localStorage.setItem(STATUS_KEY, JSON.stringify(CURRENT_STATUS));
}
function resetDefaults(){
  CURRENT_STATUS = {...(DATA?.UNIT_STATUS || {})};
  saveStatus();
  CURRENT_CAP_OVR = {};
  saveCapOverrides();
  renderStatusModal();
}
function openStatusModal(){
  renderStatusModal();
  $('#statusModal').classList.add('open');
  $('#statusModal').setAttribute('aria-hidden', 'false');
}
function closeStatusModal(){
  $('#statusModal').classList.remove('open');
  $('#statusModal').setAttribute('aria-hidden', 'true');
}
function renderStatusModal(){
  const cont = $('#statusContent');
  const eszOrderAllStations = Object.keys(DATA?.STATION_UNITS || {}).sort();
  let html = '';
  for(const st of eszOrderAllStations){
    const units = (DATA.STATION_UNITS[st] || []).slice().sort((a,b)=>a.localeCompare(b));
    if(!units.length) continue;
    html += `<details class="stGroup"><summary><b>Station ${st}</b></summary>`;
    html += `<table class="table"><thead><tr><th style="width:160px;">Unit</th><th style="width:260px;">Capabilities</th><th>Status</th></tr></thead><tbody>`;
    for(const u of units){
      const capsEff = effectiveCaps(u).join(', ');
      const capsBase = (DATA.UNIT_CAPS[u]||[]).join(', ');
      const stv = (CURRENT_STATUS[u] || 'AQ').toUpperCase();
      const cls = stv==='AQ' ? 'status-AQ' : (stv==='CALL'?'status-CALL':'status-PA');
      html += `<tr>
        <td>${u}</td>
        <td>
          <input type="text" data-capunit="${u}" value="${capsEff}" placeholder="${capsBase}" style="width:100%;"/>
          <div class="muted small">Tokens comma/space separated. Examples: E, A, ALS, BR, MP, K, K3000, BT, HM, BC, BLS…</div>
        </td>
        <td>
          <select data-unit="${u}" class="${cls}">
            <option value="AQ" ${stv==='AQ'?'selected':''}>AQ (Available)</option>
            <option value="CALL" ${stv==='CALL'?'selected':''}>CALL (On incident)</option>
            <option value="PA" ${stv==='PA'?'selected':''}>PA (Out of service)</option>
          </select>
        </td>
      </tr>`;
    }
    html += `</tbody></table></details>`;
  }
  cont.innerHTML = html;

  function parseCapsInput(s){
    const raw = String(s||'').toUpperCase().split(/[^A-Z0-9/]+/).filter(Boolean);
    const out=[]; const seen=new Set();
    for(const tok of raw){ if(!seen.has(tok)){ seen.add(tok); out.push(tok);} }
    return out;
  }
  cont.querySelectorAll('input[data-capunit]').forEach(inp => {
    inp.addEventListener('change', e => {
      const unit = e.target.getAttribute('data-capunit');
      const arr = parseCapsInput(e.target.value);
      if(arr.length){ CURRENT_CAP_OVR[unit] = arr; }
      else { delete CURRENT_CAP_OVR[unit]; }
      saveCapOverrides();
    });
  });
  cont.querySelectorAll('select[data-unit]').forEach(sel => {
    sel.addEventListener('change', e => {
      const unit = e.target.getAttribute('data-unit');
      const val = (e.target.value || 'AQ').toUpperCase();
      CURRENT_STATUS[unit] = val;
      e.target.className = (val==='AQ') ? 'status-AQ' : (val==='CALL'?'status-CALL':'status-PA');
      saveStatus();
    });
  });
}

// UI bootstrap
async function main(){
  map = L.map('map').setView([39.414, -77.410], 11);
  L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png', {maxZoom:19, attribution:'© OpenStreetMap contributors'}).addTo(map);
  eszLayer = L.geoJSON(null, {style: {color:'#f59e0b', weight:3, fillOpacity:0.12, fillColor:'#f59e0b'}}).addTo(map);

  map.on('click', async (e)=>{
    window.__incidentPoint = [e.latlng.lat, e.latlng.lng];
    addPoint(window.__incidentPoint);
    setMsg($('#geocodeMsg'), `Point: ${e.latlng.lat.toFixed(6)}, ${e.latlng.lng.toFixed(6)}`);
    try{ const eszFeat=await fetchESZForPoint(e.latlng.lat,e.latlng.lng); showESZ(eszFeat); }
    catch(err){ setMsg($('#geocodeMsg'), err.message, 'warn'); }
  });

  try{
    const res = await fetch('data.json?v=' + Date.now());
    DATA = await res.json();
  }catch(e){
    const el = $('#loadError');
    el.style.display = 'block';
    el.textContent = 'Failed to load data.json — check deployment path. (' + (e.message||e) + ')';
    console.error(e);
    DATA = {ESZ_ORDER:{}, STATION_UNITS:{}, UNIT_CAPS:{}, UNIT_STATUS:{}, PLAN_STRUCT:{}, NON_HYDRANT_ESZ:[]};
  }

  loadStatus();
  loadCapOverrides();

  const sel = $('#incidentSelect');
  const keys = Object.keys(DATA.PLAN_STRUCT||{}).sort();
  sel.innerHTML = keys.length ? keys.map(k=>`<option value="${k}">${k}</option>`).join('') : '<option value="">(no plans loaded)</option>';
  if(keys.length) sel.value = keys[0];

  const updateView = ()=>{
    const planEntry = (DATA.PLAN_STRUCT||{})[sel.value];
    if(!planEntry){ $('#planRoles').textContent=''; $('#ifCloserView').textContent=''; $('#planFlavor').textContent=''; return; }
    const esz = $('#eszInfo').textContent.trim();
    const selPlan = decidePlanForESZ(esz, planEntry);
    const groups = selPlan.groups || [];
    const ifc = selPlan.ifCloser || {};
    $('#planRoles').textContent = 'Plan: ' + groups.map(g => (g.qty>1?g.qty+'× ':'') + g.caps.join(' OR ')).join(', ');
    const ifcList = Object.entries(ifc).map(([k,v])=> v>1? (v+'× '+k) : k).join(', ');
    $('#ifCloserView').innerHTML = ifcList ? ('If closer <b>(earlier in run card)</b>: ' + ifcList) : '';
    const badge = selPlan.flavor === 'NON-HYDRAN' ? 'Using NON-HYDRAN plan for this ESZ' : 'Using STANDARD plan';
    $('#planFlavor').innerHTML = '<span class="badge">' + badge + '</span>' + (selPlan.isNH && selPlan.flavor!=='NON-HYDRAN' ? ' — (no specific NON-HYDRAN plan for this incident)' : '');
  };
  sel.addEventListener('change', updateView);
  updateView();

  $('#btnSearch').addEventListener('click', async ()=>{
    const mode=$('#searchMode').value; const q=$('#query').value.trim();
    if(!q){ setMsg($('#geocodeMsg'),'Enter a search'); return; }
    setMsg($('#geocodeMsg'),'Searching…');
    try{
      let latlng;
      if(mode==='address') latlng=await locateByAddress(q);
      else if(mode==='poi') latlng=await locateByPOI(q);
      else latlng=await locateByIntersection(q);
      window.__incidentPoint = latlng;
      addPoint(latlng);
      setMsg($('#geocodeMsg'),`Found: ${latlng[0].toFixed(6)}, ${latlng[1].toFixed(6)}`);
      const eszFeat=await fetchESZForPoint(latlng[0],latlng[1]);
      showESZ(eszFeat);
    }catch(e){ setMsg($('#geocodeMsg'), e.message||'Search failed', 'warn'); $('#eszInfo').textContent='—'; $('#eszOrder').textContent=''; eszLayer.clearLayers(); }
  });

  $('#btnRecommend').addEventListener('click', ()=>{
    const esz=$('#eszInfo').textContent.trim();
    const recDiv=$('#rec');
    if(!esz || esz==='—'){ recDiv.innerHTML='<div class="muted">Locate a point first to get ESZ.</div>'; return; }
    const rows = recommendUnitsRunCard_Additive(esz);
    window.__currentRecUnits = Array.from(new Set(rows.map(r=>r.unit).filter(u => u && !u.startsWith('('))));

    const respRows = rows.filter(r => r.from === 'RESP');
    const ifcRows  = rows.filter(r => r.from === 'IFC');
    const groupsResp = {}; for (const r of respRows) (groupsResp[r.roleCap] = groupsResp[r.roleCap] || []).push(r.unit);
    const groupsIfc = {};  for (const r of ifcRows)  (groupsIfc[r.roleCap]  = groupsIfc[r.roleCap]  || []).push(r.unit);

    const incidentKey = $('#incidentSelect').value;
    const planEntry = (DATA.PLAN_STRUCT||{})[incidentKey];
    const selPlan = decidePlanForESZ(esz, planEntry);
    const norm = s => String(s||'').toUpperCase().replace(/[^A-Z0-9]/g,'');
    const planRespOrder = [];
    for (const g of (selPlan.groups || [])) {
      const capsNorm = (g.caps || []).map(norm);
      const picked = respRows.find(r => capsNorm.includes(norm(r.roleCap)));
      const key = picked ? picked.roleCap : (capsNorm[0] || 'OTHER');
      if (!planRespOrder.includes(key)) planRespOrder.push(key);
    }

    const requiredCounts = {};
    for (const g of (selPlan.groups || [])) {
      const capsNorm = (g.caps || []).map(norm);
      const picked = respRows.find(r => capsNorm.includes(norm(r.roleCap)));
      const key = picked ? picked.roleCap : (capsNorm[0] || 'OTHER');
      requiredCounts[key] = (requiredCounts[key] || 0) + (g.qty || 1);
    }

    const ifcCapsOrder = [];
    for (const r of ifcRows) {
      if (!planRespOrder.includes(r.roleCap) && !ifcCapsOrder.includes(r.roleCap)) ifcCapsOrder.push(r.roleCap);
    }

    const allCapsSeen = new Set([...Object.keys(groupsResp), ...Object.keys(groupsIfc)]);
    const extras = [];
    for (const cap of allCapsSeen) {
      if (!planRespOrder.includes(cap) && !ifcCapsOrder.includes(cap)) extras.push(cap);
    }

    let html = '<div class="muted">Recommendation (run card + add-on IfCloser):</div>';
    for (const key of planRespOrder) {
      const have = (groupsResp[key] || []).slice();
      const need = requiredCounts[key] || have.length;
      while (have.length < need) have.push('(' + key + ' needed)');
      html += '<div style=\"margin-top:6px;\"><b>' + key + ':</b> <div class=\"units\">' + have.map(u => '<span class=\"pill ' + (u.startsWith('(')?'':'pill-rec') + '\">' + u + '</span>').join(' ') + '</div></div>';
    }
    for (const key of ifcCapsOrder) {
      const arr = groupsIfc[key];
      if (!arr || !arr.length) continue;
      html += '<div style=\"margin-top:6px;\"><b>' + key + ' (If closer):</b> <div class=\"units\">' + arr.map(u => '<span class=\"pill ' + (u.startsWith('(')?'':'pill-rec') + '\">' + u + '</span>').join(' ') + '</div></div>';
    }
    for (const key of extras) {
      const arr = (groupsResp[key] || []).concat(groupsIfc[key] || []);
      if (!arr.length) continue;
      html += '<div style=\"margin-top:6px;\"><b>' + key + ':</b> <div class=\"units\">' + arr.map(u => '<span class=\"pill ' + (u.startsWith('(')?'':'pill-rec') + '\">' + u + '</span>').join(' ') + '</div></div>';
    }

    recDiv.innerHTML = html;

    const dbg = window.__lastDebug || null;
    if(dbg){
      const out=[];
      out.push(`Plan flavor: ${dbg.planFlavor}`);
      out.push(`RESP picks: ${respRows.map(r=>r.unit+'['+r.roleCap+']@'+r.st+'/'+r.rank).join(', ')}`);
      out.push(`IFC picks: ${ifcRows.map(r=>r.unit+'['+r.roleCap+']@'+r.st+'/'+r.rank).join(', ')}`);
      $('#dbg').textContent = out.join('\n');
    }
  });

  // Send dispatch => mark units CALL
  const btnSend = $('#btnSend');
  if (btnSend) btnSend.addEventListener('click', ()=>{
    const units = (window.__currentRecUnits||[]).slice();
    if(!units.length){ toast('Get a recommendation first.'); return; }
    for(const u of units){ CURRENT_STATUS[u] = 'CALL'; }
    saveStatus();
    toast('Sent: ' + units.join(', ') + ' (status → CALL)');
    $('#btnRecommend').click();
  });

  // Status modal buttons
  $('#btnStatus').addEventListener('click', openStatusModal);
  $('#btnCloseStatus').addEventListener('click', closeStatusModal);
  $('#btnResetStatus').addEventListener('click', resetDefaults);
}

window.addEventListener('DOMContentLoaded', main);
