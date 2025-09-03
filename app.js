
// ESRI endpoints (for locating & ESZ; no routing used)
const ESZ_URL = "https://fcgis.frederickcountymd.gov/server_pub/rest/services/PublicSafety/EmergencyESZ/MapServer/0";
const ADDR_URL = "https://fcgis.frederickcountymd.gov/server_pub/rest/services/Basemap/Addresses/MapServer/1";
const CENTERLINE_URL = "https://fcgis.frederickcountymd.gov/server_pub/rest/services/Basemap/Centerlines/MapServer/0";
const POI_URL = "https://fcgis.frederickcountymd.gov/server/rest/services/Basemap/Basemap/MapServer/18";

let DATA = null;

// ---- Capability normalization helpers ----
function normCap(s){ return String(s||'').toUpperCase().replace(/[^A-Z0-9]/g,''); }
function hasCap(unit, cap){
  const caps = (DATA.UNIT_CAPS[unit]||[]).map(normCap);
  return caps.includes(normCap(cap));
}
// Optional alias map (we keep empty since FK and K3000 are distinct per user)
const CAPABILITY_ALIASES = {};
function expandTokens(list){
  const out=[];
  for(const t of (list||[])){
    const x = String(t).toUpperCase();
    if(CAPABILITY_ALIASES[x]) out.push(...CAPABILITY_ALIASES[x]);
    else out.push(x);
  }
  return out;
}

let map, pointMarker, eszLayer;
const $ = (s)=>document.querySelector(s);
function setMsg(el, text, cls='muted'){ el.className = cls; el.textContent = text; }
function toEsriPoint(lng, lat){ return {x:lng, y:lat, spatialReference:{wkid:4326}}; }
async function fetchJSON(url){ const r = await fetch(url); if(!r.ok) throw new Error('HTTP '+r.status); return r.json(); }
function encodeParams(p){ return Object.entries(p).map(([k,v])=>k+'='+encodeURIComponent(v)).join('&'); }
function addPoint(latlng){ if(pointMarker) map.removeLayer(pointMarker); pointMarker=L.marker(latlng).addTo(map); }
function normalizeStationId(id){ const s=String(id||''); const m=s.match(/(\d{3})$/); return m?m[1]:s; }

// SU preference (BLS only) at these stations
const SU_PREF_STATIONS = new Set(['909','921','913']);

// Locate helpers
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

// ESZ lookup
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
  eszLayer.clearLayers();
  const rings = feature.geometry.rings.map(r=>r.map(([x,y])=>[x,y]));
  eszLayer.addData({type:'Feature', properties:feature.attributes, geometry:{type:'Polygon', coordinates:rings}});
  map.fitBounds(eszLayer.getBounds(), {padding:[20,20]});
  const attrs = feature.attributes||{};
  const esz = (attrs.ESZ ?? attrs.esz ?? '').toString().padStart(4,'0');
  $('#eszInfo').textContent = esz || '—';
  const order = DATA.ESZ_ORDER[esz] || [];
  $('#eszOrder').textContent = order.length ? ('Station order: ' + order.join(' → ')) : 'No station order on file.';
}

// Ranking
function stationRank(eszOrder, st){ return eszOrder.findIndex(v => normalizeStationId(v)===st); }

function buildCandidatesByOrder(eszOrder, capsNeeded, usedUnits){
  const cand = []; // {unit, cap, st, rank}
  const capsNeededNorm = (capsNeeded||[]).map(normCap);
  for(const stRaw of eszOrder){
    const st = normalizeStationId(stRaw);
    let units = (DATA.STATION_UNITS[st]||[]).slice();
    const rank = stationRank(eszOrder, st);
    // Preference: BLS-only asks at stations 909/921/913 prioritize SUxx
    const wantsOnlyBLS = Array.isArray(capsNeeded) && capsNeeded.length===1 && normCap(capsNeeded[0])==='BLS';
    if(wantsOnlyBLS && SU_PREF_STATIONS.has(st)){
      const suFirst = units.filter(u=>/^SU\\d+$/i.test(u));
      const rest = units.filter(u=>!/^SU\\d+$/i.test(u));
      units = suFirst.concat(rest);
    }
    for(const u of units){
      if(usedUnits.has(u)) continue;
      const capsNorm = (DATA.UNIT_CAPS[u] || []).map(normCap);
      for(const cap of capsNeeded){
        if(capsNorm.includes(normCap(cap))){
          cand.push({unit:u, cap:cap, st, rank});
        }
      }
    }
  }
  cand.sort((a,b)=> a.rank - b.rank); // strictly by run card order
  return cand;
}

function unitStation(unit, eszOrder){
  for(const stRaw of eszOrder){
    const st = normalizeStationId(stRaw);
    const arr = DATA.STATION_UNITS[st]||[];
    if(arr.includes(unit)) return st;
  }
  return null;
}

// Recommendation (run card + add-on IfCloser; anchored to Ambulance if present)
// Returns array of {unit, roleCap, from, st, rank}
function recommendUnitsRunCard_Additive(esz){
  const order = (DATA.ESZ_ORDER[esz]||[]).map(normalizeStationId);
  const incidentKey = $('#incidentSelect').value;
  const plan = DATA.PLAN_STRUCT[incidentKey];
  if(!plan) return [];
  const groups = plan.groups || [];
  const ifCloserCounts = Object.assign({}, plan.ifCloser || {});
  const used = new Set();
  const results = []; // {unit, roleCap, from:'RESP'|'IFC', st, rank}
  const responseSelections = []; // keep details for baseline/anchors

  // Unknown token banner (normalized presence test)
  const tokenExists = (tok)=>{
    const T = normCap(tok);
    for(const arr of Object.values(DATA.STATION_UNITS)){
      for(const u of arr){
        const caps = (DATA.UNIT_CAPS[u]||[]).map(normCap);
        if(caps.includes(T)) return true;
      }
    }
    return false;
  };
  const unknown = new Set();
  for(const g of groups) g.caps.forEach(c => { if(!tokenExists(c) && c!=='BC') unknown.add(c); });
  Object.keys(ifCloserCounts||{}).forEach(c => { if(!tokenExists(c)) unknown.add(c); });
  $('#vocabWarn').style.display = unknown.size ? 'block' : 'none';
  $('#vocabWarn').textContent = unknown.size ? ('Unknown capability tokens (no unit advertises: ' + Array.from(unknown).join(', ')+')') : '';

  // 1) RESPONSE first (supports OR, qty, and normalized matching)
  for(const g of groups){
    for(let i=0;i<g.qty;i++){
      if(g.caps.includes('BC')){
        const bcUnits = (DATA.BC_UNITS||[]).filter(u=>!used.has(u));
        let picked=null, pickedSt=null, pickedRank=Infinity;
        for(const [idx, stRaw] of order.entries()){
          const st = normalizeStationId(stRaw);
          const units = DATA.STATION_UNITS[st] || [];
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
      // Capability OR group
      const caps = g.caps.slice();
      // Choose first station/first unit that satisfies any cap in order
      let chosen=null;
      const cands = buildCandidatesByOrder(order, caps, used);
      if(cands.length){
        chosen = cands[0];
        used.add(chosen.unit);
        results.push({unit:chosen.unit, roleCap:normCap(chosen.cap), from:'RESP', st:chosen.st, rank:chosen.rank});
        responseSelections.push({unit:chosen.unit, roleCap:normCap(chosen.cap), st:chosen.st, rank:chosen.rank});
      } else {
        results.push({unit:'('+caps.join(' OR ')+' needed)', roleCap:normCap(caps[0]||'OTHER'), from:'RESP', st:null, rank:Infinity});
      }
    }
  }

  // Establish ambulance anchor rank (or earliest response if no A)
  const ambResponses = responseSelections.filter(sel => hasCap(sel.unit,'A'));
  let baselineRank = ambResponses.length ? Math.min(...ambResponses.map(s=>s.rank)) : Infinity;
  if(baselineRank===Infinity){
    for(const sel of responseSelections){ if(sel.rank < baselineRank) baselineRank = sel.rank; }
  }

  // 2) IF-CLOSER ADD-ONS
  for(const [capRaw, count] of Object.entries(ifCloserCounts)){
    let remaining = count;
    const capNorm = normCap(capRaw);
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

  // 3) BLS EXCEPTIONS after selections
  const ambSel = ambResponses[0] || null;
  if(ambSel){
    const ambSt = ambSel.st;
    if(ambSt === '924' || ambSt === '930'){
      const dropSt = ambSt==='924' ? '911' : '910';
      const kept=[];
      for(const r of results){
        const isBLSfromDrop = (r.from && r.unit && hasCap(r.unit, 'BLS') && (DATA.STATION_UNITS[dropSt]||[]).includes(r.unit));
        if(!isBLSfromDrop) kept.push(r);
      }
      results.length=0; results.push(...kept);
    }
  }

  return results;
}

const VERSION = 'v-fk-k3000-1';
async function main(){
  let res;
  try{
    res = await fetch('data.json?v=' + VERSION);
    DATA = await res.json();
  }catch(e){
    alert('Failed to load data.json: ' + e.message);
    return;
  }
  window.ALL_UNITS = new Set(Object.values(DATA.STATION_UNITS).flat());

  // Map (no routing used)
  map = L.map('map').setView([39.414, -77.410], 11);
  L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png', {maxZoom:19, attribution:'© OpenStreetMap contributors'}).addTo(map);
  eszLayer = L.geoJSON(null, {style: {color:'#ef4444', weight:3, fillOpacity:0.15}}).addTo(map);

  // Incident select
  const sel = $('#incidentSelect');
  const keys = Object.keys(DATA.PLAN_STRUCT).sort();
  if(!keys.length){ sel.innerHTML = '<option value="">(no plans loaded)</option>'; }
  else {
    sel.innerHTML = keys.map(k=>`<option value="${k}">${k}</option>`).join('');
    sel.value = keys[0];
    const updateView = ()=>{
      const plan = DATA.PLAN_STRUCT[sel.value];
      const groups = plan?.groups || [];
      const ifc = plan?.ifCloser || {};
      $('#planRoles').textContent = 'Plan: ' + groups.map(g => (g.qty>1?g.qty+'× ':'') + g.caps.join(' OR ')).join(', ');
      const ifcList = Object.entries(ifc).map(([k,v])=> v>1? (v+'× '+k) : k).join(', ');
      $('#ifCloserView').innerHTML = ifcList ? ('If closer <b>(add-on by run card order)</b>: ' + ifcList) : '';
    };
    sel.addEventListener('change', updateView);
    updateView();
  }

  // Map click
  map.on('click', async (e)=>{
    window.__incidentPoint = [e.latlng.lat, e.latlng.lng];
    addPoint(window.__incidentPoint);
    setMsg($('#geocodeMsg'), `Point: ${e.latlng.lat.toFixed(6)}, ${e.latlng.lng.toFixed(6)}`, 'muted');
    try{ const eszFeat=await fetchESZForPoint(e.latlng.lat,e.latlng.lng); showESZ(eszFeat); }
    catch(err){ setMsg($('#geocodeMsg'), err.message, 'muted'); }
  });

  // Search UI
  $('#btnSearch').addEventListener('click', async ()=>{
    const mode=$('#searchMode').value; const q=$('#query').value.trim();
    if(!q){ setMsg($('#geocodeMsg'),'Enter a search','muted'); return; }
    setMsg($('#geocodeMsg'),'Searching…');
    try{
      let latlng;
      if(mode==='address') latlng=await locateByAddress(q);
      else if(mode==='poi') latlng=await locateByPOI(q);
      else latlng=await locateByIntersection(q);
      window.__incidentPoint = latlng;
      addPoint(latlng);
      setMsg($('#geocodeMsg'),`Found: ${latlng[0].toFixed(6)}, ${latlng[1].toFixed(6)}`,'muted');
      const eszFeat=await fetchESZForPoint(latlng[0],latlng[1]);
      showESZ(eszFeat);
    }catch(e){ setMsg($('#geocodeMsg'), e.message||'Search failed','muted'); $('#eszInfo').textContent='—'; $('#eszOrder').textContent=''; eszLayer.clearLayers(); }
  });

  $('#btnRecommend').addEventListener('click', ()=>{
    const esz=$('#eszInfo').textContent.trim();
    const recDiv=$('#rec');
    if(!esz || esz==='—'){ recDiv.innerHTML='<div class="muted">Locate a point first to get ESZ.</div>'; return; }
    const rows = recommendUnitsRunCard_Additive(esz);

    // Vertical grouped rendering by role capability
    const order = ['BC','E','ALS','A','BLS','PE','RS','TANKER','BRUSH','K3000','FK','OTHER'];
    const groups = {};
    for(const r of rows){
      const key = r.roleCap || 'OTHER';
      (groups[key] = groups[key] || []).push(r.unit);
    }
    let html = '<div class="muted">Recommendation (run card + add-on IfCloser):</div>';
    for(const key of order){
      if(!groups[key] || !groups[key].length) continue;
      html += '<div style="margin-top:6px;"><b>'+key+':</b> <div class="units">'+groups[key].map(u=>'<span class="pill">'+u+'</span>').join(' ') + '</div></div>';
    }
    recDiv.innerHTML = html;
  });
}

window.addEventListener('DOMContentLoaded', main);
