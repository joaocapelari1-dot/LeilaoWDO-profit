/**
 * MarketDataIntegrityLayer (MDIL) + MarketQualityEngine (MQE)
 * 
 * Detecta se o feed é REAL ou GHOST e calcula qualidade (MQS 0-100).
 * 
 * GHOST FEED = conexão ativa mas sem dados reais (apenas TinyBook sintético)
 * REAL FEED  = OfferBook Level 2 + Trades contínuos
 */

const { Logger } = require('./utils/logger');

// ── Thresholds ────────────────────────────────────────────────────
const GHOST_THRESHOLD      = 7;    // ghostScore >= 7 → feed inválido
const OFFER_BOOK_TIMEOUT   = 3000; // ms sem OfferBook → +3 ghost
const TRADE_TIMEOUT        = 5000; // ms sem Trades → +3 ghost
const TINY_ONLY_TIMEOUT    = 5000; // ms só TinyBook → +5 ghost
const MIN_BOOK_DEPTH       = 2;    // níveis mínimos
const MQS_HEALTHY          = 85;
const MQS_DEGRADED         = 60;

class MarketDataIntegrityLayer {
  constructor(bus) {
    this.bus  = bus;
    this.log  = new Logger('MDIL');

    // Estado por símbolo
    this._state = {};

    // Watchdog
    this._watchdogTimer = null;
    this._started = false;
  }

  // ── API Pública ───────────────────────────────────────────────

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

  // Registrar recebimento de OfferBook real
  onOfferBook(sym, depth) {
    const s = this._getState(sym);
    s.lastOfferBook  = Date.now();
    s.offerBookDepth = depth;
    s.hasRealBook    = depth >= MIN_BOOK_DEPTH;
    s.tinyOnlyStart  = null; // reset — recebeu book real
    if (!s.realFeedConfirmed && s.hasRealBook) {
      s.realFeedConfirmed = true;
      this.log.info(`[MDIL] REAL FEED CONFIRMED — ${sym} (depth=${depth})`);
      this.bus.emit('mdil:real_feed', { sym });
    }
  }

  // Registrar recebimento de Trade real
  onTrade(sym) {
    const s = this._getState(sym);
    s.lastTrade = Date.now();
  }

  // Registrar TinyBook (sintético)
  onTinyBook(sym) {
    const s = this._getState(sym);
    s.lastTiny = Date.now();
    if (!s.tinyOnlyStart) s.tinyOnlyStart = Date.now();
  }

  // Estado atual do feed para um símbolo
  getFeedStatus(sym) {
    const s = this._state[sym];
    if (!s) return { valid: false, mqs: 0, ghost: true, reason: 'sem dados' };
    return {
      valid:    s.mqs >= MQS_DEGRADED && s.ghostScore < GHOST_THRESHOLD,
      mqs:      s.mqs,
      ghost:    s.ghostScore >= GHOST_THRESHOLD,
      ghostScore: s.ghostScore,
      source:   s.hasRealBook ? 'offer_book' : 'tiny_book',
      synthetic: !s.hasRealBook,
    };
  }

  getAllStatus() {
    return Object.fromEntries(
      Object.entries(this._state).map(([sym, s]) => [sym, this.getFeedStatus(sym)])
    );
  }

  // ── Watchdog 1s ───────────────────────────────────────────────

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

    // Sem OfferBook > 3s
    if (!s.lastOfferBook || (now - s.lastOfferBook) > OFFER_BOOK_TIMEOUT) score += 3;

    // Sem Trades > 5s (só penaliza em horário de mercado)
    if (s.lastTrade && (now - s.lastTrade) > TRADE_TIMEOUT) score += 3;

    // Apenas TinyBook por > 5s
    if (s.tinyOnlyStart && !s.hasRealBook && (now - s.tinyOnlyStart) > TINY_ONLY_TIMEOUT) score += 5;

    // Book com profundidade < 2
    if (s.offerBookDepth !== undefined && s.offerBookDepth < MIN_BOOK_DEPTH) score += 2;

    const wasGhost = s.ghostScore >= GHOST_THRESHOLD;
    s.ghostScore = score;
    const isGhost = score >= GHOST_THRESHOLD;

    if (isGhost && !wasGhost) {
      this.log.warn(`[MDIL] GHOST FEED DETECTED — ${sym} (score=${score})`);
      this.bus.emit('mdil:ghost_feed', { sym, score });
    } else if (!isGhost && wasGhost) {
      this.log.info(`[MDIL] FEED RECOVERED — ${sym} (score=${score})`);
      this.bus.emit('mdil:feed_recovered', { sym });
    }
  }

  _updateMQS(sym, s, now) {
    let mqs = 100;

    // Penalidade: sem OfferBook real
    if (!s.hasRealBook) mqs -= 40;
    else if (s.lastOfferBook && (now - s.lastOfferBook) > 2000) mqs -= 20;

    // Penalidade: sem trades
    if (!s.lastTrade) mqs -= 15;
    else if ((now - s.lastTrade) > TRADE_TIMEOUT) mqs -= 25;

    // Penalidade: ghost score
    mqs -= s.ghostScore * 3;

    // Penalidade: book congelado
    if (s.lastOfferBook && (now - s.lastOfferBook) > 10000) mqs -= 20;

    s.mqs = Math.max(0, Math.min(100, mqs));

    // Estado MQS
    if (s.mqs >= MQS_HEALTHY && s.mqsState !== 'HEALTHY') {
      s.mqsState = 'HEALTHY';
      this.log.info(`[MQE] ${sym} HEALTHY (MQS=${s.mqs})`);
    } else if (s.mqs >= MQS_DEGRADED && s.mqs < MQS_HEALTHY && s.mqsState !== 'DEGRADED') {
      s.mqsState = 'DEGRADED';
      this.log.warn(`[MQE] ${sym} DEGRADED (MQS=${s.mqs})`);
    } else if (s.mqs < MQS_DEGRADED && s.mqsState !== 'INVALID') {
      s.mqsState = 'INVALID';
      this.log.warn(`[MQE] FEED INVALID - LOW QUALITY — ${sym} (MQS=${s.mqs})`);
      this.bus.emit('mdil:feed_invalid', { sym, mqs: s.mqs });
    }
  }

  _emitStatus(sym, s) {
    // Emite status a cada 10s para o frontend
    if (!s._lastStatusEmit || (Date.now() - s._lastStatusEmit) > 10000) {
      s._lastStatusEmit = Date.now();
      this.bus.emit('mdil:status', {
        sym,
        mqs:       s.mqs,
        mqsState:  s.mqsState,
        ghost:     s.ghostScore >= GHOST_THRESHOLD,
        ghostScore: s.ghostScore,
        source:    s.hasRealBook ? 'offer_book' : 'tiny_book',
        synthetic: !s.hasRealBook,
      });
    }
  }

  _getState(sym) {
    if (!this._state[sym]) {
      this._state[sym] = {
        lastOfferBook:      null,
        lastTrade:          null,
        lastTiny:           null,
        tinyOnlyStart:      Date.now(), // assume sintético até provar real
        offerBookDepth:     0,
        hasRealBook:        false,
        realFeedConfirmed:  false,
        ghostScore:         10, // começa alto — só reduz com dados reais
        mqs:                0,
        mqsState:           'INVALID',
        _lastStatusEmit:    null,
      };
    }
    return this._state[sym];
  }
}

module.exports = { MarketDataIntegrityLayer };
