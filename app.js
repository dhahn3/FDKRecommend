
const banner=()=>document.getElementById('banner');
window.addEventListener('error',e=>{if(banner()){banner().className='warn';banner().textContent='JS error: '+(e.message||e)}});
window.addEventListener('unhandledrejection',e=>{if(banner()){banner().className='warn';banner().textContent='Promise error: '+(e.reason&&e.reason.message?e.reason.message:e.reason)}});

let DATA=null, MAP, MARKER, CURRENT_ESZ=null;
const STATUS=new Map(), DEFAULT_STATUS=new Map(), USER_CAPS=new Map();
const normCap=c=>String(c||'').toUpperCase().trim();
const trailing=d=>String(d||'').match(/(\d{3})$/)?.[1]||null;
const mutualAidEnabled=()=>document.getElementById('mutualAid').checked;

function effectiveCaps(u){const base=new Set((DATA?.UNIT_CAPS?.[u]||[]).map(normCap));if(USER_CAPS.has(u)){for(const c of USER_CAPS.get(u)) base.add(normCap(c));}return Array.from(base)}
function isAvailable(u){return (STATUS.get(u)||DATA?.UNIT_STATUS?.[u]||'AQ')==='AQ'}
function isStationAllowed(st){if(mutualAidEnabled()) return true; const d=trailing(st); return d?d[0]==='9':false}
function stationUnits(st){const s=String(st||'').toUpperCase(); const d=trailing(s); const a=(DATA?.STATION_UNITS?.[s])||[]; const b=d?((DATA?.STATION_UNITS?.[d])||[]):[]; return Array.from(new Set([...a,...b]))}

const SU_PREF=new Set(['909','921','913']);
function buildCandidatesByOrder(order, caps, used){
  const want=(caps||[]).map(normCap); const out=[];
  order.forEach((st,idx)=>{
    if(!isStationAllowed(st)) return;
    let units=stationUnits(st);
    const onlyBLS=want.length===1 && want[0]==='BLS';
    const d=trailing(st);
    if(onlyBLS && SU_PREF.has(d||st)){ const su=units.filter(u=>/^SU\d+$/i.test(u)); const rest=units.filter(u=>!/^SU\d+$/i.test(u)); units=su.concat(rest); }
    for(const u of units){ if(used?.has(u)) continue; if(!isAvailable(u)) continue; const capsU=effectiveCaps(u); for(const c of want){ if(capsU.includes(c)){ out.push({unit:u,cap:c,rank:idx,st}); } } }
  }); out.sort((a,b)=>a.rank-b.rank); return out;
}
function pickForCap(cap, order, used){return buildCandidatesByOrder(order,[cap],used)[0]||null}
function maybeAddDD(out,order,used){const eIdx=out.findIndex(x=>x.cap==='E'); if(eIdx<0) return; const firstE=out[eIdx]; const dd=buildCandidatesByOrder(order,['DD'],used).filter(x=>x.rank<firstE.rank); for(const d of dd){ if(!out.some(x=>x.unit===d.unit)) out.push(d); used.add(d.unit); const nextE=pickForCap('E',order,used); if(nextE){ out.push(nextE); used.add(nextE.unit);} } }
function maybeAddDDK(out,order,used){const kIdx=out.findIndex(x=>x.cap==='K'); if(kIdx<0) return; const firstK=out[kIdx]; const ddk=buildCandidatesByOrder(order,['DDK'],used).filter(x=>x.rank<firstK.rank); for(const d of ddk){ if(!out.some(x=>x.unit===d.unit)) out.push(d); used.add(d.unit); const nextK=pickForCap('K',order,used); if(nextK){ out.push(nextK); used.add(nextK.unit);} } }
function enforceHM33(out,eszKey,used){if(!out.some(x=>x.cap==='HM')) return; if(String(eszKey||'').startsWith('50')) return; if(DATA?.UNIT_CAPS?.HM33 && isAvailable('HM33') && effectiveCaps('HM33').includes('HM')){ if(!out.some(x=>x.unit==='HM33')){ out.push({unit:'HM33',cap:'HM',rank:-1,st:'FIRE/033'}); used.add('HM33'); } } }
function suppressBLS(out){const a=out.filter(x=>x.cap==='A').map(x=>x.unit); const drop=new Set(); if(a.some(u=>/^A?924/.test(u)||/A?29/.test(u))) drop.add('911'); if(a.some(u=>/^A?930/.test(u)||/A?30/.test(u))) drop.add('910'); if(!drop.size) return out; return out.filter(x=>!(x.cap==='BLS' && Array.from(drop).some(s=>x.unit.includes(s))))}

function pill(t){const s=document.createElement('span'); s.className='pill blue'; s.textContent=t; return s}
function row(lbl,arr){const d=document.createElement('div'); d.style.margin='10px 0'; const h=document.createElement('div'); h.textContent=lbl+':'; d.appendChild(h); const box=document.createElement('div'); box.className='pills'; arr.forEach(t=>box.appendChild(pill(t))); d.appendChild(box); return d}

function recommend(){
  const dbg=[]; const out=[]; const used=new Set();
  const planKey=document.getElementById('incident').value;
  const plan=DATA?.PLAN_STRUCT?.[planKey];
  const eszKey=CURRENT_ESZ || Object.keys(DATA.ESZ_ORDER||{})[0];
  const eszOrder=(DATA?.ESZ_ORDER?.[eszKey])||[];
  if(!plan) throw new Error('No plan for '+planKey);
  if(!eszOrder.length) throw new Error('No station order for ESZ '+eszKey);

  const sequence=[]; (plan.groups||[]).forEach(g=>{const qty=Number(g.qty)||1;const caps=(g.caps||[]).map(normCap); for(let i=0;i<qty;i++) sequence.push(...caps)});
  for(const cap of sequence){ const pick=pickForCap(cap,eszOrder,used); if(pick){ out.push(pick); used.add(pick.unit); dbg.push(`pick ${cap}: ${pick.unit} @ ${pick.st}`); } else { dbg.push(`(need ${cap})`); } }
  for(const cap of (plan.ifCloser||[]).map(normCap)){ const add=pickForCap(cap,eszOrder,used); if(add){ out.push(add); used.add(add.unit); dbg.push(`ifCloser ${cap}: ${add.unit}`); } else { dbg.push(`(ifCloser need ${cap})`); } }

  maybeAddDD(out,eszOrder,used); maybeAddDDK(out,eszOrder,used); enforceHM33(out,eszKey,used);
  const out2=suppressBLS(out);

  const groups={}; sequence.concat((plan.ifCloser||[]).map(normCap)).forEach(c=>{groups[c]=groups[c]||[]});
  for(const r of out2){ (groups[r.cap]=groups[r.cap]||[]).push(r.unit); }
  const rec=document.getElementById('rec'); rec.innerHTML='';
  document.getElementById('planTxt').textContent='Plan: '+(plan.groups||[]).map(g=>`${g.qty}× ${g.caps.join(' OR ')}`).join(', ')+((plan.ifCloser||[]).length?` — If closer: ${(plan.ifCloser||[]).join(', ')}`:'');
  Object.entries(groups).forEach(([cap,units])=>{ if(units&&units.length) rec.appendChild(row(cap,units)); });
  document.getElementById('dbg').textContent=dbg.join('\\n');
}

function openStatus(){
  const modal=document.getElementById('statusModal'); const grid=document.getElementById('statusGrid'); grid.innerHTML='';
  const by=new Map(); for(const [k,arr] of Object.entries(DATA.STATION_UNITS||{})){ const d=trailing(k)||k; const g=by.get(d)||[]; for(const u of arr){ if(!g.includes(u)) g.push(u);} by.set(d,g); }
  const stations=Array.from(by.keys()).sort();
  for(const st of stations){ const h=document.createElement('h3'); h.textContent='Station '+st; grid.appendChild(h); const box=document.createElement('div'); box.style.gridColumn='span 2'; grid.appendChild(box); const units=(by.get(st)||[]).sort(); for(const u of units){ const badge=document.createElement('span'); badge.className='badge'; const name=document.createElement('b'); name.textContent=u; badge.appendChild(name); const stSel=document.createElement('select'); ['AQ','PA','CALL'].forEach(s=>{const o=document.createElement('option'); o.value=s;o.text=s; stSel.appendChild(o);}); stSel.value=STATUS.get(u)||DATA?.UNIT_STATUS?.[u]||'AQ'; stSel.onchange=()=>STATUS.set(u, stSel.value); badge.appendChild(stSel); const capInput=document.createElement('input'); capInput.placeholder='add cap'; capInput.size=6; const add=document.createElement('button'); add.className='secondary'; add.textContent='Add'; add.onclick=()=>{ const val=normCap(capInput.value); if(val){ const caps=new Set(USER_CAPS.get(u)||effectiveCaps(u)); caps.add(val); USER_CAPS.set(u,caps); capInput.value=''; } }; badge.appendChild(capInput); badge.appendChild(add); const capSpan=document.createElement('span'); capSpan.className='cap'; capSpan.textContent=' '+effectiveCaps(u).join(','); badge.appendChild(capSpan); box.appendChild(badge);} }
  modal.setAttribute('aria-hidden','false');
}
function sendDispatch(){ const units=Array.from(document.querySelectorAll('#rec .pill')).map(el=>el.textContent); for(const u of units){ STATUS.set(u,'CALL'); } const b=banner(); if(b){b.className='ok';b.textContent='Dispatch sent: '+units.join(', ');} }
function setESZ(key){ CURRENT_ESZ=key; document.getElementById('esz').textContent=key||'—'; const order=(DATA?.ESZ_ORDER?.[key])||[]; document.getElementById('stationOrder').textContent=order.length?'Station order: '+order.join(' → '):'Station order: (none)'; }

async function boot(){
  try{ const r=await fetch('data.json?v=v53'); if(!r.ok) throw new Error(r.status); DATA=await r.json(); }catch(e){ DATA={"ESZ_ORDER":{"0501":["905","919","920","612","928","FIRE/JC01","FIRE/WC08","914","913","911"]},"PLAN_STRUCT":{"HOUSE":{"groups":[{"qty":6,"caps":["E"]},{"qty":1,"caps":["FS"]},{"qty":1,"caps":["AERIAL"]},{"qty":1,"caps":["SS"]},{"qty":3,"caps":["K"]},{"qty":1,"caps":["A"]},{"qty":1,"caps":["ALS"]},{"qty":2,"caps":["BC"]},{"qty":1,"caps":["SAF"]}],"ifCloser":["BLS"]},"ABDOMALS":{"groups":[{"qty":1,"caps":["A"]},{"qty":1,"caps":["ALS"]}],"ifCloser":["BLS"]}},"UNIT_CAPS":{"E51":["E"],"E201":["E"],"E612":["E"],"E281":["E"],"E121":["E"],"E141":["E"],"R19":["FS"],"Q11":["AERIAL"],"R20":["SS"],"EK204":["K"],"K612":["K"],"K22":["K"],"A169":["A"],"ALS17":["ALS"],"BC902":["BC"],"BC901":["BC"],"SAF901":["SAF"],"E161":["DD"],"K9":["DDK"],"HM33":["HM"],"ALS20":["ALS"],"E291":["BLS"],"SU9":["BLS"]},"STATION_UNITS":{"905":["E51","A196"],"912":["BC902"],"929":["BC901"],"913":["ALS20","SU9"],"612":["E612","K612"],"928":["K22"],"920":["EK204"],"919":["R19"],"920b":["R20"],"911":["E201","E121"],"914":["E281"],"910":["E141"],"931":["SAF901"],"FIRE/033":["HM33"],"FIRE/WC08":["E161"],"FIRE/JC01":["Q11"]},"UNIT_STATUS":{}}; }
  for(const u of Object.keys(DATA.UNIT_CAPS||{})){ STATUS.set(u, DATA?.UNIT_STATUS?.[u]||'AQ'); DEFAULT_STATUS.set(u, DATA?.UNIT_STATUS?.[u]||'AQ'); }
  try{ MAP=L.map('map').setView([39.414,-77.410],11); L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png',{maxZoom:19,attribution:'© OpenStreetMap contributors'}).addTo(MAP); MAP.on('click',e=>{ if(MARKER) MARKER.remove(); MARKER=L.marker(e.latlng).addTo(MAP); }); }catch(err){ console.warn('Map init failed',err); }
  const inc=document.getElementById('incident'); inc.innerHTML=''; Object.keys(DATA.PLAN_STRUCT||{}).sort().forEach(k=>{const o=document.createElement('option'); o.value=o.textContent=k; inc.appendChild(o);});
  const eszSel=document.getElementById('eszSelect'); eszSel.innerHTML=''; Object.keys(DATA.ESZ_ORDER||{}).forEach(k=>{const o=document.createElement('option'); o.value=o.textContent=k; eszSel.appendChild(o);}); setESZ(Object.keys(DATA.ESZ_ORDER||{})[0]);
  document.getElementById('btnRec').onclick=()=>{ try{recommend(); if(banner()){banner().className='ok';banner().textContent='Ready';}}catch(err){if(banner()){banner().className='warn';banner().textContent='Recommendation failed: '+(err.message||err)}} };
  document.getElementById('btnDispatch').onclick=sendDispatch; document.getElementById('btnStatus').onclick=openStatus; document.getElementById('closeStatus').onclick=()=>document.getElementById('statusModal').setAttribute('aria-hidden','true'); document.getElementById('resetCaps').onclick=()=>{USER_CAPS.clear(); STATUS.clear(); for(const [u,v] of DEFAULT_STATUS.entries()) STATUS.set(u,v); openStatus();}; document.getElementById('setEsz').onclick=()=>setESZ(document.getElementById('eszSelect').value||null);
  if(banner()){banner().className='ok';banner().textContent='Ready';}
}
boot();
