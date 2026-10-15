# Florbal Scoreboard

A browser scoreboard for florbal (floorball) matches. It has no dependencies, needs no build step and works offline. Open `index.html` in any modern browser.

- **Operator view**: `index.html` shows the scoreboard plus all the controls (a laptop or tablet at the scorer's table).
- **Display view**: `index.html?display` shows the scoreboard only, edge to edge, for a projector or TV. Open it with **Open display window**, drag it to the second screen and double-click or press `F` for fullscreen. It follows the operator view live.

The match is saved in the browser (`localStorage`), so a page reload or a browser crash keeps the score, clock and penalties.

## What's on the board

| | |
|---|---|
| Team names and colours | Editable, shown as a colour stripe |
| Score | Large digits |
| Game clock | Counts down, shows tenths in the last minute, white when running, amber when stopped |
| Period | 1 / 3, Overtime, Penalty shots |
| Penalties | Player #, type and remaining time for each team; waiting penalties are marked ⏳ |
| Strength | e.g. `5 vs 4` during a power play |
| Shots on goal | SOG counter per team |
| Timeout | `TO` badge, crossed out once used |
| Breaks | Timeout / intermission countdown, `FINAL` at the end |

## Rules implemented (IFF)

- **Periods**: 3 × 20 min by default, 10 min intermission that starts automatically and leads into the next period. You can change all of these in Settings, e.g. 3 × 15 for youth matches.
- **Overtime**: 10 min sudden death (0 = no overtime). The first goal ends the match. After that come penalty shots.
- **Match end**: finishes automatically after the last period if the score isn't tied.
- **Penalties**: 2', 2+2', 5', 10' personal and match penalty. They run on game time, so they stop with the clock and carry over into the next period.
  - A team can be reduced by at most 2 players. A third team penalty waits and starts exactly when a slot frees up.
  - A 10' personal penalty doesn't reduce the team.
  - A **power-play goal** ends the conceding team's 2' penalty with the least time left. A 2+2' still in its first half drops to a fresh 2'. 5' and match penalties are not cancelled.
- **Timeout**: one 30 s timeout per team, which stops the game clock.
- **Buzzer**: sounds at the end of each period, break and timeout (can be turned off).

## Match log and report

Every goal (with scorer, assist and PP/SH strength), penalty, timeout and period end is logged with period and elapsed time. After a goal, a dialog asks for the scorer and assist numbers; press Enter to save or click Skip. You can edit or delete entries. Deleting a goal also lowers the score. **Download report** saves a text protocol:

```
Tatran Střešovice 3:2 FBC Vítkovice
(1:0, 1:1, 1:1)
Shots on goal: 24:19

1  04:12  Goal Tatran Střešovice #17 (A #9)
1  11:40  2' FBC Vítkovice #4 – Hooking
...
```

## Keyboard shortcuts (operator view)

| Key | Action |
|---|---|
| `Space` | Start / stop the game clock |
| `Q` / `P` | Goal home / away |
| `A` / `L` | Shot home / away |
| `B` | Buzzer |
| `F` | Fullscreen board |

## Development

```
npm test   # rules tests (Node 18+)
```

- `js/logic.js` holds all the match rules as pure functions over a JSON state, shared by the browser and the tests.
- `js/app.js` is the UI: rendering, controls, keyboard and syncing between windows.
- `css/style.css` is the styling. The board scales with its container, from a phone up to a projector.
