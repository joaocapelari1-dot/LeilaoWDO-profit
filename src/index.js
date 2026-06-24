require('dotenv').config();
const { Worker, isMainThread, parentPort, workerData } = require('worker_threads');
const path = require('path');

if (isMainThread) {
  // ════════════════════════════════════════════════════════════
  // MAIN THREAD — apenas HTTP + WebSocket + broadcast
  // Sem processamento de mercado aqui
  // ════════════════════════════════════════════════════════════
  const { createServer } = require('./api/server');
  const { Logger }       = require('./utils/logger');
  const { EventBus }     = require('./utils/event_bus');

  const log = new Logger('MAIN');
  log.info('═══════════════════════════════════════════════');
  log.info('  WDO Auction Production Engine v1.2');
  log.info(`  MODE: ${process.env.MOCK_MODE === 'false' ? '🔴 LIVE' : '🟡 MOCK'}`);
  log.info(`  EXECUTION: 📄 PAPER`);
  log.info('═══════════════════════════════════════════════');

  const bus = new EventBus();
  global.__bus = bus; // exposto para testes via Railway Console

  // Inicia servidor HTTP/WS imediatamente
  let _workerRef = null;
  const { start, stop, broadcast } = createServer(bus, {});
  global.__getWorker = () => _workerRef;
  start().then(() => {
    log.info('HTTP Server pronto');

    // Inicia worker principal (Cedro, Claude, Risk, Execution)
    const worker = new Worker(__filename, { workerData: { isWorker: true } });
    _workerRef = worker;

// FIX bus-pipeline: Forward profit:* do main bus para o worker thread (onde ProfitClient escuta)
const PROFIT_FORWARD = ['trade','offer_book','theoretical_price','ticker_state','tiny_book','daily','connection_state'];
PROFIT_FORWARD.forEach(evt => {
    bus.on('profit:' + evt, (data) => {
        try { worker.postMessage({ type: 'profit:' + evt, data }); } catch {}
    });
});

    // Inicia macro worker separado (MacroEngine + MarketContext)
    const macroWorker = new Worker(require('path').join(__dirname, 'macro_worker.js'));
    macroWorker.on('message', ({ type, data }) => {
      if (SNAPSHOT_TYPES.includes(type)) lastSnapshot[type] = data;
      // Salvar contexto de mercado no snapshot
      if (type === 'context:gap') lastSnapshot['context:gap'] = data;
      if (type === 'context:calendar') lastSnapshot['context:calendar'] = data;
      bus.emit(type, data);
      // Repassar worker:macro como macro:update para o server (WebSocket) e worker principal (Claude)
      if (type === 'worker:macro') {
        bus.emit('macro:update', data);
        worker.postMessage({ type: 'macro:update', data }); // Claude precisa receber
      }
      if (type === 'macro:significant_change') {
        bus.emit('macro:significant_change', data);
        worker.postMessage({ type: 'macro:significant_change', data });
      }
    });
    macroWorker.on('error', (e) => log.error('MacroWorker error:', e.message));
    macroWorker.on('exit', (code) => { if (code !== 0) log.warn('MacroWorker saiu:', code); });

    // Worker → Main: recebe snapshots e faz broadcast
    // Cache do último snapshot para envio imediato a novos clientes
    const lastSnapshot = {};
    const SNAPSHOT_TYPES = ['worker:auction','worker:risk','worker:execution','worker:macro','worker:adaptive','context:gap','context:calendar'];

    worker.on('message', ({ type, data }) => {
      if (SNAPSHOT_TYPES.includes(type)) lastSnapshot[type] = data;
      bus.emit(type, data);
    });

    // Quando novo cliente conecta, envia snapshot cacheado imediatamente
    bus.on('ws:request_snapshot', (ws) => {
      try {
        if (!ws || ws.readyState !== 1) return;
        const snap = {
          type: 'state_snapshot',
          data: {
            auction:   lastSnapshot['worker:auction']   || { state:'CONTINUOUS', signalEmitted:false, history:[], auctionFeatures:null },
            risk:      lastSnapshot['worker:risk']      || {},
            execution: lastSnapshot['worker:execution'] || { paperMode:true, balance:50000, openPositions:[], closedTrades:[], stats:{} },
            macro:     lastSnapshot['worker:macro']     || null,
            adaptive:  lastSnapshot['worker:adaptive']  || null,
            gap:       lastSnapshot['context:gap']      || null,
            calendario:lastSnapshot['context:calendar'] || null,
          }
        };
        ws.send(JSON.stringify(snap));
      } catch(e) {}
    });

    worker.on('error', (e) => log.error('Worker error:', e.message));
    worker.on('exit', (code) => {
      log.warn('Worker saiu com código', code);
      if (code !== 0) process.exit(1);
    });

    process.on('SIGTERM', () => {
      console.log('[MAIN] SIGTERM — aguardando worker desconectar Cedro...');
      worker.postMessage({ type: 'shutdown' });
      setTimeout(() => { worker.terminate(); stop(); process.exit(0); }, 2000); // 2s para Cedro desconectar
    });
    process.on('SIGINT', () => {
      console.log('[MAIN] SIGINT — aguardando worker desconectar Cedro...');
      worker.postMessage({ type: 'shutdown' });
      setTimeout(() => { worker.terminate(); stop(); process.exit(0); }, 2000);
    });
  });

} else {
  // ════════════════════════════════════════════════════════════
  // WORKER THREAD — todos os engines de mercado aqui
  // Envia snapshots para main via postMessage (throttled)
  // ════════════════════════════════════════════════════════════
  // ── Market Data Provider ─────────────────────────────────────────
  // MARKET_PROVIDER sempre PROFIT - ProfitDLL via ProfitBridge
  // CedroAdapter removido - usando apenas ProfitClient (MARKET_PROVIDER=PROFIT)
  const { ProfitClient } = require('./adapters/profit_client');
  const { DataNormalizer }      = require('./core/data_normalizer');
  const { FeatureEngine }       = require('./core/feature_engine');
  const { ClaudeAIEngine }      = require('./engines/claude_ai_engine');
  const { RiskEngine }          = require('./engines/risk_engine');
  const { ExecutionEngine }     = require('./engines/execution_engine');
  // MacroEngine movido para macro_worker.js
  // MarketContextEngine movido para macro_worker.js
  const { AdaptiveLogEngine }   = require('./engines/adaptive_log_engine');
  const { MarketMakerDetector } = require('./engines/market_maker_detector');
  const { MarketFeaturesEngine }= require('./engines/market_features_engine');
  const { TelegramNotifier }    = require('./notifications/telegram_notifier');
  const { Logger }              = require('./utils/logger');
  const { EventBus }            = require('./utils/event_bus');

  const log = new Logger('WORKER');
  const bus = new EventBus();

  // Receber macro do main thread (vem do macroWorker separado)
  parentPort.on('message', ({ type, data }) => {
    if (type === 'macro:update') { bus.emit('macro:update', data); return; }
    if (type === 'macro:significant_change') { bus.emit('macro:significant_change', data); return; }
    if (type === 'debug:feature') { bus.emit('feature:wdo', data); return; }
    if (type.startsWith('profit:')) { bus.emit(type, data); return; } // FIX bus-pipeline
    if (type === 'shutdown') {
      // Desconecta market data limpo antes do main encerrar
      try {
        if (global._cedroAdapter?.disconnect) global._cedroAdapter.disconnect(); // ProfitClient
        else if (adapter?.disconnect) adapter.disconnect();
      } catch(e) {}
      return;
    }
  });

  // Throttle: só envia para main a cada 100ms
  const throttleMap = {};
  const sendToMain = (type, data) => {
    const now = Date.now();
    if (!throttleMap[type] || now - throttleMap[type] >= 100) {
      throttleMap[type] = now;
      try { parentPort.postMessage({ type, data }); } catch {}
    }
  };

  // Eventos que chegam ao main (throttled)
  const BROADCAST_EVENTS = [
    'normalized:tick', 'book:update', 'market:features', 'feature:wdo', 'feature:dol',
    'ai:analise', 'risk:snapshot', 'risk:approved', 'risk:rejected',
    'risk:window_open', 'risk:window_aborted', 'execution:fill',
    'execution:close', 'iceberg:detected', 'context:gap',
    'context:calendar', 'context:market_makers', 'adaptive:thresholds',
    'adaptive:pregao_salvo', 'feature:wdo', 'feature:dol',
    'cedro:symbols', 'ai:pos_abertura_fim', 'ai:esgotamento',
  ];

  BROADCAST_EVENTS.forEach(evt => {
    bus.on(evt, (data) => sendToMain(evt, data));
  });

  // macro:update enviado pelo macro_worker.js

  // Inicializar todos os engines
  // Sempre usa ProfitClient (MARKET_PROVIDER=PROFIT obrigatorio)
  let adapter = new ProfitClient(bus);
  global._cedroAdapter = adapter;
  log.info('📡 Market Data: PROFIT DLL via ProfitBridge');
  const normalizer = new DataNormalizer(bus);
  const mktFeatures= new MarketFeaturesEngine(bus);
  const mmDetector = new MarketMakerDetector(bus);
  const telegram   = new TelegramNotifier(bus);
  const features   = new FeatureEngine(bus);
  // macro movido para macro_worker.js
  // mktCtx movido para macro_worker.js
  const adaptive   = new AdaptiveLogEngine(bus);
  const claude     = new ClaudeAIEngine(bus);
  const risk       = new RiskEngine(bus);
  const execution  = new ExecutionEngine(bus);

  // Pipeline
  bus.on('raw:tick',        (d) => normalizer.process(d));
  bus.on('raw:tick:dol',    (d) => normalizer.process(d));
  bus.on('raw:book',        (d) => normalizer.processBook(d));
  bus.on('raw:book:dol',    (d) => normalizer.processBook(d));
  bus.on('raw:trade',       (d) => normalizer.processTrade(d));
  bus.on('raw:trade:dol',   (d) => normalizer.processTrade(d));
  // FIX: ProfitClient emite cedro:* em vez de raw:* — adicionar mapeamento para DataNormalizer
  bus.on('cedro:tick:wdo', (d) => normalizer.process(d));
  bus.on('cedro:tick:dol', (d) => normalizer.process(d));
  bus.on('cedro:book:wdo', (d) => normalizer.processBook(d));
  bus.on('cedro:book:dol', (d) => normalizer.processBook(d));
  bus.on('cedro:trade:wdo',(d) => normalizer.processTrade(d));
  bus.on('cedro:trade:dol',(d) => normalizer.processTrade(d));
  bus.on('normalized:tick', (d) => features.onTick(d));
  bus.on('normalized:book', (d) => features.onBook(d));
  // macro:update→mktCtx movido para macro_worker.js
  bus.on('risk:approved',   (d) => execution.execute(d));

  adapter.start();
  // macro.start() e mktCtx.start() rodam no macro_worker.js
  adaptive.start();

  // ── DEBUG: simular leilão ──────────────────────────────────
  bus.on('debug:simular', ({ phase }) => {
    const fakeFeature = {
      phase, symbol: 'WDOFUT', last: 5069, bid: 5069, ask: 5069.5,
      vwap: 5070, momentum: 0.5, aggRatio: 0.90, flowDelta: 800,
      bookImbalance: 0.1, volatility: 1.2,
      auction: { theoreticalPrice: 5068.5, surplus: -68, side: 'BALANCED', volumeAtAuction: 2 },
      _simulated: true
    };
    worker.postMessage({ type: 'debug:feature', data: fakeFeature });
  });

  // Health check automático às 8h40 BRT
  setInterval(() => {
    const now = new Date();
    const brt = new Date(now.getTime() - 3 * 60 * 60 * 1000);
    const h = brt.getUTCHours();
    const m = brt.getUTCMinutes();
    if (h === 8 && m === 40 && !global._healthCheckDone) {
      global._healthCheckDone = true;
      telegram.healthCheck();
      // Reset às 8h41 para próximo dia
      setTimeout(() => { global._healthCheckDone = false; }, 90000);
    }
    // Reset diário à meia-noite
    if (h === 0 && m === 0) global._healthCheckDone = false;
  }, 30000);

  log.info('Worker iniciado — todos os engines ativos');

  // Envia status dos engines para o main thread a cada 2s
  setInterval(() => {
    try {
      if (risk)    parentPort.postMessage({ type: 'worker:risk',    data: risk.getStatus() });
      if (execution) parentPort.postMessage({ type: 'worker:execution', data: execution.getStatus() });
      // worker:macro snapshot enviado pelo macro_worker.js
      if (adaptive) parentPort.postMessage({ type: 'worker:adaptive', data: {
        historico: adaptive.historico?.slice(-7) || [],
        journal: adaptive.journal?.slice(-10) || [],
        status: adaptive.status,
        thresholds: adaptive.thresholds,
        totalPregoes: adaptive.historico?.length || 0,
        totalTrades: adaptive.journal?.length || 0,
        wins: 0, losses: 0, winRate: 0, pnlBRL: 0, pnlTicks: 0,
        balanco_mensal: { periodo: 'mensal', trades: 0, mensagem: 'Sem trades' },
        balanco_anual:  { periodo: 'anual',  trades: 0, mensagem: 'Sem trades' },
      }});
    } catch(e) {}
  }, 2000);
}

// Shutdown tratado no worker thread via postMessage({type:'shutdown'})
// Handler SIGTERM/SIGINT já registrado no bloco isMainThread acima
