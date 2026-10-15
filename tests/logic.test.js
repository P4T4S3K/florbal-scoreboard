'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const FS = require('../js/logic.js');

const { MIN, SEC } = FS;

function running(settings) {
  const s = FS.createState(settings);
  FS.toggleClock(s, 0);
  return s;
}

test('clock counts down and stops/resumes', () => {
  const s = running();
  assert.equal(FS.countdown(s.clock, 5 * SEC), 20 * MIN - 5 * SEC);
  FS.toggleClock(s, 5 * SEC); // stop
  assert.equal(FS.countdown(s.clock, 60 * SEC), 20 * MIN - 5 * SEC);
  FS.toggleClock(s, 60 * SEC); // resume
  assert.equal(FS.gameTime(s, 70 * SEC), 15 * SEC);
});

test('period end starts the intermission, which leads into the next period', () => {
  const s = running();
  const r = FS.tick(s, 20 * MIN);
  assert.ok(r.buzzer);
  assert.equal(s.aux.kind, 'intermission');
  FS.tick(s, 30 * MIN);
  assert.equal(s.aux, null);
  assert.equal(s.period, 2);
  assert.equal(s.clock.base, 20 * MIN);
  assert.equal(FS.gameTime(s, 30 * MIN), 20 * MIN);
});

test('match finishes after regulation when not tied, overtime is sudden death', () => {
  const s = FS.createState({ periods: 1, periodMin: 1 });
  FS.toggleClock(s, 0);
  FS.addGoal(s, 'home', 10 * SEC);
  FS.tick(s, MIN);
  assert.ok(s.finished);

  const t = FS.createState({ periods: 1, periodMin: 1 });
  FS.toggleClock(t, 0);
  FS.tick(t, MIN);
  assert.ok(!t.finished);
  FS.nextPeriod(t, MIN);
  assert.equal(FS.periodLabel(t), 'OT');
  FS.toggleClock(t, 2 * MIN);
  const ev = FS.addGoal(t, 'away', 2 * MIN + 30 * SEC);
  assert.ok(ev.winning && t.finished && !t.clock.running);
  assert.match(FS.buildReport(t), /HOME 0:1 AWAY OT/);
});

test('penalty runs on game time and freezes with the clock', () => {
  const s = running();
  const p = FS.addPenalty(s, 'home', 7, '2', 'Hooking', 10 * SEC);
  assert.equal(FS.playersOnCourt(s, 'home'), 4);
  FS.toggleClock(s, 70 * SEC); // stop after 60 s of penalty
  assert.equal(FS.penaltyRemaining(p, FS.gameTime(s, 500 * SEC)), MIN);
  FS.toggleClock(s, 500 * SEC);
  FS.tick(s, 560 * SEC);
  assert.equal(s.penalties.length, 0);
});

test('third team penalty waits and starts when a slot frees', () => {
  const s = running();
  FS.addPenalty(s, 'home', 1, '2', '', 0);
  FS.addPenalty(s, 'home', 2, '5', '', 30 * SEC);
  const third = FS.addPenalty(s, 'home', 3, '2', '', 40 * SEC);
  assert.equal(third.start, null);
  assert.equal(FS.playersOnCourt(s, 'home'), 3);
  FS.tick(s, 2 * MIN + 500); // first expired at exactly 2:00
  assert.equal(third.start, 2 * MIN);
});

test('10 minute personal penalty does not reduce the team', () => {
  const s = running();
  FS.addPenalty(s, 'away', 9, '10', '', 0);
  assert.equal(FS.playersOnCourt(s, 'away'), 5);
});

test('power-play goal cancels the 2 minute penalty with least time left', () => {
  const s = running();
  const a = FS.addPenalty(s, 'away', 4, '2', '', 0);
  const b = FS.addPenalty(s, 'away', 5, '2', '', 30 * SEC);
  const ev = FS.addGoal(s, 'home', 60 * SEC);
  assert.equal(ev.strength, 'PP');
  assert.equal(ev.cancelledPenalty, a.id);
  assert.deepEqual(s.penalties.map((p) => p.id), [b.id]);
});

test('power-play goal does not cancel a 5 minute penalty', () => {
  const s = running();
  FS.addPenalty(s, 'away', 4, '5', '', 0);
  FS.addGoal(s, 'home', 60 * SEC);
  assert.equal(s.penalties.length, 1);
});

test('goal at equal strength cancels nothing', () => {
  const s = running();
  FS.addPenalty(s, 'away', 4, '2', '', 0);
  FS.addPenalty(s, 'home', 8, '2', '', 0);
  const ev = FS.addGoal(s, 'home', 60 * SEC);
  assert.equal(ev.strength, 'EV');
  assert.equal(s.penalties.length, 2);
});

test('power-play goal in first half of 2+2 leaves a fresh 2 minutes', () => {
  const s = running();
  const p = FS.addPenalty(s, 'away', 4, '2+2', '', 0);
  FS.addGoal(s, 'home', 60 * SEC);
  assert.equal(p.end, 3 * MIN);
  FS.addGoal(s, 'home', 90 * SEC);
  assert.equal(s.penalties.length, 0);
});

test('timeout is once per team and pauses the game clock', () => {
  const s = running();
  assert.ok(FS.callTimeout(s, 'home', 10 * SEC));
  assert.ok(!s.clock.running);
  assert.ok(!FS.toggleClock(s, 11 * SEC)); // cannot start during timeout
  FS.tick(s, 40 * SEC);
  assert.equal(s.aux, null);
  assert.ok(!FS.callTimeout(s, 'home', 50 * SEC));
});

test('removing a goal event undoes the score', () => {
  const s = running();
  const ev = FS.addGoal(s, 'home', SEC);
  FS.removeEvent(s, ev.id, 2 * SEC);
  assert.equal(s.home.score, 0);
});

test('formatting', () => {
  assert.equal(FS.fmtClock(20 * MIN), '20:00');
  assert.equal(FS.fmtClock(60 * SEC + 1), '1:01');
  assert.equal(FS.fmtClock(59950), '1:00');
  assert.equal(FS.fmtClock(59 * SEC + 400), '59.4');
  assert.equal(FS.fmtElapsed(754 * SEC), '12:34');
});
