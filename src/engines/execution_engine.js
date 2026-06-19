/**
 * ExecutionEngine
 * PAPER MODE (default): simulates fills, P&L, position tracking.
 * LIVE MODE: placeholder for broker integration (XP, Rico, etc.)
 *
 * Paper mode fills at signal price with simulated slippage.
 */
const { Logger } = require('../utils/logger');

const CONTRACT_SIZE_USD = 10000;   // WDO = USD 10k per contract
const TICK_SIZE         = 0.5;
const TICK_VALUE_BRL    = 10;      // R$10 per tick per contract

class ExecutionEngine {
  constructor(bus) {
    this.bus       = bus;
    this.log       = new Logger('EXECUTION');
    this.paperMode = process.env.PAPER_MODE !== 'false';

    // Paper state
    this.balance   = parseFloat(process.env.PAPER_INITIAL_BALANCE || '50000');
    this.positions = [];
    this.trades    = [];

    this.log.info(`Motor de execução: ${this.paperMode ? '📄 PAPER' : '🔴 LIVE'} mode`);

    // Atualiza lastPrice das posições abertas a cada tick
    bus.on('normalized:tick', (tick) => {
      if (!tick.last) return;
      this.positions.filter(p => p.status === 'open').forEach(p => { p.lastPrice = tick.last; });
    });
    if (!this.paperMode) {
      this.log.warn('⚠️  LIVE EXECUTION MODE — real orders will be sent');
    }
  }

  execute(order) {
    if (this.paperMode) {
      return this._paperExecute(order);
    }
    return this._liveExecute(order);
  }

  // ── Paper Execution ─────────────────────────────────────────
  _paperExecute(order) {
    // Simulate slippage: 1 tick adverse
    const slippage    = TICK_SIZE;
    const fillPrice   = order.direction === 'buy'
      ? order.entry + slippage
      : order.entry - slippage;

    const position = {
      id:           `POS-${Date.now()}`,
      signalId:     order.id,
      direction:    order.direction,
      contracts:    order.contracts,
      entryPrice:   fillPrice,
      stopPrice:    order.stopPrice,
      targetPrice:  order.targetPrice,
      riskBrl:      order.riskBrl,
      rewardBrl:    order.rewardBrl,
      openedAt:     Date.now(),
      status:       'open',
      pnl:          0,
    };

    this.positions.push(position);
    this.log.info(`📄 📄 EXECUÇÃO PAPER: ${order.direction.toUpperCase()} ${order.contracts}x @ ${fillPrice} | Stop: ${order.stopPrice} | Target: ${order.targetPrice}`);

    this.bus.emit('execution:fill', {
      ...position,
      fillPrice,
      paperMode: true,
    });

    // Broadcast to frontend
    this.bus.emit('ws:broadcast', { type: 'execution_fill', data: position });

    // Monitorar stop/alvo com preço real da Cedro
    this._monitorPosition(position);

    return position;
  }

  _monitorPosition(position) {
    // Monitora preço real da Cedro via normalized:tick
    const handler = (tick) => {
      const pos = this.positions.find(p => p.id === position.id && p.status === 'open');
      if (!pos) { this.bus.off('normalized:tick', handler); return; }

      // Usa apenas ticks do WDO
      if (tick.symbol && !tick.symbol.includes('WDO') && !tick.symbol.includes('WDOF')) return;

      const price = tick.last || tick.bid || 0;
      if (!price) return;

      const isBuy = pos.direction === 'buy';

      // Verifica stop
      const hitStop   = isBuy ? price <= pos.stopPrice   : price >= pos.stopPrice;
      // Verifica alvo
      const hitTarget = isBuy ? price >= pos.targetPrice : price <= pos.targetPrice;

      if (hitTarget) {
        this.bus.off('normalized:tick', handler);
        this._closePosition(pos.id, pos.targetPrice, 'alvo_atingido');
        return;
      }
      if (hitStop) {
        this.bus.off('normalized:tick', handler);
        this._closePosition(pos.id, pos.stopPrice, 'stop_atingido');
        return;
      }
    };

    this.bus.on('normalized:tick', handler);

    // Encerramento forçado às 9h10 BRT se ainda aberta
    const agora   = new Date();
    const fechamento = new Date();
    fechamento.setHours(9, 10, 0, 0);
    let msAte910 = fechamento - agora;
    if (msAte910 <= 0) msAte910 = 5 * 60 * 1000; // fallback 5min se já passou

    setTimeout(() => {
      const pos = this.positions.find(p => p.id === position.id && p.status === 'open');
      if (!pos) return;
      this.bus.off('normalized:tick', handler);
      const price = pos.lastPrice || pos.entryPrice;
      this._closePosition(pos.id, price, 'encerramento_9h10');
    }, msAte910);

    this.log.info(`👁 Monitorando posição ${position.id} | Stop: ${position.stopPrice} | Alvo: ${position.targetPrice} | Fecha: 9h10`);
  }

  _closePosition(posId, exitPrice, reason) {
    const pos = this.positions.find(p => p.id === posId && p.status === 'open');
    if (!pos) return;

    const priceDiff  = pos.direction === 'buy'
      ? exitPrice - pos.entryPrice
      : pos.entryPrice - exitPrice;
    const ticks      = priceDiff / TICK_SIZE;
    const pnl        = ticks * TICK_VALUE_BRL * pos.contracts;

    pos.status    = 'closed';
    pos.exitPrice = exitPrice;
    pos.exitAt    = Date.now();
    pos.pnl       = Math.round(pnl * 100) / 100;
    pos.closedBy  = reason;

    this.balance += pos.pnl;
    this.trades.push({ ...pos });

    this.log.info(`📄 POSIÇÃO FECHADA [${reason}]: PnL R$${pos.pnl.toFixed(2)} | Saldo: R$${this.balance.toFixed(2)}`);

    this.bus.emit('execution:close', { contracts: pos.contracts, pnl: pos.pnl, reason });
    this.bus.emit('ws:broadcast', { type: 'execution_close', data: pos });
  }

  // ── Live Execution ──────────────────────────────────────────
  _liveExecute(order) {
    this.log.warn('🔴 LIVE EXECUTION — NOT IMPLEMENTED. Integrate broker API here.');
    // TODO: Integrate with XP Investimentos / Rico / Necton API
    // This must never be called in paper mode.
    this.bus.emit('execution:error', { reason: 'Live execution not implemented', order });
  }

  async close() {
    // Close any open paper positions at market on shutdown
    const open = this.positions.filter(p => p.status === 'open');
    for (const pos of open) {
      this.log.warn(`Forcing close on shutdown: ${pos.id}`);
      this._closePosition(pos.id, pos.entryPrice, 'encerramento_sistema');
    }
  }

  getStatus() {
    const closedTrades = this.trades;
    const wins  = closedTrades.filter(t => t.pnl > 0).length;
    const losses = closedTrades.filter(t => t.pnl <= 0).length;
    const totalPnl = closedTrades.reduce((s, t) => s + t.pnl, 0);

    return {
      paperMode:      this.paperMode,
      balance:        Math.round(this.balance * 100) / 100,
      openPositions:  this.positions.filter(p => p.status === 'open'),
      closedTrades:   closedTrades.slice(-20),
      stats: {
        totalTrades: closedTrades.length,
        wins,
        losses,
        winRate:     closedTrades.length > 0 ? Math.round((wins / closedTrades.length) * 100) : 0,
        totalPnl:    Math.round(totalPnl * 100) / 100,
        avgPnl:      closedTrades.length > 0 ? Math.round((totalPnl / closedTrades.length) * 100) / 100 : 0,
      },
    };
  }
}

module.exports = { ExecutionEngine };
