/**
 * AuctionStateMachine
 * Manages the WDO opening auction lifecycle.
 *
 * States:
 *   IDLE → PRE_OPEN → AUCTION → PRICE_DISCOVERY → SIGNAL_READY → CONTINUOUS → CLOSING → DONE
 *
 * Transitions are driven by phase changes in the feature vector.
 * When auction conditions are met, emits 'auction:signal' for risk evaluation.
 */
const { Logger } = require('../utils/logger');

const STATES = {
  IDLE:            'IDLE',
  PRE_OPEN:        'PRE_OPEN',
  AUCTION:         'AUCTION',
  PRICE_DISCOVERY: 'PRICE_DISCOVERY',
  SIGNAL_READY:    'SIGNAL_READY',
  CONTINUOUS:      'CONTINUOUS',
  CLOSING:         'CLOSING',
  DONE:            'DONE',
};

// Minimum auction volume before considering a signal
const MIN_AUCTION_VOLUME = parseInt(process.env.MIN_VOLUME_AUCTION || '100');

class AuctionStateMachine {
  constructor(bus) {
    this.bus      = bus;
    this.log      = new Logger('AUCTION-SM');
    this.history  = [];
    this.auctionFeatures = null;
    this.signalEmitted   = false;

    // Se iniciar após 9h05 e antes de 18h, vai direto para CONTINUOUS
    const now  = new Date();
    const brt  = new Date(now.getTime() - 3 * 60 * 60 * 1000);
    const mins = brt.getUTCHours() * 60 + brt.getUTCMinutes();
    if (mins >= (8 * 60 + 55) && mins < (18 * 60)) {
      this.state = STATES.CONTINUOUS;
      this.log.info('State machine initialized — state: CONTINUOUS (mercado aberto)');
    } else {
      this.state = STATES.IDLE;
      this.log.info('State machine initialized — state: IDLE');
    }
  }



  onFeature(features) {
    // AuctionSM: só para Dashboard, Telegram e AdaptiveLog
    // Claude analisa por horário independente — não precisa de estado

    // Declarar h,m uma vez para todo o método
    const _brt = new Date(Date.now() - 3 * 60 * 60 * 1000);
    const h = _brt.getUTCHours();
    const m = _brt.getUTCMinutes();

    // Filtro: só aceitar PRE_OPEN/AUCTION na janela 8h50-9h15 BRT
    // Evita leilões falsos pelo tick de boot da Cedro (phase=auction fora do horário)
    if (features.phase === 'pre_open' || features.phase === 'auction') {
      const naJanela = (h === 8 && m >= 50) || (h === 9 && m <= 15);
      if (!naJanela) return; // ignora tick de boot fora do horário
    }

    // Reset flags diário
    if (h === 9 && m >= 6) {
      this._loggedForcePreOpen = false;
      this._loggedForceAuction = false;
    }

    // Log de phase para diagnóstico
    if (features.phase === 'pre_open' || features.phase === 'auction') {
      console.log('[AUCTION-SM] onFeature phase=' + features.phase + ' state=' + this.state + ' ' + new Date().toISOString());
    this._checkAuctionTimeout();


    }
    const prevState = this.state;

    // ── Transition Logic ──────────────────────────────────────
    switch (this.state) {
      case STATES.IDLE:
      case STATES.CONTINUOUS:
        if (features.phase === 'pre_open') {
          this._transition(STATES.PRE_OPEN, features);
        } else if (features.phase === 'auction') {
          this._transition(STATES.AUCTION, features);
        } else if (features.phase === 'closing') {
          this._transition(STATES.CLOSING, features);
        }
        break;

      case STATES.PRE_OPEN:
        if (features.phase === 'auction') {
          this._transition(STATES.AUCTION, features);
        }
        break;

      case STATES.AUCTION:
        // Update auction snapshot
        this.auctionFeatures = features;

        // Enough auction volume to attempt price discovery?
        if (features.auction.volumeAtAuction >= MIN_AUCTION_VOLUME) {
          this._transition(STATES.PRICE_DISCOVERY, features);
        }
        break;

      case STATES.PRICE_DISCOVERY:
        this.auctionFeatures = features;

        // Emit signal if we have a clear directional read
        if (!this.signalEmitted && this._hasSignal(features)) {
          this._transition(STATES.SIGNAL_READY, features);
          this._emitSignal(features);
        }

        if (features.phase === 'continuous') {
          this._transition(STATES.CONTINUOUS, features);
        }
        break;

      case STATES.SIGNAL_READY:
        if (features.phase === 'continuous') {
          this._transition(STATES.CONTINUOUS, features);
        }
        break;



      case STATES.CLOSING:
        // End of session
        this._transition(STATES.DONE, features);
        break;

      case STATES.DONE:
        // No more transitions today
        break;
    }
  }

  // ── Signal Detection ─────────────────────────────────────────
  _hasSignal(features) {
    const { auction, flowDelta, bookImbalance, aggRatio } = features;

    // Need at least 3 confluent signals
    const signals = [];

    if (auction.theoreticalPrice !== null) {
      // 1. Auction has a clear surplus side
      if (Math.abs(auction.surplus) > 200) {
        signals.push({ name: 'auction_surplus', direction: auction.surplus > 0 ? 'buy' : 'sell', strength: 2 });
      }

      // 2. Book imbalance confirms direction
      if (Math.abs(bookImbalance) > 0.2) {
        signals.push({ name: 'book_imbalance', direction: bookImbalance > 0 ? 'buy' : 'sell', strength: 1 });
      }

      // 3. Aggressor flow direction
      if (aggRatio > 0.65) signals.push({ name: 'aggressor_flow', direction: 'buy',  strength: 2 });
      if (aggRatio < 0.35) signals.push({ name: 'aggressor_flow', direction: 'sell', strength: 2 });

      // 4. Flow delta direction
      if (Math.abs(flowDelta) > 500) {
        signals.push({ name: 'flow_delta', direction: flowDelta > 0 ? 'buy' : 'sell', strength: 1 });
      }
    }

    if (signals.length < 2) return false;

    // Check if all signals agree
    const directions = signals.map(s => s.direction);
    const allBuy  = directions.every(d => d === 'buy');
    const allSell = directions.every(d => d === 'sell');

    return allBuy || allSell;
  }

  _emitSignal(features) {
    const { auction, flowDelta, bookImbalance, aggRatio, last, vwap } = features;
    const direction = auction.surplus > 0 || flowDelta > 0 ? 'buy' : 'sell';

    const signal = {
      id:          `SIG-${Date.now()}`,
      timestamp:   Date.now(),
      source:      'auction_state_machine',
      state:       this.state,
      direction,
      price:       auction.theoreticalPrice || last,
      vwap,
      confluence:  {
        auctionSurplus:  auction.surplus,
        auctionSide:     auction.side,
        bookImbalance,
        aggRatio,
        flowDelta,
        volumeAtAuction: auction.volumeAtAuction,
      },
    };

    this.signalEmitted = true;
    this.log.info(`🎯 🎯 SINAL EMITIDO: ${direction.toUpperCase()} @ ${signal.price}`);
    this.log.info(`   Confluência: surplus=${auction.surplus} | imbalance=${bookImbalance} | aggRatio=${aggRatio}`);
    this.bus.emit('auction:signal', signal);
  }

  _checkAuctionTimeout() {
    if (this.state !== 'AUCTION') return;
    const brt = new Date(Date.now() - 3 * 60 * 60 * 1000);
    const h = brt.getUTCHours(); const m = brt.getUTCMinutes();
    const naJanela = (h === 8 && m >= 50) || (h === 9 && m <= 10);
    if (naJanela) return;
    const tempoEmAuction = Date.now() - (this._auctionStartTime || Date.now());
    if (tempoEmAuction > 10 * 60 * 1000) {
      console.log('[AUCTION-SM] ⏰ Timeout AUCTION >10min fora da janela → CONTINUOUS');
      this._auctionStartTime = null;
      this._transition(STATES.CONTINUOUS, { phase: 'continuous', _timeout: true });
    }
  }

  _transition(nextState, features) {
    if (nextState === STATES.AUCTION) this._auctionStartTime = Date.now();
    const entry = { from: this.state, to: nextState, timestamp: Date.now(), fase: features.phase };
    this.history.push(entry);
    this.log.info(`🔄 Estado: ${this.state} → ${nextState} (fase: ${features.phase})`);
    this.state = nextState;
    this.bus.emit('auction:state_change', entry);
  }

  getStatus() {
    return {
      state:           this.state,
      signalEmitted:   this.signalEmitted,
      history:         this.history,
      auctionFeatures: this.auctionFeatures,
    };
  }

  reset() {
    this.state          = STATES.IDLE;
    this.history        = [];
    this.auctionFeatures = null;
    this.signalEmitted  = false;
    this.log.info('Máquina de estados resetada para novo pregão');
  }
}

module.exports = { AuctionStateMachine, STATES };
