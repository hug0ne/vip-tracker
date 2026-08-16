
'use strict';

const STORE_KEY = 'vipTrackerDataV1';
const app = document.getElementById('app');
const installBtn = document.getElementById('installBtn');
let deferredInstall = null;

const defaultData = {
  pitchers: [],
  appearances: [],
  activeAppearanceId: null,
  settings: {
    enablePitchTypes: false,
    defaultPitchLimit: 85
  }
};

let data = loadData();
let route = 'home';

function uid(prefix='id') {
  return `${prefix}_${Date.now()}_${Math.random().toString(36).slice(2,8)}`;
}

function loadData() {
  try {
    return { ...structuredClone(defaultData), ...JSON.parse(localStorage.getItem(STORE_KEY) || '{}') };
  } catch {
    return structuredClone(defaultData);
  }
}

function saveData() {
  localStorage.setItem(STORE_KEY, JSON.stringify(data));
}

function esc(value='') {
  return String(value).replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#039;'}[c]));
}

function pitcherById(id) {
  return data.pitchers.find(p => p.id === id);
}

function activeAppearance() {
  return data.appearances.find(a => a.id === data.activeAppearanceId);
}

function formatIP(outs) {
  return `${Math.floor(outs / 3)}.${outs % 3}`;
}

function statsFor(a) {
  const pitches = a.batters.flatMap(b => b.pitches || []);
  const strikes = pitches.filter(p => ['SL','SW','F','DK'].includes(p.result)).length;
  const balls = pitches.filter(p => p.result === 'B').length;
  const batters = a.batters.filter(b => b.completed).length;
  const firstPitchStrikes = a.batters.filter(b => b.completed && ['SL','SW','F','DK'].includes(b.pitches?.[0]?.result)).length;
  const strikeouts = a.batters.filter(b => ['K','KL'].includes(b.outcome)).length;
  const looking = a.batters.filter(b => b.outcome === 'KL').length;
  const walks = a.batters.filter(b => b.outcome === 'BB').length;
  const hits = a.batters.filter(b => ['1B','2B','3B','HR'].includes(b.outcome)).length;
  const total = pitches.length;
  return {
    total, strikes, balls, batters, firstPitchStrikes, strikeouts, looking, walks, hits,
    strikePct: total ? (strikes / total * 100) : 0,
    firstPitchPct: batters ? (firstPitchStrikes / batters * 100) : 0,
    avgPerBatter: batters ? total / batters : 0,
    ip: formatIP(a.pitcherOuts || 0),
    runs: a.runs || 0,
    earnedRuns: a.earnedRuns || 0,
    errors: a.errors || 0
  };
}

function navigate(next) {
  route = next;
  render();
}

document.querySelectorAll('[data-route]').forEach(btn => {
  btn.addEventListener('click', () => navigate(btn.dataset.route));
});

window.addEventListener('beforeinstallprompt', e => {
  e.preventDefault();
  deferredInstall = e;
  installBtn.classList.remove('hidden');
});
installBtn.addEventListener('click', async () => {
  if (!deferredInstall) return;
  deferredInstall.prompt();
  await deferredInstall.userChoice;
  deferredInstall = null;
  installBtn.classList.add('hidden');
});

function render() {
  if (route === 'home') renderHome();
  else if (route === 'pitchers') renderPitchers();
  else if (route === 'appearances') renderAppearances();
  else if (route === 'settings') renderSettings();
  else if (route === 'new-appearance') renderNewAppearance();
  else if (route === 'tracker') renderTracker();
  else if (route.startsWith('summary:')) renderSummary(route.split(':')[1]);
}

function renderHome() {
  const active = activeAppearance();
  const latest = [...data.appearances].sort((a,b) => b.createdAt - a.createdAt).slice(0,3);
  app.innerHTML = `
    <section class="card hero">
      <h2>Track one pitcher, one outing, one pitch at a time.</h2>
      <p>Works offline and saves automatically on this device.</p>
      ${data.pitchers.length
        ? `<button class="primary full" id="newAppearanceBtn">Start New Appearance</button>`
        : `<button class="primary full" id="addFirstPitcherBtn">Add Your First Pitcher</button>`}
      ${active && !active.endedAt ? `<button class="success full" style="margin-top:10px" id="resumeBtn">Resume Active Appearance</button>` : ''}
    </section>

    <section class="card">
      <div class="kicker">Overview</div>
      <div class="stat-grid">
        <div class="stat"><strong>${data.pitchers.length}</strong><span>Pitchers</span></div>
        <div class="stat"><strong>${data.appearances.filter(a=>a.endedAt).length}</strong><span>Completed</span></div>
        <div class="stat"><strong>${data.appearances.reduce((sum,a)=>sum+statsFor(a).total,0)}</strong><span>Career Pitches</span></div>
      </div>
    </section>

    <section class="card">
      <h3 class="section-title">Recent Appearances</h3>
      ${latest.length ? latest.map(a => {
        const p = pitcherById(a.pitcherId);
        const s = statsFor(a);
        return `<div class="list-item">
          <div><strong>${esc(p?.displayName || 'Pitcher')}</strong><br><span class="muted">${esc(a.team)} vs ${esc(a.opponent)} · ${esc(a.date)}</span></div>
          <button class="secondary" data-summary="${a.id}">${s.total} pitches</button>
        </div>`;
      }).join('') : `<p class="muted">No appearances saved yet.</p>`}
    </section>
  `;
  document.getElementById('newAppearanceBtn')?.addEventListener('click', () => navigate('new-appearance'));
  document.getElementById('addFirstPitcherBtn')?.addEventListener('click', () => navigate('pitchers'));
  document.getElementById('resumeBtn')?.addEventListener('click', () => navigate('tracker'));
  app.querySelectorAll('[data-summary]').forEach(b => b.addEventListener('click', () => navigate(`summary:${b.dataset.summary}`)));
}

function renderPitchers() {
  app.innerHTML = `
    <section class="card">
      <h2 class="section-title">Pitchers</h2>
      ${data.pitchers.map(p => `
        <div class="list-item">
          <div>
            <strong>${esc(p.displayName)}</strong><br>
            <span class="muted">${esc(p.school || '')}${p.gradYear ? ` · Class of ${esc(p.gradYear)}` : ''} · Throws ${esc(p.arm)}</span>
          </div>
          <span class="badge">#${esc(p.jersey || '—')}</span>
        </div>`).join('') || `<p class="muted">No pitchers added.</p>`}
    </section>
    <section class="card">
      <h3>Add Pitcher</h3>
      <form id="pitcherForm">
        <div class="row">
          <div><label>First name</label><input name="firstName" required></div>
          <div><label>Last name</label><input name="lastName" required></div>
        </div>
        <label>Display name or nickname</label><input name="displayName" placeholder="Optional">
        <div class="row">
          <div><label>Jersey number</label><input name="jersey" inputmode="numeric"></div>
          <div><label>Throwing arm</label><select name="arm"><option>Right</option><option>Left</option></select></div>
        </div>
        <label>Date of birth</label><input type="date" name="dob">
        <div class="row">
          <div><label>School</label><input name="school"></div>
          <div><label>Graduation year</label><input name="gradYear" inputmode="numeric"></div>
        </div>
        <button class="primary full" type="submit" style="margin-top:14px">Save Pitcher</button>
      </form>
    </section>`;
  document.getElementById('pitcherForm').addEventListener('submit', e => {
    e.preventDefault();
    const f = new FormData(e.target);
    const first = f.get('firstName').trim();
    const last = f.get('lastName').trim();
    data.pitchers.push({
      id:uid('pitcher'), firstName:first, lastName:last,
      displayName:f.get('displayName').trim() || `${first} ${last}`,
      jersey:f.get('jersey').trim(), arm:f.get('arm'),
      dob:f.get('dob'), school:f.get('school').trim(),
      gradYear:f.get('gradYear').trim(), createdAt:Date.now()
    });
    saveData(); renderPitchers();
  });
}

function renderNewAppearance() {
  if (!data.pitchers.length) return navigate('pitchers');
  app.innerHTML = `
    <section class="card">
      <h2>New Pitching Appearance</h2>
      <form id="appearanceForm">
        <label>Pitcher</label>
        <select name="pitcherId">${data.pitchers.map(p=>`<option value="${p.id}">${esc(p.displayName)}</option>`).join('')}</select>
        <label>Date</label><input type="date" name="date" required value="${new Date().toISOString().slice(0,10)}">
        <div class="row">
          <div><label>Pitcher's team</label><input name="team" required></div>
          <div><label>Opponent</label><input name="opponent" required></div>
        </div>
        <label>Location</label><input name="location">
        <div class="row">
          <div><label>Starting inning</label><input name="inning" type="number" min="1" value="1"></div>
          <div><label>Half</label><select name="half"><option>Top</option><option>Bottom</option></select></div>
        </div>
        <div class="row">
          <div><label>Outs when entering</label><select name="outs"><option>0</option><option>1</option><option>2</option></select></div>
          <div><label>Pitch limit</label><input name="pitchLimit" type="number" min="1" value="${data.settings.defaultPitchLimit || 85}"></div>
        </div>
        <label>Inherited runners</label>
        <div class="grid three">
          <label><input type="checkbox" name="r1"> First</label>
          <label><input type="checkbox" name="r2"> Second</label>
          <label><input type="checkbox" name="r3"> Third</label>
        </div>
        <button class="primary full" style="margin-top:14px">Start Tracking</button>
      </form>
    </section>`;
  document.getElementById('appearanceForm').addEventListener('submit', e => {
    e.preventDefault();
    const f = new FormData(e.target);
    const a = {
      id:uid('appearance'), pitcherId:f.get('pitcherId'), date:f.get('date'),
      team:f.get('team').trim(), opponent:f.get('opponent').trim(),
      location:f.get('location').trim(), inning:Number(f.get('inning')),
      half:f.get('half'), entryOuts:Number(f.get('outs')), currentOuts:Number(f.get('outs')),
      pitcherOuts:0, pitchLimit:Number(f.get('pitchLimit')) || null,
      inherited:{first:!!f.get('r1'),second:!!f.get('r2'),third:!!f.get('r3')},
      batters:[], currentBatter:null, runs:0, earnedRuns:0, errors:0,
      createdAt:Date.now(), endedAt:null, endReason:''
    };
    data.appearances.push(a);
    data.activeAppearanceId = a.id;
    saveData();
    startNextBatter(a);
    navigate('tracker');
  });
}

function startNextBatter(a) {
  a.currentBatter = {
    id:uid('batter'), jersey:'', order:a.batters.length + 1,
    pitches:[], outcome:null, completed:false, outsRecorded:0, runs:0, earnedRuns:0
  };
  saveData();
}

function currentCount(b) {
  let balls = 0, strikes = 0;
  for (const p of b.pitches) {
    if (p.result === 'B') balls = Math.min(4, balls + 1);
    if (['SL','SW','DK'].includes(p.result)) strikes = Math.min(3, strikes + 1);
    if (p.result === 'F' && strikes < 2) strikes++;
  }
  return {balls,strikes};
}

function renderTracker() {
  const a = activeAppearance();
  if (!a) return navigate('home');
  if (!a.currentBatter) startNextBatter(a);
  const b = a.currentBatter;
  const s = statsFor(a);
  const c = currentCount(b);
  const nearLimit = a.pitchLimit && s.total >= a.pitchLimit - 5;
  app.innerHTML = `
    ${nearLimit ? `<div class="alert">Pitch count is ${s.total}. Limit: ${a.pitchLimit}.</div>` : ''}
    <section class="card">
      <div class="batter-head">
        <div>
          <div class="kicker">${esc(a.half)} ${a.inning} · ${a.currentOuts} out${a.currentOuts===1?'':'s'}</div>
          <h2 style="margin:4px 0">Batter #<span id="batterNumberLabel">${esc(b.jersey || '—')}</span></h2>
        </div>
        <div class="big-count">${c.balls}-${c.strikes}</div>
      </div>
      <label>Batter jersey number</label>
      <input id="batterJersey" inputmode="numeric" value="${esc(b.jersey)}" placeholder="Enter jersey number">
      <div class="sequence">${b.pitches.map(p=>`<span>${esc(p.result)}</span>`).join('')}</div>
    </section>

    <section class="card">
      <div class="grid five">
        <button class="pitch-btn" data-pitch="SL">SL</button>
        <button class="pitch-btn" data-pitch="SW">SW</button>
        <button class="pitch-btn ball" data-pitch="B">B</button>
        <button class="pitch-btn foul" data-pitch="F">F</button>
        <button class="pitch-btn" data-pitch="DK">DK</button>
      </div>
      <div class="grid two" style="margin-top:12px">
        <button class="secondary" id="undoBtn">Undo Last Pitch</button>
        <button class="primary" id="outcomeBtn">Record Outcome</button>
      </div>
    </section>

    <section class="card">
      <div class="stat-grid">
        <div class="stat"><strong>${s.total}</strong><span>Pitches</span></div>
        <div class="stat"><strong>${s.strikes}</strong><span>Strikes</span></div>
        <div class="stat"><strong>${s.balls}</strong><span>Balls</span></div>
        <div class="stat"><strong>${s.strikePct.toFixed(0)}%</strong><span>Strike %</span></div>
        <div class="stat"><strong>${s.batters}</strong><span>Batters</span></div>
        <div class="stat"><strong>${s.ip}</strong><span>IP</span></div>
      </div>
    </section>

    <section class="card">
      <div class="grid two">
        <button class="secondary" id="advanceInningBtn">Advance Inning</button>
        <button class="danger" id="endAppearanceBtn">End Appearance</button>
      </div>
    </section>`;
  document.getElementById('batterJersey').addEventListener('input', e => {
    b.jersey = e.target.value.trim();
    document.getElementById('batterNumberLabel').textContent = b.jersey || '—';
    saveData();
  });
  app.querySelectorAll('[data-pitch]').forEach(btn => btn.addEventListener('click', () => {
    b.pitches.push({ id:uid('pitch'), result:btn.dataset.pitch, at:Date.now(), pitchType:null, velocity:null });
    saveData(); renderTracker();
  }));
  document.getElementById('undoBtn').addEventListener('click', () => {
    b.pitches.pop(); saveData(); renderTracker();
  });
  document.getElementById('outcomeBtn').addEventListener('click', () => showOutcomeModal(a,b));
  document.getElementById('advanceInningBtn').addEventListener('click', () => {
    a.inning += 1; a.currentOuts = 0; saveData(); renderTracker();
  });
  document.getElementById('endAppearanceBtn').addEventListener('click', () => showEndModal(a));
}

function showModal(html, bind) {
  const tpl = document.getElementById('modalTemplate');
  const node = tpl.content.cloneNode(true);
  node.querySelector('.modal-content').innerHTML = html;
  document.body.appendChild(node);
  const backdrop = document.querySelector('.modal-backdrop:last-of-type');
  bind(backdrop);
}
function closeModal(backdrop) { backdrop.remove(); }

function showOutcomeModal(a,b) {
  const outcomes = [
    ['K','K Swinging',1],['KL','Ʞ Looking',1],['BB','Walk',0],['HBP','Hit By Pitch',0],
    ['1B','Single',0],['2B','Double',0],['3B','Triple',0],['HR','Home Run',0],
    ['GO','Groundout',1],['FO','Flyout',1],['LO','Lineout',1],['FC',"Fielder's Choice",0],
    ['ROE','Reached on Error',0],['CI',"Catcher's Interference",0],['BT','Bunt',0],['OTHER','Other',0]
  ];
  showModal(`
    <h3>Record Batter Outcome</h3>
    <div class="grid three">
      ${outcomes.map(o=>`<button class="outcome-btn" data-code="${o[0]}" data-default-outs="${o[2]}">${o[1]}</button>`).join('')}
    </div>
    <div id="detailFields" class="hidden">
      <div class="row">
        <div><label>Outs recorded</label><select id="outsRecorded"><option>0</option><option>1</option><option>2</option><option>3</option></select></div>
        <div><label>Runs scored</label><input id="runsScored" type="number" min="0" value="0"></div>
      </div>
      <div class="row">
        <div><label>Earned runs</label><input id="earnedRuns" type="number" min="0" value="0"></div>
        <div><label>Errors</label><input id="errors" type="number" min="0" value="0"></div>
      </div>
      <button class="primary full" id="saveOutcome" style="margin-top:12px">Save and Next Batter</button>
    </div>
    <button class="secondary full" id="cancelModal" style="margin-top:12px">Cancel</button>
  `, backdrop => {
    let selected = null;
    backdrop.querySelectorAll('[data-code]').forEach(btn => btn.addEventListener('click', () => {
      selected = btn.dataset.code;
      backdrop.querySelector('#detailFields').classList.remove('hidden');
      backdrop.querySelector('#outsRecorded').value = btn.dataset.defaultOuts;
    }));
    backdrop.querySelector('#saveOutcome').addEventListener('click', () => {
      if (!selected) return;
      b.outcome = selected; b.completed = true;
      b.outsRecorded = Number(backdrop.querySelector('#outsRecorded').value);
      b.runs = Number(backdrop.querySelector('#runsScored').value) || 0;
      b.earnedRuns = Number(backdrop.querySelector('#earnedRuns').value) || 0;
      b.errors = Number(backdrop.querySelector('#errors').value) || 0;
      a.pitcherOuts += b.outsRecorded;
      a.currentOuts += b.outsRecorded;
      a.runs += b.runs; a.earnedRuns += b.earnedRuns; a.errors += b.errors;
      a.batters.push(b);
      while (a.currentOuts >= 3) { a.currentOuts -= 3; a.inning += 1; }
      startNextBatter(a);
      saveData(); closeModal(backdrop); renderTracker();
    });
    backdrop.querySelector('#cancelModal').addEventListener('click', () => closeModal(backdrop));
  });
}

function showEndModal(a) {
  showModal(`
    <h3>End Pitching Appearance</h3>
    <label>Reason</label>
    <select id="endReason">
      <option>Replaced by another pitcher</option>
      <option>Reached pitch limit</option>
      <option>End of game</option>
      <option>Time limit</option>
      <option>Run rule</option>
      <option>Forfeit</option>
      <option>Coaches' decision</option>
      <option>Injury</option>
      <option>Other</option>
    </select>
    <label>Notes</label><textarea id="endNotes"></textarea>
    <button class="danger full" id="confirmEnd" style="margin-top:12px">End and Save</button>
    <button class="secondary full" id="cancelEnd" style="margin-top:10px">Cancel</button>
  `, backdrop => {
    backdrop.querySelector('#confirmEnd').addEventListener('click', () => {
      a.endReason = backdrop.querySelector('#endReason').value;
      a.notes = backdrop.querySelector('#endNotes').value.trim();
      a.endedAt = Date.now();
      data.activeAppearanceId = null;
      saveData(); closeModal(backdrop); navigate(`summary:${a.id}`);
    });
    backdrop.querySelector('#cancelEnd').addEventListener('click', () => closeModal(backdrop));
  });
}

function renderAppearances() {
  const rows = [...data.appearances].sort((a,b)=>b.createdAt-a.createdAt);
  app.innerHTML = `
    <section class="card">
      <h2>Appearances</h2>
      ${rows.map(a => {
        const p = pitcherById(a.pitcherId), s = statsFor(a);
        return `<div class="list-item">
          <div>
            <strong>${esc(p?.displayName || 'Pitcher')}</strong><br>
            <span class="muted">${esc(a.team)} vs ${esc(a.opponent)} · ${esc(a.date)}</span><br>
            <span class="badge">${a.endedAt ? 'Completed' : 'Active'}</span>
          </div>
          <button class="secondary" data-summary="${a.id}">${s.total} pitches</button>
        </div>`;
      }).join('') || `<p class="muted">No appearances recorded.</p>`}
    </section>`;
  app.querySelectorAll('[data-summary]').forEach(b => b.addEventListener('click', () => navigate(`summary:${b.dataset.summary}`)));
}

function renderSummary(id) {
  const a = data.appearances.find(x=>x.id===id);
  if (!a) return navigate('appearances');
  const p = pitcherById(a.pitcherId), s = statsFor(a);
  app.innerHTML = `
    <section class="card hero">
      <div class="kicker">${esc(a.date)}</div>
      <h2>${esc(p?.displayName || 'Pitcher')}</h2>
      <p>${esc(a.team)} vs ${esc(a.opponent)}</p>
      <span class="badge">${esc(a.endReason || (a.endedAt ? 'Completed' : 'Active'))}</span>
    </section>
    <section class="card">
      <div class="stat-grid">
        <div class="stat"><strong>${s.ip}</strong><span>IP</span></div>
        <div class="stat"><strong>${s.total}</strong><span>Pitches</span></div>
        <div class="stat"><strong>${s.strikePct.toFixed(1)}%</strong><span>Strike %</span></div>
        <div class="stat"><strong>${s.strikeouts}</strong><span>Strikeouts</span></div>
        <div class="stat"><strong>${s.walks}</strong><span>Walks</span></div>
        <div class="stat"><strong>${s.hits}</strong><span>Hits</span></div>
        <div class="stat"><strong>${s.runs}</strong><span>Runs</span></div>
        <div class="stat"><strong>${s.earnedRuns}</strong><span>Earned</span></div>
        <div class="stat"><strong>${s.firstPitchPct.toFixed(1)}%</strong><span>1st Pitch Strike</span></div>
      </div>
    </section>
    <section class="card">
      <h3>At-Bat Replay</h3>
      ${a.batters.map((b,i)=>`
        <div class="list-item">
          <div><strong>${i+1}. Batter #${esc(b.jersey || '—')}</strong><br>
          <span class="muted">${b.pitches.map(p=>esc(p.result)).join(' · ') || 'No pitches'}</span></div>
          <span class="badge">${esc(b.outcome || '—')}</span>
        </div>`).join('') || `<p class="muted">No completed batters.</p>`}
    </section>
    <section class="card">
      <button class="secondary full" id="exportOneBtn">Export This Appearance</button>
      ${!a.endedAt ? `<button class="success full" id="resumeSummaryBtn" style="margin-top:10px">Resume Tracking</button>` : ''}
    </section>`;
  document.getElementById('exportOneBtn').addEventListener('click', () => downloadJson(`vip-appearance-${a.date}.json`, a));
  document.getElementById('resumeSummaryBtn')?.addEventListener('click', () => {
    data.activeAppearanceId = a.id; saveData(); navigate('tracker');
  });
}

function renderSettings() {
  app.innerHTML = `
    <section class="card">
      <h2>Settings</h2>
      <form id="settingsForm">
        <label>Default pitch limit</label>
        <input type="number" name="defaultPitchLimit" min="1" value="${data.settings.defaultPitchLimit || 85}">
        <label><input type="checkbox" name="enablePitchTypes" ${data.settings.enablePitchTypes?'checked':''}> Enable pitch types for future tracking</label>
        <button class="primary full" style="margin-top:12px">Save Settings</button>
      </form>
    </section>
    <section class="card">
      <h3>Backup and Restore</h3>
      <div class="grid two">
        <button class="secondary" id="exportAllBtn">Export All Data</button>
        <label class="secondary" style="text-align:center;margin:0">Import Data<input class="hidden" id="importFile" type="file" accept=".json,application/json"></label>
      </div>
      <button class="danger full" id="resetBtn" style="margin-top:12px">Erase All Local Data</button>
    </section>`;
  document.getElementById('settingsForm').addEventListener('submit', e => {
    e.preventDefault(); const f = new FormData(e.target);
    data.settings.defaultPitchLimit = Number(f.get('defaultPitchLimit')) || 85;
    data.settings.enablePitchTypes = !!f.get('enablePitchTypes');
    saveData(); alert('Settings saved.');
  });
  document.getElementById('exportAllBtn').addEventListener('click', () => downloadJson('vip-tracker-backup.json', data));
  document.getElementById('importFile').addEventListener('change', async e => {
    const file = e.target.files[0]; if (!file) return;
    try { data = JSON.parse(await file.text()); saveData(); renderSettings(); alert('Data imported.'); }
    catch { alert('That file is not a valid VIP Tracker backup.'); }
  });
  document.getElementById('resetBtn').addEventListener('click', () => {
    if (confirm('Erase all pitchers and appearances from this device?')) {
      data = structuredClone(defaultData); saveData(); navigate('home');
    }
  });
}

function downloadJson(filename, obj) {
  const blob = new Blob([JSON.stringify(obj,null,2)], {type:'application/json'});
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a'); a.href=url; a.download=filename; a.click();
  setTimeout(()=>URL.revokeObjectURL(url),1000);
}

if ('serviceWorker' in navigator) {
  window.addEventListener('load', () => navigator.serviceWorker.register('service-worker.js'));
}

render();
