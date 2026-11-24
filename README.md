# Dip-Buyer Bot — Pump.fun Replay Sprint

![competition](https://make.fun/badge/u-jackxyz72-pump-fun-replay-sprint-paper-bot-0b809122.svg)
![rank](https://make.fun/badge/u-jackxyz72-pump-fun-replay-sprint-paper-bot-0b809122/Ritwan007/pumpfun-replay-dip-bot/rank.svg)
![reward](https://make.fun/badge/u-jackxyz72-pump-fun-replay-sprint-paper-bot-0b809122/Ritwan007/pumpfun-replay-dip-bot/reward.svg)

A paper-trading bot for the make.fun competition
[Pump.fun Replay Sprint — Paper Bot, Real Ranking](https://make.fun/c/u-jackxyz72-pump-fun-replay-sprint-paper-bot-0b809122):
it trades 10 SOL of paper money on a 24-hour replay of pump.fun bonding-curve
tape, speaking agent-fun/replay/v2. Nothing is traded for real.

## Strategy

Buy the dip inside a proven uptrend — nothing else.

- **Long window (1,200 slots):** the coin must show an established uptrend —
  price at least +30% above where the window started, net SOL flow positive,
  and at least 20 distinct non-creator buyers. A coin that cannot prove broad,
  sustained demand is never touched.
- **Short window (60 slots):** the price must have pulled back 8–25% from the
  window's first print. That pullback is the entry — the bot never chases a
  launch pop or a coin at its highs, because orders fill two slots after the
  decision and the top of a spike is exactly what those two slots contain.
- **The turn:** at least two buys in the last ten slots, so the bot is not
  catching a knife that is still falling.
- **Sizing and vetoes:** 0.25 SOL per position (always under the harness cap
  of 1% of the coin's real reserve), at most 5 open positions, one entry per
  coin per run, no entry after the creator sells. Buys carry a 300 bps
  slippage guard: if the price ran away during the two-slot latency, the
  harness rejects the order and the rejection costs nothing.
- **Exits:** take profit at +25%, stop loss at −15%, a trailing stop armed at
  +20% that fires 18% below the peak, a hard exit after 1,200 slots, and an
  immediate exit on a creator sell or a single 3+ SOL dump.
- **Guardrail filler:** if the run is late and fewer than 20 distinct coins
  have a finished round trip, the bot takes minimum-size round trips on the
  deepest, busiest coins still trading, so the entry always meets the
  20-coin bar.

A round trip pays ~1.25% of curve fees per side plus a flat 105,000 lamports
per order, so the bot trades rarely and on purpose: on the dev window it made
54 round trips in 24 hours. The full measurement record — every strategy
family tried, per-slice numbers, and why this one shipped — is in
[MEASUREMENT.md](MEASUREMENT.md).

## Layout

- `main.ts` — the entrypoint the grader runs (`node main.ts`); it wires the
  wire protocol to the strategy.
- `strategy.ts` — the whole strategy, a pure function of the batches it is
  fed: no clock, no randomness, no I/O, so the harness's two executions of it
  produce byte-identical action logs.
- `vendor/makefun-bot.ts` — the kit's agent-fun/replay/v2 bot shim, vendored
  byte for byte (excluded from authorship counts by design).

## License

MIT — see [LICENSE](LICENSE).
