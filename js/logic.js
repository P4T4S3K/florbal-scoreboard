/*
 * Florbal scoreboard – match logic.
 *
 * Pure functions over a plain JSON state object (no DOM), so the same code
 * runs in the browser (exposed as global `FS`) and in Node tests.
 * Every function that depends on time takes `now` (epoch ms) explicitly.
 *
 * Time model: countdowns are stored as { running, base, anchor } where
 * `base` is the remaining ms at the moment `anchor` (epoch ms). This survives
 * page reloads and lets a second window (the display) compute the same clock.
 *
 * Penalties are stored in "game time" (ms of played time since the start of
 * the match), so they freeze when the game clock is stopped and carry over
 * between periods.
 */
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.FS = api;
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  const SEC = 1000;
  const MIN = 60 * SEC;
  const TEAMS = ['home', 'away'];

  // team: counts against the team's number of players on court
  // cancel: ends early when the opponent scores a power-play goal
  const PENALTY_TYPES = {
    '2': { label: "2'", ms: 2 * MIN, team: true, cancel: true },
    '2+2': { label: "2+2'", ms: 4 * MIN, team: true, cancel: true },
    '5': { label: "5'", ms: 5 * MIN, team: true, cancel: false },
    '10': { label: "10'", ms: 10 * MIN, team: false, cancel: false },
    'MP': { label: 'MP', ms: 5 * MIN, team: true, cancel: false },
  };

  // A team can be reduced by at most two players; further team penalties
  // wait until a slot frees up.
  const MAX_ACTIVE_PENALTIES = 2;
  const FIELD_PLAYERS = 5;

  const DEFAULT_SETTINGS = {
    periods: 3,
    periodMin: 20,
    intermissionMin: 10,
    otMin: 10, // 0 = no overtime
    timeoutSec: 30,
    buzzer: true,
  };

  const other = (team) => (team === 'home' ? 'away' : 'home');

  /* ---------- state ---------- */

  function createState(settings, teams) {
    const s = Object.assign({}, DEFAULT_SETTINGS, settings || {});
    const team = (side, defName, defColor) => {
      const src = (teams && teams[side]) || {};
      return {
        name: src.name || defName,
        color: src.color || defColor,
        score: 0,
        shots: 0,
        timeoutUsed: false,
      };
    };
    const len = periodLength(s, 1);
    return {
      settings: s,
      home: team('home', 'HOME', '#1e88e5'),
      away: team('away', 'AWAY', '#e53935'),
      period: 1,
      elapsedBefore: 0, // game time played in previous periods
      clock: { running: false, base: len, length: len, anchor: 0 },
      aux: null, // { kind: 'timeout' | 'intermission', team?, running, base, anchor }
      finished: false,
      penalties: [],
      events: [],
      nextId: 1,
    };
  }

  /* ---------- periods ---------- */

  function periodLength(settings, period) {
    if (period <= settings.periods) return settings.periodMin * MIN;
    if (period === settings.periods + 1 && settings.otMin > 0) return settings.otMin * MIN;
    return 0; // penalty shots
  }

  function isOvertime(state) {
    const s = state.settings;
    return s.otMin > 0 && state.period === s.periods + 1;
  }

  function isShootout(state) {
    return state.period > state.settings.periods && !isOvertime(state);
  }

  function periodLabel(state, period) {
    const p = period === undefined ? state.period : period;
    const s = state.settings;
    if (p <= s.periods) return String(p);
    if (s.otMin > 0 && p === s.periods + 1) return 'OT';
    return 'PS';
  }

  /* ---------- countdowns ---------- */

  function countdown(c, now) {
    if (!c) return 0;
    return c.running ? Math.max(0, c.base - (now - c.anchor)) : c.base;
  }

  function startCountdown(c, now) {
    if (!c.running) {
      c.anchor = now;
      c.running = true;
    }
  }

  function stopCountdown(c, now) {
    if (c.running) {
      c.base = countdown(c, now);
      c.running = false;
    }
  }

  function periodElapsed(state, now) {
    return state.clock.length - countdown(state.clock, now);
  }

  function gameTime(state, now) {
    return state.elapsedBefore + periodElapsed(state, now);
  }

  function toggleClock(state, now) {
    if (state.finished || state.aux) return false;
    const c = state.clock;
    if (c.running) {
      stopCountdown(c, now);
      return true;
    }
    if (countdown(c, now) <= 0) return false;
    startCountdown(c, now);
    return true;
  }

  function setClock(state, ms, now) {
    const c = state.clock;
    c.base = Math.min(c.length, Math.max(0, Math.round(ms)));
    if (c.running) c.anchor = now;
  }

  function adjustClock(state, deltaMs, now) {
    setClock(state, countdown(state.clock, now) + deltaMs, now);
  }

  /* ---------- events ---------- */

  function log(state, now, type, team, data) {
    const ev = Object.assign(
      {
        id: state.nextId++,
        type,
        team,
        period: state.period,
        time: Math.max(0, periodElapsed(state, now)),
      },
      data
    );
    state.events.push(ev);
    return ev;
  }

  /* ---------- penalties ---------- */

  function activeTeamPenalties(state, team) {
    return state.penalties.filter(
      (p) => p.team === team && p.start !== null && PENALTY_TYPES[p.type].team
    ).length;
  }

  function playersOnCourt(state, team) {
    return FIELD_PLAYERS - activeTeamPenalties(state, team);
  }

  function startPending(state, at) {
    for (const p of state.penalties) {
      if (p.start === null && !PENALTY_TYPES[p.type].team) {
        p.start = at;
        p.end = at + p.duration;
      }
    }
    for (const team of TEAMS) {
      let active = activeTeamPenalties(state, team);
      for (const p of state.penalties) {
        if (active >= MAX_ACTIVE_PENALTIES) break;
        if (p.team === team && p.start === null && PENALTY_TYPES[p.type].team) {
          p.start = at;
          p.end = at + p.duration;
          active++;
        }
      }
    }
  }

  function penaltyRemaining(p, gt) {
    return p.start === null ? p.duration : Math.max(0, p.end - gt);
  }

  function addPenalty(state, team, player, type, reason, now) {
    const def = PENALTY_TYPES[type];
    if (!def) throw new Error('Unknown penalty type: ' + type);
    const p = {
      id: state.nextId++,
      team,
      player: String(player || '').trim(),
      type,
      reason: String(reason || '').trim(),
      duration: def.ms,
      start: null,
      end: null,
    };
    state.penalties.push(p);
    log(state, now, 'penalty', team, {
      penaltyId: p.id,
      player: p.player,
      penType: type,
      reason: p.reason,
    });
    startPending(state, gameTime(state, now));
    return p;
  }

  function removePenalty(state, id, now) {
    const i = state.penalties.findIndex((p) => p.id === id);
    if (i < 0) return false;
    state.penalties.splice(i, 1);
    startPending(state, gameTime(state, now));
    return true;
  }

  function expirePenalties(state, now) {
    const gt = gameTime(state, now);
    let changed = false;
    for (;;) {
      const due = state.penalties
        .filter((p) => p.start !== null && p.end <= gt)
        .sort((a, b) => a.end - b.end)[0];
      if (!due) break;
      state.penalties.splice(state.penalties.indexOf(due), 1);
      // a waiting penalty starts exactly when the previous one ran out
      startPending(state, due.end);
      changed = true;
    }
    return changed;
  }

  /* ---------- goals, shots, timeouts ---------- */

  function addGoal(state, team, now) {
    if (state.finished) return null;
    const opp = other(team);
    const own = activeTeamPenalties(state, team);
    const theirs = activeTeamPenalties(state, opp);
    const strength = own < theirs ? 'PP' : own > theirs ? 'SH' : 'EV';
    state[team].score++;
    const ev = log(state, now, 'goal', team, { scorer: '', assist: '', strength });

    // Power-play goal: the opponent's cancellable penalty with the least
    // time remaining ends. A 2+2 in its first half drops to its second half.
    if (strength === 'PP') {
      const gt = gameTime(state, now);
      const cand = state.penalties
        .filter((p) => p.team === opp && p.start !== null && PENALTY_TYPES[p.type].cancel)
        .sort((a, b) => a.end - b.end)[0];
      if (cand) {
        if (cand.type === '2+2' && cand.end - gt > 2 * MIN) {
          cand.end = gt + 2 * MIN;
        } else {
          state.penalties.splice(state.penalties.indexOf(cand), 1);
          startPending(state, gt);
        }
        ev.cancelledPenalty = cand.id;
      }
    }

    // Overtime is sudden death.
    if (isOvertime(state)) {
      stopCountdown(state.clock, now);
      state.finished = true;
      ev.winning = true;
    }
    return ev;
  }

  function addShot(state, team, delta) {
    state[team].shots = Math.max(0, state[team].shots + delta);
  }

  function callTimeout(state, team, now) {
    if (state.finished || state[team].timeoutUsed || state.aux) return false;
    stopCountdown(state.clock, now);
    state[team].timeoutUsed = true;
    state.aux = {
      kind: 'timeout',
      team,
      running: true,
      base: state.settings.timeoutSec * SEC,
      anchor: now,
    };
    log(state, now, 'timeout', team, {});
    return true;
  }

  function startIntermission(state, now) {
    if (state.aux) return false;
    stopCountdown(state.clock, now);
    state.aux = {
      kind: 'intermission',
      running: true,
      base: state.settings.intermissionMin * MIN,
      anchor: now,
    };
    return true;
  }

  function toggleAux(state, now) {
    const a = state.aux;
    if (!a) return false;
    if (a.running) stopCountdown(a, now);
    else startCountdown(a, now);
    return true;
  }

  function endAux(state, now) {
    const a = state.aux;
    if (!a) return false;
    state.aux = null;
    if (a.kind === 'intermission') nextPeriod(state, now);
    return true;
  }

  function nextPeriod(state, now) {
    if (isShootout(state)) return false;
    stopCountdown(state.clock, now);
    state.elapsedBefore += periodElapsed(state, now);
    state.period++;
    const len = periodLength(state.settings, state.period);
    state.clock = { running: false, base: len, length: len, anchor: 0 };
    state.aux = null;
    state.finished = false;
    return true;
  }

  function endMatch(state, now) {
    stopCountdown(state.clock, now);
    state.aux = null;
    state.finished = true;
    log(state, now, 'end', null, {});
  }

  function resumeMatch(state) {
    state.finished = false;
  }

  function removeEvent(state, id, now) {
    const i = state.events.findIndex((e) => e.id === id);
    if (i < 0) return false;
    const ev = state.events[i];
    state.events.splice(i, 1);
    if (ev.type === 'goal') {
      state[ev.team].score = Math.max(0, state[ev.team].score - 1);
      if (ev.winning) state.finished = false;
    } else if (ev.type === 'penalty') {
      removePenalty(state, ev.penaltyId, now);
    } else if (ev.type === 'timeout') {
      state[ev.team].timeoutUsed = false;
      if (state.aux && state.aux.kind === 'timeout' && state.aux.team === ev.team) state.aux = null;
    } else if (ev.type === 'end') {
      state.finished = false;
    }
    return true;
  }

  /* ---------- tick ---------- */

  // Advances automatic transitions. Returns { changed, buzzer }.
  function tick(state, now) {
    const out = { changed: false, buzzer: false };

    if (state.aux && state.aux.running && countdown(state.aux, now) <= 0) {
      endAux(state, now);
      out.changed = out.buzzer = true;
    }

    if (expirePenalties(state, now)) out.changed = true;

    const c = state.clock;
    if (c.running && countdown(c, now) <= 0) {
      stopCountdown(c, now);
      out.changed = out.buzzer = true;
      log(state, now, 'periodEnd', null, { label: periodLabel(state) });
      const s = state.settings;
      if (state.period < s.periods) {
        if (s.intermissionMin > 0) startIntermission(state, now);
      } else if (state.home.score !== state.away.score) {
        state.finished = true;
      }
    }
    return out;
  }

  /* ---------- formatting ---------- */

  const pad = (n) => String(n).padStart(2, '0');

  // Countdown display: m:ss, switching to ss.t in the last minute.
  function fmtClock(ms) {
    const tenths = Math.ceil(ms / 100);
    if (tenths >= 600) {
      const s = Math.ceil(ms / SEC);
      return Math.floor(s / 60) + ':' + pad(s % 60);
    }
    return Math.floor(tenths / 10) + '.' + (tenths % 10);
  }

  // m:ss, rounded up (for penalty and break countdowns)
  function fmtCountdown(ms) {
    const s = Math.ceil(ms / SEC);
    return Math.floor(s / 60) + ':' + pad(s % 60);
  }

  // mm:ss elapsed (for the match protocol)
  function fmtElapsed(ms) {
    const s = Math.floor(ms / SEC);
    return pad(Math.floor(s / 60)) + ':' + pad(s % 60);
  }

  function describeEvent(state, ev) {
    const name = ev.team ? state[ev.team].name : '';
    switch (ev.type) {
      case 'goal': {
        let t = 'Goal ' + name;
        if (ev.scorer) t += ' #' + ev.scorer;
        if (ev.assist) t += ' (A #' + ev.assist + ')';
        if (ev.strength && ev.strength !== 'EV') t += ' [' + ev.strength + ']';
        return t;
      }
      case 'penalty': {
        let t = PENALTY_TYPES[ev.penType].label + ' ' + name;
        if (ev.player) t += ' #' + ev.player;
        if (ev.reason) t += ' – ' + ev.reason;
        return t;
      }
      case 'timeout':
        return 'Timeout ' + name;
      case 'periodEnd':
        return 'End of period ' + ev.label;
      case 'end':
        return 'Match ended';
      default:
        return ev.type;
    }
  }

  function periodScores(state) {
    const n = Math.max(state.period, state.settings.periods);
    const rows = [];
    for (let p = 1; p <= n; p++) {
      const goals = state.events.filter((e) => e.type === 'goal' && e.period === p);
      const h = goals.filter((e) => e.team === 'home').length;
      const a = goals.filter((e) => e.team === 'away').length;
      rows.push({ label: periodLabel(state, p), home: h, away: a });
    }
    return rows;
  }

  function buildReport(state) {
    const { home, away } = state;
    const lines = [];
    let suffix = '';
    const last = state.events.filter((e) => e.type === 'goal').pop();
    if (last && last.period > state.settings.periods) suffix = ' ' + periodLabel(state, last.period);
    lines.push(`${home.name} ${home.score}:${away.score} ${away.name}${suffix}`);
    lines.push('(' + periodScores(state).map((r) => `${r.home}:${r.away}`).join(', ') + ')');
    lines.push(`Shots on goal: ${home.shots}:${away.shots}`);
    lines.push('');
    for (const ev of state.events) {
      lines.push(`${periodLabel(state, ev.period).padEnd(2)} ${fmtElapsed(ev.time)}  ${describeEvent(state, ev)}`);
    }
    return lines.join('\n') + '\n';
  }

  return {
    SEC, MIN, TEAMS, PENALTY_TYPES, MAX_ACTIVE_PENALTIES, FIELD_PLAYERS, DEFAULT_SETTINGS,
    other, createState, periodLength, periodLabel, isOvertime, isShootout,
    countdown, periodElapsed, gameTime, toggleClock, setClock, adjustClock,
    activeTeamPenalties, playersOnCourt, penaltyRemaining, addPenalty, removePenalty, expirePenalties,
    addGoal, addShot, callTimeout, startIntermission, toggleAux, endAux, nextPeriod,
    endMatch, resumeMatch, removeEvent, tick,
    fmtClock, fmtCountdown, fmtElapsed, describeEvent, periodScores, buildReport,
  };
});
