
(function(){ var w=document.getElementById('loadWarn'); if(w){ w.textContent='JS loaded — initializing…'; } })();

window.DATA={PLAN_STRUCT:{}};
function ensureFallback(){
  if(!DATA.PLAN_STRUCT || Object.keys(DATA.PLAN_STRUCT).length===0){
    DATA.PLAN_STRUCT={ "HOUSE":{groups:[{qty:1,caps:["E"]},{qty:1,caps:["A"]}], ifCloser:["BLS"]}, "ABDOMALS":{groups:[{qty:1,caps:["A"]},{qty:1,caps:["ALS"]}], ifCloser:["BLS"]} };
    var w=document.getElementById('loadWarn'); if(w){w.className='ok'; w.textContent='Ready (fallback incidents)';}
  }
}
async function boot(){
  try{
    const r=await fetch('data.json?v=52c'); if(r.ok){ DATA=await r.json(); var w=document.getElementById('loadWarn'); if(w){ w.className='ok'; w.textContent='Ready (data.json loaded)'; } }
    else { ensureFallback(); }
  }catch(e){ ensureFallback(); }
  const sel=document.getElementById('incident'); sel.innerHTML='';
  Object.keys(DATA.PLAN_STRUCT||{}).forEach(k=>{ var o=document.createElement('option'); o.text=k; o.value=k; sel.appendChild(o); });
  document.getElementById('btnSelfTest').onclick=function(){ document.getElementById('dbg').textContent='incidents='+Object.keys(DATA.PLAN_STRUCT||{}).length; alert('self test ran'); };
  document.getElementById('btnRec').onclick=function(){ alert('OK: '+(sel.value||'none')); };
}
window.boot=boot;
boot();
