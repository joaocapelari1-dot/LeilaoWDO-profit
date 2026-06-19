'use strict';
/**
 * ProfitClient v1.0
 * Conecta ao ProfitBridge (Python/Windows) via WebSocket
 * e emite os mesmos eventos que o LiveCedroClient emite.
 *
 * Eventos emitidos (compatíveis com DataNormalizer):
 *   cedro:tick:wdo  → tick do WDO (last, bid, ask, theor_price, surplus...)
 *   cedro:tick:dol  → tick do DOL
 *   cedro:book:wdo  → book L2 do WDO (bids[], asks[])
 *   cedro:book:dol  → book L2 do DOL
 *   cedro:trade:wdo → trade do WDO (tape reading)
 *   cedro:trade:dol → trade do DOL
 *   cedro:connected → quando conectado e pronto
 *   cedro:syn       → keepalive (a cada mensagem recebida)
 */

const WebSocket = require('ws');
const logger    = require('../utils/logger');

const PROFIT_BRIDGE_URL = process.env.PROFIT_BRIDGE_URL || 'ws://localhost:8787';
const RECONNECT_MS      = 3000;
const MAX_RECONNECTS    = 999;

// Símbolos WDO e DOL
const WDO_SYMBOLS = ['WDOFUT', 'WDON26', 'WDOQ26', 'WDOV26', 'WDO'];
const DOL_SYMBOLS = ['DOLFUT', 'DOLN26', 'DOLQ26', 'DOLV26', 'DOL'];

class ProfitClient {
  constructor(bus) {
    this.bus          = bus;
    this.log          = logger.child({ module: 'PROFIT-CLIENT' });
    this.ws           = null;
    this.reconnects   = 0;
    this.authed       = false;

    // Book acumulado por símbolo
    this.bookWDO      = { bids: {}, asks: {} };
    this.bookDOL      = { bids: {}, asks: {} };

    // Último tick por símbolo (para merge incremental)
    this.lastWDO      = {};
    this.lastDOL      = {};

    this._connect();
  }

  // ── Conexão WebSocket ─────────────────────────────────────────────────────
  _connect() {
    this.log.info(`Conectando ao ProfitBridge: ${PROFIT_BRIDGE_URL}`);

    this.ws = new WebSocket(PROFIT_BRIDGE_URL);

    this.ws.on('open', () => {
      this.reconnects = 0;
      this.log.info('✅ Conectado ao ProfitBridge');
    });

    this.ws.on('message', (data) => {
      try {
        const msg = JSON.parse(data);
        // ProfitBridge pode mandar array (batch) ou objeto único
        if (Array.isArray(msg)) {
          msg.forEach(m => this._handleMessage(m));
        } else {
          this._handleMessage(msg);
        }
        // Keepalive
        this.bus.emit('cedro:syn', { timestamp: Date.now() });
      } catch (e) {
        this.log.warn('Erro parse mensagem: ' + e.message);
      }
    });

    this.ws.on('close', () => {
      this.authed = false;
      this.log.warn('Desconectado do ProfitBridge — reconectando...');
      this._scheduleReconnect();
    });

    this.ws.on('error', (e) => {
      this.log.warn('WebSocket erro: ' + e.message);
    });
  }

  _scheduleReconnect() {
    if (this.reconnects >= MAX_RECONNECTS) return;
    this.reconnects++;
    setTimeout(() => this._connect(), RECONNECT_MS);
  }

  // ── Dispatcher de mensagens ───────────────────────────────────────────────
  _handleMessage(msg) {
    if (!msg || !msg.type) return;

    switch (msg.type) {
      case 'connected':
        this.authed = true;
        this.log.info(`ProfitBridge conectado — símbolos: ${(msg.symbols || []).join(', ')}`);
        this.bus.emit('cedro:connected');
        break;

      case 'tick':
        this._onTick(msg);
        break;

      case 'book_entry':
        this._onBookEntry(msg);
        break;

      case 'tiny_book':
        this._onTinyBook(msg);
        break;

      case 'daily':
        this._onDaily(msg);
        break;

      case 'connection_state':
        this.log.info(`DLL state: type=${msg.state_type} result=${msg.result}`);
        break;

      default:
        break;
    }
  }

  // ── Tick (new_trade_callback) ─────────────────────────────────────────────
  _onTick(msg) {
    const sym   = msg.symbol || '';
    const isWDO = WDO_SYMBOLS.some(s => sym.includes(s));
    const isDOL = DOL_SYMBOLS.some(s => sym.includes(s));
    if (!isWDO && !isDOL) return;

    // Calcula surplus com sinal
    const surplus = msg.surplus_side === 'buy'  ?  Math.abs(msg.surplus || 0) :
                    msg.surplus_side === 'sell' ? -Math.abs(msg.surplus || 0) : 0;

    const tick = {
      symbol:       sym,
      timestamp:    msg.timestamp || Date.now(),
      last:         msg.last      || 0,
      bid:          msg.bid       || 0,
      ask:          msg.ask       || 0,
      trade_vol:    msg.qty       || 0,
      auc_vol:      0, // preenchido via daily
      theor_price:  msg.theor_price || 0,
      theor_qty:    msg.theor_qty   || 0,
      surplus,
      surplus_side: msg.surplus_side || null,
      buy_agent:    msg.buy_agent    || 0,
      sell_agent:   msg.sell_agent   || 0,
    };

    if (isWDO) {
      this.lastWDO = { ...this.lastWDO, ...tick };
      this.bus.emit('cedro:tick:wdo', { ...this.lastWDO });

      // Tape reading
      this.bus.emit('cedro:trade:wdo', {
        symbol:    sym,
        price:     tick.last,
        qty:       tick.trade_vol,
        agressor:  msg.surplus_side || 'balanced',
        timestamp: tick.timestamp,
      });
    } else {
      this.lastDOL = { ...this.lastDOL, ...tick };
      this.bus.emit('cedro:tick:dol', { ...this.lastDOL });

      this.bus.emit('cedro:trade:dol', {
        symbol:    sym,
        price:     tick.last,
        qty:       tick.trade_vol,
        agressor:  msg.surplus_side || 'balanced',
        timestamp: tick.timestamp,
      });
    }
  }

  // ── Book Entry (offer_book_callback) ──────────────────────────────────────
  _onBookEntry(msg) {
    const sym   = msg.symbol || '';
    const isWDO = WDO_SYMBOLS.some(s => sym.includes(s));
    const isDOL = DOL_SYMBOLS.some(s => sym.includes(s));
    if (!isWDO && !isDOL) return;

    const book  = isWDO ? this.bookWDO : this.bookDOL;
    const key   = Math.round((msg.price || 0) * 100);

    if (msg.qty > 0) {
      if (msg.side === 'bid') book.bids[key] = { price: msg.price, qty: msg.qty, broker: msg.broker };
      else                    book.asks[key] = { price: msg.price, qty: msg.qty, broker: msg.broker };
    } else {
      // qty=0 → remover nível
      if (msg.side === 'bid') delete book.bids[key];
      else                    delete book.asks[key];
    }

    // Emite book atualizado
    this._emitBook(sym, book, isWDO);
  }

  // ── Tiny Book (topo do book) ──────────────────────────────────────────────
  _onTinyBook(msg) {
    const sym   = msg.symbol || '';
    const isWDO = WDO_SYMBOLS.some(s => sym.includes(s));
    const isDOL = DOL_SYMBOLS.some(s => sym.includes(s));
    if (!isWDO && !isDOL) return;

    // Atualiza bid ou ask no último tick
    if (isWDO) {
      if (msg.side === 'bid') this.lastWDO.bid = msg.price;
      else                    this.lastWDO.ask = msg.price;
    } else {
      if (msg.side === 'bid') this.lastDOL.bid = msg.price;
      else                    this.lastDOL.ask = msg.price;
    }
  }

  // ── Daily (dados diários) ─────────────────────────────────────────────────
  _onDaily(msg) {
    const sym   = msg.symbol || '';
    const isWDO = WDO_SYMBOLS.some(s => sym.includes(s));
    if (!isWDO) return;

    // Atualiza auc_vol com volume do dia
    this.lastWDO.auc_vol = msg.contracts || 0;
    this.lastWDO.open    = msg.open  || 0;
    this.lastWDO.high    = msg.high  || 0;
    this.lastWDO.low     = msg.low   || 0;
  }

  // ── Emit Book ─────────────────────────────────────────────────────────────
  _emitBook(symbol, book, isWDO) {
    const bids = Object.values(book.bids)
      .sort((a, b) => b.price - a.price)
      .slice(0, 20);
    const asks = Object.values(book.asks)
      .sort((a, b) => a.price - b.price)
      .slice(0, 20);

    const bookMsg = { symbol, bids, asks, timestamp: Date.now() };

    if (isWDO) this.bus.emit('cedro:book:wdo', bookMsg);
    else        this.bus.emit('cedro:book:dol', bookMsg);
  }

  // ── Disconnect ────────────────────────────────────────────────────────────
  disconnect() {
    if (this.ws) {
      this.ws.removeAllListeners();
      this.ws.close();
      this.ws = null;
    }
    this.log.info('ProfitClient desconectado');
  }
}

module.exports = { ProfitClient };
