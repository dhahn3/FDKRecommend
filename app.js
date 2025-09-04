
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
const CAPABILITY_ALIASES = {}; // keep empty; FK and K3000 are distinct
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
  const dbg = {esz, incident: $('#incidentSelect').value, steps: []};

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

  // 1) RESPONSE first
  
for(const g of groups){
  for(let i=0;i<g.qty;i++){
    // --- HM special-case: always include HM33, and if another HM is closer, include that as well ---
    if (g.caps.map(x => String(x).toUpperCase()).includes('HM') && i===0) {
      const hm33 = 'HM33';
      const orderStations = order.slice();
      // Prepare candidate list for HM in run-card order
      const hmCands = buildCandidatesByOrder(orderStations, ['HM'], used);
      // Try to add HM33 first if available & capable
      let hm33Added = false;
      if (ALL_UNITS.has(hm33) && hasCap(hm33,'HM') && !used.has(hm33)) {
        const hm33St = unitStation(hm33, orderStations);
        const hm33Rank = (hm33St!=null) ? stationRank(orderStations, hm33St) : Infinity;
        used.add(hm33);
        results.push({unit:hm33, roleCap:'HM', from:'RESP', st:hm33St, rank:hm33Rank});
        responseSelections.push({unit:hm33, roleCap:'HM', st:hm33St, rank:hm33Rank});
        hm33Added = true;
      }
      // Fill remaining required HM (if any)
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
      // Add an extra closer HM if one exists earlier in run-card order than HM33
      // (only if HM33 has a finite rank in this ESZ order)
      const hm33Sel = responseSelections.find(r => r.unit==='HM33' && r.roleCap==='HM');
      if (hm33Sel && Number.isFinite(hm33Sel.rank)) {
        const closer = hmCands.find(c => c.unit!=='HM33' && !used.has(c.unit) && c.rank < hm33Sel.rank);
        if (closer) {
          used.add(closer.unit);
          results.push({unit:closer.unit, roleCap:'HM', from:'RESP', st:closer.st, rank:closer.rank});
          responseSelections.push({unit:closer.unit, roleCap:'HM', st:closer.st, rank:closer.rank});
        }
      }
      // Skip normal handling for this HM group
      i = g.qty;
      continue;
    }
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
      let chosen=null;
      const cands = buildCandidatesByOrder(order, caps, used);
      dbg.steps.push({phase:'RESP', need:{qty:g.qty, caps:g.caps}, candidates:cands.slice(0,12), used:Array.from(used)});
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
    const addCands = buildCandidatesByOrder(order, [capRaw], used);
    dbg.steps.push({phase:'IFC', need:{qty:count, caps:[capRaw]}, candidates:addCands.slice(0,12), baselineRank});
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
        // IMPORTANT: Only drop items that were chosen to satisfy a BLS requirement (roleCap==='BLS')
        // Do NOT drop Engines (or any other role) even if the unit also advertises BLS.
        const isBLSfromDropStation = (r.roleCap === 'BLS') && (DATA.STATION_UNITS[dropSt]||[]).includes(r.unit);
        if(!isBLSfromDropStation) kept.push(r);
      }
      results.length=0; results.push(...kept);
    }
  }

  return results;

}

const VERSION = 'v-plan-order-1';
async function main(){
  let res;
  try{
    res = await fetch('data.json?v=' + VERSION);
    DATA = await res.json();
  }catch(e){
    alert('Failed to load data.json: ' + e.message);
    return;
  }

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

    // Split into RESP / IFC
    const respRows = rows.filter(r => r.from === 'RESP');
    const ifcRows  = rows.filter(r => r.from === 'IFC');

    // Build groups by cap (separately for RESP and IFC)
    const groupsResp = {};
    for (const r of respRows) {
      const cap = r.roleCap || 'OTHER';
      (groupsResp[cap] = groupsResp[cap] || []).push(r.unit);
    }
    const groupsIfc = {};
    for (const r of ifcRows) {
      const cap = r.roleCap || 'OTHER';
      (groupsIfc[cap] = groupsIfc[cap] || []).push(r.unit);
    }

    // Determine capability row order:
    // 1) Response plan order (using chosen cap when OR appears, else first cap)
    const incidentKey = document.querySelector('#incidentSelect').value;
    const plan = DATA.PLAN_STRUCT[incidentKey];
    const norm = s => String(s||'').toUpperCase().replace(/[^A-Z0-9]/g,'');
    const planRespOrder = [];
    for (const g of (plan?.groups || [])) {
      const capsNorm = (g.caps || []).map(norm);
      const picked = respRows.find(r => capsNorm.includes(norm(r.roleCap)));
      const key = picked ? picked.roleCap : (capsNorm[0] || 'OTHER');
      if (!planRespOrder.includes(key)) planRespOrder.push(key);
    }

    // 2) If-Closer caps after, first-seen
    const ifcCapsOrder = [];
    for (const r of ifcRows) {
      if (!planRespOrder.includes(r.roleCap) && !ifcCapsOrder.includes(r.roleCap)) ifcCapsOrder.push(r.roleCap);
    }

    // 3) Extras
    const extras = [];
    const allCapsSeen = new Set([...Object.keys(groupsResp), ...Object.keys(groupsIfc)]);
    for (const cap of allCapsSeen) {
      if (!planRespOrder.includes(cap) && !ifcCapsOrder.includes(cap)) extras.push(cap);
    }

    // Compute required counts per cap from the plan (using chosen cap for OR-groups)
    const requiredCounts = {};
    for (const g of (plan?.groups || [])) {
      const capsNorm = (g.caps || []).map(norm);
      const picked = respRows.find(r => capsNorm.includes(norm(r.roleCap)));
      const key = picked ? picked.roleCap : (capsNorm[0] || 'OTHER');
      requiredCounts[key] = (requiredCounts[key] || 0) + (g.qty || 1);
    }

    // Render
    let html = '<div class="muted">Recommendation (run card + add-on IfCloser):</div>';
    // RESPONSE rows: show placeholders if we filled fewer than required
    for (const key of planRespOrder) {
      const have = (groupsResp[key] || []).slice();
      const need = requiredCounts[key] || have.length;
      while (have.length < need) have.push('(' + key + ' needed)');
      html += '<div style="margin-top:6px;"><b>' + key + ':</b> <div class="units">' + have.map(u => '<span class="pill">' + u + '</span>').join(' ') + '</div></div>';
    }
    // IF-CLOSER rows (only actual units)
    for (const key of ifcCapsOrder) {
      const arr = groupsIfc[key];
      if (!arr || !arr.length) continue;
      html += '<div style="margin-top:6px;"><b>' + key + ' (If closer):</b> <div class="units">' + arr.map(u => '<span class="pill">' + u + '</span>').join(' ') + '</div></div>';
    }
    // EXTRAS (if any)
    for (const key of extras) {
      const arr = (groupsResp[key] || []).concat(groupsIfc[key] || []);
      if (!arr.length) continue;
      html += '<div style="margin-top:6px;"><b>' + key + ':</b> <div class="units">' + arr.map(u => '<span class="pill">' + u + '</span>').join(' ') + '</div></div>';
    }

    recDiv.innerHTML = html;
    const dbg = window.__lastDebug || null;
    if(dbg){
      const out=[];
      for(const s of dbg.steps){
        const caps = (s.need && s.need.caps) ? s.need.caps.join(' OR ') : '';
        out.push(`• ${s.phase}: need ${caps} x${(s.need && s.need.qty) || ''}`);
        const candText = (s.candidates||[]).map(c => `${c.unit}[${c.cap}]@${c.st}/${c.rank}`).join(', ');
        if(candText) out.push('   candidates: ' + candText);
        if(typeof s.baselineRank==='number') out.push('   baselineRank: ' + s.baselineRank);
      }
      document.querySelector('#dbg').textContent = out.join('\n');
    }


  });
}

window.addEventListener('DOMContentLoaded', main);
