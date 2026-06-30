const express   = require('express');
const http      = require('http');
const WebSocket = require('ws');
const path      = require('path');
const { Logger } = require('../utils/logger');

const PORT          = parseInt(process.env.PORT || '8080');
const BRIDGE_SECRET = process.env.BRIDGE_SECRET || '';

function createServer(bus, engines = {}) {
  const log = new Logger('API');
  const app = express();
  app.use(express.json({ limit: '1mb' }));

  // Frontend buildado
  const frontendDist = path.join(__dirname, '../../frontend/dist');
  app.use(express.static(frontendDist));

  // CORS
  app.use((req, res, next) => {
    res.header('Access-Control-Allow-Origin', '*');
    res.header('Access-Control-Allow-Headers', 'Content-Type,Authorization,X-Bridge-Secret');
    res.header('Access-Control-Allow-Methods', 'GET,POST,OPTIONS');
    if (req.method === 'OPTIONS') return res.sendStatus(204);
    next();
  });

  // REST
  app.get('/health', (req, res) => res.json({ status: 'ok', ts: Date.now() }));

  // Rota de diagnostico: injeta um book de teste direto no bus do MAIN THREAD
  // Se o frontend receber isso, o caminho bus->broadcast->frontend esta OK
  // Se nao receber, o problema e exclusivamente no worker_threads
  app.get('/api/test-broadcast', (req, res) => {
    const fakeBook = {
      symbol: 'WDON26',
      bids: Array.from({length:10},(_,i)=>({price: 5170 - i*0.5, qty: 10})),
      asks: Array.from({length:10},(_,i)=>({price: 5170.5 + i*0.5, qty: 10})),
      best_bid: 5170, best_ask: 5170.5,
      timestamp: Date.now(), source: 'test'
    };
    bus.emit('book:update', fakeBook);
    bus.emit('auction:state', { symbol: 'WDON26', state: 'TEST', in_auction: true, timestamp: Date.now() });
    res.json({ ok: true, sent: fakeBook });
  });

  app.get('/api/status', (req, res) => {
    res.json({
      risk:      engines?.risk?.getStatus?.()      || {},
      execution: engines?.execution?.getStatus?.() || {},
    });
  });

  app.get('/api/adaptive/historico',      (req, res) => { try { res.json(engines.adaptiveLog?.getHistorico?.()      || []); } catch { res.json([]); }});
  app.get('/api/adaptive/journal',        (req, res) => { try { res.json(engines.adaptiveLog?.getJournal?.()         || []); } catch { res.json([]); }});
  app.get('/api/adaptive/balanco/mensal', (req, res) => { try { res.json(engines.adaptiveLog?.getBalancoMensal?.()  || {}); } catch { res.json({}); }});
  app.get('/api/adaptive/balanco/anual',  (req, res) => { try { res.json(engines.adaptiveLog?.getBalancoAnual?.()   || {}); } catch { res.json({}); }});

  // SPA fallback
  app.get('*', (req, res) => {
    res.sendFile(path.join(frontendDist, 'index.html'), (err) => {
      if (err) res.status(200).send('<h1>WDO Auction Engine</h1>');
    });
  });

  const httpServer = http.createServer(app);

  // ÃÂ¢ÃÂÃÂÃÂ¢ÃÂÃÂ WebSocket server unico ÃÂ¢ÃÂÃÂ distingue /bridge de /ws ÃÂ¢ÃÂÃÂÃÂ¢ÃÂÃÂÃÂ¢ÃÂÃÂÃÂ¢ÃÂÃÂÃÂ¢ÃÂÃÂÃÂ¢ÃÂÃÂÃÂ¢ÃÂÃÂÃÂ¢ÃÂÃÂÃÂ¢ÃÂÃÂÃÂ¢ÃÂÃÂÃÂ¢ÃÂÃÂÃÂ¢ÃÂÃÂ
  const wss     = new WebSocket.Server({ server: httpServer });
  const clients = new Set();   // frontends
  const bridges = new Set();   // VPS ProfitBridge

  // Broadcast para todos os frontends
  const broadcast = (type, data) => {
    const msg = JSON.stringify({ type, data, ts: Date.now() });
    for (const ws of clients) {
      if (ws.readyState === WebSocket.OPEN) ws.send(msg);
    }
  };

  wss.on('connection', (ws, req) => {
    const url    = req.url || '';
    const secret = req.headers['x-bridge-secret'] || '';

    // ÃÂ¢ÃÂÃÂÃÂ¢ÃÂÃÂ Conexao do ProfitBridge (VPS) ÃÂ¢ÃÂÃÂÃÂ¢ÃÂÃÂÃÂ¢ÃÂÃÂÃÂ¢ÃÂÃÂÃÂ¢ÃÂÃÂÃÂ¢ÃÂÃÂÃÂ¢ÃÂÃÂÃÂ¢ÃÂÃÂÃÂ¢ÃÂÃÂÃÂ¢ÃÂÃÂÃÂ¢ÃÂÃÂÃÂ¢ÃÂÃÂÃÂ¢ÃÂÃÂÃÂ¢ÃÂÃÂÃÂ¢ÃÂÃÂÃÂ¢ÃÂÃÂÃÂ¢ÃÂÃÂÃÂ¢ÃÂÃÂÃÂ¢ÃÂÃÂÃÂ¢ÃÂÃÂÃÂ¢ÃÂÃÂÃÂ¢ÃÂÃÂÃÂ¢ÃÂÃÂÃÂ¢ÃÂÃÂÃÂ¢ÃÂÃÂÃÂ¢ÃÂÃÂÃÂ¢ÃÂÃÂÃÂ¢ÃÂÃÂÃÂ¢ÃÂÃÂÃÂ¢ÃÂÃÂ
    if (url === '/bridge' && secret === BRIDGE_SECRET && BRIDGE_SECRET) {
      log.info('ProfitBridge VPS conectado');
      bridges.add(ws);

      ws.send(JSON.stringify({ type: 'connected', ts: Date.now() }));

      // Keepalive para o bridge ÃÂ¢ÃÂÃÂ Railway fecha conexoes inativas (v2)
      const keepalive = setInterval(() => {
        if (ws.readyState === WebSocket.OPEN) {
          ws.ping();
        } else {
          clearInterval(keepalive);
        }
      }, 8000);

      ws.on('pong', () => {
        // bridge respondeu ao ping ÃÂ¢ÃÂÃÂ conexao viva
      });

      ws.on('message', (raw) => {
        try {
          // Sanitizar -Infinity e Infinity antes do JSON.parse
          // A DLL envia -inf como valor numerico que nao e JSON valido
          const sanitized = raw.toString()
            .replace(/-Infinity/g, 'null')
            .replace(/Infinity/g, 'null')
            .replace(/NaN/g, 'null')
            .replace(/:-inf/gi, ':null')
            .replace(/: -inf/gi, ': null');
          const data = JSON.parse(sanitized);
          const arr  = Array.isArray(data) ? data : [data];
          arr.forEach(ev => {
            if (!ev.type || ev.type === 'heartbeat') return;
            bus.emit('profit:' + ev.type, ev);
          });
        } catch (e) {
          log.error('Bridge parse error: ' + e.message);
        }
      });

      ws.on('close', () => {
        clearInterval(keepalive);
        bridges.delete(ws);
        log.warn('ProfitBridge desconectado');
        bus.emit('profit:connection_state', { type: 'connection_state', conn_type: 2, result: 0 });
      });

      return;
    }

    // ÃÂ¢ÃÂÃÂÃÂ¢ÃÂÃÂ Conexao do frontend ÃÂ¢ÃÂÃÂÃÂ¢ÃÂÃÂÃÂ¢ÃÂÃÂÃÂ¢ÃÂÃÂÃÂ¢ÃÂÃÂÃÂ¢ÃÂÃÂÃÂ¢ÃÂÃÂÃÂ¢ÃÂÃÂÃÂ¢ÃÂÃÂÃÂ¢ÃÂÃÂÃÂ¢ÃÂÃÂÃÂ¢ÃÂÃÂÃÂ¢ÃÂÃÂÃÂ¢ÃÂÃÂÃÂ¢ÃÂÃÂÃÂ¢ÃÂÃÂÃÂ¢ÃÂÃÂÃÂ¢ÃÂÃÂÃÂ¢ÃÂÃÂÃÂ¢ÃÂÃÂÃÂ¢ÃÂÃÂÃÂ¢ÃÂÃÂÃÂ¢ÃÂÃÂÃÂ¢ÃÂÃÂÃÂ¢ÃÂÃÂÃÂ¢ÃÂÃÂÃÂ¢ÃÂÃÂÃÂ¢ÃÂÃÂÃÂ¢ÃÂÃÂÃÂ¢ÃÂÃÂÃÂ¢ÃÂÃÂÃÂ¢ÃÂÃÂÃÂ¢ÃÂÃÂÃÂ¢ÃÂÃÂÃÂ¢ÃÂÃÂÃÂ¢ÃÂÃÂÃÂ¢ÃÂÃÂÃÂ¢ÃÂÃÂÃÂ¢ÃÂÃÂÃÂ¢ÃÂÃÂÃÂ¢ÃÂÃÂ
    if (url === '/ws' || url === '/') {
      clients.add(ws);
      log.info('WS client conectado (' + clients.size + ')');

      ws.send(JSON.stringify({ type: 'connected', data: { ok: true } }));
      ws.on('close', () => clients.delete(ws));
      return;
    }

    // Rejeitar conexoes invalidas
    log.warn('WS rejeitado: url=' + url);
    ws.close(1008, 'Invalid path or secret');
  });

  // ÃÂ¢ÃÂÃÂÃÂ¢ÃÂÃÂ Broadcasts para o frontend ÃÂ¢ÃÂÃÂÃÂ¢ÃÂÃÂÃÂ¢ÃÂÃÂÃÂ¢ÃÂÃÂÃÂ¢ÃÂÃÂÃÂ¢ÃÂÃÂÃÂ¢ÃÂÃÂÃÂ¢ÃÂÃÂÃÂ¢ÃÂÃÂÃÂ¢ÃÂÃÂÃÂ¢ÃÂÃÂÃÂ¢ÃÂÃÂÃÂ¢ÃÂÃÂÃÂ¢ÃÂÃÂÃÂ¢ÃÂÃÂÃÂ¢ÃÂÃÂÃÂ¢ÃÂÃÂÃÂ¢ÃÂÃÂÃÂ¢ÃÂÃÂÃÂ¢ÃÂÃÂÃÂ¢ÃÂÃÂÃÂ¢ÃÂÃÂÃÂ¢ÃÂÃÂÃÂ¢ÃÂÃÂÃÂ¢ÃÂÃÂÃÂ¢ÃÂÃÂÃÂ¢ÃÂÃÂÃÂ¢ÃÂÃÂÃÂ¢ÃÂÃÂÃÂ¢ÃÂÃÂÃÂ¢ÃÂÃÂÃÂ¢ÃÂÃÂÃÂ¢ÃÂÃÂÃÂ¢ÃÂÃÂÃÂ¢ÃÂÃÂÃÂ¢ÃÂÃÂ
  bus.on('normalized:tick',         d => broadcast('tick',           d));
  bus.on('book:update',             d => broadcast('book',           d));
  bus.on('market:book:wdo',          d => broadcast('book',           d));
  bus.on('market:book:dol',          d => broadcast('book_dol',       d));
  bus.on('book:update:dol',         d => broadcast('book_dol',       d));
  bus.on('feature:wdo',             d => broadcast('features',       d));
  bus.on('feature:dol',             d => broadcast('features_dol',   d));
  bus.on('market:features',         d => broadcast('market_features',d));
  bus.on('market:tick:dol',          d => broadcast('tick_dol',       d));
  bus.on('auction:state',           d => broadcast('auction_state',  d));
  bus.on('market:ticker_state',      d => broadcast('auction_state',  d));
  bus.on('signal:approved',         d => broadcast('signal',         d));
  bus.on('mdil:status',             d => broadcast('mdil_status',    d));
  bus.on('mdil:ghost_feed',         d => broadcast('mdil_ghost',     d));
  bus.on('mdil:real_feed',          d => broadcast('mdil_real',      d));
  bus.on('risk:approved',           d => broadcast('risk_approved',  d));
  bus.on('risk:rejected',           d => broadcast('risk_rejected',  d));
  bus.on('ai:analise',              d => broadcast('ai_analise',     d));
  bus.on('context:gap',             d => broadcast('context_gap',    d));
  bus.on('context:calendar',        d => broadcast('context_calendar',d));
  bus.on('macro:update',            d => broadcast('macro_update',   d));
  bus.on('iceberg:detected',        d => broadcast('iceberg',        d));
  bus.on('esgotamento:detectado',   d => broadcast('esgotamento',    d));
  bus.on('fill',                    d => broadcast('fill',           d));

  const start = () => new Promise((resolve) => {
    httpServer.listen(PORT, '0.0.0.0', () => {
      log.info('API rodando em http://localhost:' + PORT);
      log.info('WS frontend: /ws');
      log.info('WS bridge:   /bridge');
      resolve();
    });
  });

  const stop = () => { wss.close(); httpServer.close(); };

  return { start, stop, broadcast };
}

module.exports = { createServer };
