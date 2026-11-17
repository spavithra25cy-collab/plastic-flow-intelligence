# Beyond the Factory Floor: Plastic Line Flow Intelligence

A working prototype that finds hidden inefficiencies in a plastic injection-molding line and warns about disruptions before they reach output.

**Live demo:** `https://<your-username>.github.io/plastic-flow-intelligence/` (enable GitHub Pages, see below)

## The problem

A plastics plant sees unexpected slowdowns even though every machine looks fine on its own dashboard. Machine-level monitoring cannot show how a change in one station spreads through buffers and conveyors to slow the whole line.

**Question:** how can the facility find hidden inefficiencies and anticipate disruptions before they occur?

## The scenario

**Injection-molding Line 3**, five stations in series with small buffers between them:

```
Resin Dryer -> [hopper] -> Injection Molding -> [buf] -> Cooling Conveyor -> [buf] -> Trim & Inspect -> [buf] -> Packaging
```

One unit is one tray of 20 parts. Injection Molding (4.0 s/tray) is the nominal constraint, so ideal output is 900 trays/h. Each machine has random micro-stops, cycle-time noise, and (in the default scenario) a slowly drifting dryer.

## The 5 features

| # | Feature | What it answers |
|---|---------|-----------------|
| 1 | **Live line flow map** (System view vs Machine view) | What does each machine actually do to the line? Machine view mimics today's monitors (everything green); System view shows starved, blocked and running states and buffer levels. |
| 2 | **Hidden-loss attribution** | Who really caused the waiting? Every starved or blocked second is traced through the buffers to the root station, giving a cause-by-affected heatmap, a loss breakdown for the constraint, and plain-language insights. Includes a stop ledger showing the micro-stops that local OEE hides. |
| 3 | **Early-warning predictor** | What will go wrong next? Buffer trends give time-to-starve and time-to-block; rolling cycle-time regression catches drift and predicts when a station becomes the new bottleneck, with a 0-100 risk score. |
| 4 | **Ripple what-if simulator** | If this station stops or slows, how far and how fast does it spread? Twin runs (with and without the disruption, identical randomness) give lost output, extra waiting per station, and propagation timing. A button injects the same disruption into the live line. |
| 5 | **Improvement ranking** | Where should we act first? 15 levers (stop recovery, cycle time, buffer size, sensor recalibration) are simulated and ranked by recovered trays/h. The slowest machine is often not the best target. |

## Run it

No build step and no dependencies.

```bash
# any static server works
npx serve .          # or: python3 -m http.server 8000
```

Then open the printed address. Or just open `index.html` directly in a browser.

**Suggested demo flow (about 2 minutes):**
1. Keep the default scenario at 30x speed. Within ~10 simulated minutes the early-warning panel flags the **dryer drift** and predicts when it will become the line constraint, while Machine view still shows green.
2. Toggle **Machine view / System view** in feature 1 and read the gap banner.
3. Look at feature 2's heatmap and insights to see which station is costing others time.
4. In feature 4, run a 3-minute **Packaging stop** and watch the ripple move upstream, then **Inject into live line**.
5. In feature 5, see that **recalibrating the dryer sensor** outranks speeding up the slowest machine.
6. Switch the scenario to **Packaging micro-stop cascade** for a different failure pattern.

## Tests

```bash
npm test      # or: node tests/sim.test.js
```

Nine tests cover determinism, buffer bounds, time accounting, drift false-positive and early-detection checks, ripple direction and sensitivity ranking.

## How it works

- `sim.js` is a discrete-event simulation with a 1-second step. Stations pull from the upstream buffer, work, and push downstream; they go **starved** when the input buffer is empty, **blocked** when the output buffer is full, or **down** on a stop. Each station has its own random stream so a disruption cannot alter the randomness of unaffected stations, which keeps what-if comparisons clean.
- **Attribution:** a starved station walks upstream to the first station that is not itself starved; a blocked station walks downstream to the first that is not blocked. That station is the root cause (stopped, running slow, or simple rate mismatch).
- **Forecasting:** least-squares slope of buffer levels (last 3 min) and of rolling mean cycle time (last 10 min). Drift alarms need more than +15%/h.
- **Sensitivity:** each lever is applied to a copy of the current configuration and compared with the baseline over 2 simulated hours and 3 seeds.
- `app.js` is plain JavaScript and SVG/canvas, so the site runs on GitHub Pages with no backend.

## Assumptions and limits

- Data is simulated. The parameters (cycle times, MTBF/MTTR, buffer sizes, drift rate) are illustrative, not measured from a real plant.
- The line is a single serial flow with unlimited resin upstream and no scrap or rework.
- The what-if and ranking runs start from a fresh line carrying the current drift level, not an exact copy of the live state.
- Ranking differences of a few trays/h are within simulation noise.
- Connecting a real plant would mean replacing the simulator with machine status and counter feeds (OPC UA / MQTT) in the same status model; the analytics layer would stay as is.

## Project structure

```
index.html            dashboard
style.css             styling
app.js                UI, rendering, interaction
sim.js                simulation + analytics (forecast, whatIf, sensitivity)
tests/sim.test.js     unit tests (Node, no dependencies)
docs/6-hour-workflow.md   build plan and how each hour maps to the repo
```

See [docs/6-hour-workflow.md](docs/6-hour-workflow.md) for the step-by-step 6-hour workflow.

## Deploy to GitHub Pages

Repository **Settings -> Pages -> Build and deployment -> Deploy from a branch -> `main` / `(root)` -> Save.** The site appears at `https://<your-username>.github.io/<repo-name>/` after about a minute.

## License

MIT
