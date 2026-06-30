/**
 * Market Features Engine v1
 * Implementa análises especializadas para o leilão do WDO:
 * 1. VAP — Volume at Price
 * 2. dTP/dt — Velocidade do Preço Teórico
 * 3. Agressor Ratio no Tape
 * 4. Tunnel Limits
 * 5. Spread WDO-DOL
 * 6. Detecção de Escora Real
 * 7. Ratio Volume Leilão vs Histórico
 * 8. Classificação do Gap
 */

const { Logger } = require('../utils/logger');

class MarketFeaturesEngine {
  constructor(bus) {
    this.bus = bus;
    this.log = new Logger('MKT-FEATURES');

    // ── Estado interno ───────────────────────────────────────────
    this.vap          = {};        // price → { buyVol, sellVol, totalVol, trades }
    this.tpHistory    = [];        // histórico do preço teórico
    this.tapeBuffer   = [];        // últimos 100 trades
    this.tunnelLimits = {};        // limites de túnel da B3
    this.escoraMap    = {};        // price → { attacks, absorbed, level }
    this.lastWDO      = null;
    this.lastDOL      = null;
    this.aucVolHistory = [];       // histórico de volume dos leilões

    this._listen();
    this.log.info('Market Features Engine iniciado');
  }

  _listen() {
    // Ticks WDO
    this.bus.on('normalized:tick', (tick) => {
      if (tick.symbol?.startsWith('WDO')) {
        this.lastWDO = tick;
        this._updateTP(tick);
        this._updateTunnelLimits(tick);
        this._updateSpread();
      }
      if (tick.symbol?.startsWith('DOL')) {
        this.lastDOL = tick;
        this._updateSpread();
      }
    });

    // Tape de negócios
    this.bus.on('normalized:trade', (trade) => {
      if (trade.symbol?.startsWith('WDO')) {
        this._updateVAP(trade);
        this._updateAgressorRatio(trade);
      }
    });

    // Book updates para escora
    this.bus.on('normalized:book', (book) => {
      if (book.symbol?.startsWith('WDO')) {
        this._updateEscora(book);
      }
    });

    // Emite snapshot a cada 500ms
    setInterval(() => this._emitSnapshot(), 500);
  }

  // ── 1. VAP — Volume at Price ─────────────────────────────────
  _updateVAP(trade) {
    if (!trade.price || !trade.qty) return;
    const key = Math.round(trade.price * 2) / 2; // arredonda para tick de 0.5
    if (!this.vap[key]) {
      this.vap[key] = { price: key, buyVol: 0, sellVol: 0, totalVol: 0, trades: 0 };
    }
    const v = this.vap[key];
    v.totalVol += trade.qty;
    v.trades++;
    if (trade.side === 'buy')  v.buyVol  += trade.qty;
    if (trade.side === 'sell') v.sellVol += trade.qty;
  }

  getVAP() {
    const arr = Object.values(this.vap).sort((a, b) => b.totalVol - a.totalVol);
    const poc = arr[0] || null; // Point of Control
    const totalVol = arr.reduce((s, v) => s + v.totalVol, 0);

    // Value Area (70% do volume)
    let accumulated = 0;
    const valueArea = [];
    for (const v of arr) {
      accumulated += v.totalVol;
      valueArea.push(v.price);
      if (accumulated >= totalVol * 0.7) break;
    }

    return {
      poc,
      valueArea: { high: Math.max(...valueArea), low: Math.min(...valueArea) },
      levels: arr.slice(0, 10),
      totalVol,
    };
  }

  // ── 2. dTP/dt — Velocidade do Preço Teórico ──────────────────
  _updateTP(tick) {
    if (!tick.theor_price) return;
    this.tpHistory.push({ t: Date.now(), tp: tick.theor_price, qty: tick.theor_qty || 0 });
    if (this.tpHistory.length > 60) this.tpHistory.shift();
  }

  getTPVelocity() {
    if (this.tpHistory.length < 3) return { velocidade: 0, convergindo: false, estavel: false, oscilando: false };

    const recent  = this.tpHistory.slice(-10);
    const oldest  = recent[0];
    const newest  = recent[recent.length - 1];
    const dt      = (newest.t - oldest.t) / 1000; // segundos
    const dTP     = newest.tp - oldest.tp;
    const vel     = dt > 0 ? dTP / dt : 0; // pontos por segundo

    // Calcula oscilação (desvio padrão dos últimos ticks)
    const prices  = recent.map(r => r.tp);
    const mean    = prices.reduce((s, p) => s + p, 0) / prices.length;
    const std     = Math.sqrt(prices.reduce((s, p) => s + Math.pow(p - mean, 2), 0) / prices.length);

    // Verifica tendência
    const diffs   = [];
    for (let i = 1; i < recent.length; i++) diffs.push(recent[i].tp - recent[i-1].tp);
    const sameDir = diffs.every(d => d >= 0) || diffs.every(d => d <= 0);

    return {
      velocidade:   Math.round(vel * 100) / 100,  // pontos/segundo
      desvioPadrao: Math.round(std * 100) / 100,
      convergindo:  Math.abs(vel) < 0.5 && std < 1.0,
      estavel:      std < 0.5,
      oscilando:    std > 2.0,
      tendencia:    vel > 0.5 ? 'subindo' : vel < -0.5 ? 'caindo' : 'lateral',
      sameDir,
      ultimoTP:     newest.tp,
      score:        std < 0.5 ? 2 : std < 1.5 ? 1 : std > 3 ? -2 : 0,
    };
  }

  // ── 3. Agressor Ratio no Tape ─────────────────────────────────
  _updateAgressorRatio(trade) {
    this.tapeBuffer.push({
      t:        Date.now(),
      price:    trade.price,
      qty:      trade.qty,
      side:     trade.side,
      agressor: trade.agressor,
    });
    if (this.tapeBuffer.length > 200) this.tapeBuffer.shift();
  }

  getAgressorRatio() {
    const recent  = this.tapeBuffer.slice(-50);
    if (!recent.length) return { buyRatio: 0.5, sellRatio: 0.5, delta: 0, pressao: 'neutro' };

    const buyVol  = recent.filter(t => t.side === 'buy').reduce((s, t) => s + (t.qty || 0), 0);
    const sellVol = recent.filter(t => t.side === 'sell').reduce((s, t) => s + (t.qty || 0), 0);
    const total   = buyVol + sellVol || 1;
    const delta   = buyVol - sellVol;
    const ratio   = buyVol / total;

    return {
      buyVol,
      sellVol,
      buyRatio:  Math.round(ratio * 1000) / 1000,
      sellRatio: Math.round((1 - ratio) * 1000) / 1000,
      delta,
      pressao:   ratio > 0.6 ? 'compradora' : ratio < 0.4 ? 'vendedora' : 'neutro',
      score:     ratio > 0.65 ? 2 : ratio > 0.55 ? 1 : ratio < 0.35 ? -2 : ratio < 0.45 ? -1 : 0,
    };
  }

  // ── 4. Tunnel Limits ──────────────────────────────────────────
  _updateTunnelLimits(tick) {
    // Índices 107/108 = upper/lower tunnel limit
    // Índices 148/149 = upper/lower auction tunnel
    if (tick.raw) {
      if (tick.raw[107]) this.tunnelLimits.upperStatic  = parseFloat(tick.raw[107]);
      if (tick.raw[108]) this.tunnelLimits.lowerStatic  = parseFloat(tick.raw[108]);
      if (tick.raw[148]) this.tunnelLimits.upperAuction = parseFloat(tick.raw[148]);
      if (tick.raw[149]) this.tunnelLimits.lowerAuction = parseFloat(tick.raw[149]);
      if (tick.raw[150]) this.tunnelLimits.upperReject  = parseFloat(tick.raw[150]);
      if (tick.raw[151]) this.tunnelLimits.lowerReject  = parseFloat(tick.raw[151]);
    }
  }

  getTunnelAnalysis(theorPrice) {
    const t   = this.tunnelLimits;
    if (!theorPrice || (!t.upperAuction && !t.upperStatic)) {
      return { risco: 'desconhecido', proximoLimite: null, distancia: null };
    }

    const upper = t.upperAuction || t.upperStatic;
    const lower = t.lowerAuction || t.lowerStatic;

    const distUpper = upper ? Math.abs(theorPrice - upper) : 999;
    const distLower = lower ? Math.abs(theorPrice - lower) : 999;
    const minDist   = Math.min(distUpper, distLower);

    return {
      upperLimit:    upper,
      lowerLimit:    lower,
      distUpper:     Math.round(distUpper * 100) / 100,
      distLower:     Math.round(distLower * 100) / 100,
      proximoLimite: distUpper < distLower ? 'teto' : 'piso',
      risco:         minDist < 5 ? 'alto' : minDist < 15 ? 'medio' : 'baixo',
      score:         minDist < 5 ? -2 : minDist < 10 ? -1 : 0,
    };
  }

  // ── 5. Spread WDO-DOL ─────────────────────────────────────────
  _updateSpread() {
    // noop — calculado no getSpreadAnalysis
  }

  getSpreadAnalysis() {
    const wdo = this.lastWDO?.theor_price || this.lastWDO?.last;
    const dol = this.lastDOL?.theor_price || this.lastDOL?.last;
    if (!wdo || !dol) return { spread: null, normal: null, divergente: false };

    // WDO deveria ser DOL / 5 (mini = 20% do cheio em valor de ponto)
    const esperado  = dol;
    const spread    = Math.abs(wdo - dol);
    const normal    = spread < 5;
    const divergente = spread > 10;

    return {
      wdo,
      dol,
      spread:     Math.round(spread * 100) / 100,
      normal,
      divergente,
      descricao:  divergente ? `Spread anormal: ${spread.toFixed(1)} pts` : 'Spread normal',
      score:      divergente ? -1 : 0,
    };
  }

  // ── 6. Detecção de Escora Real ────────────────────────────────
  _updateEscora(book) {
    // Para cada nível do book, verifica se foi "atacado" e segurou
    const allLevels = [...(book.bids || []), ...(book.asks || [])];
    allLevels.forEach(level => {
      const key = Math.round(level.price * 2) / 2;
      if (!this.escoraMap[key]) {
        this.escoraMap[key] = { price: key, maxVol: 0, attacks: 0, absorbed: 0, firstSeen: Date.now() };
      }
      const e = this.escoraMap[key];
      if (level.qty > e.maxVol) {
        e.maxVol = level.qty;
      }
      // Mantém só os últimos 200 níveis
      if (Object.keys(this.escoraMap).length > 200) {
        const oldest = Object.keys(this.escoraMap).sort((a, b) =>
          this.escoraMap[a].firstSeen - this.escoraMap[b].firstSeen
        )[0];
        delete this.escoraMap[oldest];
      }
    });
  }

  getEscoraReal(theorPrice) {
    if (!theorPrice) return { escoraAtual: null, nivelForte: null, score: 0 };

    // Níveis próximos do preço teórico (±10 pontos)
    const proximos = Object.values(this.escoraMap)
      .filter(e => Math.abs(e.price - theorPrice) <= 10 && e.maxVol >= 200)
      .sort((a, b) => b.maxVol - a.maxVol);

    const escoraAtual = proximos[0] || null;
    const nivelForte  = escoraAtual?.maxVol >= 500;

    return {
      escoraAtual,
      nivelForte,
      proximos: proximos.slice(0, 5),
      score:    nivelForte ? 1 : 0,
      descricao: escoraAtual
        ? `Escora em ${escoraAtual.price.toFixed(1)} (${escoraAtual.maxVol} lotes)`
        : 'Sem escora clara',
    };
  }

  // ── 7. Ratio Volume Leilão vs Histórico ───────────────────────
  registrarAucVol(vol) {
    if (!vol || vol < 100) return;
    this.aucVolHistory.push({ t: Date.now(), vol });
    if (this.aucVolHistory.length > 60) this.aucVolHistory.shift(); // 60 pregões
  }

  getVolumeRatio(aucVolAtual) {
    if (!aucVolAtual || this.aucVolHistory.length < 5) {
      return { ratio: null, forte: false, descricao: 'Histórico insuficiente' };
    }
    const media = this.aucVolHistory.reduce((s, v) => s + v.vol, 0) / this.aucVolHistory.length;
    const ratio = aucVolAtual / media;

    return {
      ratio:     Math.round(ratio * 100) / 100,
      media:     Math.round(media),
      atual:     aucVolAtual,
      forte:     ratio >= 1.5,
      fraco:     ratio < 0.7,
      descricao: ratio >= 1.5 ? `Volume ${ratio.toFixed(1)}x acima da média` :
                 ratio < 0.7  ? `Volume ${ratio.toFixed(1)}x abaixo da média` :
                 `Volume normal (${ratio.toFixed(1)}x)`,
      score:     ratio >= 2.0 ? 2 : ratio >= 1.5 ? 1 : ratio < 0.5 ? -2 : ratio < 0.7 ? -1 : 0,
    };
  }

  // ── 8. Classificação do Gap ───────────────────────────────────
  classificarGap(gapPts, macroScore, dolAlinhado) {
    if (gapPts === null || gapPts === undefined) {
      return { classificacao: 'desconhecido', score: 0, descricao: 'Gap não disponível' };
    }

    const absGap = Math.abs(gapPts);
    const direcao = gapPts > 0 ? 'alta' : 'baixa';

    let classificacao = '';
    let score = 0;
    let descricao = '';

    // Gap pequeno < 10 pts
    if (absGap < 10) {
      classificacao = 'neutro';
      score = 0;
      descricao = `Gap pequeno (${gapPts.toFixed(1)} pts) — mercado lateral`;
    }
    // Gap médio 10-30 pts
    else if (absGap < 30) {
      if (macroScore > 0 && dolAlinhado) {
        classificacao = 'confirmado';
        score = 1;
        descricao = `Gap de ${direcao} (${gapPts.toFixed(1)} pts) confirmado pelo macro`;
      } else if (macroScore < 0) {
        classificacao = 'contra_tendencia';
        score = -1;
        descricao = `Gap de ${direcao} contra o macro — possível reversão`;
      } else {
        classificacao = 'indefinido';
        score = 0;
        descricao = `Gap de ${direcao} (${gapPts.toFixed(1)} pts) — macro neutro`;
      }
    }
    // Gap grande > 30 pts
    else {
      if (macroScore > 2) {
        classificacao = 'forte';
        score = 2;
        descricao = `Gap forte de ${direcao} (${gapPts.toFixed(1)} pts) com macro alinhado`;
      } else {
        classificacao = 'excessivo';
        score = -1;
        descricao = `Gap excessivo (${gapPts.toFixed(1)} pts) — risco de reversão`;
      }
    }

    return { classificacao, score, descricao, gapPts, direcao, absGap };
  }

  // ── Snapshot completo ─────────────────────────────────────────
  _emitSnapshot() {
    const tp        = this.lastWDO?.theor_price;
    const aucVol    = this.lastWDO?.auc_vol;
    const snapshot  = {
      vap:           this.getVAP(),
      tpVelocidade:  this.getTPVelocity(),
      agressorRatio: this.getAgressorRatio(),
      tunnel:        this.getTunnelAnalysis(tp),
      spread:        this.getSpreadAnalysis(),
      escoraReal:    this.getEscoraReal(tp),
      volumeRatio:   this.getVolumeRatio(aucVol),
    };

    // Score total das features
    snapshot.featureScore =
      (snapshot.tpVelocidade?.score  || 0) +
      (snapshot.agressorRatio?.score || 0) +
      (snapshot.tunnel?.score        || 0) +
      (snapshot.spread?.score        || 0) +
      (snapshot.escoraReal?.score    || 0) +
      (snapshot.volumeRatio?.score   || 0);

    this.bus.emit('market:features', snapshot);
  }

  // Limpa VAP ao iniciar novo pregão
  resetDia() {
    this.vap          = {};
    this.tpHistory    = [];
    this.tapeBuffer   = [];
    this.escoraMap    = {};
    this.log.info('Market Features resetado para novo pregão');
  }
}

module.exports = { MarketFeaturesEngine };
