const express = require('express');
const http = require('http');
const WebSocket = require('ws');
const jwt = require('jsonwebtoken');
const { Logger } = require('../utils/logger');

const PORT = parseInt(process.env.PORT || '8080');

function createServer(bus, engines = {}) {

  const log = new Logger('API');

  const app = express();
  app.use(express.json({ limit: '1mb' }));

  // CORS simples e seguro
  app.use((req, res, next) => {
    res.header('Access-Control-Allow-Origin', '*');
    res.header('Access-Control-Allow-Headers', 'Content-Type,Authorization');
    res.header('Access-Control-Allow-Methods', 'GET,POST,OPTIONS');

    if (req.method === 'OPTIONS') return res.sendStatus(204);
    next();
  });

  let offerBookCount = 0;

  // HEALTH FIXADO
  app.get('/health', (req, res) => {
    res.json({
      status: 'ok',
      offerBookCount,
      ts: Date.now()
    });
  });

  // SAFE STATUS
  app.get('/api/status', (req, res) => {
    res.json({
      risk: engines?.risk?.getStatus?.() || {},
      execution: engines?.execution?.getStatus?.() || {}
    });
  });

  // HTTP
  const httpServer = http.createServer(app);

  // WS
  const wss = new WebSocket.Server({ server: httpServer, path: '/ws' });
  const clients = new Set();

  wss.on('connection', (ws) => {
    clients.add(ws);
    log.info('WS client conectado');

    ws.send(JSON.stringify({
      type: 'connected',
      data: { ok: true }
    }));

    ws.on('close', () => clients.delete(ws));
  });

  // broadcast seguro
  const broadcast = (type, data) => {
    const msg = JSON.stringify({ type, data, ts: Date.now() });

    for (const ws of clients) {
      if (ws.readyState === 1) {
        ws.send(msg);
      }
    }
  };

  bus.on('normalized:tick', d => {
    broadcast('tick', d);
  });

  bus.on('book:update', d => {
    broadcast('book', d);
  });

  const start = () => new Promise((resolve) => {
    httpServer.listen(PORT, '0.0.0.0', () => {
      log.info(`API rodando em http://localhost:${PORT}`);
      resolve();
    });
  });

  const stop = () => {
    wss.close();
    httpServer.close();
  };

  return { start, stop, broadcast };
}

module.exports = { createServer };
