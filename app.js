
// ESRI endpoints (only for ESZ lookup & geocoding user input)
const ESZ_URL = "https://fcgis.frederickcountymd.gov/server_pub/rest/services/PublicSafety/EmergencyESZ/MapServer/0";
const ADDR_URL = "https://fcgis.frederickcountymd.gov/server_pub/rest/services/Basemap/Addresses/MapServer/1";
const CENTERLINE_URL = "https://fcgis.frederickcountymd.gov/server_pub/rest/services/Basemap/Centerlines/MapServer/0";
const POI_URL = "https://fcgis.frederickcountymd.gov/server/rest/services/Basemap/Basemap/MapServer/18";

let DATA = null;
let map, pointMarker, eszLayer;

const $ = (s)=>document.querySelector(s);
function setMsg(el, text, cls='muted'){ el.className = cls; el.textContent = text; }
function toEsriPoint(lng, lat){ return {x:lng, y:lat, spatialReference:{wkid:4326}}; }
async function fetchJSON(url){ const r = await fetch(url); if(!r.ok) throw new Error('HTTP '+r.status); return r.json(); }
function encodeParams(p){ return Object.entries(p).map(([k,v])=>k+'='+encodeURIComponent(v)).join('&'); }
function addPoint(latlng){ if(pointMarker) map.removeLayer(pointMarker); pointMarker=L.marker(latlng).addTo(map); }
function normalizeStationId(id){ const s=String(id||''); const m=s.match(/(\d{3})$/); return m?m[1]:s; }

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

// Run-card-only candidate building: rank = index in station order
function stationRank(eszOrder, st){ return eszOrder.findIndex(v => normalizeStationId(v)===st); }

function buildCandidatesByOrder(eszOrder, capsNeeded, usedUnits){
  const cand = []; // {unit, cap, st, rank}
  for(const stRaw of eszOrder){
    const st = normalizeStationId(stRaw);
    const units = (DATA.STATION_UNITS[st]||[]).slice();
    const rank = stationRank(eszOrder, st);
    for(const u of units){
      if(usedUnits.has(u)) continue;
      const caps = DATA.UNIT_CAPS[u] || [];
      for(const cap of capsNeeded){
        if(caps.includes(cap)){
          cand.push({unit:u, cap, st, rank});
        }
      }
    }
  }
  cand.sort((a,b)=> a.rank - b.rank); // strictly by run card order
  return cand;
}

// Recommendation using only run card order.
// If Closer rule here = earlier station rank in run card order.
function recommendUnitsRunCardOnly(esz){
  const order = (DATA.ESZ_ORDER[esz]||[]).map(normalizeStationId);
  const incidentKey = $('#incidentSelect').value;
  const plan = DATA.PLAN_STRUCT[incidentKey];
  if(!plan) return [];
  const groups = plan.groups || [];
  const ifCloserCounts = Object.assign({}, plan.ifCloser || {});
  const used = new Set();
  const out = [];

  const unknown = new Set();
  for(const g of groups) g.caps.forEach(c => { if(!DATA.CAP_VOCAB.includes(c) && c!=='BC') unknown.add(c); });
  Object.keys(ifCloserCounts||{}).forEach(c => { if(!DATA.CAP_VOCAB.includes(c)) unknown.add(c); });
  $('#vocabWarn').style.display = unknown.size ? 'block' : 'none';
  $('#vocabWarn').textContent = unknown.size ? ('Unknown capability tokens (not in your capability sheet): ' + Array.from(unknown).join(', ')) : '';

  for(const g of groups){
    for(let i=0;i<g.qty;i++){
      let chosen = '';

      if(g.caps.includes('BC')){
        const bcUnits = DATA.BC_UNITS.filter(u=>!used.has(u));
        // Scan stations in order, pick the first station containing an available BC unit
        let picked = null;
        for(const stRaw of order){
          const st = normalizeStationId(stRaw);
          const units = DATA.STATION_UNITS[st] || [];
          const present = units.find(u => bcUnits.includes(u));
          if(present){ picked = present; break; }
        }
        if(picked){ chosen = picked; used.add(chosen); }
        out.push(chosen || '(BC needed)');
        continue;
      }

      // Primary: first by station order among allowed caps
      const primaryCaps = g.caps.filter(c => DATA.CAP_VOCAB.includes(c));
      const primaryCands = primaryCaps.length ? buildCandidatesByOrder(order, primaryCaps, used) : [];
      const bestPrimary = primaryCands[0] || null;
      const bestPrimaryRank = bestPrimary ? bestPrimary.rank : Infinity;

      // IfCloser: first by station order among allowed alt caps (with remaining counts)
      const altCaps = Object.entries(ifCloserCounts).filter(([cap,cnt])=>cnt>0 && DATA.CAP_VOCAB.includes(cap)).map(([cap,_])=>cap);
      const altCands = altCaps.length ? buildCandidatesByOrder(order, altCaps, used) : [];
      const bestAlt = altCands[0] || null;
      const bestAltRank = bestAlt ? bestAlt.rank : Infinity;

      // Decide: pick alt only if it appears at an earlier station index than primary
      if(bestAlt && bestAltRank < bestPrimaryRank){
        chosen = bestAlt.unit; used.add(chosen); ifCloserCounts[bestAlt.cap] = (ifCloserCounts[bestAlt.cap]||1) - 1;
      } else if(bestPrimary){
        chosen = bestPrimary.unit; used.add(chosen);
      } else {
        chosen = '(' + (g.caps.join(' OR ')) + ' needed)';
      }
      out.push(chosen);
    }
  }
  return out;
}

async function main(){
  try{
    const res = await fetch('data.json'); DATA = await res.json();
  }catch(e){
    alert('Failed to load data.json: ' + e.message);
    return;
  }

  // Map setup (for locating & ESZ only)
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
      $('#ifCloserView').innerHTML = ifcList ? ('If closer (by run card order): ' + ifcList + ' <span class="badge">Run card priority</span>') : '';
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
    const units = recommendUnitsRunCardOnly(esz);
    recDiv.innerHTML = '<div class="muted">Recommendation (run card order only):</div>' +
      '<div class="units">'+ units.map(u=>'<span class="pill">'+u+'</span>').join(' ') + '</div>';
  });
}

window.addEventListener('DOMContentLoaded', main);
