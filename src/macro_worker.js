// ═══════════════════════════════════════════════════
// MACRO WORKER — roda em thread separada
// Responsável: MacroEngine + MarketContext
// Comunica com main via postMessage
// ═══════════════════════════════════════════════════
const { parentPort } = require('worker_threads');
const { EventBus }            = require('./utils/event_bus');
const { Logger }              = require('./utils/logger');
const { MacroEngine }         = require('./engines/macro_engine');
const { MarketContextEngine } = require('./engines/market_context_engine');

const bus = new EventBus();
const log = new Logger('MACRO-WORKER');

const macro    = new MacroEngine(bus);
const mktCtx   = new MarketContextEngine(bus);

// Repassa macro:update para o main thread
bus.on('macro:update', (d) => {
  try { parentPort.postMessage({ type: 'worker:macro', data: d }); } catch(e) {}
});

// Repassa macro:bom_dia para o main thread
bus.on('macro:bom_dia', (d) => {
  try { parentPort.postMessage({ type: 'macro:bom_dia', data: d }); } catch(e) {}
});

// Repassa macro:significant_change para o main thread
bus.on('macro:significant_change', (d) => {
  try { parentPort.postMessage({ type: 'macro:significant_change', data: d }); } catch(e) {}
});

// Recebe eventos do main thread (ex: tick de preço para MarketContext)
parentPort.on('message', ({ type, data }) => {
  if (type === 'lastPrice') mktCtx.lastPrice = data;
});

bus.on('macro:update', (d) => { if (mktCtx._macroSnap !== undefined) mktCtx._macroSnap = d; });

macro.start();
mktCtx.start();

log.info('Macro Worker iniciado — MacroEngine + MarketContext isolados');
