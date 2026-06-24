/**
 * DataNormalizer — suporta WDO e DOL
 */
const { Logger } = require('../utils/logger');

class DataNormalizer {
  constructor(bus) {
    this.bus       = bus;
    this.log       = new Logger('NORMALIZER');
    this.lastTicks = {};   // por símbolo
    this.tickCount  = 0;
  }

  process(raw) {
    try {
      const sym = raw.symbol || 'WDON26'; // fallback para contrato fixo
      // Cedro manda ticks parciais — merge com último tick válido
      const prev = this.lastTicks[sym] || {};
      const merged = {
        ...prev,
        ...raw,
        last: raw.last || prev.last || 0,
        bid:  raw.bid  || prev.bid  || 0,
        ask:  raw.ask  || prev.ask  || 0,
      };
      const tick = this._validateTick(merged);
      if (!tick) return;
      this.lastTicks[sym] = tick;
      this.tickCount++;
      this.bus.emit('normalized:tick', tick);
    } catch (e) {
      this.log.error('Tick error:', e.message);
    }
  }

  processTrade(raw) {
    try {
      if (!raw || !raw.price || !raw.qty) return;
      this.bus.emit('normalized:trade', {
        symbol:    raw.symbol,
        timestamp: raw.timestamp || Date.now(),
        price:     raw.price,
        qty:       raw.qty,
        side:      raw.side,
        agressor:  raw.agressor,
        hora:      raw.hora,
      });
    } catch (e) {
      this.log.error('Trade error:', e.message);
    }
  }

  processBook(raw) {
    try {
      const book = this._validateBook(raw);
      if (!book) return;
      this.bus.emit('normalized:book', book);
      this.bus.emit('book:update', book); // FIX: server.js escuta book:update para broadcast ao frontend
    } catch (e) {
      this.log.error('Book error:', e.message);
    }
  }

  _validateTick(raw) {
    if (!raw || !raw.bid || !raw.ask || !raw.last) return null;
    if (raw.bid > raw.ask) return null;
    return {
      symbol:      raw.symbol    || 'WDOFUT',  // preserva símbolo real (WDON26, DOLQ26)
      timestamp:   raw.timestamp || Date.now(),
      phase:       (() => {
        const p = raw.phase;
        if (p === 'P' || p === 'pre_open') return 'pre_open';
        if (p === 'A' || p === 'auction')  return 'auction';
        return 'continuous';
      })(),
      phaseChange: raw.phaseChange || null,
      bid:         Math.round(raw.bid  * 100) / 100,
      ask:         Math.round(raw.ask  * 100) / 100,
      last:        Math.round(raw.last * 100) / 100,
      spread:      Math.round((raw.ask - raw.bid) * 100) / 100,
      mid:         Math.round(((raw.bid + raw.ask) / 2) * 100) / 100,
      bid_vol:     raw.bid_vol   || 0,
      ask_vol:     raw.ask_vol   || 0,
      trade_vol:   raw.trade_vol || 0,
      cum_vol:     raw.cum_vol   || 0,
      source:      raw.source    || 'unknown',
      // Leilão
      theor_price: raw.theor_price || 0,
      theor_qty:   raw.theor_qty   || 0,
      surplus:     raw.surplus     || 0,
      surplus_side: raw.surplus_side || null,
      auc_vol:     raw.auc_vol     || 0,
      prev_close:  raw.prev_close  || 0,
    };
  }

  _validateBook(raw) {
    if (!raw || !Array.isArray(raw.bids) || !Array.isArray(raw.asks)) return null;
    const bids = raw.bids.filter(b => b.price > 0 && b.qty > 0).sort((a,b) => b.price - a.price);
    const asks = raw.asks.filter(a => a.price > 0 && a.qty > 0).sort((a,b) => a.price - b.price);
    const bidVol = bids.reduce((s,b) => s+b.qty, 0);
    const askVol = asks.reduce((s,a) => s+a.qty, 0);
    return {
      symbol:        raw.symbol    || 'WDOFUT',
      timestamp:     raw.timestamp || Date.now(),
      phase:         (() => {
        const p = raw.phase;
        if (p === 'P' || p === 'pre_open') return 'pre_open';
        if (p === 'A' || p === 'auction')  return 'auction';
        return 'continuous';
      })(),
      bids, asks,
      bid_vol_total: bidVol,
      ask_vol_total: askVol,
      imbalance:     bidVol + askVol > 0 ? Math.round((bidVol - askVol) / (bidVol + askVol) * 1000) / 1000 : 0,
      best_bid:      bids[0]?.price || 0,
      best_ask:      asks[0]?.price || 0,
      source:        raw.source    || 'unknown',
    };
  }
}

module.exports = { DataNormalizer };
