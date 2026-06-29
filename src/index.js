require('dotenv').config();
const { Worker, isMainThread, parentPort, workerData } = require('worker_threads');
const path = require('path');

if (isMainThread) {
  // ================= MAIN THREAD =================
  const { createServer } = require('./api/server');
  const Logger = require('./utils/logger');
  const { EventBus } = require('./utils/event_bus');

  const log = Logger('MAIN');

  log.info('Ã¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂ');
  log.info(' WDO Auction Production Engine v1.2');
  log.info(` MODE: ${process.env.MOCK_MODE === 'false' ? 'Ã°ÂÂÂ´ LIVE' : 'Ã°ÂÂÂ¡ MOCK'}`);
  log.info('Ã¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂ');

  const bus = new EventBus();
  global.__bus = bus;

  let workerRef = null;

  const { start, stop } = createServer(bus, {});
  global.__getWorker = () => workerRef;

  start().then(() => {
    log.info('HTTP Server pronto');

    const worker = new Worker(__filename, {
      workerData: { isWorker: true }
    });

    workerRef = worker;

    const PROFIT_FORWARD = [
      'trade',
      'offer_book',
      'theoretical_price',
      'ticker_state',
      'tiny_book',
      'daily',
      'connection_state',
      'price_depth'   // livro de profundidade real via SubscribePriceDepth
    ];

    PROFIT_FORWARD.forEach(evt => {
      bus.on('profit:' + evt, (data) => {
        try {
          worker.postMessage({ type: 'profit:' + evt, data });
        } catch {}
      });
    });

    const macroWorker = new Worker(path.join(__dirname, 'macro_worker.js'));

    const lastSnapshot = {};
    const SNAPSHOT_TYPES = [
      'worker:auction',
      'worker:risk',
      'worker:execution',
      'worker:macro',
      'worker:adaptive',
      'context:gap',
      'context:calendar'
    ];

    macroWorker.on('message', ({ type, data }) => {
      if (SNAPSHOT_TYPES.includes(type)) lastSnapshot[type] = data;

      bus.emit(type, data);

      if (type === 'worker:macro') {
        bus.emit('macro:update', data);
        worker.postMessage({ type: 'macro:update', data });
      }

      if (type === 'macro:significant_change') {
        bus.emit('macro:significant_change', data);
        worker.postMessage({ type: 'macro:significant_change', data });
      }
    });

    worker.on('message', ({ type, data }) => {
      if (SNAPSHOT_TYPES.includes(type)) lastSnapshot[type] = data;
      bus.emit(type, data);
    });

    bus.on('ws:request_snapshot', (ws) => {
      try {
        if (!ws || ws.readyState !== 1) return;

        ws.send(JSON.stringify({
          type: 'state_snapshot',
          data: {
            auction: lastSnapshot['worker:auction'] || {},
            risk: lastSnapshot['worker:risk'] || {},
            execution: lastSnapshot['worker:execution'] || {},
            macro: lastSnapshot['worker:macro'] || null,
            adaptive: lastSnapshot['worker:adaptive'] || null,
            gap: lastSnapshot['context:gap'] || null,
            calendario: lastSnapshot['context:calendar'] || null,
          }
        }));
      } catch {}
    });

    worker.on('exit', (code) => {
      log.warn('Worker saiu:', code);
      if (code !== 0) process.exit(1);
    });

    process.on('SIGTERM', shutdown);
    process.on('SIGINT', shutdown);

    function shutdown() {
      log.info('Shutdown iniciado...');
      try {
        worker.postMessage({ type: 'shutdown' });
      } catch {}

      setTimeout(() => {
        worker.terminate();
        stop();
        process.exit(0);
      }, 2000);
    }
  });

} else {
  // ================= WORKER THREAD =================

  const { ProfitClient } = require('./adapters/profit_client');
  const { DataNormalizer } = require('./core/data_normalizer');
  const { FeatureEngine } = require('./core/feature_engine');
  const { ClaudeAIEngine } = require('./engines/claude_ai_engine');
  const { RiskEngine } = require('./engines/risk_engine');
  const { ExecutionEngine } = require('./engines/execution_engine');
  const { AdaptiveLogEngine } = require('./engines/adaptive_log_engine');
  const { MarketMakerDetector } = require('./engines/market_maker_detector');
  const { MarketFeaturesEngine } = require('./engines/market_features_engine');
  const { TelegramNotifier } = require('./notifications/telegram_notifier');
  const Logger = require('./utils/logger');
  const { EventBus } = require('./utils/event_bus');

  const log = Logger('WORKER');
  const bus = new EventBus();

  let adapter = new ProfitClient(bus);
  global._profitAdapter = adapter;

  const normalizer = new DataNormalizer(bus);
  const features = new FeatureEngine(bus);
  const mktFeatures = new MarketFeaturesEngine(bus);
  const mmDetector = new MarketMakerDetector(bus);
  const telegram = new TelegramNotifier(bus);
  const adaptive = new AdaptiveLogEngine(bus);
  const claude = new ClaudeAIEngine(bus);
  const risk = new RiskEngine(bus);
  const execution = new ExecutionEngine(bus);

  if (parentPort) {
    parentPort.on('message', ({ type, data }) => {
      if (type === 'shutdown') {
        try { adapter?.disconnect?.(); } catch {}
      }

      if (type.startsWith('profit:')) bus.emit(type, data);
      if (type === 'macro:update') bus.emit('macro:update', data);
      if (type === 'macro:significant_change') bus.emit('macro:significant_change', data);
    });
  }

  bus.on('profit:price_depth', (d) => {
    if (!d || !d.ticker) return;

    const WDO = ['WDO','WDON26','WDOQ26','WDOV26'];
    const DOL = ['DOL','DOLN26','DOLQ26','DOLV26'];

    const sym = d.ticker;

    const isWDO = WDO.some(s => sym.includes(s));
    const isDOL = DOL.some(s => sym.includes(s));
    if (!isWDO && !isDOL) return;

    const book = {
      symbol: sym,
      bids: (d.bids || []).map(b => ({ price: b.price, qty: b.qty })),
      asks: (d.asks || []).map(a => ({ price: a.price, qty: a.qty })),
      bid_vol_total: (d.bids || []).reduce((s,b) => s + b.qty, 0),
      ask_vol_total: (d.asks || []).reduce((s,a) => s + a.qty, 0),
      imbalance: 0,
      source: 'price_depth_real',
      timestamp: Date.now(),
    };

    if (isWDO) bus.emit('book:update', book);
    else bus.emit('book:update:dol', book);

    try {
      adapter.mdil?.onOfferBook(sym, book.bids.length);
    } catch {}

    log.info(`[PRICE_DEPTH] ${sym}`);
  });

  bus.on('raw:tick', d => normalizer.process(d));
  bus.on('raw:book', d => normalizer.processBook(d));
  bus.on('raw:trade', d => normalizer.processTrade(d));

  bus.on('market:tick:wdo', d => normalizer.process(d));
  bus.on('market:tick:dol', (d) => {
    normalizer.process(d);
    // Emite feature:dol com last price para alimentar SuperDOM DOL
    if (d?.last) bus.emit('feature:dol', { last: d.last, bid: d.bid || d.last, ask: d.ask || d.last, symbol: d.symbol || 'DOLN26', source: 'tick' });
  });

  bus.on('market:book:wdo', d => { const b = normalizer.processBook(d); if (b) bus.emit('book:update', b); });
  bus.on('market:book:dol', d => { const b = normalizer.processBook(d); if (b) bus.emit('book:update:dol', b); });

  bus.on('risk:approved', d => execution.execute(d));

  adapter.start();
  adaptive.start();

  log.info('Worker iniciado OK');
}
