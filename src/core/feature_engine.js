/**
 * FeatureEngine — processa WDO e DOL separadamente
 * Calcula confluência DOL x WDO para o Risk Engine
 */
const { Logger } = require('../utils/logger');

const WINDOW_TICKS     = 20;
const ICEBERG_THRESHOLD = 3;

class SymbolState {
  constructor() {
    this.ticks        = [];
    this.lastBook     = null;
    this.flowDelta    = 0;
    this.buyVol       = 0;
    this.sellVol      = 0;
    this.vwapNum      = 0;
    this.vwapDen      = 0;
    this.auctionData  = { theoreticalPrice: null, surplus: 0, side: null, volumeAtAuction: 0 };
    this.icebergTracker    = {};
    this.prevBookSnapshot  = {};
  }
}

class FeatureEngine {
  constructor(bus) {
    this.bus         = bus;
    this.tradeHistory = []; // histórico do dia para o gráfico
    this.log    = new Logger('FEATURE-ENG');
    this.wdo    = new SymbolState();
    this.dol    = new SymbolState();
  }

  _getState(symbol) {
    // Aceita tanto símbolo genérico (DOLFUT) quanto real (DOLQ26, DOLM26, etc.)
    return (symbol === 'DOLFUT' || symbol?.startsWith('DOL')) ? this.dol : this.wdo;
  }

  onTick(tick) {
    const s = this._getState(tick.symbol);
    s.ticks.push(tick);
    if (s.ticks.length > WINDOW_TICKS) s.ticks.shift();
    this._classifyAggressor(s, tick);
    if (tick.trade_vol > 0) { s.vwapNum += tick.last * tick.trade_vol; s.vwapDen += tick.trade_vol; }
    if (tick.phase === 'auction' || tick.phase === 'pre_open') this._updateAuction(s, tick); // pre_open já tem theor_price e surplus

    const fv = this._buildFeatureVector(tick.symbol, s, tick);

    // Emite evento com símbolo
    this.bus.emit('feature:update', fv);
    if (tick.symbol === 'WDOFUT' || tick.symbol?.startsWith('WDO')) {
      // Confluência DOL x WDO só quando ambos têm dados
      if (this.dol.auctionData.theoreticalPrice) {
        fv.confluence = this._calcConfluence();
      }
      this.bus.emit('feature:wdo', fv);
    } else {
      this.bus.emit('feature:dol', fv);
    }
  }

  onBook(book) {
    const s = this._getState(book.symbol);
    s.lastBook = book;
    this._detectIcebergs(s, book);
    this.bus.emit('book:update', { ...book });
  }

  // ── Confluência DOL x WDO ────────────────────────────────────
  _calcConfluence() {
    const wdoSide = this.wdo.auctionData.side;
    const dolSide = this.dol.auctionData.side;
    const wdoSurplus = this.wdo.auctionData.surplus;
    const dolSurplus = this.dol.auctionData.surplus;

    const aligned = wdoSide && dolSide && wdoSide !== 'balanced' && dolSide !== 'balanced' && wdoSide === dolSide;
    const direction = aligned ? wdoSide : null;
    const strength  = aligned ? Math.min(Math.abs(wdoSurplus) + Math.abs(dolSurplus), 1000) : 0;

    return {
      aligned,
      direction,
      wdoSide,
      dolSide,
      wdoSurplus,
      dolSurplus,
      strength,
      label: aligned
        ? `DOL+WDO ${direction?.toUpperCase()} ✓`
        : `DOL ${dolSide || '?'} vs WDO ${wdoSide || '?'} ✗`,
    };
  }

  _classifyAggressor(s, tick) {
    if (!tick.trade_vol) return;
    if (tick.last >= tick.ask) { s.buyVol += tick.trade_vol; s.flowDelta += tick.trade_vol; }
    else if (tick.last <= tick.bid) { s.sellVol += tick.trade_vol; s.flowDelta -= tick.trade_vol; }
  }

  _updateAuction(s, tick) {
    s.auctionData.volumeAtAuction += tick.trade_vol || 0;
    if (s.lastBook) {
      const tp = this._calcTP(s.lastBook);
      s.auctionData.theoreticalPrice = tp;
      s.auctionData.surplus = this._calcSurplus(s.lastBook, tp);
      s.auctionData.side = s.auctionData.surplus > 200 ? 'buy' : s.auctionData.surplus < -200 ? 'sell' : 'balanced';
    }
  }

  _calcTP(book) {
    const prices = [...book.bids.map(b => b.price), ...book.asks.map(a => a.price)].sort((a,b) => a-b);
    let maxVol = 0, tp = book.bids[0]?.price || 0;
    for (const p of prices) {
      const bv = book.bids.filter(b => b.price >= p).reduce((s,b) => s+b.qty, 0);
      const av = book.asks.filter(a => a.price <= p).reduce((s,a) => s+a.qty, 0);
      const ev = Math.min(bv, av);
      if (ev > maxVol) { maxVol = ev; tp = p; }
    }
    return tp;
  }

  _calcSurplus(book, tp) {
    const bv = book.bids.filter(b => b.price >= tp).reduce((s,b) => s+b.qty, 0);
    const av = book.asks.filter(a => a.price <= tp).reduce((s,a) => s+a.qty, 0);
    return bv - av;
  }

  _detectIcebergs(s, book) {
    const all = [...book.bids.map(b => ({...b, side:'bid'})), ...book.asks.map(a => ({...a, side:'ask'}))];
    all.forEach(level => {
      const key  = `${level.side}_${level.price}`;
      const prev = s.prevBookSnapshot[key];
      if (prev && level.qty < prev.qty && level.qty > 50) {
        if (!s.icebergTracker[key]) s.icebergTracker[key] = { price: level.price, side: level.side, count: 0, totalVol: 0, lastQty: level.qty };
        s.icebergTracker[key].count++;
        s.icebergTracker[key].totalVol += (prev.qty - level.qty);
        s.icebergTracker[key].lastQty = level.qty;
        if (s.icebergTracker[key].count >= ICEBERG_THRESHOLD) this.bus.emit('iceberg:detected', s.icebergTracker[key]);
      }
      s.prevBookSnapshot[key] = { qty: level.qty };
    });
    const activeKeys = new Set(all.map(l => `${l.side}_${l.price}`));
    Object.keys(s.icebergTracker).forEach(k => { if (!activeKeys.has(k)) delete s.icebergTracker[k]; });
  }

  _buildFeatureVector(symbol, s, tick) {
    const vwap     = s.vwapDen > 0 ? s.vwapNum / s.vwapDen : tick.last;
    const total    = s.buyVol + s.sellVol;
    const aggRatio = total > 0 ? s.buyVol / total : 0.5;
    const prices   = s.ticks.map(t => t.last);
    const momentum = prices.length >= 2 ? prices[prices.length-1] - prices[0] : 0;
    const variance = prices.length >= 2 ? prices.reduce((a,b) => a + (b - vwap)**2, 0) / prices.length : 0;

    return {
      symbol,
      timestamp:    tick.timestamp,
      phase:        tick.phase,
      phaseChange:  tick.phaseChange || null,
      last:         tick.last,
      bid:          tick.bid,
      ask:          tick.ask,
      spread:       tick.spread,
      vwap:         Math.round(vwap * 100) / 100,
      priceVsVwap:  Math.round((tick.last - vwap) * 100) / 100,
      flowDelta:    s.flowDelta,
      buyVol:       s.buyVol,
      sellVol:      s.sellVol,
      aggRatio:     Math.round(aggRatio * 1000) / 1000,
      momentum:     Math.round(momentum * 100) / 100,
      volatility:   Math.round(Math.sqrt(variance) * 100) / 100,
      bookImbalance:   s.lastBook?.imbalance || 0,
      bidVolTotal:     s.lastBook?.bid_vol_total || 0,
      askVolTotal:     s.lastBook?.ask_vol_total || 0,
      bestBid:         s.lastBook?.best_bid || tick.bid,
      bestAsk:         s.lastBook?.best_ask || tick.ask,
      auction:         { ...s.auctionData },
      icebergs:        Object.values(s.icebergTracker).filter(i => i.count >= ICEBERG_THRESHOLD),
      book:            s.lastBook,
      cumVolume:       tick.cum_vol,
    };
  }

  getWDOSnapshot() { return this._buildFeatureVector('WDOFUT', this.wdo, this.wdo.ticks[this.wdo.ticks.length-1] || {}); }
  getDOLSnapshot() { return this._buildFeatureVector('DOLFUT', this.dol, this.dol.ticks[this.dol.ticks.length-1] || {}); }
  getConfluence()  { return this._calcConfluence(); }
}

module.exports = { FeatureEngine };
