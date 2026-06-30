/**
 * MarketDataIntegrityLayer (MDIL) + MarketQualityEngine (MQE)
 * Detecta GHOST FEED vs REAL FEED e calcula MQS 0-100
 */

const { Logger } = require('../utils/logger');

const GHOST_THRESHOLD    = 7;
const OFFER_BOOK_TIMEOUT = 3000;
const TRADE_TIMEOUT      = 5000;
const TINY_ONLY_TIMEOUT  = 5000;
const MIN_BOOK_DEPTH     = 2;
const MQS_HEALTHY        = 85;
const MQS_DEGRADED       = 60;

class MarketDataIntegrityLayer {
  constructor(bus) {
    this.bus   = bus;
    this.log   = new Logger('MDIL');
    this._state = {};
    this._watchdogTimer = null;
    this._started = false;
  }

  start() {
    if (this._started) return;
    this._started = true;
    this._watchdogTimer = setInterval(() => this._watchdog(), 1000);
    this.log.info('MDIL + MQE iniciado — watchdog 1s ativo');
  }

  stop() {
    if (this._watchdogTimer) clearInterval(this._watchdogTimer);
    this._started = false;
  }

  onOfferBook(sym, depth) {
    const s = this._getState(sym);
    s.lastOfferBook  = Date.now();
    s.offerBookDepth = depth;
    s.hasRealBook    = depth >= MIN_BOOK_DEPTH;
    s.tinyOnlyStart  = null;
    if (!s.realFeedConfirmed && s.hasRealBook) {
      s.realFeedConfirmed = true;
      this.log.info(`[MDIL] REAL FEED CONFIRMED — ${sym} (depth=${depth})`);
      if (this.bus) this.bus.emit('mdil:real_feed', { sym });
    }
  }

  onTrade(sym) {
    const s = this._getState(sym);
    s.lastTrade = Date.now();
  }

  onTinyBook(sym) {
    const s = this._getState(sym);
    s.lastTiny = Date.now();
    if (!s.tinyOnlyStart) s.tinyOnlyStart = Date.now();
  }

  getFeedStatus(sym) {
    const s = this._state[sym];
    if (!s) return { valid: false, mqs: 0, ghost: true, reason: 'sem dados' };
    return {
      valid:      s.mqs >= MQS_DEGRADED && s.ghostScore < GHOST_THRESHOLD,
      mqs:        s.mqs,
      ghost:      s.ghostScore >= GHOST_THRESHOLD,
      ghostScore: s.ghostScore,
      source:     s.hasRealBook ? 'offer_book' : 'tiny_book',
      synthetic:  !s.hasRealBook,
    };
  }

  getAllStatus() {
    return Object.fromEntries(
      Object.entries(this._state).map(([sym, s]) => [sym, this.getFeedStatus(sym)])
    );
  }

  _watchdog() {
    const now = Date.now();
    for (const [sym, s] of Object.entries(this._state)) {
      this._updateGhostScore(sym, s, now);
      this._updateMQS(sym, s, now);
      this._emitStatus(sym, s);
    }
  }

  _updateGhostScore(sym, s, now) {
    let score = 0;
    if (!s.lastOfferBook || (now - s.lastOfferBook) > OFFER_BOOK_TIMEOUT) score += 3;
    if (s.lastTrade && (now - s.lastTrade) > TRADE_TIMEOUT) score += 3;
    if (s.tinyOnlyStart && !s.hasRealBook && (now - s.tinyOnlyStart) > TINY_ONLY_TIMEOUT) score += 5;
    if (s.offerBookDepth !== undefined && s.offerBookDepth < MIN_BOOK_DEPTH) score += 2;

    const wasGhost = s.ghostScore >= GHOST_THRESHOLD;
    s.ghostScore = score;
    const isGhost = score >= GHOST_THRESHOLD;

    // So emite ghost_feed UMA VEZ por sessao por simbolo (evita spam de Telegram).
    // Sem PriceDepth/OfferBook real, o sistema permanece em modo TinyBook
    // indefinidamente — isso e esperado, nao um problema transitorio a cada minuto.
    if (isGhost && !wasGhost && !s.ghostAlertSent) {
      s.ghostAlertSent = true;
      this.log.warn(`[MDIL] GHOST FEED DETECTED — ${sym} (score=${score}) — TinyBook ativo, alerta unico`);
      if (this.bus) this.bus.emit('mdil:ghost_feed', { sym, score });
    } else if (!isGhost && wasGhost) {
      s.ghostAlertSent = false;
      this.log.info(`[MDIL] FEED RECOVERED — ${sym}`);
      if (this.bus) this.bus.emit('mdil:feed_recovered', { sym });
    }
  }

  _updateMQS(sym, s, now) {
    let mqs = 100;
    if (!s.hasRealBook) mqs -= 40;
    else if (s.lastOfferBook && (now - s.lastOfferBook) > 2000) mqs -= 20;
    if (!s.lastTrade) mqs -= 15;
    else if ((now - s.lastTrade) > TRADE_TIMEOUT) mqs -= 25;
    mqs -= s.ghostScore * 3;
    if (s.lastOfferBook && (now - s.lastOfferBook) > 10000) mqs -= 20;
    s.mqs = Math.max(0, Math.min(100, mqs));

    if (s.mqs >= MQS_HEALTHY && s.mqsState !== 'HEALTHY') {
      s.mqsState = 'HEALTHY';
      this.log.info(`[MQE] ${sym} HEALTHY (MQS=${s.mqs})`);
    } else if (s.mqs >= MQS_DEGRADED && s.mqs < MQS_HEALTHY && s.mqsState !== 'DEGRADED') {
      s.mqsState = 'DEGRADED';
      this.log.warn(`[MQE] ${sym} DEGRADED (MQS=${s.mqs})`);
    } else if (s.mqs < MQS_DEGRADED && s.mqsState !== 'INVALID') {
      s.mqsState = 'INVALID';
      this.log.warn(`[MQE] FEED INVALID — ${sym} (MQS=${s.mqs})`);
      if (this.bus) this.bus.emit('mdil:feed_invalid', { sym, mqs: s.mqs });
    }
  }

  _emitStatus(sym, s) {
    if (!s._lastStatusEmit || (Date.now() - s._lastStatusEmit) > 10000) {
      s._lastStatusEmit = Date.now();
      if (this.bus) this.bus.emit('mdil:status', {
        sym, mqs: s.mqs, mqsState: s.mqsState,
        ghost: s.ghostScore >= GHOST_THRESHOLD, ghostScore: s.ghostScore,
        source: s.hasRealBook ? 'offer_book' : 'tiny_book',
        synthetic: !s.hasRealBook,
      });
    }
  }

  _getState(sym) {
    if (!this._state[sym]) {
      this._state[sym] = {
        lastOfferBook: null, lastTrade: null, lastTiny: null,
        tinyOnlyStart: Date.now(), offerBookDepth: 0,
        hasRealBook: false, realFeedConfirmed: false,
        ghostScore: 10, mqs: 0, mqsState: 'INVALID', _lastStatusEmit: null,
      };
    }
    return this._state[sym];
  }
}

module.exports = { MarketDataIntegrityLayer };
