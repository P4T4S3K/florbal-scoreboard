/*
 * Florbal scoreboard – UI.
 *
 * index.html            operator view (scoreboard + controls)
 * index.html?display    audience view (scoreboard only), e.g. on a projector;
 *                       it follows the operator view through localStorage.
 */
(function () {
  'use strict';

  const STORAGE_KEY = 'florbal-scoreboard:v1';
  const isDisplay = new URLSearchParams(location.search).has('display');
  const $ = (sel, root = document) => root.querySelector(sel);
  const $$ = (sel, root = document) => Array.from(root.querySelectorAll(sel));

  let state = load() || FS.createState();

  function load() {
    try {
      const s = JSON.parse(localStorage.getItem(STORAGE_KEY));
      if (!s || !s.clock || !s.home) return null;
      s.settings = Object.assign({}, FS.DEFAULT_SETTINGS, s.settings);
      return s;
    } catch (e) {
      return null;
    }
  }

  function save() {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
    } catch (e) {
      /* storage unavailable – keep running in memory */
    }
  }

  function commit() {
    save();
    renderStatic();
    renderLive();
  }

  /* ---------- buzzer ---------- */

  let audio;
  function buzz() {
    if (!state.settings.buzzer) return;
    try {
      audio = audio || new (window.AudioContext || window.webkitAudioContext)();
      const t = audio.currentTime;
      const osc = audio.createOscillator();
      const gain = audio.createGain();
      osc.type = 'sawtooth';
      osc.frequency.value = 196;
      gain.gain.setValueAtTime(0.3, t);
      gain.gain.setValueAtTime(0.3, t + 1.3);
      gain.gain.linearRampToValueAtTime(0, t + 1.5);
      osc.connect(gain).connect(audio.destination);
      osc.start(t);
      osc.stop(t + 1.5);
    } catch (e) {
      /* no audio */
    }
  }

  /* ---------- rendering ---------- */

  const board = $('#board');
  const teamEls = {};
  for (const team of FS.TEAMS) {
    const el = $(`.team[data-team="${team}"]`, board);
    teamEls[team] = {
      name: $('[data-bind="name"]', el),
      score: $('[data-bind="score"]', el),
      shots: $('[data-bind="shots"]', el),
      timeout: $('[data-bind="timeout"]', el),
      pens: $('[data-bind="pens"]', el),
      ctrlPens: isDisplay ? null : $(`.team-panel[data-team="${team}"] [data-bind="ctrl-pens"]`),
    };
  }

  function escapeHtml(s) {
    return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  }

  // Rebuilds the list only when the set of penalties changes, so buttons
  // inside it are not replaced while the operator clicks them.
  function renderPenalties(ul, pens, gt, removable) {
    const key = pens.map((p) => p.id + (p.start === null ? 'q' : 'r')).join(',');
    if (ul.dataset.key !== key) {
      ul.dataset.key = key;
      ul.innerHTML = pens
        .map((p) => {
          const def = FS.PENALTY_TYPES[p.type];
          const cls = p.start === null ? 'waiting' : def.team ? '' : 'personal';
          return (
            `<li class="${cls}" data-id="${p.id}">` +
            `<span class="pen-player">${p.player ? '#' + escapeHtml(p.player) : '–'}</span>` +
            `<span class="pen-type">${def.label}</span>` +
            `<span class="pen-time"></span>` +
            (removable ? `<button class="x" data-action="remove-penalty" data-id="${p.id}" title="Remove">✕</button>` : '') +
            `</li>`
          );
        })
        .join('');
    }
    $$('li', ul).forEach((li, i) => {
      const t = FS.fmtCountdown(FS.penaltyRemaining(pens[i], gt));
      const span = $('.pen-time', li);
      if (span.textContent !== t) span.textContent = t;
    });
  }

  function setText(el, text) {
    if (el.textContent !== text) el.textContent = text;
  }

  function renderLive() {
    const now = Date.now();
    const gt = FS.gameTime(state, now);
    const root = document.documentElement.style;
    root.setProperty('--home', state.home.color);
    root.setProperty('--away', state.away.color);

    for (const team of FS.TEAMS) {
      const t = state[team];
      const els = teamEls[team];
      setText(els.name, t.name);
      setText(els.score, String(t.score));
      setText(els.shots, 'SOG ' + t.shots);
      els.timeout.classList.toggle('used', t.timeoutUsed);
      // running penalties first, then waiting ones
      const pens = state.penalties
        .filter((p) => p.team === team)
        .sort((a, b) => (a.start === null) - (b.start === null));
      renderPenalties(els.pens, pens, gt, false);
      if (els.ctrlPens) renderPenalties(els.ctrlPens, pens, gt, true);
    }

    const s = state.settings;
    let period;
    if (FS.isShootout(state)) period = 'Penalty shots';
    else if (FS.isOvertime(state)) period = 'Overtime';
    else period = 'Period ' + state.period + (s.periods > 1 ? ' / ' + s.periods : '');
    setText($('#period'), period);

    const clockEl = $('#clock');
    const remaining = FS.countdown(state.clock, now);
    setText(clockEl, FS.isShootout(state) ? '—' : FS.fmtClock(remaining));
    clockEl.classList.toggle('running', state.clock.running);
    clockEl.classList.toggle('last-minute', remaining < FS.MIN && remaining > 0);

    const h = FS.playersOnCourt(state, 'home');
    const a = FS.playersOnCourt(state, 'away');
    setText($('#strength'), h !== a || h < FS.FIELD_PLAYERS ? `${h} vs ${a}` : '');

    let aux = '';
    if (state.aux) {
      const left = FS.fmtCountdown(FS.countdown(state.aux, now));
      aux = state.aux.kind === 'timeout' ? `Timeout ${state[state.aux.team].name} ${left}` : `Intermission ${left}`;
      if (!state.aux.running) aux += ' (paused)';
    } else if (state.finished) {
      aux = 'Final';
    }
    const auxEl = $('#aux');
    setText(auxEl, aux);
    auxEl.classList.toggle('timeout', !!state.aux && state.aux.kind === 'timeout');

    if (!isDisplay) {
      const btn = $('#toggle-clock');
      setText(btn, state.clock.running ? 'Stop' : 'Start');
      btn.classList.toggle('stop', state.clock.running);
      btn.disabled = state.finished || !!state.aux || (!state.clock.running && remaining <= 0);
      $('#toggle-aux').disabled = !state.aux;
      setText($('#toggle-aux'), state.aux && !state.aux.running ? 'Resume break' : 'Pause break');
      $('#end-aux').disabled = !state.aux;
      $('#next-period').disabled = FS.isShootout(state);
      setText($('#end-match'), state.finished ? 'Resume match' : 'End match');
      for (const team of FS.TEAMS) {
        $(`.team-panel[data-team="${team}"] [data-action="timeout"]`).disabled =
          state[team].timeoutUsed || !!state.aux || state.finished;
      }
    }
  }

  function renderStatic() {
    if (isDisplay) return;
    for (const team of FS.TEAMS) {
      const panel = $(`.team-panel[data-team="${team}"]`);
      panel.style.setProperty('--team', state[team].color);
      for (const input of $$('[data-field]', panel)) {
        if (document.activeElement !== input) input.value = state[team][input.dataset.field];
      }
    }
    for (const input of $$('[data-setting]')) {
      if (document.activeElement === input) continue;
      const v = state.settings[input.dataset.setting];
      if (input.type === 'checkbox') input.checked = !!v;
      else input.value = v;
    }

    setText(
      $('#period-scores'),
      `${state.home.name} ${state.home.score}:${state.away.score} ${state.away.name}  (` +
        FS.periodScores(state).map((r) => `${r.home}:${r.away}`).join(', ') + ')'
    );

    $('#log').innerHTML = state.events
      .slice()
      .reverse()
      .map((ev) => {
        const actions =
          (ev.type === 'goal' ? `<button class="x" data-action="edit-goal" data-id="${ev.id}" title="Edit">✎</button>` : '') +
          `<button class="x" data-action="remove-event" data-id="${ev.id}" title="Delete">✕</button>`;
        const color = ev.team ? ` style="--team:${escapeHtml(state[ev.team].color)}"` : '';
        return (
          `<tr class="ev-${ev.type}"${color}>` +
          `<td>${FS.periodLabel(state, ev.period)}</td>` +
          `<td>${FS.fmtElapsed(ev.time)}</td>` +
          `<td>${escapeHtml(FS.describeEvent(state, ev))}</td>` +
          `<td class="actions">${actions}</td></tr>`
        );
      })
      .join('');
  }

  /* ---------- goal dialog ---------- */

  const dialog = $('#goal-dialog');
  let editingGoal = null;

  function openGoalDialog(ev) {
    if (!ev || isDisplay) return;
    editingGoal = ev.id;
    const form = $('form', dialog);
    setText($('#goal-title'), `Goal ${state[ev.team].name} – ${FS.periodLabel(state, ev.period)} ${FS.fmtElapsed(ev.time)}`);
    form.scorer.value = ev.scorer || '';
    form.assist.value = ev.assist || '';
    dialog.showModal();
    form.scorer.focus();
  }

  dialog.addEventListener('close', () => {
    const ev = state.events.find((e) => e.id === editingGoal);
    if (ev && dialog.returnValue === 'ok') {
      const form = $('form', dialog);
      ev.scorer = form.scorer.value.trim();
      ev.assist = form.assist.value.trim();
      commit();
    }
    editingGoal = null;
    dialog.returnValue = '';
  });
  $('[data-close]', dialog).addEventListener('click', () => dialog.close('cancel'));

  /* ---------- actions ---------- */

  function goal(team) {
    const ev = FS.addGoal(state, team, Date.now());
    commit();
    if (ev && ev.winning) buzz();
    openGoalDialog(ev);
  }

  function goalMinus(team) {
    const last = state.events.filter((e) => e.type === 'goal' && e.team === team).pop();
    if (last) FS.removeEvent(state, last.id, Date.now());
    commit();
  }

  function toggleFullscreen(el) {
    if (document.fullscreenElement) document.exitFullscreen();
    else if (el.requestFullscreen) el.requestFullscreen();
  }

  function download(filename, text) {
    const a = document.createElement('a');
    a.href = URL.createObjectURL(new Blob([text], { type: 'text/plain;charset=utf-8' }));
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(a.href), 1000);
  }

  function slug(s) {
    return s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'team';
  }

  const actions = {
    'toggle-clock': () => FS.toggleClock(state, Date.now()),
    adjust: (btn) => FS.adjustClock(state, Number(btn.dataset.ms), Date.now()),
    'set-clock': () => {
      const v = prompt('Set clock (m:ss)', FS.fmtCountdown(FS.countdown(state.clock, Date.now())));
      const m = v && v.trim().match(/^(\d{1,2})(?::(\d{1,2}))?$/);
      if (m) FS.setClock(state, (Number(m[1]) * 60 + Number(m[2] || 0)) * FS.SEC, Date.now());
    },
    'toggle-aux': () => FS.toggleAux(state, Date.now()),
    'end-aux': () => FS.endAux(state, Date.now()),
    intermission: () => FS.startIntermission(state, Date.now()),
    'next-period': () => {
      if (FS.countdown(state.clock, Date.now()) > 0 && !confirm('The period is not over yet. Go to the next period?')) return;
      FS.nextPeriod(state, Date.now());
    },
    'end-match': () => {
      if (state.finished) FS.resumeMatch(state);
      else if (confirm('End the match?')) FS.endMatch(state, Date.now());
    },
    buzzer: () => buzz(),
    'open-display': () => window.open(location.pathname + '?display', 'florbal-display', 'popup,width=1280,height=720'),
    fullscreen: () => toggleFullscreen(board),
    goal: (btn, team) => goal(team),
    'goal-minus': (btn, team) => goalMinus(team),
    shot: (btn, team) => FS.addShot(state, team, Number(btn.dataset.delta)),
    timeout: (btn, team) => FS.callTimeout(state, team, Date.now()),
    'remove-penalty': (btn) => {
      const id = Number(btn.dataset.id);
      const ev = state.events.find((e) => e.type === 'penalty' && e.penaltyId === id);
      if (!confirm('Remove this penalty' + (ev ? ' and its log entry' : '') + '?')) return;
      if (ev) FS.removeEvent(state, ev.id, Date.now());
      else FS.removePenalty(state, id, Date.now());
    },
    'remove-event': (btn) => {
      if (confirm('Delete this log entry?')) FS.removeEvent(state, Number(btn.dataset.id), Date.now());
    },
    'edit-goal': (btn) => openGoalDialog(state.events.find((e) => e.id === Number(btn.dataset.id))),
    export: () => {
      const date = new Date().toISOString().slice(0, 10);
      download(`${date}-${slug(state.home.name)}-${slug(state.away.name)}.txt`, FS.buildReport(state));
    },
    'new-match': () => {
      if (!confirm('Start a new match? The current score and log will be cleared.')) return;
      state = FS.createState(state.settings, { home: state.home, away: state.away });
    },
  };

  function setupControls() {
    document.addEventListener('click', (e) => {
      const btn = e.target.closest('[data-action]');
      if (!btn || btn.disabled || !actions[btn.dataset.action]) return;
      // drop focus after a mouse click so Space keeps controlling the clock
      if (e.detail > 0) btn.blur();
      const teamEl = btn.closest('[data-team]');
      actions[btn.dataset.action](btn, teamEl && teamEl.dataset.team);
      // goal() commits itself before opening the dialog
      if (btn.dataset.action !== 'goal') commit();
    });

    for (const panel of $$('.team-panel')) {
      const team = panel.dataset.team;
      for (const input of $$('[data-field]', panel)) {
        input.addEventListener('input', () => {
          const v = input.dataset.field === 'name' ? input.value.trim() || team.toUpperCase() : input.value;
          state[team][input.dataset.field] = v;
          commit();
        });
      }
      const form = $('.pen-form', panel);
      form.addEventListener('submit', (e) => {
        e.preventDefault();
        FS.addPenalty(state, team, form.player.value, form.type.value, form.reason.value, Date.now());
        form.reset();
        commit();
      });
    }

    for (const input of $$('[data-setting]')) {
      input.addEventListener('change', () => {
        const key = input.dataset.setting;
        if (input.type === 'checkbox') {
          state.settings[key] = input.checked;
        } else {
          const n = Math.round(Number(input.value));
          if (!Number.isFinite(n) || n < Number(input.min) || n > Number(input.max)) {
            input.value = state.settings[key];
            return;
          }
          state.settings[key] = n;
        }
        // apply a new period length if the current period has not started
        const c = state.clock;
        const len = FS.periodLength(state.settings, state.period);
        if (!c.running && c.base === c.length && len !== c.length) {
          c.base = c.length = len;
        }
        commit();
      });
    }

    document.addEventListener('keydown', (e) => {
      if (e.ctrlKey || e.metaKey || e.altKey || dialog.open) return;
      if (e.target.closest('input, select, textarea')) return;
      const key = e.key.toLowerCase();
      const map = {
        ' ': () => FS.toggleClock(state, Date.now()),
        q: () => goal('home'),
        p: () => goal('away'),
        a: () => FS.addShot(state, 'home', 1),
        l: () => FS.addShot(state, 'away', 1),
        b: () => buzz(),
        f: () => toggleFullscreen(board),
      };
      if (!map[key]) return;
      e.preventDefault();
      map[key]();
      if (key !== 'q' && key !== 'p') commit();
    });

    setInterval(() => {
      const r = FS.tick(state, Date.now());
      if (r.buzzer) buzz();
      if (r.changed) {
        save();
        renderStatic();
      }
      renderLive();
    }, 100);

    window.addEventListener('storage', (e) => {
      // another operator tab changed the match
      if (e.key === STORAGE_KEY) {
        state = load() || state;
        renderStatic();
      }
    });
  }

  function setupDisplay() {
    document.body.classList.add('display-mode');
    $('#controls').remove();
    window.addEventListener('storage', (e) => {
      if (e.key === STORAGE_KEY) state = load() || state;
    });
    document.addEventListener('dblclick', () => toggleFullscreen(document.documentElement));
    document.addEventListener('keydown', (e) => {
      if (e.key.toLowerCase() === 'f') toggleFullscreen(document.documentElement);
    });
    setInterval(renderLive, 100);
  }

  if (isDisplay) setupDisplay();
  else setupControls();
  renderStatic();
  renderLive();
})();
