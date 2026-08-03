/**
 * JumpLab → Google Sheets KPI pipeline
 * Reads training data from Supabase (wk_store) and builds Raw + KPI tabs.
 * Read-only view; no manual entry (except the Bodyweight tab).
 *
 * SETUP:
 *   1. New Google Sheet → Extensions → Apps Script
 *   2. Paste this whole file into Code.gs → Save
 *   3. Run `syncAll` once (authorize when prompted)
 *   4. Run `installTrigger` once (auto-refresh every 15 min)
 *   5. Use the "JumpLab" menu that appears after reload for manual refresh
 */

// ---------- CONFIG ----------
const SB_URL = 'https://ulrblhxyrkdpvgsyoesf.supabase.co/rest/v1/wk_store';
const SB_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InVscmJsaHh5cmtkcHZnc3lvZXNmIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzcwNzY1MzAsImV4cCI6MjA5MjY1MjUzMH0.cVXpHtA-7E6pvltUOvdaUf_7vxGyHW5RpqKXjjM5La8'; // public anon key (read-only RLS)

// Which exercise-ids feed each KPI (validated against live data, 94 workouts)
const K = {
  fly30:      ['fly-30m'],                                  // tf-time (30 m fly) → 30/t
  flySeg:     ['fly-30m','start-50m','start-60m','overspeed-40m','fly-20m'], // fly-10m-* → 10/seg
  accel10:    ['start-10m'], accel20: ['start-20m'], accel30: ['start-30m'], // tf-time (min)
  approachV:  ['full-app-popup','full-app-runthrough','approach-jump-16','approach-jump-18',
               'approach-popup-16','approach-runthrough-16','approach-jump-10',
               'approach-jump-12','approach-jump-14'],      // time-10-1m → 10/t (approach vel.)
  jumpPB:     {10:'approach-jump-10',12:'approach-jump-12',14:'approach-jump-14',16:'approach-jump-16'}, // tf-dist
  standingLJ: ['standing-lj'],                              // tf-dist
  bounds10:   ['bounds-10-pr'],                             // tf-dist  (10 SKOK)
  altBounds:  ['alt-bounds-jump'],                          // tf-dist  (5 alt bounds, pre-run)
  slBoundsL:  ['sl-bounds-pr-l'],                           // tf-dist  (5 SL bounds L, pre-run)
  slBoundsR:  ['sl-bounds-pr-r'],                           // tf-dist  (5 SL bounds R, pre-run)
  rsi:        ['drop-jump-60cm'],                           // height(cm)/100 ÷ gct
  lifts: [  // est. 1RM via Epley
    ['tb-deadlift','TB Deadlift'], ['deadlift','Deadlift'], ['rdl','RDL'],
    ['hip-thrust','Hip Thrust'], ['hip-thrust-staggered','Hip Thrust (stag.)'],
    ['high-pull','Hang High Pull'], ['bulgarian-split-squat','Bulgarian SS'],
    ['hang-power-clean','Hang Power Clean'], ['step-up','Step Up'], ['quarter-squat','Quarter Squat']
  ]
};
const ROLL = 6;                 // rolling window (sessions) for SPC
const RAW_KEYS = ['tf-time','split-10m','split-20m','split-30m','split-40m',
  'fly-10m-1','fly-10m-2','fly-10m-3','time-10-1m','time-20-11m','tf-dist',
  'approach-mark','steps','height','gct','weight','reps','time'];

// ---------- FETCH ----------
function fetchStore(key) {
  const res = UrlFetchApp.fetch(SB_URL + '?key=eq.' + key + '&select=value',
    { headers: { apikey: SB_KEY, Authorization: 'Bearer ' + SB_KEY }, muteHttpExceptions: true });
  const body = JSON.parse(res.getContentText());
  if (!key) throw new Error('fetchStore called with no key — run syncAll (not this function directly).');
  if (!body.length) throw new Error('No row for key=' + key);
  return body[0].value;
}
function athMap(athletes){ const m={}; (athletes||[]).forEach(a=>m[a.id]=a.name||a.id); return m; }

// ---------- RAW ----------
function writeRaw(workouts, athletes) {
  const name = athMap(athletes);
  const head = ['Date','Athlete','Tag','ExerciseId'].concat(RAW_KEYS);
  const rows = [head];
  workouts.slice().sort((a,b)=>Number(a.startTime)-Number(b.startTime)).forEach(w=>{
    const d = new Date(Number(w.startTime));
    const tag = (w.tag && w.tag.name) || '';
    Object.entries(w.athletes||{}).forEach(([aid,ad])=>{
      Object.entries(ad.sets||{}).forEach(([eid,sets])=>{
        (sets||[]).forEach(s=>{
          if (!s.completed) return;
          const v = s.values || {};
          rows.push([d, name[aid]||aid, tag, eid.split('__')[0]]
            .concat(RAW_KEYS.map(k => (v[k]===undefined?'':v[k]))));
        });
      });
    });
  });
  const sh = sheet('Raw'); resetSheet(sh);
  sh.getRange(1,1,rows.length,head.length).setValues(rows);
  sh.getRange(1,1,1,head.length).setFontWeight('bold');
  sh.setFrozenRows(1);
}

// ---------- KPI helpers ----------
// fn(valuesObj) -> number|null ; returns {athId:[{date,val}] sorted}
function series(workouts, exIds, fn, mode){
  const by = {};
  workouts.forEach(w=>{
    const date = new Date(Number(w.startTime));
    Object.entries(w.athletes||{}).forEach(([aid,ad])=>{
      let best=null;
      Object.entries(ad.sets||{}).forEach(([eid,sets])=>{
        if (exIds.indexOf(eid.split('__')[0])<0) return;
        (sets||[]).forEach(s=>{
          if (!s.completed) return;
          const v = fn(s.values||{});
          if (v===null || isNaN(v)) return;
          if (best===null || (mode==='max'? v>best : v<best)) best=v;
        });
      });
      if (best!==null) (by[aid]=by[aid]||[]).push({date,val:best});
    });
  });
  Object.values(by).forEach(a=>a.sort((x,y)=>x.date-y.date));
  return by;
}
function mean(a){ return a.reduce((s,x)=>s+x,0)/a.length; }
function sd(a){ if(a.length<2) return 0; const m=mean(a); return Math.sqrt(a.reduce((s,x)=>s+(x-m)*(x-m),0)/(a.length-1)); }
function trend(vals){ // last 3 consecutive drops → '↓', 3 rises → '↑'
  if (vals.length<3) return '';
  const t=vals.slice(-3);
  if (t[0]>t[1] && t[1]>t[2]) return '↓';
  if (t[0]<t[1] && t[1]<t[2]) return '↑';
  return '→';
}

// Season targets (per athlete) — from the plan's championship norms
const TARGET = {
  'Fly-30 velocity':                  {'ath-1':10.3, 'ath-2':9.3},
  'Approach vel. (last 10 m→board)':  {'ath-1':9.6,  'ath-2':8.7},
  'Standing LJ':                      {'ath-1':3.25, 'ath-2':2.85},
  'LJ best (all approaches)':         {'ath-1':8.00, 'ath-2':6.70}
};

// ---------- KPI sheet (scannable: status dot · target · gap · sparkline) ----------
function writeKPI(workouts, athletes){
  const name = athMap(athletes);
  const sh = sheet('KPI');
  resetSheet(sh);   // clear + unmerge + unfreeze + unhide (clear() alone leaves these behind)
  const rnd=(x,d)=> (x===''||x==null||isNaN(x))?'':Math.round(x*Math.pow(10,d))/Math.pow(10,d);
  const SCOL=10;                       // hidden series values start here (for sparklines)
  const HEAD=['KPI','Athlete','Unit','Latest','Target','Gap','●','Trend'];
  sh.getRange('A1').setValue('KPI DASHBOARD — auto from JumpLab').setFontWeight('bold').setFontSize(14);
  sh.getRange('A2').setValue('● 🟢 at/above target · 🟡 close · 🔴 below (falls back to trend-band when no target). Trend = sparkline of full history. See the Charts tab for graphs.').setFontColor('#777');
  let r=4;
  function section(t){
    sh.getRange(r,1,1,8).merge().setValue(t).setFontWeight('bold').setFontSize(12).setBackground('#2e2e2e').setFontColor('#ffffff'); r++;
    sh.getRange(r,1,1,8).setValues([HEAD]).setFontWeight('bold').setBackground('#efefef'); r++;
  }
  function card(label, unit, by, goodDir, dec){
    Object.keys(by).sort().forEach(aid=>{
      const s=by[aid]; if(!s.length) return;
      const vals=s.map(x=>x.val), latest=vals[vals.length-1];
      const last=vals.slice(-ROLL), m=mean(last), dev=sd(last);
      const tgt=(TARGET[label]||{})[aid];
      let bg, dot;
      if (tgt!=null){
        const hit   = goodDir==='up'? latest>=tgt      : latest<=tgt;
        const close = goodDir==='up'? latest>=tgt*0.97 : latest<=tgt*1.03;
        bg = hit?'#d6ead6':(close?'#fff4c2':'#f8d0d0'); dot = hit?'🟢':(close?'🟡':'🔴');
      } else {
        const lo=m-dev, hi=m+dev;
        const good = goodDir==='up'? latest>hi : latest<lo;
        const bad  = goodDir==='up'? latest<lo : latest>hi;
        bg = good?'#d6ead6':(bad?'#f8d0d0':'#fff4c2'); dot = good?'🟢':(bad?'🔴':'🟡');
      }
      const gap = tgt!=null ? rnd((goodDir==='up'? latest-tgt : tgt-latest), dec) : '';
      sh.getRange(r,1,1,8).setValues([[label, name[aid]||aid, unit, rnd(latest,dec), tgt!=null?tgt:'', gap, dot, '']]);
      sh.getRange(r,4).setBackground(bg);
      const ser=vals.map(v=>rnd(v,dec));
      sh.getRange(r,SCOL,1,ser.length).setValues([ser]);
      const a=sh.getRange(r,SCOL).getA1Notation(), b=sh.getRange(r,SCOL+ser.length-1).getA1Notation();
      sh.getRange(r,8).setFormula('=SPARKLINE('+a+':'+b+')');
      r++;
    });
    r++;
  }

  section('🏃  SPEED');
  card('Fly-30 velocity','m/s', series(workouts,K.fly30, v=>{const t=+v['tf-time'];return t>0?30/t:null},'max'),'up',2);
  card('Fly-10 top segment','m/s', series(workouts,K.flySeg, v=>{const segs=['fly-10m-1','fly-10m-2','fly-10m-3'].map(k=>+v[k]).filter(x=>x>0);return segs.length?10/Math.min.apply(null,segs):null},'max'),'up',2);
  card('Approach vel. (last 10 m→board)','m/s', series(workouts,K.approachV, v=>{const t=+v['time-10-1m'];return t>0?10/t:null},'max'),'up',2);
  card('Accel 10 m','s', series(workouts,K.accel10, v=>+v['tf-time']||null,'min'),'down',2);
  card('Accel 20 m','s', series(workouts,K.accel20, v=>+v['tf-time']||null,'min'),'down',2);
  card('Accel 30 m','s', series(workouts,K.accel30, v=>+v['tf-time']||null,'min'),'down',2);

  section('🦵  JUMPS & BOUNDS');
  card('LJ best (all approaches)','m', series(workouts,['approach-jump-10','approach-jump-12','approach-jump-14','approach-jump-16'], v=>+v['tf-dist']||null,'max'),'up',2);
  Object.entries(K.jumpPB).forEach(([steps,eid])=> card('LJ best — '+steps+'-step','m', series(workouts,[eid], v=>+v['tf-dist']||null,'max'),'up',2));
  card('Standing LJ','m', series(workouts,K.standingLJ, v=>+v['tf-dist']||null,'max'),'up',2);
  card('5 bounds — Alt (pre-run)','m', series(workouts,K.altBounds, v=>+v['tf-dist']||null,'max'),'up',2);
  const boundsL=series(workouts,K.slBoundsL, v=>+v['tf-dist']||null,'max');
  const boundsR=series(workouts,K.slBoundsR, v=>+v['tf-dist']||null,'max');
  card('5 bounds — SL Left (pre-run)','m', boundsL,'up',2);
  card('5 bounds — SL Right (pre-run)','m', boundsR,'up',2);
  card('SL bound asymmetry |L−R|','%', asymmetry(boundsL,boundsR),'down',1);
  card('10-bound (10 SKOK)','m', series(workouts,K.bounds10, v=>+v['tf-dist']||null,'max'),'up',2);
  card('RSI (drop jump 60 cm)','—', series(workouts,K.rsi, v=>{const h=+v.height,g=+v.gct;return (h>0&&g>0)?(h/100)/g:null},'max'),'up',2);

  section('🏋️  STRENGTH — est. 1RM (Epley)');
  K.lifts.forEach(([eid,label])=> card('1RM est · '+label,'kg', series(workouts,[eid], v=>{const w=+v.weight,rp=+v.reps;return (w>0&&rp>0)?w*(1+rp/30):null},'max'),'up',0));

  sh.setColumnWidth(1,250); sh.setColumnWidth(8,150);
  sh.setFrozenRows(3);   // NOTE: no frozen columns — they conflict with the full-width section merges
  const lc=sh.getLastColumn(); if(lc>=9) sh.hideColumns(9, lc-8);
}

// clear() leaves merges / frozen panes / hidden columns behind — reset them or re-runs collide
function resetSheet(sh){
  sh.setFrozenRows(0); sh.setFrozenColumns(0);
  const mr=sh.getMaxRows(), mc=sh.getMaxColumns();
  sh.getRange(1,1,mr,mc).breakApart();
  sh.showColumns(1,mc); sh.showRows(1,mr);
  sh.clear();
}

// L/R asymmetry series from left/right {aid:[{date,val}]}
function asymmetry(byL, byR){
  const out={};
  Object.keys(byL).forEach(aid=>{
    if(!byR[aid]) return;
    const rmap={}; byR[aid].forEach(x=>rmap[x.date.getTime()]=x.val);
    byL[aid].forEach(x=>{ const rv=rmap[x.date.getTime()];
      if(rv) (out[aid]=out[aid]||[]).push({date:x.date, val:Math.abs(x.val-rv)/Math.max(x.val,rv)*100}); });
  });
  Object.values(out).forEach(a=>a.sort((x,y)=>x.date-y.date));
  return out;
}

// ---------- Charts tab (line graphs, both athletes) ----------
function writeCharts(workouts, athletes){
  const name = athMap(athletes);
  const cs = sheet('Charts'); cs.getCharts().forEach(c=>cs.removeChart(c)); resetSheet(cs);
  const cd = sheet('ChartData'); cd.clear();
  if (cd.isSheetHidden()) cd.showSheet();   // must be visible to write, re-hidden at the end
  const rnd=(x,d)=>(x==null||isNaN(x))?'':Math.round(x*Math.pow(10,d))/Math.pow(10,d);
  let cdRow=1, anchor=1;
  function chart(title, by, dec){
    const aids=Object.keys(by).sort(); if(!aids.length) return;
    const maxlen=Math.max.apply(null, aids.map(a=>by[a].length));
    const block=[['Session'].concat(aids.map(a=>name[a]||a))];
    for(let i=0;i<maxlen;i++){ const row=[i+1]; aids.forEach(a=>{const s=by[a]; row.push(i<s.length?rnd(s[i].val,dec):'');}); block.push(row); }
    const start=cdRow; cd.getRange(start,1,block.length,block[0].length).setValues(block); cdRow+=block.length+2;
    const c=cs.newChart().asLineChart().addRange(cd.getRange(start,1,block.length,block[0].length)).setNumHeaders(1)
      .setOption('title',title).setOption('width',600).setOption('height',300).setOption('pointSize',4)
      .setOption('legend',{position:'bottom'}).setPosition(anchor,1,0,0).build();
    cs.insertChart(c); anchor+=16;
  }
  chart('Fly-30 velocity (m/s)', series(workouts,K.fly30, v=>{const t=+v['tf-time'];return t>0?30/t:null},'max'),2);
  chart('Approach velocity — last 10 m → board (m/s)', series(workouts,K.approachV, v=>{const t=+v['time-10-1m'];return t>0?10/t:null},'max'),2);
  chart('LJ best — all approaches (m)', series(workouts,['approach-jump-10','approach-jump-12','approach-jump-14','approach-jump-16'], v=>+v['tf-dist']||null,'max'),2);
  chart('Standing LJ (m)', series(workouts,K.standingLJ, v=>+v['tf-dist']||null,'max'),2);
  const bL=series(workouts,K.slBoundsL, v=>+v['tf-dist']||null,'max'), bR=series(workouts,K.slBoundsR, v=>+v['tf-dist']||null,'max');
  chart('SL bound L/R asymmetry (%) — lower is better', asymmetry(bL,bR),1);
  chart('Est. 1RM — TB Deadlift (kg)', series(workouts,['tb-deadlift'], v=>{const w=+v.weight,rp=+v.reps;return (w>0&&rp>0)?w*(1+rp/30):null},'max'),0);
  cd.hideSheet();
}

// ---------- Bodyweight (manual) ----------
function ensureBodyweight(){
  const sh = sheet('Bodyweight');
  if (sh.getLastRow()===0){
    sh.getRange(1,1,2,3).setValues([['Date','Athlete','kg'],['2026-10-01','Stanley','']]);
    sh.getRange(1,1,1,3).setFontWeight('bold').setBackground('#fff4c2');
    sh.getRange('A4').setValue('↑ manual entry — add a row each month (used for strength-per-kg ratios later)').setFontColor('#888');
  }
}

// ---------- orchestration ----------
function syncAll(){
  const workouts = fetchStore('workouts2');
  const athletes = fetchStore('athletes');
  writeRaw(workouts, athletes);
  writeKPI(workouts, athletes);
  writeCharts(workouts, athletes);
  ensureBodyweight();
}
function sheet(n){ const ss=SpreadsheetApp.getActive(); return ss.getSheetByName(n)||ss.insertSheet(n); }
function installTrigger(){
  ScriptApp.getProjectTriggers().forEach(t=>{ if(t.getHandlerFunction()==='syncAll') ScriptApp.deleteTrigger(t); });
  ScriptApp.newTrigger('syncAll').timeBased().everyMinutes(15).create();
}
function onOpen(){
  SpreadsheetApp.getUi().createMenu('JumpLab')
    .addItem('Refresh now','syncAll')
    .addItem('Install 15-min auto-refresh','installTrigger')
    .addToUi();
}
