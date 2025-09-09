
(function(){
  const w = document.getElementById('loadWarn');
  if(w){ w.style.display='block'; w.textContent='JS loaded — initializing…'; }
})();

let DATA={ESZ_ORDER:{}, PLAN_STRUCT:{}, NON_HYDRANT_ESZ:[], UNIT_CAPS:{}, STATION_UNITS:{}, BC_UNITS:[], UNIT_STATUS:{}};
function ensureFallbackPlans(){
  if(!DATA || !DATA.PLAN_STRUCT || Object.keys(DATA.PLAN_STRUCT).length===0){
    DATA.PLAN_STRUCT = {
      "HOUSE": { groups:[
        {qty:6, caps:["E"]}, {qty:1, caps:["FS"]}, {qty:1, caps:["AERIAL"]},
        {qty:1, caps:["SS"]}, {qty:3, caps:["K"]}, {qty:1, caps:["A"]},
        {qty:1, caps:["ALS"]}, {qty:2, caps:["BC"]}, {qty:1, caps:["SAF"]}
      ], ifCloser:["BLS"]},
      "ABDOMALS": { groups:[ {qty:1, caps:["A"]}, {qty:1, caps:["ALS"]} ], ifCloser:["BLS"]}
    };
    const w=document.getElementById('loadWarn');
    if(w){ w.className='ok'; w.textContent='Ready (using FALLBACK incident list)'; }
  }
}

async function boot(){
  const w=document.getElementById('loadWarn');
  try{
    const resp = await fetch('data.json?v=51');
    if(resp.ok){ DATA = await resp.json(); if(w){ w.className='ok'; w.textContent='Ready (data.json loaded)'; } }
    else { ensureFallbackPlans(); }
  }catch(_){ ensureFallbackPlans(); }

  // Minimal: populate incident dropdown
  const sel = document.getElementById('incident');
  sel.innerHTML = '';
  for(const k of Object.keys(DATA.PLAN_STRUCT)){ const o=document.createElement('option'); o.value=o.textContent=k; sel.appendChild(o); }
  if(sel.options.length===0){ const o=document.createElement('option'); o.text= '—'; sel.appendChild(o); }

  // Wire buttons
  document.getElementById('btnSelfTest').addEventListener('click', selfTest);
  document.getElementById('btnRec').addEventListener('click', ()=>{
    const k=sel.value;
    const plan=DATA.PLAN_STRUCT[k];
    const out=document.getElementById('rec');
    out.innerHTML='';
    if(!plan){ out.textContent='No plan for '+k; return; }
    const list=document.createElement('div');
    list.innerHTML = '<div class=\"small\">Plan (capabilities only):</div>';
    for(const g of plan.groups){ const pill=document.createElement('span'); pill.className='pill'; pill.textContent = `${(g.qty||1)}× ${g.caps.join(\" OR \")}`; list.appendChild(pill); }
    out.appendChild(list);
  });

  // Map
  try{
    const map = L.map('map').setView([39.414,-77.410], 11);
    L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png',{maxZoom:19,attribution:'© OpenStreetMap contributors'}).addTo(map);
  }catch(err){ if(w){ w.className='warn'; w.textContent='Map init failed: '+(err.message||err); } }
}

function selfTest(){
  const lines=[];
  lines.push('Incident options: '+Object.keys(DATA.PLAN_STRUCT).length);
  lines.push('Has ESZ_ORDER: '+(DATA.ESZ_ORDER && Object.keys(DATA.ESZ_ORDER).length));
  lines.push('Has UNIT_CAPS: '+(DATA.UNIT_CAPS && Object.keys(DATA.UNIT_CAPS).length));
  document.getElementById('dbg').textContent = lines.join('\n');
  alert('Self test ran. See Debug section for details.');
}

window.addEventListener('error', e=>{ const w=document.getElementById('loadWarn'); if(w){w.className='warn'; w.textContent='JS error: '+(e.message||'see console');}});
window.addEventListener('unhandledrejection', e=>{ const w=document.getElementById('loadWarn'); if(w){w.className='warn'; w.textContent='Promise rejection: '+(e.reason && e.reason.message ? e.reason.message : e.reason);}});

boot();
