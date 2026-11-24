# Measurement log — Pump.fun Replay Sprint (u-jackxyz72-pump-fun-replay-sprint-paper-bot-0b809122)

All numbers are from the kit's own local simulator (the pilot tools' engine
port) on this kit's dev window: the full 24 h dataset (all three parts
concatenated, the way the dev grade runs) and per-part slices for robustness.
The dev failed-tx draw is the grader's own (draw 0); extra draws vary only
the seeded failed-tx key.

## Shipped configuration (strategy.ts DEFAULT_PARAMS)

Dip entries: long window 1,200 slots (uptrend ≥ +30%, ≥ 20 distinct
non-creator buyers, net flow positive), short window 60 slots (pullback
−25%…−8%), turn filter (≥ 2 buys in the last 10 slots), 0.25 SOL stakes,
300 bps buy slippage guard, exits TP +25% / SL −15% / trailing 18% armed at
+20% / max hold 1,200 slots / creator-sell and dump exits.

Full dev window, four failed-tx draws:

| draw | net PnL (SOL) | ex-top-3 | fills | trip mints | wins | max DD |
|---|---|---|---|---|---|---|
| 0 (dev key) | +0.3285 | +0.0804 | 108 | 54 | 22 | 0.0297 |
| 1 | +0.2418 | −0.0063 | 102 | 51 | 20 | 0.0280 |
| 2 | +0.3042 | +0.0561 | 104 | 52 | 21 | 0.0297 |
| 3 | +0.3685 | +0.1204 | 104 | 52 | 22 | 0.0296 |

Cost sensitivity on draw 0: no failed txs +0.3285; **at 2× fees +0.0817** —
still positive. Guardrails on the full window: 51–54 distinct trip mints
(bar: 20), max drawdown ~3% (bar: ≤ 50%).

Per-slice (parts are consecutive time slices of the same window; positions
and tape state do not carry across a slice boundary in these runs, so the
slices understate the full-window run): dip default +0.139 / −0.271 /
+0.275; the shipped long-window variant +0.191 / −0.129 / +0.284.

## What else was measured (per-part slices, net PnL SOL)

| strategy | part 0 | part 1 | part 2 | sum |
|---|---|---|---|---|
| patient strength (this repo, strength mode) | −0.009 | −0.249 | −0.578 | −0.837 |
| strength, ride exits (no TP, wide trail) | −0.470 | −0.808 | −0.639 | −1.917 |
| strength, tighter buy slippage 150 bps | +0.001 | −0.026 | −0.528 | −0.552 |
| strength, deep coins only (40–85 SOL) | −0.199 | −0.306 | −0.270 | −0.775 |
| dip, shallow pullback −15%…−5% | +0.016 | −0.350 | −0.425 | −0.759 |
| dip, trailing-only exits | −0.068 | −0.268 | +0.175 | −0.160 |
| dip, shipped long-window form | +0.191 | −0.129 | +0.284 | +0.346 |

Kit baselines on part 0 for scale: hold-cash 0.0000, momentum pilot −9.3837
(its stake sizing is ruinous), and on the identical calibration window a
sibling sprint's early-strength spray measured −0.4806 with every pilot
family negative on every slice.

## Why the dip shape survives fees when the others do not

- A round trip costs ~2.5% in curve fees plus 2 × 105,000 lamports flat.
  Strength entries buy after a move and pay that toll to fade; dip entries
  buy 8–25% below the recent tape, so the toll is recovered by the bounce
  the entry is positioned for.
- The 300 bps buy slippage guard converts the 2-slot latency from a
  liability into a filter: 7 orders on the full window were rejected for
  free because the price had already run — fills only happen at prices the
  bot actually decided on.
- One entry per coin, 0.25 SOL stakes and a 5-position cap keep any single
  coin's failure at ~0.04 SOL, while the 20-coin guardrail is met by the
  strategy itself (51–54 trip mints), not by the filler.
