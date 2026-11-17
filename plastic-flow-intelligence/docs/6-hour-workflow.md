# 6-Hour Build Workflow

How the prototype was planned and built, hour by hour, with the output of each hour and where it lives in the repo.

## Hour 1: Frame the problem and pick the scenario

- Restate the challenge: machines look fine individually, but the line still slows; existing monitoring misses cross-station effects.
- Pick one concrete scenario so the prototype is credible: **plastic injection-molding line** (Dryer, Molding, Cooling, Trim/Inspect, Packaging).
- Identify why slowdowns hide in this process: small buffers, micro-stops shorter than a minute, and slow drift (for example resin dryer moisture sensor drift).
- Define "success": show the loss no single machine reports, and warn before output drops.
- **Output:** scenario, hypotheses, the 5-feature list (README "The scenario" and "The 5 features").

## Hour 2: Model the line

- Choose a discrete-event simulation (1 s step) of stations in series with finite buffers.
- Station states: running, starved, blocked, down. Add micro-stops (MTBF/MTTR), cycle-time noise, and a drift term.
- Give every station its own random stream so what-if comparisons isolate cause and effect.
- Define the ideal rate (constraint cycle time) as the efficiency yardstick.
- **Output:** `Sim` class and scenario presets in `sim.js`.

## Hour 3: Build the analytics for the 5 features

1. **Flow map data:** per-station status, utilization, local OEE (availability x speed) versus system waiting time.
2. **Attribution:** walk upstream for starvation and downstream for blocking to find the root station; accumulate a cause-by-affected matrix and constraint loss by cause.
3. **Early warning:** regression on buffer levels (time-to-empty/full) and on rolling cycle time (drift, time to new constraint); combine into a risk score.
4. **Ripple what-if:** twin runs with and without a disruption; measure lost output, extra waiting, and propagation lag.
5. **Ranking:** apply each lever to the current config, simulate, rank by recovered trays/h.
- **Output:** `forecast`, `whatIf`, `sensitivity` in `sim.js`.

## Hour 4: Build the dashboard

- Layout: KPI strip, flow map, attribution + early-warning side by side, what-if + ranking side by side.
- Plain SVG/canvas and vanilla JS so it hosts on GitHub Pages with no build step.
- Controls: scenario, speed, pause/reset, view toggle, what-if form, live injection.
- **Output:** `index.html`, `style.css`, `app.js`.

## Hour 5: Test and tune

- Unit tests: determinism, buffer bounds, time accounting, ripple direction, ranking order.
- Tuning found and fixed: false drift alarms on healthy lines (raised the threshold and lengthened the window), meaningless ripple timings (switched to a twin-run lag measure), and a cascade scenario that lost too little (smaller buffers).
- Headless browser smoke test of the page: loads, runs, all panels populate, no console errors.
- **Output:** `tests/sim.test.js`, tuned parameters.

## Hour 6: Document, package, publish

- README with the problem, scenario, features, run instructions, assumptions and limits.
- Create the GitHub repository, push, and enable GitHub Pages.
- Rehearse the 2-minute demo flow (README "Suggested demo flow").
- **Output:** public repo link and live demo link.

## What would come next with more time

- Replace simulated data with real machine status and counters (OPC UA / MQTT).
- Calibrate MTBF/MTTR, cycle times and buffer sizes from historian data.
- Add scrap/rework, changeovers and parallel machines.
- Alert delivery (email/Teams) and an operator acknowledgement log.
