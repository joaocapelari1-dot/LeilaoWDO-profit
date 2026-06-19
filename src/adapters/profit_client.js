'use strict';
/**
 * ProfitClient v2.0
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
 *   cedro:syn       → keepalive
 */

const WebSocket = require('ws');

const PROFIT_BRIDGE_URL = process.env.PROFIT_BRIDGE_URL || 'ws://localhost:8787';
const RECONNECT_BASE_MS = 3000;
const RECONNECT_MAX_MS  = 30000;
const MAX_RECONNECTS    = 999;

const WDO_SYMBOLS = ['WDOFUT', 'WDON26', 'WDOQ26', 'WDOV26', 'WDO'];
const DOL_SYMBOLS = ['DOLFUT', 'DOLN26', 'DOLQ26', 'DOLV26', 'DOL'];

class ProfitClient {
  constructor(bus) {
    this.bus        = bus;
    this.ws         = null;
    this.reconnects = 0;
    this.authed     = false;

    // Book acumulado por símbolo (price*100 → entry)
    this.bookWDO = { bids: {}, asks: {} };
    this.bookDOL = { bids: {}, asks: {} };

    // Último tick por símbolo
    this.lastWDO = {};
    this.lastDOL = {};

    // Preço teórico por símbolo
    this.theorWDO = { price: 0, qty: 0 };
    this.theorDOL = { price: 0, qty: 0 };

    // Estado de leilão
    this.auctionActive = {};
  }

  start() {
    this._connect();
  }

  // ── Conexão WebSocket ──────────────────────────────────────────────────────
  _connect() {
    console.log(`[PROFIT-CLIENT] Conectando ao ProfitBridge: ${PROFIT_BRIDGE_URL}`);
    this.ws = new WebSocket(PROFIT_BRIDGE_URL);

    this.ws.on('open', () => {
      this.reconnects = 0;
      console.log('[PROFIT-CLIENT] ✅ Conectado ao ProfitBridge');
      this.bus.emit('cedro:connected');
    });

    this.ws.on('message', (data) => {
      try {
        const msg = JSON.parse(data);
        if (Array.isArray(msg)) {
          msg.forEach(m => this._handleMessage(m));
        } else {
          this._handleMessage(msg);
        }
        this.bus.emit('cedro:syn', { timestamp: Date.now() });
      } catch (e) {
        console.warn('[PROFIT-CLIENT] Erro parse:', e.message);
      }
    });

    this.ws.on('close', () => {
      this.authed = false;
      console.warn('[PROFIT-CLIENT] Desconectado — reconectando...');
      this._scheduleReconnect();
    });

    this.ws.on('error', (e) => {
      console.warn('[PROFIT-CLIENT] WS erro:', e.message);
    });
  }

  _scheduleReconnect() {
    if (this.reconnects >= MAX_RECONNECTS) return;
    const delay = Math.min(RECONNECT_BASE_MS * Math.pow(2, this.reconnects), RECONNECT_MAX_MS);
    this.reconnects++;
    setTimeout(() => this._connect(), delay);
  }

  disconnect() {
    if (this.ws) {
      this.ws.removeAllListeners();
      this.ws.close();
      this.ws = null;
    }
  }

  // ── Dispatcher ─────────────────────────────────────────────────────────────
  _handleMessage(msg) {
    if (!msg || !msg.type) return;

    switch (msg.type) {

      case 'snapshot':
        // Estado inicial ao conectar
        if (msg.auction_active) this.auctionActive = { ...msg.auction_active };
        this.authed = true;
        console.log('[PROFIT-CLIENT] Snapshot recebido — market_data:', msg.connection?.market_data);
        break;

      case 'connection_state':
        console.log(`[PROFIT-CLIENT] DLL state [${msg.conn_type}] → ${msg.result}`);
        if (msg.conn_type === 'MARKET_DATA' && msg.result === 'CONNECTED') {
          this.bus.emit('cedro:connected');
        }
        break;

      // ── Trade / Tape reading ──────────────────────────────────────────────
      case 'trade':
        this._onTrade(msg);
        break;

      // ── Preço Teórico (durante leilão) ───────────────────────────────────
      case 'theoretical_price':
        this._onTheoreticalPrice(msg);
        break;

      // ── Estado do ticker (leilão/aberto/fechado) ─────────────────────────
      case 'ticker_state':
        this._onTickerState(msg);
        break;

      // ── Offer Book L2 ────────────────────────────────────────────────────
      case 'offer_book':
        this._onOfferBook(msg);
        break;

      // ── Topo do livro (bid/ask rápido) ───────────────────────────────────
      case 'tiny_book':
        this._onTinyBook(msg);
        break;

      // ── Dados diários ─────────────────────────────────────────────────────
      case 'daily':
        this._onDaily(msg);
        break;

      case 'pong':
        break;

      default:
        break;
    }
  }

  // ── Trade ─────────────────────────────────────────────────────────────────
  _onTrade(msg) {
    const sym   = msg.ticker || '';
    const isWDO = WDO_SYMBOLS.some(s => sym.includes(s));
    const isDOL = DOL_SYMBOLS.some(s => sym.includes(s));
    if (!isWDO && !isDOL) return;

    // aggressor: 'BUY' | 'SELL' | 'AUCTION' | null
    const agressor = msg.aggressor === 'BUY'  ? 'buy'  :
                     msg.aggressor === 'SELL' ? 'sell' : 'balanced';

    const tick = {
      symbol:    sym,
      timestamp: msg.timestamp || Date.now(),
      last:      msg.price     || 0,
      bid:       isWDO ? (this.lastWDO.bid || 0) : (this.lastDOL.bid || 0),
      ask:       isWDO ? (this.lastWDO.ask || 0) : (this.lastDOL.ask || 0),
      trade_vol: msg.quantity  || 0,
      auc_vol:   0,
      theor_price:  isWDO ? this.theorWDO.price : this.theorDOL.price,
      theor_qty:    isWDO ? this.theorWDO.qty   : this.theorDOL.qty,
      surplus:      0,
      surplus_side: null,
      buy_agent:    msg.buy_agent  || 0,
      sell_agent:   msg.sell_agent || 0,
      in_auction:   this.auctionActive[sym] || false,
    };

    if (isWDO) {
      this.lastWDO = { ...this.lastWDO, ...tick };
      this.bus.emit('cedro:tick:wdo', { ...this.lastWDO });
      this.bus.emit('cedro:trade:wdo', { symbol: sym, price: tick.last, qty: tick.trade_vol, agressor, timestamp: tick.timestamp });
    } else {
      this.lastDOL = { ...this.lastDOL, ...tick };
      this.bus.emit('cedro:tick:dol', { ...this.lastDOL });
      this.bus.emit('cedro:trade:dol', { symbol: sym, price: tick.last, qty: tick.trade_vol, agressor, timestamp: tick.timestamp });
    }
  }

  // ── Preço Teórico ─────────────────────────────────────────────────────────
  _onTheoreticalPrice(msg) {
    const sym   = msg.ticker || '';
    const isWDO = WDO_SYMBOLS.some(s => sym.includes(s));
    const isDOL = DOL_SYMBOLS.some(s => sym.includes(s));
    if (!isWDO && !isDOL) return;

    const price = msg.theoretical_price;
    const qty   = msg.theoretical_qty || 0;

    // -Infinity = sem preço teórico ainda (leilão não formado)
    if (!isFinite(price) || price <= 0) return;

    if (isWDO) {
      this.theorWDO = { price, qty };
      this.lastWDO  = { ...this.lastWDO, theor_price: price, theor_qty: qty, in_auction: true };
      this.bus.emit('cedro:tick:wdo', { ...this.lastWDO });
    } else {
      this.theorDOL = { price, qty };
      this.lastDOL  = { ...this.lastDOL, theor_price: price, theor_qty: qty, in_auction: true };
      this.bus.emit('cedro:tick:dol', { ...this.lastDOL });
    }
  }

  // ── Estado do Ticker ──────────────────────────────────────────────────────
  _onTickerState(msg) {
    const sym = msg.ticker || '';
    this.auctionActive[sym] = msg.in_auction || false;

    if (msg.in_auction) {
      console.log(`[PROFIT-CLIENT] 🔔 LEILÃO ATIVO: ${sym}`);
    } else {
      console.log(`[PROFIT-CLIENT] [${sym}] estado: ${msg.state}`);
    }

    this.bus.emit('cedro:ticker_state', {
      symbol:    sym,
      state:     msg.state,
      in_auction: msg.in_auction,
      timestamp: msg.timestamp,
    });
  }

  // ── Offer Book L2 ─────────────────────────────────────────────────────────
  _onOfferBook(msg) {
    const sym   = msg.ticker || '';
    const isWDO = WDO_SYMBOLS.some(s => sym.includes(s));
    const isDOL = DOL_SYMBOLS.some(s => sym.includes(s));
    if (!isWDO && !isDOL) return;

    const book  = isWDO ? this.bookWDO : this.bookDOL;
    const price = msg.price;
    const qty   = msg.quantity || 0;
    const side  = msg.side; // 'BUY' | 'SELL'
    const action= msg.action; // 'ADD' | 'EDIT' | 'DELETE' | 'DELETE_FROM' | 'FULL_BOOK'

    if (action === 'FULL_BOOK') {
      // Reset do book
      book.bids = {};
      book.asks = {};
      return;
    }

    if (price == null) return;
    const key = Math.round(price * 100);

    if (action === 'DELETE' || qty === 0) {
      if (side === 'BUY')  delete book.bids[key];
      else                 delete book.asks[key];
    } else {
      const entry = { price, qty, agent: msg.agent || 0 };
      if (side === 'BUY')  book.bids[key] = entry;
      else                 book.asks[key] = entry;
    }

    this._emitBook(sym, book, isWDO);
  }

  // ── Tiny Book ─────────────────────────────────────────────────────────────
  _onTinyBook(msg) {
    const sym   = msg.ticker || '';
    const isWDO = WDO_SYMBOLS.some(s => sym.includes(s));
    const isDOL = DOL_SYMBOLS.some(s => sym.includes(s));
    if (!isWDO && !isDOL) return;

    const isBid = msg.side === 'BUY';
    if (isWDO) {
      if (isBid) this.lastWDO.bid = msg.price;
      else       this.lastWDO.ask = msg.price;
    } else {
      if (isBid) this.lastDOL.bid = msg.price;
      else       this.lastDOL.ask = msg.price;
    }
  }

  // ── Daily ─────────────────────────────────────────────────────────────────
  _onDaily(msg) {
    const sym   = msg.ticker || '';
    const isWDO = WDO_SYMBOLS.some(s => sym.includes(s));
    if (!isWDO) return;

    this.lastWDO.auc_vol = msg.qty     || 0;
    this.lastWDO.open    = msg.open    || 0;
    this.lastWDO.high    = msg.high    || 0;
    this.lastWDO.low     = msg.low     || 0;
  }

  // ── Emit Book ─────────────────────────────────────────────────────────────
  _emitBook(symbol, book, isWDO) {
    const bids = Object.values(book.bids).sort((a, b) => b.price - a.price).slice(0, 20);
    const asks = Object.values(book.asks).sort((a, b) => a.price - b.price).slice(0, 20);
    const bookMsg = { symbol, bids, asks, timestamp: Date.now() };

    if (isWDO) this.bus.emit('cedro:book:wdo', bookMsg);
    else       this.bus.emit('cedro:book:dol', bookMsg);
  }
}

module.exports = { ProfitClient };
