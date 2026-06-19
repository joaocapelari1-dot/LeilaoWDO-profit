const { MockDataGenerator } = require('./mock_data_generator');
const { LiveCedroClient }   = require('./live_cedro_client');
const { Logger } = require('../utils/logger');

class CedroAdapter {
  constructor(bus) {
    this.bus    = bus;
    this.log    = new Logger('CEDRO-ADAPTER');
    this.mode   = process.env.MOCK_MODE !== 'false' ? 'mock' : 'live';
    this.client = this.mode === 'mock'
      ? new MockDataGenerator(bus)
      : new LiveCedroClient(bus);
    this.liveClient = this.mode === 'live' ? this.client : null;

    if (this.mode === 'live') {
      this._bridgeLiveEvents();
    }
  }

  // Mapeia eventos Cedro → eventos internos do sistema
  _bridgeLiveEvents() {
    const bus = this.bus;

    // WDO Quote → tick normalizado
    bus.on('cedro:tick:wdo', (tick) => {
      bus.emit('raw:tick', {
        symbol:      'WDOFUT',
        last:        tick.last,
        bid:         tick.bid,
        ask:         tick.ask,
        trade_vol:   tick.trade_vol,
        auc_vol:     tick.auc_vol,
        theor_price: tick.theor_price,
        theor_qty:   tick.theor_qty,
        surplus:     tick.surplus,
        surplus_side: tick.surplus_side,
        phase:       tick.phase,
        status:      tick.status,
        prev_close:  tick.prev_close,
        open:        tick.open,
        high:        tick.high,
        low:         tick.low,
        timestamp:   tick.timestamp,
      });
    });

    // DOL Quote → tick DOL
    bus.on('cedro:tick:dol', (tick) => {
      bus.emit('raw:tick:dol', {
        symbol:      'DOLFUT',
        last:        tick.last,
        bid:         tick.bid,
        ask:         tick.ask,
        trade_vol:   tick.trade_vol,
        surplus:     tick.surplus,
        theor_price: tick.theor_price,
        timestamp:   tick.timestamp,
      });
    });

    // Books
    bus.on('cedro:book:wdo', (book) => {
      bus.emit('raw:book', { ...book, symbol: 'WDOFUT' });
    });

    bus.on('cedro:book:dol', (book) => {
      bus.emit('raw:book:dol', { ...book, symbol: 'DOLFUT' });
    });

    // Tape
    bus.on('cedro:trade:wdo', (trade) => {
      bus.emit('raw:trade', trade);
    });

    bus.on('cedro:trade:dol', (trade) => {
      bus.emit('raw:trade:dol', trade);
    });

    this.log.info('Bridge live events configurado');
  }

  async start() {
    this.log.info(`Iniciando em modo ${this.mode.toUpperCase()}`);
    await this.client.start();
  }

  async stop() {
    await this.client.stop();
  }

  getMode() { return this.mode; }
}

module.exports = { CedroAdapter };
