/**
 * API Server
 * - REST endpoints for dashboard queries
 * - WebSocket server that broadcasts real-time events to frontend
 */
const express = require('express');
const http    = require('http');
const WebSocket = require('ws');
const cors    = require('cors');
const { Logger } = require('../utils/logger');
const jwt     = require('jsonwebtoken');

const PORT    = parseInt(process.env.PORT    || '8080');

function createServer(bus, engines = {}) {
  const log = new Logger('API-SERVER');
  const app = express();

  // ── CORS PRIMEIRO — antes de tudo ────────────────────────────
  app.use((req, res, next) => {
    res.header('Access-Control-Allow-Origin', '*');
    res.header('Access-Control-Allow-Methods', 'GET,POST,PUT,DELETE,OPTIONS');
    res.header('Access-Control-Allow-Headers', 'Content-Type,Authorization');
    if (req.method === 'OPTIONS') { res.sendStatus(204); return; }
    next();
  });
  app.use(express.json({ limit: '1mb' }));

  // Worker thread envia snapshots via bus — atualiza engines dinamicamente
  const _eng = engines;
  bus.on('worker:auction',   (d) => { _eng.auction   = { getStatus: () => d, getSnapshot: () => d }; });
  bus.on('worker:risk',      (d) => { _eng.risk      = { getStatus: () => d }; });
  bus.on('worker:execution', (d) => { _eng.execution = { getStatus: () => d }; });
  bus.on('worker:adaptive',  (d) => { _eng.adaptive  = d; });
  bus.on('worker:macro',     (d) => { _eng.macro     = { getSnapshot: () => d }; });
  engines = _eng;

  // ── Auth ─────────────────────────────────────────────────────
  const JWT_SECRET  = process.env.JWT_SECRET  || 'wdo-auction-secret-2025';
  const ADMIN_USER  = process.env.ADMIN_USER  || 'joao';
  const ADMIN_PASS  = process.env.ADMIN_PASS  || 'wdo2025';

  const authMiddleware = (req, res, next) => {
    const token = req.headers['authorization']?.split(' ')[1] || req.query.token;
    if (!token) return res.status(401).json({ error: 'Token não fornecido' });
    try { req.user = jwt.verify(token, JWT_SECRET); next(); }
    catch { res.status(401).json({ error: 'Token inválido ou expirado' }); }
  };

  // ── REST Routes ───────────────────────────────────────────────
  app.get('/health', (req, res) => {
    res.json({ status: 'ok', timestamp: Date.now(), mode: process.env.MOCK_MODE !== 'false' ? 'mock' : 'live' });
  });

  // ── Diagnóstico público ────────────────────────────────────
  app.get('/api/diag', (req, res) => {
    const mem = process.memoryUsage();
    const fs = require('fs');
    
    // Event loop lag
    const start = Date.now();
    setImmediate(() => {
      const lag = Date.now() - start;
      
      // Tamanho dos arquivos de dados
      let adaptiveSize = 0, journalSize = 0;
      try { adaptiveSize = fs.statSync('/app/data/adaptive_log.json').size; } catch {}
      try { journalSize  = fs.statSync('/app/data/trade_journal.json').size; } catch {}
      
      res.json({
        memoria: {
          heapUsed_MB:  Math.round(mem.heapUsed / 1024 / 1024),
          heapTotal_MB: Math.round(mem.heapTotal / 1024 / 1024),
          rss_MB:       Math.round(mem.rss / 1024 / 1024),
          external_MB:  Math.round(mem.external / 1024 / 1024),
        },
        eventLoopLag_ms: lag,
        arquivos: {
          adaptive_log_KB: Math.round(adaptiveSize / 1024),
          trade_journal_KB: Math.round(journalSize / 1024),
        },
        uptime_min: Math.round(process.uptime() / 60),
        ts: Date.now()
      });
    });
  });

  // ── Login ───────────────────────────────────────────────────
  app.post('/api/auth/login', (req, res) => {
    const { usuario, senha, username, password } = req.body;
    const u = usuario || username;
    const s = senha || password;
    if (u !== ADMIN_USER || s !== ADMIN_PASS) {
      return res.status(401).json({ error: 'Usuário ou senha incorretos' });
    }
    const token = jwt.sign({ usuario: u, role: 'admin' }, JWT_SECRET, { expiresIn: '12h' });
    res.json({ token, usuario: u, expiresIn: 43200 });
  });

  // Verifica token ativo
  app.get('/api/auth/verify', authMiddleware, (req, res) => {
    res.json({ ok: true, usuario: req.user.usuario });
  });

  app.get('/api/status', (req, res) => {
    res.json({
      auction:   { state:'IDLE', signalEmitted:false, history:[], auctionFeatures:null },
      risk:      engines.risk ? engines.risk.getStatus() : {},
      execution: engines.execution ? engines.execution.getStatus() : { paperMode:true, balance:50000, openPositions:[], closedTrades:[], stats:{} },
    });
  });

  app.get('/api/execution', (req, res) => {
    res.json(engines.execution ? engines.execution.getStatus() : { paperMode:true, balance:50000, openPositions:[], closedTrades:[], stats:{} });
  });

  app.get('/api/risk', (req, res) => {
    res.json(engines.risk ? engines.risk.getStatus() : {});
  });

  app.get('/api/auction', (req, res) => {
    res.json({ state:'IDLE', signalEmitted:false, history:[], auctionFeatures:null });
  });

  // ── DEBUG: simular leilão (remover após testes) ──────────
  app.post('/api/debug/simular-leilao', (req, res) => { // sem auth — apenas debug
    const { phase } = req.body;
    if (!['pre_open','auction','continuous'].includes(phase)) {
      return res.json({ ok: false, error: 'phase inválida' });
    }
    const w = global.__getWorker ? global.__getWorker() : null;
    if (!w) return res.json({ ok: false, error: 'worker não disponível ainda' });
    const feat = {
      phase, symbol: 'WDOFUT', last: 5069, bid: 5069, ask: 5069.5,
      vwap: 5070, momentum: 0.5, aggRatio: 0.90, flowDelta: 800,
      bookImbalance: 0.1, volatility: 1.2,
      auction: { theoreticalPrice: 5068.5, surplus: -68, side: 'BALANCED', volumeAtAuction: 2 },
      _simulated: true
    };
    w.postMessage({ type: 'debug:feature', data: feat });
    res.json({ ok: true, phase, msg: 'debug:feature enviado ao worker com phase=' + phase });
  });

  // Ping macro — retorna snapshot completo para debug
  app.get('/api/macro/ping', authMiddleware, (req, res) => {
    const macro = engines.macro ? engines.macro ? engines.macro.getSnapshot() : null : null;
    res.json({ ok: true, hasData: !!macro, ts: Date.now(), snapshot: macro });
  });

  app.get('/api/adaptive', authMiddleware, (req, res) => {
    res.json(engines.adaptive ? engines.adaptive.getStats() : { error: 'Adaptive log não disponível' });
  });

  app.post('/api/adaptive/reset', (req, res) => {
    if (engines.adaptive) engines.adaptive.resetar();
    res.json({ ok: true, message: 'Calibração resetada para defaults' });
  });

  app.post('/api/adaptive/reativar', (req, res) => {
    if (engines.adaptive) engines.adaptive.reativar();
    res.json({ ok: true, message: 'Calibração reativada' });
  });

  // Limpa histórico mock (só em MOCK_MODE)
  app.delete('/api/adaptive/historico', authMiddleware, (req, res) => {
    if (process.env.MOCK_MODE === 'false') {
      return res.status(403).json({ error: 'Não permitido em modo live' });
    }
    if (engines.adaptive) {
      engines.adaptive.historico = [];
      engines.adaptive.journal   = [];
      engines.adaptive._saveHistorico();
      engines.adaptive._saveJournal();
      res.json({ ok: true, message: 'Histórico mock limpo' });
    } else {
      res.json({ ok: false });
    }
  });

  app.get('/api/adaptive/journal', authMiddleware, async (req, res) => { res.setTimeout(5000, () => res.json([])); 
    res.json(engines.adaptive ? (engines.adaptive.journal || []) : []);
  });

  app.get('/api/adaptive/correlacao', authMiddleware, (req, res) => {
    res.json(engines.adaptive ? engines.adaptive.getCorrelacaoFiltros() : {});
  });

  app.get('/api/adaptive/balanco/:periodo', authMiddleware, (req, res) => {
    const periodo = req.params.periodo || 'mensal';
    res.json(engines.adaptive ? engines.adaptive ? (() => engines.adaptive.balanco_anual || {}) : (() => ({}))(periodo) : {});
  });

  app.get('/api/adaptive/historico', authMiddleware, async (req, res) => { res.setTimeout(5000, () => res.json([])); 
    res.json(engines.adaptive ? (engines.adaptive.historico || []) : []);
  });

  app.post('/api/risk/reset', (req, res) => {
    engines.risk.resetDay();
    res.json({ ok: true, message: 'Risk engine reset' });
  });

  app.post('/api/auction/reset', (req, res) => {
    // auction removido
    res.json({ ok: true, message: 'Auction state machine reset' });
  });

  // ── HTTP Server ───────────────────────────────────────────────
  const httpServer = http.createServer(app);


  // ── Bridge Secret ─────────────────────────────────────────────
  const BRIDGE_SECRET = process.env.BRIDGE_SECRET || '321Angelin@@';

  // ── WebSocket Server ──────────────────────────────────────────
  const wss = new WebSocket.Server({ server: httpServer, path: '/ws' });
  const clients = new Set();

  // Heartbeat para manter WebSocket vivo
  const heartbeat = setInterval(() => {
    clients.forEach(ws => {
      if (ws.readyState === WebSocket.OPEN) ws.ping();
    });
  }, 30000);

  wss.on('connection', (ws, req) => {
    // Detectar se é conexão da VPS (bridge) ou frontend
    const bridgeSecret = req.headers['x-bridge-secret'];
    if (bridgeSecret) {
      // ── Conexão da VPS (arquitetura invertida) ──────────────────
      if (bridgeSecret !== BRIDGE_SECRET) {
        log.warn('Bridge: secret invalido — rejeitando');
        ws.close();
        return;
      }
      log.info('✅ ProfitBridge VPS conectado via /ws!');
      ws.on('message', (data) => {
        try {
          const cleaned = data.toString().replace(/-Infinity/g, "null").replace(/\bInfinity\b/g, "null").replace(/\bNaN\b/g, "null");
          const msgs = JSON.parse(cleaned);
          const events = Array.isArray(msgs) ? msgs : [msgs];
          events.forEach(event => {
            if (!event || !event.type || event.type === 'bridge_auth') return;
            bus.emit('profit:' + event.type, event);
          });
        } catch(e) { log.warn('Bridge parse error: ' + e.message); }
      });
      ws.on('close', () => log.warn('ProfitBridge VPS desconectado'));
      ws.on('error', (e) => log.warn('Bridge error: ' + e.message));
      return; // Não adicionar ao clients do frontend
    }
    ws.isAlive = true;
    ws.on('pong', () => { ws.isAlive = true; });
    clients.add(ws);
    log.info(`WS client connected (${clients.size} total)`);
    // Snapshot imediato do cache do worker
    setTimeout(() => bus.emit('ws:request_snapshot', ws), 200);

    // Send current state immediately on connect
    ws.send(JSON.stringify({
      type: 'state_snapshot',
      data: {
        auction:   { state:'IDLE', signalEmitted:false, history:[], auctionFeatures:null },
        risk:      engines.risk ? engines.risk.getStatus() : {},
        execution: engines.execution ? engines.execution.getStatus() : { paperMode:true, balance:50000, openPositions:[], closedTrades:[], stats:{} },
      }
    }));

    ws.on('close', () => {
      clients.delete(ws);
      log.info(`WS client disconnected (${clients.size} remaining)`);
    });

    ws.on('error', () => clients.delete(ws));
  });

  // ── Bus → WebSocket Bridge ────────────────────────────────────
  const broadcast = (type, data) => {
    if (clients.size === 0) return;
    const msg = JSON.stringify({ type, data, timestamp: Date.now() });
    clients.forEach(ws => {
      if (ws.readyState === WebSocket.OPEN) ws.send(msg);
    });
  };

  // Forward key events to frontend
  // Throttle tick e book para não bloquear event loop (máx 10/s)
  let lastTick = 0, lastBook = 0;
  bus.on('normalized:tick', (d) => {
    const now = Date.now();
    if (now - lastTick >= 200) { lastTick = now; broadcast('tick', d); }
  });
  bus.on('book:update', (d) => {
    const now = Date.now();
    if (now - lastBook >= 200) { lastBook = now; broadcast('book', d); }
  });
  bus.on('iceberg:detected',   (d) => broadcast('iceberg',        d));
  bus.on('context:gap',        (d) => broadcast('context_gap',     d));
  bus.on('context:calendar',   (d) => broadcast('context_calendar', d));
  bus.on('context:market_makers',(d) => broadcast('context_mm',     d));
  bus.on('risk:confianca',        (d) => broadcast('risk_confianca',    d));
  bus.on('ai:analise',            (d) => broadcast('ai_analise',        d));
  bus.on('macro:update',          (d) => broadcast('macro_update',      d));
  bus.on('cedro:symbols',         (d) => broadcast('symbols_update',    d));
  bus.on('market:features',       (d) => broadcast('market_features',   d));

  // ── Chat endpoint (proxy para Anthropic evitando CORS) ──────
  app.post('/api/chat', authMiddleware, async (req, res) => {
    try {
      const { messages, system } = req.body;
      const apiKey = process.env.ANTHROPIC_API_KEY;
      if (!apiKey) return res.status(503).json({ error: 'ANTHROPIC_API_KEY não configurada' });

      const response = await fetch('https://api.anthropic.com/v1/messages', {
        method: 'POST',
        headers: {
          'Content-Type':      'application/json',
          'x-api-key':         apiKey,
          'anthropic-version': '2023-06-01',
        },
        body: JSON.stringify({
          model:      'claude-sonnet-4-5',
          max_tokens: 1000,
          system:     system || 'Você é o assistente do WDO Auction Engine.',
          messages,
        }),
      });

      const data = await response.json();
      if (data.error) {
        console.error('[CHAT] Anthropic erro:', JSON.stringify(data.error));
      }
      res.json(data);
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  });

  // Endpoint para reload de API
  app.post('/api/reload/:api', authMiddleware, (req, res) => {
    const api = req.params.api;
    bus.emit('api:reload', { api });
    res.json({ ok: true, message: `Reload solicitado: ${api}` });
  });
  bus.on('adaptive:thresholds',  (d) => broadcast('adaptive_thresh',  d));
  bus.on('adaptive:pregao_salvo',(d) => broadcast('adaptive_pregao',  d));
  bus.on('feature:wdo',        (d) => broadcast('features',       d));
  bus.on('feature:dol',        (d) => broadcast('features_dol',   d));
  // ai:analise já registrado acima (linha 301)
  bus.on('risk:approved',      (d) => broadcast('risk_approved',  d));
  bus.on('risk:rejected',      (d) => broadcast('risk_rejected',  d));
  bus.on('risk:snapshot',      (d) => broadcast('risk_snapshot',  d));
  bus.on('risk:window_open',   (d) => broadcast('risk_window',    { ...d, status: 'open' }));
  bus.on('risk:window_aborted',(d) => broadcast('risk_window',    { ...d, status: 'aborted' }));
  bus.on('execution:fill',     (d) => broadcast('fill',           d));
  bus.on('execution:close',    (d) => broadcast('close',          d));

  // Also handle explicit broadcast requests
  bus.on('ws:broadcast', ({ type, data }) => broadcast(type, data));

  // ── Start / Stop ──────────────────────────────────────────────
  const start = () => new Promise((resolve) => {
    httpServer.listen(PORT, '0.0.0.0', () => {
      log.info(`REST API: http://localhost:${PORT}`);
      log.info(`WebSocket: ws://localhost:${PORT}/ws`);
      resolve();
    });
  });

  const stop = () => {
    wss.close();
    httpServer.close();
    log.info('Server stopped');
  };

  return { start, stop, broadcast };
}

module.exports = { createServer };
