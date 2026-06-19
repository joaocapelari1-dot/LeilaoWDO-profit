/**
 * MockDataGenerator
 * Simula WDO (Mini Dólar) + DOL (Dólar Cheio) em paralelo.
 * DOL = WDO * 10 em valor de contrato, tick = 0.5 também.
 * Leilões abrem juntos — permite testar confluência.
 */
const { Logger } = require('../utils/logger');

const TICK_INTERVAL_MS = 250;
const BOOK_INTERVAL_MS = 500;
const BASE_PRICE_WDO   = 5150;
const BASE_PRICE_DOL   = 5150;  // mesmo patamar, spreads diferentes
const TICK_SIZE        = 0.5;

class MockDataGenerator {
  constructor(bus) {
    this.bus    = bus;
    this.log    = new Logger('MOCK-GEN');
    this.timers = [];
    this.phase  = 'pre_open';

    // WDO state
    this.wdo = { price: BASE_PRICE_WDO, volume: 0 };
    // DOL state — lidera levemente o WDO
    this.dol = { price: BASE_PRICE_DOL, volume: 0 };

    this._regime        = 'ranging';
    this._regimeCounter = 0;
  }

  async start() {
    this.log.info('Mock generator started — WDO + DOL simulados');
    this._scheduleAuctionLifecycle();
    this._startTickStream();
    this._startBookStream();
  }

  async stop() {
    this.timers.forEach(t => { clearInterval(t); clearTimeout(t); });
    this.log.info('Mock encerrado');
  }

  _scheduleAuctionLifecycle() {
    const schedule = [
      { delay: 2000,  phase: 'pre_open' },
      { delay: 8000,  phase: 'auction' },
      { delay: 20000, phase: 'continuous' },
      { delay: 50000, phase: 'closing' },
    ];
    schedule.forEach(({ delay, phase }) => {
      const t = setTimeout(() => {
        this.phase = phase;
        this.log.info(`📊 Fase: ${phase}`);
        // Emite para ambos os símbolos
        this.bus.emit('raw:tick', this._buildTick('WDOFUT', this.wdo, { phaseChange: phase }));
        this.bus.emit('raw:tick', this._buildTick('DOLFUT', this.dol, { phaseChange: phase }));
      }, delay);
      this.timers.push(t);
    });
  }

  _startTickStream() {
    const t = setInterval(() => {
      // DOL lidera — move primeiro
      this._moveDOL();
      // WDO segue com pequena correlação
      this._moveWDO();

      this.bus.emit('raw:tick', this._buildTick('WDOFUT', this.wdo));
      this.bus.emit('raw:tick', this._buildTick('DOLFUT', this.dol));
    }, TICK_INTERVAL_MS);
    this.timers.push(t);
  }

  _startBookStream() {
    const t = setInterval(() => {
      this.bus.emit('raw:book', this._buildBook('WDOFUT', this.wdo.price));
      this.bus.emit('raw:book', this._buildBook('DOLFUT', this.dol.price));
    }, BOOK_INTERVAL_MS);
    this.timers.push(t);
  }

  _moveDOL() {
    const regime = this._detectRegime();
    const drift  = regime === 'trending_up' ? 0.4 : regime === 'trending_down' ? -0.4 : 0;
    const noise  = (Math.random() - 0.5) * 3;
    this.dol.price = Math.round((this.dol.price + drift + noise) / TICK_SIZE) * TICK_SIZE;
    this.dol.volume += Math.floor(Math.random() * 20) + 1;
  }

  _moveWDO() {
    // WDO segue DOL com 80% correlação + 20% ruído próprio
    const dolMove  = this.dol.price - BASE_PRICE_DOL;
    const corr     = dolMove * 0.8;
    const noise    = (Math.random() - 0.5) * 1.5;
    this.wdo.price = Math.round((BASE_PRICE_WDO + corr + noise) / TICK_SIZE) * TICK_SIZE;
    const tradeVol = this.phase === 'auction'
      ? Math.floor(Math.random() * 500) + 100
      : Math.floor(Math.random() * 50) + 1;
    this.wdo.volume += tradeVol;
  }

  _buildTick(symbol, state, extras = {}) {
    const spread = TICK_SIZE * (symbol === 'DOLFUT' ? 2 : 1);
    const bid    = state.price - spread / 2;
    const ask    = state.price + spread / 2;
    const vol    = this.phase === 'auction'
      ? Math.floor(Math.random() * (symbol === 'DOLFUT' ? 50 : 500)) + 10
      : Math.floor(Math.random() * (symbol === 'DOLFUT' ? 10 : 50)) + 1;

    return {
      source:    'mock',
      symbol,
      timestamp: Date.now(),
      phase:     this.phase,
      bid, ask,
      last:      state.price,
      bid_vol:   Math.floor(Math.random() * 50) + 5,
      ask_vol:   Math.floor(Math.random() * 50) + 5,
      trade_vol: vol,
      cum_vol:   state.volume,
      ...extras,
    };
  }

  _buildBook(symbol, price) {
    const levels = 5;
    const bids = [], asks = [];
    // DOL tem lotes maiores (contrato cheio)
    const lotMultiplier = symbol === 'DOLFUT' ? 0.1 : 1;
    const imbalFactor   = this.phase === 'auction'
      ? (Math.random() > 0.5 ? 2.5 : 0.4)
      : 1.0;

    for (let i = 0; i < levels; i++) {
      const base = Math.floor(Math.random() * 200 * lotMultiplier) + 20;
      bids.push({ price: price - (i+1)*TICK_SIZE, qty: Math.floor(base * imbalFactor), orders: Math.floor(Math.random()*5)+1 });
      asks.push({ price: price + (i+1)*TICK_SIZE, qty: Math.floor(base / imbalFactor), orders: Math.floor(Math.random()*5)+1 });
    }

    const bidVol = bids.reduce((s,b) => s+b.qty, 0);
    const askVol = asks.reduce((s,a) => s+a.qty, 0);

    return {
      source: 'mock', symbol, timestamp: Date.now(), phase: this.phase,
      bids, asks,
      imbalance: (bidVol - askVol) / (bidVol + askVol),
    };
  }

  _detectRegime() {
    this._regimeCounter++;
    if (this._regimeCounter > 40) {
      this._regimeCounter = 0;
      const r = Math.random();
      this._regime = r < 0.33 ? 'trending_up' : r < 0.66 ? 'trending_down' : 'ranging';
    }
    return this._regime;
  }
}

module.exports = { MockDataGenerator };
