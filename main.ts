// Pump.fun Replay Sprint — paper bot entrypoint.
//
// hello: the harness greets the bot once with the run's caps, fees and seed.
// After that, every batch carries one slot of recorded pump.fun tape plus the
// fills of the orders decided two slots earlier. The bot answers each batch
// with the orders it wants decided on that slot; an order decided on slot s
// fills at slot s + latency, so nothing here chases a price it cannot still
// get — the strategy in strategy.ts does the thinking, this file only wires
// the wire protocol to it.

import { runBot } from './vendor/makefun-bot.ts';
import { createStrategy, DEFAULT_PARAMS } from './strategy.ts';

const strategy = createStrategy(DEFAULT_PARAMS);

await runBot({
  onHello(state) {
    strategy.onHello(state);
  },
  onBatch(state, batch) {
    return strategy.onBatch(state, batch);
  },
  onDone(state) {
    strategy.onDone(state);
  },
});
