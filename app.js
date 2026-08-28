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
    defaultPitchLimit: 85,
    inningsPerGame: 7
  }
};

const PITCH_TYPES = [
  { code: 'FB', label: 'Fastball', statKey: 'MPHFB' },
  { code: 'CT', label: 'Cutter', statKey: 'MPHCT' },
  { code: 'CB', label: 'Curveball', statKey: 'MPHCB' },
  { code: 'SL2', label: 'Slider', statKey: 'MPHSL' },
  { code: 'CH', label: 'Changeup', statKey: 'MPHCH' },
  { code: 'OS', label: 'Offspeed/Other', statKey: 'MPHOS' }
];

// Backfills fields added after an appearance may have been created/saved, so
// older saved data keeps working without a migration step.
function normalizeAppearance(a) {
  if (!a.tally) a.tally = { pik: 0, bk: 0, cs: 0, sb: 0 };
  if (typeof a.lob !== 'number') a.lob = 0;
  if (a.decision === undefined) a.decision = null;
  if (typeof a.saveOpportunity !== 'boolean') a.saveOpportunity = false;
  if (typeof a.isStart !== 'boolean') a.isStart = false;
  if (!a.bases) a.bases = { ...(a.inherited || emptyBases()) };
  return a;
}

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

/* ---------------------------------------------------------------------- */
/* Outcome catalog                                                         */
/* ---------------------------------------------------------------------- */

const STRIKEOUT_CODES = ['K', 'KL', 'D3O', 'D3R'];
const WALK_CODES = ['BB', 'IBB'];
const HIT_CODES = ['1B', '2B', '3B', 'HR'];

const SAFE_TYPES = [
  { code: 'BB',  label: 'Walk', outs: 0 },
  { code: 'IBB', label: 'Intentional Walk', outs: 0 },
  { code: 'HBP', label: 'Hit By Pitch', outs: 0 },
  { code: '1B',  label: 'Single', outs: 0 },
  { code: '2B',  label: 'Double', outs: 0 },
  { code: '3B',  label: 'Triple', outs: 0 },
  { code: 'HR',  label: 'Home Run', outs: 0 },
  { code: 'FC',  label: "Fielder's Choice", outs: 1, needsRunner: true, runnerBases: ['second','third'] },
  { code: 'ROE', label: 'Reached on Error', outs: 0 },
  { code: 'CI',  label: "Catcher's Interference", outs: 0 },
  { code: 'DI',  label: 'Defensive Interference', outs: 0 },
  { code: 'BT',  label: 'Bunt', outs: 0 },
  { code: 'D3R', label: 'Dropped 3rd Strike – Reached', outs: 0 },
  { code: 'OTHER', label: 'Other', outs: 0 }
];

// Special group code handled separately in the picker UI.
const OUT_TYPES = [
  { code: 'STRIKEOUT', label: 'Strikeout', outs: 1, group: true },
  { code: 'GO',  label: 'Groundout', outs: 1 },
  { code: 'COMEBACKER', label: 'Come-backer to Pitcher', outs: 1 },
  { code: 'D3O', label: 'Dropped 3rd Strike – Out', outs: 1 },
  { code: 'FO',  label: 'Flyout', outs: 1 },
  { code: 'LO',  label: 'Lineout', outs: 1 },
  { code: 'PO',  label: 'Popout', outs: 1 },
  { code: 'FORCE', label: 'Force Out', outs: 1, needsRunner: true },
  { code: 'TAG', label: 'Tag Out', outs: 1, needsRunner: true },
  { code: 'DP',  label: 'Double Play', outs: 2, needsRunner: true },
  { code: 'TP',  label: 'Triple Play', outs: 3, clearsBases: true },
  { code: 'IFR', label: 'Infield Fly Rule Out', outs: 1 }
];

function findOutcomeMeta(code) {
  if (code === 'K') return { code: 'K', label: 'Strikeout – Swinging', outs: 1 };
  if (code === 'KL') return { code: 'KL', label: 'Strikeout – Looking', outs: 1 };
  return SAFE_TYPES.find(o => o.code === code) || OUT_TYPES.find(o => o.code === code);
}

function outcomeLabel(code) {
  const meta = findOutcomeMeta(code);
  return meta ? meta.label : (code || '—');
}

// Earned-run heuristic: official scoring reconstructs the half-inning without
// the error, which needs runner-identity tracking this app doesn't have. As a
// practical stand-in: a run is unearned if the batter reached on an error
// (ROE) or an error was logged on this play; otherwise every run charged on
// this play is earned. Still hand-editable for cases the heuristic misses.
function computeDefaultEarnedRuns(code, runs, errors) {
  runs = runs || 0;
  if (code === 'ROE' || (errors || 0) > 0) return 0;
  return runs;
}

/* ---------------------------------------------------------------------- */
/* Base-running rules (simple boolean occupancy, semi-automatic)           */
/* ---------------------------------------------------------------------- */

function emptyBases() { return { first: false, second: false, third: false }; }

// Batter reaches first, forces only the runners that must move.
function forceAdvanceFromFirst(bases) {
  let { first, second, third } = bases;
  if (first) {
    if (second) {
      third = true; // former 2nd runner forced to 3rd (former 3rd runner scores if occupied)
      second = true; // former 1st runner forced to 2nd
    } else {
      second = true;
    }
  }
  first = true;
  return { first, second, third };
}

// Everyone (existing runners) advances exactly one base; batter takes first.
function shiftBasesByOne(bases) {
  return { first: true, second: bases.first, third: bases.second };
}

// A wild pitch / passed ball: existing runners each advance one base, no batter added.
function advanceOnMissedPitch(bases) {
  return { first: false, second: bases.first, third: bases.second };
}

function applyAdvancement(bases, code, runnerOutBase) {
  switch (code) {
    case '1B': case 'BT': case 'ROE':
      return shiftBasesByOne(bases);
    case '2B':
      return { first: false, second: true, third: bases.first };
    case '3B':
      return { first: false, second: false, third: true };
    case 'HR':
      return emptyBases();
    case 'BB': case 'IBB': case 'HBP': case 'CI': case 'DI': case 'OTHER': case 'D3R':
      return forceAdvanceFromFirst(bases);
    case 'FC': case 'FORCE': case 'TAG': {
      const without = { ...bases };
      if (runnerOutBase) without[runnerOutBase] = false;
      return forceAdvanceFromFirst(without);
    }
    case 'DP': {
      const without = { ...bases };
      if (runnerOutBase) without[runnerOutBase] = false;
      return without;
    }
    case 'TP':
      return emptyBases();
    default:
      return { ...bases }; // K, KL, GO, COMEBACKER, D3O, FO, LO, PO, IFR: unchanged
  }
}

function baseLabel(key) {
  return key === 'first' ? '1st' : key === 'second' ? '2nd' : '3rd';
}

// Tallies whoever is still on base into LOB and clears the bases — call this
// whenever a half-inning actually ends (3rd out, or the inning is manually
// advanced). This also fixes bases not resetting between innings.
function endHalfInning(a) {
  const occ = Object.values(a.bases || {}).filter(Boolean).length;
  a.lob = (a.lob || 0) + occ;
  a.bases = emptyBases();
}

/* ---------------------------------------------------------------------- */
/* Derived stats (always computed from batters, never drift)               */
/* ---------------------------------------------------------------------- */

function computeTotals(a) {
  let outs = 0, runs = 0, earnedRuns = 0, errors = 0;
  for (const b of a.batters) {
    if (!b.completed) continue;
    outs += b.outsRecorded || 0;
    runs += b.runs || 0;
    earnedRuns += b.earnedRuns || 0;
    errors += b.errors || 0;
  }
  return { outs, runs, earnedRuns, errors };
}

function statsFor(a) {
  const pitches = a.batters.flatMap(b => b.pitches || []);
  const strikes = pitches.filter(p => ['SL','SW','F','DK'].includes(p.result)).length;
  const balls = pitches.filter(p => p.result === 'B').length;
  const batters = a.batters.filter(b => b.completed).length;
  const firstPitchStrikes = a.batters.filter(b => b.completed && ['SL','SW','F','DK'].includes(b.pitches?.[0]?.result)).length;
  const strikeouts = a.batters.filter(b => STRIKEOUT_CODES.includes(b.outcome)).length;
  const looking = a.batters.filter(b => b.outcome === 'KL').length;
  const walks = a.batters.filter(b => WALK_CODES.includes(b.outcome)).length;
  const hits = a.batters.filter(b => HIT_CODES.includes(b.outcome)).length;
  const total = pitches.length;
  const totals = computeTotals(a);
  return {
    total, strikes, balls, batters, firstPitchStrikes, strikeouts, looking, walks, hits,
    strikePct: total ? (strikes / total * 100) : 0,
    firstPitchPct: batters ? (firstPitchStrikes / batters * 100) : 0,
    avgPerBatter: batters ? total / batters : 0,
    ip: formatIP(totals.outs),
    runs: totals.runs,
    earnedRuns: totals.earnedRuns,
    errors: totals.errors
  };
}

/* ---------------------------------------------------------------------- */
/* GameChanger-style stat line (Appearances screen + export only)          */
/* ---------------------------------------------------------------------- */

const GC_STAT_COLUMNS = [
  ['IP','Innings pitched'], ['GS','Games started'], ['BF','Total batters faced'], ['#P','Total pitches'],
  ['W','Wins'], ['L','Losses'], ['SV','Saves'], ['SVO','Save opportunities'], ['BS','Blown saves'], ['SV%','Save percentage'],
  ['H','Hits allowed'], ['R','Runs allowed'], ['ER','Earned runs allowed'], ['BB','Base on balls (walks)'], ['SO','Strikeouts'],
  ['K-L','Strikeouts looking'], ['HBP','Hit batters'], ['ERA','Earned run average'], ['WHIP','Walks plus hits per innings pitched'],
  ['LOB','Runners left on base'], ['BK','Balks'], ['PIK','Runners picked off'], ['CS','Runners caught stealing'], ['SB','Stolen bases allowed'],
  ['SB%','Stolen bases allowed percentage'], ['WP','Wild pitches'], ['BAA','Opponent batting average'],
  ['MPHFB','Fastball average velocity'], ['MPHCT','Cutter average velocity'], ['MPHCB','Curveball average velocity'],
  ['MPHSL','Slider average velocity'], ['MPHCH','Changeup average velocity'], ['MPHOS','Offspeed average velocity']
];

// Builds the full GameChanger-abbreviation stat line for one appearance.
// Only used on the Summary (Appearances) screen and exports — the live
// Tracker screen keeps its own simple pitch-count stat grid.
function gcStatsFor(a) {
  normalizeAppearance(a);
  const s = statsFor(a);
  const totals = computeTotals(a);
  const pitches = a.batters.flatMap(b => b.pitches || []);
  const outs = totals.outs;
  const tally = a.tally || { pik: 0, bk: 0, cs: 0, sb: 0 };
  const inningsPerGame = data.settings.inningsPerGame || 7;

  const hbp = a.batters.filter(b => b.completed && b.outcome === 'HBP').length;
  const nonAbCodes = ['BB','IBB','HBP','CI','DI'];
  const nonAb = a.batters.filter(b => b.completed && nonAbCodes.includes(b.outcome)).length;
  const ab = Math.max(0, s.batters - nonAb);
  const wp = pitches.filter(p => p.advance === 'WP').length;

  const era = outs > 0 ? (totals.earnedRuns / outs) * 3 * inningsPerGame : 0;
  const whip = outs > 0 ? (s.walks + s.hits) / (outs / 3) : 0;
  const baa = ab > 0 ? (s.hits / ab) : 0;

  const sbAttempts = (tally.sb || 0) + (tally.cs || 0);
  const sbPct = sbAttempts > 0 ? (tally.sb / sbAttempts * 100) : 0;

  const sv = a.decision === 'SV' ? 1 : 0;
  const bs = a.decision === 'BS' ? 1 : 0;
  const svo = a.saveOpportunity ? 1 : 0;
  const svPct = svo > 0 ? (sv / svo * 100) : 0;

  const velocities = {};
  for (const pt of PITCH_TYPES) {
    const vals = pitches.filter(p => p.pitchType === pt.code && typeof p.velocity === 'number' && !isNaN(p.velocity)).map(p => p.velocity);
    velocities[pt.statKey] = vals.length ? (vals.reduce((x,y) => x+y, 0) / vals.length) : null;
  }

  return {
    IP: s.ip, GS: a.isStart ? 1 : 0, BF: s.batters, '#P': s.total,
    W: a.decision === 'W' ? 1 : 0, L: a.decision === 'L' ? 1 : 0,
    SV: sv, SVO: svo, BS: bs, 'SV%': svPct,
    H: s.hits, R: s.runs, ER: s.earnedRuns, BB: s.walks, SO: s.strikeouts,
    'K-L': s.looking, HBP: hbp, ERA: era, WHIP: whip, LOB: a.lob || 0,
    BK: tally.bk || 0, PIK: tally.pik || 0, CS: tally.cs || 0, SB: tally.sb || 0, 'SB%': sbPct,
    WP: wp, BAA: baa,
    MPHFB: velocities.MPHFB, MPHCT: velocities.MPHCT, MPHCB: velocities.MPHCB,
    MPHSL: velocities.MPHSL, MPHCH: velocities.MPHCH, MPHOS: velocities.MPHOS
  };
}

function formatGcStat(code, val) {
  if (val === null || val === undefined) return '—';
  if (code === 'IP') return String(val);
  if (code === 'ERA' || code === 'WHIP') return Number(val).toFixed(2);
  if (code === 'BAA') return Number(val).toFixed(3).replace(/^0\./, '.');
  if (code.endsWith('%')) return Number(val).toFixed(1) + '%';
  if (code.startsWith('MPH')) return Number(val).toFixed(1);
  return String(val);
}

function renderGcStatsTable(a) {
  const stats = gcStatsFor(a);
  return `
    <div class="gc-stats-wrap">
      <table class="gc-stats">
        <thead><tr>${GC_STAT_COLUMNS.map(([code]) => `<th>${esc(code)}</th>`).join('')}</tr></thead>
        <tbody><tr>${GC_STAT_COLUMNS.map(([code]) => `<td>${formatGcStat(code, stats[code])}</td>`).join('')}</tr></tbody>
      </table>
    </div>
    <details style="margin-top:10px">
      <summary class="muted" style="cursor:pointer">What do these mean?</summary>
      <p class="muted" style="font-size:.8rem;line-height:1.6">
        ${GC_STAT_COLUMNS.map(([code,label]) => `<strong>${esc(code)}</strong> ${esc(label)}`).join(' &nbsp;·&nbsp; ')}
      </p>
    </details>`;
}

function gcCsvFor(a) {
  const p = pitcherById(a.pitcherId);
  const stats = gcStatsFor(a);
  const header = ['Pitcher','Date','Team','Opponent', ...GC_STAT_COLUMNS.map(([code]) => code)];
  const row = [
    p?.displayName || 'Pitcher', a.date, a.team, a.opponent,
    ...GC_STAT_COLUMNS.map(([code]) => (stats[code] === null || stats[code] === undefined) ? '' : stats[code])
  ];
  const escCsv = v => /[",\n]/.test(String(v)) ? `"${String(v).replace(/"/g,'""')}"` : String(v);
  return header.map(escCsv).join(',') + '\n' + row.map(escCsv).join(',');
}

function downloadCsv(filename, csvText) {
  const blob = new Blob([csvText], { type: 'text/csv' });
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a'); link.href = url; link.download = filename; link.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
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
        <div class="list-item" data-edit-pitcher="${p.id}">
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
        ${pitcherFormFields()}
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
  app.querySelectorAll('[data-edit-pitcher]').forEach(row => row.addEventListener('click', () => {
    const pitcher = pitcherById(row.dataset.editPitcher);
    if (pitcher) openPitcherEditor(pitcher);
  }));
}

function pitcherFormFields(p) {
  const v = p || {};
  return `
    <div class="row">
      <div><label>First name</label><input name="firstName" value="${esc(v.firstName||'')}" required></div>
      <div><label>Last name</label><input name="lastName" value="${esc(v.lastName||'')}" required></div>
    </div>
    <label>Display name or nickname</label><input name="displayName" placeholder="Optional" value="${esc(v.displayName||'')}">
    <div class="row">
      <div><label>Jersey number</label><input name="jersey" inputmode="numeric" value="${esc(v.jersey||'')}"></div>
      <div><label>Throwing arm</label><select name="arm">
        <option ${v.arm==='Right'||!v.arm?'selected':''}>Right</option>
        <option ${v.arm==='Left'?'selected':''}>Left</option>
      </select></div>
    </div>
    <label>Date of birth</label><input type="date" name="dob" value="${esc(v.dob||'')}">
    <div class="row">
      <div><label>School</label><input name="school" value="${esc(v.school||'')}"></div>
      <div><label>Graduation year</label><input name="gradYear" inputmode="numeric" value="${esc(v.gradYear||'')}"></div>
    </div>`;
}

function openPitcherEditor(pitcher) {
  showModal(`
    <h3>Edit Pitcher</h3>
    <form id="editPitcherForm">
      ${pitcherFormFields(pitcher)}
      <button class="primary full" type="submit" style="margin-top:14px">Save Changes</button>
      <button class="secondary full" type="button" id="cancelEditPitcher" style="margin-top:10px">Cancel</button>
    </form>
  `, backdrop => {
    backdrop.querySelector('#editPitcherForm').addEventListener('submit', e => {
      e.preventDefault();
      const f = new FormData(e.target);
      const first = f.get('firstName').trim();
      const last = f.get('lastName').trim();
      pitcher.firstName = first;
      pitcher.lastName = last;
      pitcher.displayName = f.get('displayName').trim() || `${first} ${last}`;
      pitcher.jersey = f.get('jersey').trim();
      pitcher.arm = f.get('arm');
      pitcher.dob = f.get('dob');
      pitcher.school = f.get('school').trim();
      pitcher.gradYear = f.get('gradYear').trim();
      saveData();
      closeModal(backdrop);
      renderPitchers();
    });
    backdrop.querySelector('#cancelEditPitcher').addEventListener('click', () => closeModal(backdrop));
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
        <label style="margin-top:10px"><input type="checkbox" name="isStart" id="isStartChk"> Game start (GS)</label>
        <button class="primary full" style="margin-top:14px">Start Tracking</button>
      </form>
    </section>`;
  const form = document.getElementById('appearanceForm');
  let gsManual = false;
  function recomputeGS() {
    if (gsManual) return;
    const f = new FormData(form);
    const isTop1NoOuts = Number(f.get('inning')) === 1 && f.get('half') === 'Top' && Number(f.get('outs')) === 0;
    const noInherited = !f.get('r1') && !f.get('r2') && !f.get('r3');
    document.getElementById('isStartChk').checked = isTop1NoOuts && noInherited;
  }
  form.querySelectorAll('[name="inning"],[name="half"],[name="outs"],[name="r1"],[name="r2"],[name="r3"]')
    .forEach(el => el.addEventListener('input', recomputeGS));
  document.getElementById('isStartChk').addEventListener('change', () => { gsManual = true; });
  recomputeGS();
  form.addEventListener('submit', e => {
    e.preventDefault();
    const f = new FormData(e.target);
    const inherited = { first: !!f.get('r1'), second: !!f.get('r2'), third: !!f.get('r3') };
    const a = {
      id:uid('appearance'), pitcherId:f.get('pitcherId'), date:f.get('date'),
      team:f.get('team').trim(), opponent:f.get('opponent').trim(),
      location:f.get('location').trim(), inning:Number(f.get('inning')),
      startInning:Number(f.get('inning')), half:f.get('half'),
      entryOuts:Number(f.get('outs')), currentOuts:Number(f.get('outs')),
      pitchLimit:Number(f.get('pitchLimit')) || null,
      inherited, bases: { ...inherited },
      isStart: !!f.get('isStart'), decision: null, saveOpportunity: false,
      tally: { pik: 0, bk: 0, cs: 0, sb: 0 }, lob: 0,
      batters:[], currentBatter:null, createdAt:Date.now(), endedAt:null, endReason:''
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
    pitches:[], outcome:null, completed:false, outsRecorded:0, runs:0, earnedRuns:0, errors:0, runnerOutBase:null
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

function pitchLabel(code) {
  return { SL:'SL', SW:'SW', B:'Ball', F:'Foul', DK:'Drop K' }[code] || code;
}

/* ---------------------------------------------------------------------- */
/* Tracker screen                                                          */
/* ---------------------------------------------------------------------- */

function renderTracker() {
  const a = activeAppearance();
  if (!a) return navigate('home');
  normalizeAppearance(a);
  if (!a.currentBatter) startNextBatter(a);
  const b = a.currentBatter;
  const s = statsFor(a);
  const c = currentCount(b);
  const nearLimit = a.pitchLimit && s.total >= a.pitchLimit - 5;
  const completedBatters = [...a.batters].reverse();
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
      <div class="sequence">${b.pitches.map(p=>`<span>${esc(pitchLabel(p.result))}${p.advance ? ` · ${p.advance}` : ''}</span>`).join('')}</div>
    </section>

    ${renderBasesWidget(a)}

    <section class="card">
      <div class="grid five">
        <button class="pitch-btn" data-pitch="SL">SL</button>
        <button class="pitch-btn" data-pitch="SW">SW</button>
        <button class="pitch-btn ball" data-pitch="B">Ball</button>
        <button class="pitch-btn foul" data-pitch="F">Foul</button>
        <button class="pitch-btn" data-pitch="DK">Drop K</button>
      </div>
      ${renderPitchTypeWidget(a)}
      <div class="grid two" style="margin-top:10px">
        <button class="wp-btn" id="wildPitchBtn" ${!b.pitches.length ? 'disabled' : ''}>Wild Pitch</button>
        <button class="wp-btn" id="passedBallBtn" ${!b.pitches.length ? 'disabled' : ''}>Passed Ball</button>
      </div>
      <div class="grid two" style="margin-top:12px">
        <button class="undo" id="undoBtn">Undo Last Pitch</button>
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

    ${renderTallyWidget(a)}

    <section class="card">
      <div class="grid two">
        <button class="secondary" id="advanceInningBtn">Advance Inning</button>
        <button class="danger" id="endAppearanceBtn">End Appearance</button>
      </div>
    </section>

    ${completedBatters.length ? `
    <section class="card">
      <h3 class="section-title">This Game – Tap to Fix a Batter</h3>
      ${completedBatters.map((cb,i) => `
        <div class="list-item" data-edit-batter="${cb.id}">
          <div><strong>${completedBatters.length - i}. Batter #${esc(cb.jersey || '—')}</strong><br>
          <span class="muted">${(cb.pitches||[]).map(p=>esc(pitchLabel(p.result))).join(' · ') || 'No pitches'}</span></div>
          <span class="badge">${esc(outcomeLabel(cb.outcome))}</span>
        </div>`).join('')}
    </section>` : ''}
  `;
  document.getElementById('batterJersey').addEventListener('input', e => {
    b.jersey = e.target.value.trim();
    document.getElementById('batterNumberLabel').textContent = b.jersey || '—';
    saveData();
  });
  app.querySelectorAll('[data-pitch]').forEach(btn => btn.addEventListener('click', () => {
    const tagged = data.settings.enablePitchTypes;
    b.pitches.push({
      id:uid('pitch'), result:btn.dataset.pitch, at:Date.now(),
      pitchType: tagged ? (a.pendingPitchType || 'FB') : null,
      velocity: tagged && a.pendingVelocity ? Number(a.pendingVelocity) : null,
      advance:null
    });
    saveData(); renderTracker();
  }));
  wirePitchTypeWidget(app, a, renderTracker);
  wireTallyWidget(app, a, renderTracker);
  document.getElementById('wildPitchBtn')?.addEventListener('click', () => {
    if (!b.pitches.length) return;
    b.pitches[b.pitches.length-1].advance = 'WP';
    a.bases = advanceOnMissedPitch(a.bases);
    saveData(); renderTracker();
  });
  document.getElementById('passedBallBtn')?.addEventListener('click', () => {
    if (!b.pitches.length) return;
    b.pitches[b.pitches.length-1].advance = 'PB';
    a.bases = advanceOnMissedPitch(a.bases);
    saveData(); renderTracker();
  });
  document.getElementById('undoBtn').addEventListener('click', () => {
    b.pitches.pop(); saveData(); renderTracker();
  });
  document.getElementById('outcomeBtn').addEventListener('click', () => openOutcomeEditor(a, { onDone: () => renderTracker() }));
  document.getElementById('advanceInningBtn').addEventListener('click', () => {
    endHalfInning(a);
    a.inning += 1; a.currentOuts = 0; saveData(); renderTracker();
  });
  document.getElementById('endAppearanceBtn').addEventListener('click', () => showEndModal(a));
  app.querySelectorAll('[data-base]').forEach(btn => btn.addEventListener('click', () => {
    const key = btn.dataset.base;
    a.bases[key] = !a.bases[key];
    saveData(); renderTracker();
  }));
  app.querySelectorAll('[data-edit-batter]').forEach(row => row.addEventListener('click', () => {
    const batter = a.batters.find(x => x.id === row.dataset.editBatter);
    if (batter) openOutcomeEditor(a, { existingBatter: batter, onDone: () => renderTracker() });
  }));
}

function renderBasesWidget(a) {
  const bases = a.bases || emptyBases();
  return `
    <section class="card">
      <div class="kicker">Runners on Base · tap to correct</div>
      <div class="bases-row">
        <button class="base-pill ${bases.first ? 'on' : ''}" data-base="first">1st</button>
        <button class="base-pill ${bases.second ? 'on' : ''}" data-base="second">2nd</button>
        <button class="base-pill ${bases.third ? 'on' : ''}" data-base="third">3rd</button>
      </div>
    </section>`;
}

const TALLY_FIELDS = [
  { key: 'pik', label: 'Pickoffs (PIK)' },
  { key: 'bk', label: 'Balks (BK)' },
  { key: 'cs', label: 'Caught Stealing (CS)' },
  { key: 'sb', label: 'Stolen Bases (SB)' }
];

function renderTallyWidget(a) {
  const t = a.tally || { pik: 0, bk: 0, cs: 0, sb: 0 };
  return `
    <section class="card">
      <div class="kicker">Live Tallies</div>
      <div class="grid two" style="margin-top:8px">
        ${TALLY_FIELDS.map(f => `
          <div class="tally-row">
            <span>${f.label}</span>
            <div class="tally-controls">
              <button class="secondary small" type="button" data-tally-dec="${f.key}">−</button>
              <strong>${t[f.key] || 0}</strong>
              <button class="secondary small" type="button" data-tally-inc="${f.key}">+</button>
            </div>
          </div>`).join('')}
      </div>
    </section>`;
}

function wireTallyWidget(root, a, rerender) {
  if (!a.tally) a.tally = { pik: 0, bk: 0, cs: 0, sb: 0 };
  root.querySelectorAll('[data-tally-inc]').forEach(btn => btn.addEventListener('click', () => {
    const key = btn.dataset.tallyInc;
    a.tally[key] = (a.tally[key] || 0) + 1;
    saveData(); rerender();
  }));
  root.querySelectorAll('[data-tally-dec]').forEach(btn => btn.addEventListener('click', () => {
    const key = btn.dataset.tallyDec;
    a.tally[key] = Math.max(0, (a.tally[key] || 0) - 1);
    saveData(); rerender();
  }));
}

function renderPitchTypeWidget(a) {
  if (!data.settings.enablePitchTypes) return '';
  const selected = a.pendingPitchType || 'FB';
  return `
    <div class="pitch-type-row">
      <span class="muted" style="font-size:.78rem">Tag next pitch:</span>
      ${PITCH_TYPES.map(pt => `<button type="button" class="pitch-type-chip ${pt.code===selected?'on':''}" data-pitch-type="${pt.code}">${pt.label}</button>`).join('')}
      <input type="number" id="pendingVelocity" placeholder="MPH" value="${a.pendingVelocity || ''}" inputmode="numeric">
    </div>`;
}

function wirePitchTypeWidget(root, a, rerender) {
  if (!data.settings.enablePitchTypes) return;
  root.querySelectorAll('[data-pitch-type]').forEach(btn => btn.addEventListener('click', () => {
    a.pendingPitchType = btn.dataset.pitchType;
    saveData(); rerender();
  }));
  root.querySelector('#pendingVelocity')?.addEventListener('input', e => {
    a.pendingVelocity = e.target.value;
    saveData();
  });
}

/* ---------------------------------------------------------------------- */
/* Outcome editor (used for recording AND editing a batter)                */
/* ---------------------------------------------------------------------- */

function openOutcomeEditor(a, { existingBatter, onDone }) {
  const isEdit = !!existingBatter;
  const target = existingBatter || a.currentBatter;
  const state = {
    stage: isEdit && target.outcome ? 'detail' : 'category',
    category: isEdit ? (SAFE_TYPES.some(t => t.code === target.outcome) ? 'safe' : 'out') : null,
    code: isEdit ? target.outcome : null,
    runnerOutBase: isEdit ? target.runnerOutBase : null,
    outs: isEdit ? target.outsRecorded : 0,
    runs: isEdit ? target.runs : 0,
    earnedRuns: isEdit ? target.earnedRuns : 0,
    errors: isEdit ? target.errors : 0,
    // Tracks whether the user has typed directly into the Earned Runs field this
    // session — until then, it live-recomputes from Runs Scored/Errors so opening
    // an edit still shows whatever was already saved (see detail-stage render).
    earnedRunsManual: false,
    pitches: isEdit ? [...(target.pitches || [])] : null
  };

  const tpl = document.getElementById('modalTemplate');
  const node = tpl.content.cloneNode(true);
  document.body.appendChild(node);
  const backdrop = document.querySelector('.modal-backdrop:last-of-type');
  const content = backdrop.querySelector('.modal-content');

  function occupiedBases() {
    return Object.keys(a.bases || {}).filter(k => a.bases[k]);
  }

  // FC is restricted to the lead runner (2nd/3rd) per user convention; FORCE/TAG/DP
  // keep the full occupied-base list. See findOutcomeMeta().runnerBases.
  function eligibleRunnerBases(code) {
    const meta = findOutcomeMeta(code);
    const allowed = meta && meta.runnerBases;
    const occ = occupiedBases();
    return allowed ? occ.filter(k => allowed.includes(k)) : occ;
  }

  function renderStage() {
    if (state.stage === 'category') {
      content.innerHTML = `
        <h3>${isEdit ? 'Edit Outcome' : 'Record Batter Outcome'}</h3>
        <div class="grid two">
          <button class="outcome-btn safe-choice" id="pickSafe">Safe</button>
          <button class="outcome-btn out-choice" id="pickOut">Out</button>
        </div>
        <button class="secondary full" id="cancelModal" style="margin-top:12px">Cancel</button>`;
      content.querySelector('#pickSafe').addEventListener('click', () => { state.category = 'safe'; state.stage = 'type'; renderStage(); });
      content.querySelector('#pickOut').addEventListener('click', () => { state.category = 'out'; state.stage = 'type'; renderStage(); });
      content.querySelector('#cancelModal').addEventListener('click', () => backdrop.remove());
      return;
    }

    if (state.stage === 'type') {
      const list = state.category === 'safe' ? SAFE_TYPES : OUT_TYPES;
      const visible = list.filter(o => {
        if (['FC','FORCE','TAG','DP','TP'].includes(o.code)) return eligibleRunnerBases(o.code).length > 0;
        return true;
      });
      content.innerHTML = `
        <h3>${state.category === 'safe' ? 'How did they reach base?' : 'What kind of out?'}</h3>
        <div class="grid three">
          ${visible.map(o => `<button class="outcome-btn" data-code="${o.code}">${esc(o.label)}</button>`).join('')}
        </div>
        <button class="secondary full" id="backBtn" style="margin-top:12px">Back</button>
      `;
      content.querySelectorAll('[data-code]').forEach(btn => btn.addEventListener('click', () => {
        const code = btn.dataset.code;
        if (code === 'STRIKEOUT') { state.stage = 'strikeoutSub'; renderStage(); return; }
        const meta = findOutcomeMeta(code);
        state.code = code;
        state.outs = meta.outs;
        if (meta.needsRunner) { state.stage = 'runner'; renderStage(); }
        else { state.stage = 'detail'; renderStage(); }
      }));
      content.querySelector('#backBtn').addEventListener('click', () => { state.stage = 'category'; renderStage(); });
      return;
    }

    if (state.stage === 'strikeoutSub') {
      content.innerHTML = `
        <h3>Strikeout – Swinging or Looking?</h3>
        <div class="grid two">
          <button class="outcome-btn" data-code="K">Swinging</button>
          <button class="outcome-btn" data-code="KL">Looking</button>
        </div>
        <button class="secondary full" id="backBtn" style="margin-top:12px">Back</button>`;
      content.querySelectorAll('[data-code]').forEach(btn => btn.addEventListener('click', () => {
        state.code = btn.dataset.code;
        state.outs = 1;
        state.stage = 'detail';
        renderStage();
      }));
      content.querySelector('#backBtn').addEventListener('click', () => { state.stage = 'type'; renderStage(); });
      return;
    }

    if (state.stage === 'runner') {
      const occ = eligibleRunnerBases(state.code);
      content.innerHTML = `
        <h3>Which runner was put out?</h3>
        ${state.code === 'FC' ? '<p class="muted">Fielder\'s Choice targets the lead runner — batter reaches base.</p>' : ''}
        <div class="grid three">
          ${occ.map(k => `<button class="outcome-btn" data-runner="${k}">Runner on ${baseLabel(k)}</button>`).join('')}
        </div>
        <button class="secondary full" id="backBtn" style="margin-top:12px">Back</button>`;
      content.querySelectorAll('[data-runner]').forEach(btn => btn.addEventListener('click', () => {
        state.runnerOutBase = btn.dataset.runner;
        state.stage = 'detail';
        renderStage();
      }));
      content.querySelector('#backBtn').addEventListener('click', () => { state.stage = 'type'; renderStage(); });
      return;
    }

    if (state.stage === 'detail') {
      const meta = findOutcomeMeta(state.code);
      content.innerHTML = `
        <h3>${esc(meta ? meta.label : 'Outcome')}</h3>
        ${isEdit ? `
        <div class="kicker">Pitch Sequence</div>
        <div class="sequence" id="pitchChips">
          ${state.pitches.map((p,i)=>`<span data-remove-pitch="${i}">${esc(pitchLabel(p.result))}${p.advance ? ' · '+p.advance : ''} ✕</span>`).join('') || '<span class="muted">No pitches recorded</span>'}
        </div>
        <div class="grid five" style="margin-top:8px">
          <button class="pitch-btn small" data-add-pitch="SL">SL</button>
          <button class="pitch-btn small" data-add-pitch="SW">SW</button>
          <button class="pitch-btn small ball" data-add-pitch="B">Ball</button>
          <button class="pitch-btn small foul" data-add-pitch="F">Foul</button>
          <button class="pitch-btn small" data-add-pitch="DK">Drop K</button>
        </div>` : ''}
        <div class="row" style="margin-top:12px">
          <div><label>Outs recorded</label><select id="outsRecorded"><option>0</option><option>1</option><option>2</option><option>3</option></select></div>
          <div><label>Runs scored</label><input id="runsScored" type="number" min="0" value="${state.runs||0}"></div>
        </div>
        <div class="row">
          <div>
            <label>Earned runs</label>
            <input id="earnedRuns" type="number" min="0" value="${state.earnedRuns||0}">
            <span class="muted" id="erHint" style="font-size:12px">${state.earnedRunsManual ? 'Edited manually · ' : 'Auto from outcome/errors · '}<a href="#" id="erAutoReset">${state.earnedRunsManual ? 'reset to auto' : ''}</a></span>
          </div>
          <div><label>Errors</label><input id="errors" type="number" min="0" value="${state.errors||0}"></div>
        </div>
        <button class="primary full" id="saveOutcome" style="margin-top:12px">${isEdit ? 'Save Changes' : 'Save and Next Batter'}</button>
        <button class="secondary full" id="changeType" style="margin-top:10px">Change Outcome Type</button>
        <button class="secondary full" id="cancelModal" style="margin-top:10px">Cancel</button>
      `;
      content.querySelector('#outsRecorded').value = String(state.outs || 0);
      if (isEdit) {
        content.querySelectorAll('[data-remove-pitch]').forEach(chip => chip.addEventListener('click', () => {
          state.pitches.splice(Number(chip.dataset.removePitch), 1);
          renderStage();
        }));
        content.querySelectorAll('[data-add-pitch]').forEach(btn => btn.addEventListener('click', () => {
          state.pitches.push({ id: uid('pitch'), result: btn.dataset.addPitch, at: Date.now(), pitchType: null, velocity: null, advance: null });
          renderStage();
        }));
      }
      function refreshAutoEarnedRuns() {
        if (state.earnedRunsManual) return;
        const runs = Number(content.querySelector('#runsScored').value) || 0;
        const errors = Number(content.querySelector('#errors').value) || 0;
        content.querySelector('#earnedRuns').value = computeDefaultEarnedRuns(state.code, runs, errors);
      }
      content.querySelector('#runsScored').addEventListener('input', refreshAutoEarnedRuns);
      content.querySelector('#errors').addEventListener('input', refreshAutoEarnedRuns);
      content.querySelector('#earnedRuns').addEventListener('input', () => {
        state.earnedRunsManual = true;
        content.querySelector('#erHint').innerHTML = 'Edited manually · <a href="#" id="erAutoReset">reset to auto</a>';
        content.querySelector('#erAutoReset').addEventListener('click', ev => {
          ev.preventDefault();
          state.earnedRunsManual = false;
          refreshAutoEarnedRuns();
          content.querySelector('#erHint').innerHTML = 'Auto from outcome/errors · <a href="#" id="erAutoReset"></a>';
        });
      });
      content.querySelector('#erAutoReset')?.addEventListener('click', ev => {
        ev.preventDefault();
        state.earnedRunsManual = false;
        refreshAutoEarnedRuns();
        content.querySelector('#erHint').innerHTML = 'Auto from outcome/errors · <a href="#" id="erAutoReset"></a>';
      });
      content.querySelector('#saveOutcome').addEventListener('click', () => {
        state.outs = Number(content.querySelector('#outsRecorded').value);
        state.runs = Number(content.querySelector('#runsScored').value) || 0;
        state.earnedRuns = Number(content.querySelector('#earnedRuns').value) || 0;
        state.errors = Number(content.querySelector('#errors').value) || 0;
        commit();
      });
      content.querySelector('#changeType').addEventListener('click', () => { state.stage = 'type'; renderStage(); });
      content.querySelector('#cancelModal').addEventListener('click', () => backdrop.remove());
      return;
    }
  }

  function commit() {
    if (isEdit) {
      const prevOuts = target.outsRecorded || 0;
      target.jersey = target.jersey || '';
      if (state.pitches) target.pitches = state.pitches;
      target.outcome = state.code;
      target.completed = true;
      target.runnerOutBase = state.runnerOutBase || null;
      target.outsRecorded = state.outs;
      target.runs = state.runs;
      target.earnedRuns = state.earnedRuns;
      target.errors = state.errors;
      const delta = target.outsRecorded - prevOuts;
      if (delta !== 0) {
        let total = (a.currentOuts || 0) + delta;
        while (total < 0) { total += 3; a.inning -= 1; }
        while (total >= 3) { total -= 3; a.inning += 1; }
        a.currentOuts = total;
      }
    } else {
      const b = a.currentBatter;
      b.outcome = state.code;
      b.completed = true;
      b.runnerOutBase = state.runnerOutBase || null;
      b.outsRecorded = state.outs;
      b.runs = state.runs;
      b.earnedRuns = state.earnedRuns;
      b.errors = state.errors;
      a.currentOuts += b.outsRecorded;
      a.bases = applyAdvancement(a.bases, b.outcome, b.runnerOutBase);
      a.batters.push(b);
      if (a.currentOuts >= 3) endHalfInning(a);
      while (a.currentOuts >= 3) { a.currentOuts -= 3; a.inning += 1; }
      startNextBatter(a);
    }
    saveData();
    backdrop.remove();
    onDone && onDone();
  }

  renderStage();
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

const DECISION_OPTIONS = [
  { value: '', label: 'None' },
  { value: 'W', label: 'Win' },
  { value: 'L', label: 'Loss' },
  { value: 'SV', label: 'Save' },
  { value: 'HOLD', label: 'Hold' },
  { value: 'BS', label: 'Blown Save' }
];

function decisionFieldsHtml(a) {
  return `
    <label>Game decision</label>
    <select id="decisionSelect">
      ${DECISION_OPTIONS.map(o => `<option value="${o.value}" ${((a.decision||'')===o.value)?'selected':''}>${o.label}</option>`).join('')}
    </select>
    <label><input type="checkbox" id="saveOppChk" ${a.saveOpportunity?'checked':''}> Entered in a save opportunity (SVO)</label>`;
}

function wireDecisionFields(root, a, rerender) {
  root.querySelector('#decisionSelect')?.addEventListener('change', e => {
    a.decision = e.target.value || null;
    if (a.decision === 'SV' || a.decision === 'BS') a.saveOpportunity = true;
    saveData(); rerender();
  });
  root.querySelector('#saveOppChk')?.addEventListener('change', e => {
    a.saveOpportunity = e.target.checked;
    saveData(); rerender();
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
    ${decisionFieldsHtml(a)}
    <button class="danger full" id="confirmEnd" style="margin-top:12px">End and Save</button>
    <button class="secondary full" id="cancelEnd" style="margin-top:10px">Cancel</button>
  `, backdrop => {
    backdrop.querySelector('#decisionSelect').addEventListener('change', e => {
      if (e.target.value === 'SV' || e.target.value === 'BS') backdrop.querySelector('#saveOppChk').checked = true;
    });
    backdrop.querySelector('#confirmEnd').addEventListener('click', () => {
      a.endReason = backdrop.querySelector('#endReason').value;
      a.notes = backdrop.querySelector('#endNotes').value.trim();
      a.decision = backdrop.querySelector('#decisionSelect').value || null;
      a.saveOpportunity = backdrop.querySelector('#saveOppChk').checked;
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
  normalizeAppearance(a);
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
      <h3 class="section-title">Full Stat Line (GameChanger style)</h3>
      ${renderGcStatsTable(a)}
    </section>
    <section class="card">
      <h3 class="section-title">Decision &amp; Situational</h3>
      ${decisionFieldsHtml(a)}
    </section>
    ${renderTallyWidget(a)}
    <section class="card">
      <h3>At-Bat Replay – tap to fix a batter</h3>
      ${a.batters.map((b,i)=>`
        <div class="list-item" data-edit-batter="${b.id}">
          <div><strong>${i+1}. Batter #${esc(b.jersey || '—')}</strong><br>
          <span class="muted">${b.pitches.map(p=>esc(pitchLabel(p.result))).join(' · ') || 'No pitches'}</span></div>
          <span class="badge">${esc(outcomeLabel(b.outcome))}</span>
        </div>`).join('') || `<p class="muted">No completed batters.</p>`}
    </section>
    <section class="card">
      <button class="secondary full" id="exportOneBtn">Export This Appearance (JSON)</button>
      <button class="secondary full" id="exportGcBtn" style="margin-top:10px">Export Stat Line (CSV)</button>
      ${!a.endedAt ? `<button class="success full" id="resumeSummaryBtn" style="margin-top:10px">Resume Tracking</button>` : ''}
    </section>`;
  document.getElementById('exportOneBtn').addEventListener('click', () => downloadJson(`vip-appearance-${a.date}.json`, a));
  document.getElementById('exportGcBtn').addEventListener('click', () => downloadCsv(`vip-stat-line-${a.date}.csv`, gcCsvFor(a)));
  document.getElementById('resumeSummaryBtn')?.addEventListener('click', () => {
    data.activeAppearanceId = a.id; saveData(); navigate('tracker');
  });
  wireDecisionFields(app, a, () => renderSummary(id));
  wireTallyWidget(app, a, () => renderSummary(id));
  app.querySelectorAll('[data-edit-batter]').forEach(row => row.addEventListener('click', () => {
    const batter = a.batters.find(x => x.id === row.dataset.editBatter);
    if (batter) openOutcomeEditor(a, { existingBatter: batter, onDone: () => renderSummary(id) });
  }));
}

function renderSettings() {
  app.innerHTML = `
    <section class="card">
      <h2>Settings</h2>
      <form id="settingsForm">
        <label>Default pitch limit</label>
        <input type="number" name="defaultPitchLimit" min="1" value="${data.settings.defaultPitchLimit || 85}">
        <label>Innings per regulation game (for ERA)</label>
        <input type="number" name="inningsPerGame" min="1" value="${data.settings.inningsPerGame || 7}">
        <label><input type="checkbox" name="enablePitchTypes" ${data.settings.enablePitchTypes?'checked':''}> Tag pitch type &amp; velocity for each pitch (fastball/curveball/etc.)</label>
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
    data.settings.inningsPerGame = Number(f.get('inningsPerGame')) || 7;
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