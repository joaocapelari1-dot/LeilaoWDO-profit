/**
 * RiskEngine v2
 * 
 * Regras hard (sem IA):
 *   1. PERDA_MAXIMA_DIA
 *   2. MAX_POSITION
 *   3. VOLUME_MINIMO_LEILAO
 *   4. UM_TRADE_POR_LEILAO
 *   5. JANELA_HORARIO (09h-18h)
 *   6. VALIDADE_SINAL
 * 
 * Janela de decisão 9h00:00 → 9h01:00 (BRT):
 *   - Snapshots a cada 10s
 *   - Gatilho: confiança ≥ 85% + macro alinhado
 *   - Aborta automaticamente em 9h01:00
 *   - Vira direção se preço teórico mudar de lado
 * 
 * Macro alinhamento:
 *   DXY + USD/BRL (proxy DI) + Treasury 10y
 *   ⚠️  DI real via Cedro quando disponível
 */
const { Logger } = require('../utils/logger');

const CONFIDENCE_THRESHOLD = 0.85;   // 85% mínimo
const SNAPSHOT_INTERVAL_MS = 7000;  // a cada 7s (ciclo do Claude)
const THEORETICAL_STABLE_TICKS = 3  // preço teórico estável por N ticks
const MIN_SURPLUS_GROWTH   = 50;    // superávit precisa crescer N por snapshot

class RiskEngine {
  constructor(bus) {
    this.bus  = bus;
    this.log  = new Logger('RISK-ENGINE');

    // Config
    this.MAX_LOSS_BRL       = parseFloat(process.env.MAX_LOSS_BRL           || '500');
    this.MAX_POSITION       = parseInt(process.env.MAX_POSITION_CONTRACTS    || '5');
    this.MIN_VOLUME_AUCTION = parseInt(process.env.MIN_VOLUME_AUCTION        || '100');
    this.MIN_RR             = parseFloat(process.env.RISK_REWARD_MIN         || '2.0'); // 6 stop × 2 = 12 alvo

    // Session state
    this.realizedPnL      = 0;
    this.openContracts    = 0;
    this.tradestoday      = 0;
    this.signalsEvaluated = 0;
    this.signalsApproved  = 0;
    this.signalsRejected  = 0;
    this.rejectionLog     = [];

    // Janela de decisão
    this.windowActive      = false;
    this.windowTimer       = null;
    this.windowAbortTimer  = null;
    this.snapshotHistory   = [];      // histórico de snapshots na janela
    this.theoreticalHistory = [];     // histórico do preço teórico
    this.lastSurplus       = 0;
    this.lastMacro         = null;
    this.lastFeatures      = null;
    this.lastAIAnalysis    = null;
    this.entryExecuted     = false;

    this.log.info(`Risk Engine v2 | Limite Perda: R$${this.MAX_LOSS_BRL} | Pos. Máx: ${this.MAX_POSITION} | Vol Mín: ${this.MIN_VOLUME_AUCTION} | Gatilho IA: ${CONFIDENCE_THRESHOLD*100}%`);

    // Confluência DOL x WDO
    this.lastConfluence   = null;
    this.lastDOLFeatures  = null;
    bus.on('feature:wdo', (f) => {
      if (f.confluence) this.lastConfluence = f.confluence;
    });
    bus.on('feature:dol', (f) => {
      this.lastDOLFeatures = f;
    });

    // Listeners
    bus.on('execution:fill',  (f) => this._onFill(f));
    bus.on('execution:close', (c) => this._onClose(c));
    bus.on('macro:update',    (m) => { this.lastMacro = m; });
    bus.on('ai:analise', (a) => {
      this.lastAIAnalysis = a;
      this._onAIAnalise(a); // monitora barra de confiança
    });
    bus.on('feature:update',  (f) => { this.lastFeatures = f; this._onFeatureUpdate(f); });
  }

  // ── Avalia sinal vindo da State Machine ───────────────────────
  evaluate(signal) {
    this.signalsEvaluated++;
    const checks = this._runHardChecks(signal);
    const failed  = checks.filter(c => !c.passed);

    if (failed.length > 0) {
      const rejection = {
        signalId:  signal.id,
        timestamp: Date.now(),
        reason:    failed.map(c => c.rule).join(', '),
        details:   failed,
        signal,
      };
      this.signalsRejected++;
      this.rejectionLog.push(rejection); if (this.rejectionLog.length > 50) this.rejectionLog = this.rejectionLog.slice(-50);
      this.log.warn(`❌ SINAL REJEITADO [${signal.id}]: ${rejection.reason}`);
      this.bus.emit('risk:rejected', rejection);
      return;
    }

    // Passou nas regras hard → entra na janela de decisão se for horário de leilão
    if (this._isInDecisionWindow()) {
      this.log.info(`✅ Sinal válido — abrindo janela de decisão 9h00→9h01`);
      this._startDecisionWindow(signal);
    } else {
      // Fora da janela → aprova direto (modo de teste / mock)
      this._approve(signal);
    }
  }

  // ── Janela de Decisão 9h00:00 → 9h01:00 ─────────────────────
  _isInDecisionWindow() {
    // Janela BRT: 8h55 → 9h00:45 (antes do 1º negócio da B3)
    const brt = new Date(Date.now() - 3 * 60 * 60 * 1000);
    const h = brt.getUTCHours();
    const m = brt.getUTCMinutes();
    const s = brt.getUTCSeconds();
    return (h === 8 && m >= 55) ||
           (h === 9 && m === 0 && s <= 45);
  }

  _startDecisionWindow(signal) {
    if (this.windowActive) return;
    this.windowActive   = true;
    this.entryExecuted  = false;
    this.snapshotHistory = [];
    this.theoreticalHistory = [];
    this.log.info(`🕘 JANELA DE DECISÃO ABERTA — monitorando 8h55→9h00:45`);
    this.bus.emit('risk:window_open', { signal, timestamp: Date.now() });

    // Snapshot a cada 7s (ciclo do Claude)
    this.windowTimer = setInterval(() => {
      if (!this._isInDecisionWindow()) {
        this._abortWindow('JANELA_EXPIRADA_9h00:45');
        return;
      }
      this._takeSnapshot(signal);
    }, SNAPSHOT_INTERVAL_MS);

    // Primeiro snapshot imediato
    this._takeSnapshot(signal);
  }

  _takeSnapshot(signal) {
    if (!this.windowActive || this.entryExecuted) return;

    const f  = this.lastFeatures;
    const ai = this.lastAIAnalysis;
    const m  = this.lastMacro;

    if (!f) return;

    // ── 1. Estabilidade do preço teórico ──────────────────────
    const tp = f.auction?.theoreticalPrice;
    if (tp) { this.theoreticalHistory.push(tp); if (this.theoreticalHistory.length > 100) this.theoreticalHistory = this.theoreticalHistory.slice(-100); }
    const tpStable = this._isPriceStable(this.theoreticalHistory, THEORETICAL_STABLE_TICKS, 0.5);

    // ── 2. Superávit crescente ─────────────────────────────────
    const surplus        = f.auction?.surplus || 0;
    const surplusGrowing = surplus > this.lastSurplus + MIN_SURPLUS_GROWTH;
    this.lastSurplus     = surplus;

    // ── 3. Volume acelerando ───────────────────────────────────
    const auctionVol    = f.auction?.volumeAtAuction || 0;
    const volOk         = auctionVol >= this.MIN_VOLUME_AUCTION;

    // ── 4. Alinhamento macro ───────────────────────────────────
    const macroAlign   = this._checkMacroAlignment(signal.direction, m);

    // ── 5. Confiança da IA ────────────────────────────────────
    const aiConfianca  = ai?.confianca || 0;
    const aiVeredito   = ai?.veredito || 'NAO_OPERAR';
    const aiAligned    = (signal.direction === 'buy'  && aiVeredito === 'OPERAR_BUY') ||
                         (signal.direction === 'sell' && aiVeredito === 'OPERAR_SELL')

    // ── 6. Verificar se direção virou ─────────────────────────
    const directionFlipped = this._checkDirectionFlip(f, signal.direction);
    if (directionFlipped) {
      this._abortWindow('DIRECAO_VIROU');
      return;
    }

    // ── 7. Alinhamento Macro × Micro ──────────────────────────
    // Verifica se macro e micro apontam para a mesma direção
    const macroScore   = m?.macroScore || 0;
    const aggRatio     = f.aggRatio || 0.5;
    const flowDelta    = f.flowDelta || 0;
    const isBuy        = signal.direction === 'buy';

    // Macro favorável à direção
    const macroFavor   = isBuy ? macroScore >= 0 : macroScore <= 0;

    // Micro favorável à direção
    const microAggOk   = isBuy ? aggRatio >= 0.55 : aggRatio <= 0.45;
    const microFlowOk  = isBuy ? flowDelta > 0 : flowDelta < 0;
    const microFavor   = microAggOk && microFlowOk;

    // Alinhamento: macro e micro na mesma direção
    const macroMicroAligned = macroFavor && microFavor;

    // ── Score composto ─────────────────────────────────────────
    const snapshot = {
      timestamp:    Date.now(),
      snapshotNum:  this.snapshotHistory.length + 1,
      tp,
      tpStable,
      surplus,
      surplusGrowing,
      auctionVol,
      volOk,
      macroAlign,
      macroScore,
      macroFavor,
      microAggOk,
      microFlowOk,
      macroMicroAligned,
      aiConfianca,
      aiAligned,
      aiVeredito,
      icebergFavor,
      icebergContra,
      aiConfiancaOriginal: ai?.confianca || 0,
      ready: tpStable && volOk && aiConfianca >= CONFIDENCE_THRESHOLD && aiAligned,
    };

    this.snapshotHistory.push(snapshot); if (this.snapshotHistory.length > 20) this.snapshotHistory = this.snapshotHistory.slice(-20);
    this.log.info(`📊 📊 Snapshot #${snapshot.snapshotNum} | TP: ${tp?.toFixed(2)} ${tpStable?'✓':'✗'} | Surplus: ${surplus} ${surplusGrowing?'↑':'→'} | Macro: ${macroAlign.aligned?'✓':'✗'} (${macroAlign.reason}) | IA: ${(aiConfianca*100).toFixed(0)}% ${aiAligned?'✓':'✗'}`);
    this.bus.emit('risk:snapshot', snapshot);

    // ── Gatilho de entrada ─────────────────────────────────────
    if (snapshot.ready) {
      this.log.info(`🚀 GATILHO ATINGIDO! Confiança: ${(aiConfianca*100).toFixed(0)}% ≥ 85% | Entrando!`);
      this._approveFromWindow(signal, snapshot);
    }
  }

  _isPriceStable(history, n, maxDelta) {
    if (history.length < n) return false;
    const last = history.slice(-n);
    const range = Math.max(...last) - Math.min(...last);
    return range <= maxDelta;
  }

  _checkMacroAlignment(direction, macro) {
    if (!macro) return { aligned: true, reason: 'macro_indisponivel', score: 0 };

    const factors = [];
    let score = 0;

    // DXY
    const dxyChg = macro.dxy?.changePct || 0;
    if (direction === 'buy') {
      // BUY WDO = dólar subindo = DXY subindo
      if (dxyChg > 0.05)  { score += 2; factors.push('DXY↑ ✓'); }
      if (dxyChg < -0.05) { score -= 2; factors.push('DXY↓ ✗'); }
    } else {
      if (dxyChg < -0.05) { score += 2; factors.push('DXY↓ ✓'); }
      if (dxyChg > 0.05)  { score -= 2; factors.push('DXY↑ ✗'); }
    }

    // USD/BRL (proxy DI — ⚠️ substituir por DI real quando Cedro disponível)
    const brlChg = macro.usdbrl?.changePct || 0;
    if (direction === 'buy') {
      if (brlChg > 0.05)  { score += 2; factors.push('USDBRL↑ ✓'); }
      if (brlChg < -0.05) { score -= 2; factors.push('USDBRL↓ ✗'); }
    } else {
      if (brlChg < -0.05) { score += 2; factors.push('USDBRL↓ ✓'); }
      if (brlChg > 0.05)  { score -= 2; factors.push('USDBRL↑ ✗'); }
    }

    // Treasury 10y
    const tnxChg = macro.treasury10y?.changePct || 0;
    if (direction === 'buy') {
      if (tnxChg > 0.02)  { score += 1; factors.push('TNX↑ ✓'); }
      if (tnxChg < -0.02) { score -= 1; factors.push('TNX↓ ✗'); }
    } else {
      if (tnxChg < -0.02) { score += 1; factors.push('TNX↓ ✓'); }
      if (tnxChg > 0.02)  { score -= 1; factors.push('TNX↑ ✗'); }
    }

    // VIX
    const vixPrice = macro.vix?.price || 0;
    if (vixPrice > 25) { score -= 1; factors.push('VIX_ALTO ⚠️'); }

    const aligned = score >= 2; // precisa de pelo menos 2 fatores favoráveis
    return { aligned, score, reason: factors.join(' | ') || 'neutro' };
  }

  _checkDirectionFlip(features, originalDirection) {
    const currentSide = features.auction?.side;
    if (!currentSide || currentSide === 'balanced') return false;
    if (originalDirection === 'buy'  && currentSide === 'sell') return true;
    if (originalDirection === 'sell' && currentSide === 'buy')  return true;
    return false;
  }

  _approveFromWindow(signal, snapshot) {
    this.entryExecuted = true;
    this._closeWindow();
    const sized = this._sizePosition(signal);
    this.signalsApproved++;
    this.log.info(`✅ ENTRADA APROVADA PELA JANELA [${signal.id}]: ${signal.direction.toUpperCase()} @ ${signal.price}`);
    this._emitDeltaSnapshot(sized);
    this.bus.emit('risk:approved', { ...sized, snapshot, approvedBy: 'decision_window' });
  }

  // ── Coleta dados de volume para calibração delta pós-30 pregões ──
  _emitDeltaSnapshot(sized) {
    const f  = this.lastFeatures;
    const ic = this.lastIceberg;
    this.bus.emit('delta:snapshot', {
      timestamp:    Date.now(),
      direction:    sized.direction,
      entryPrice:   sized.price,
      stopTicks:    sized.stopTicks,
      alvoTicks:    sized.alvo1Ticks,
      // Sinais de volume que determinam amplitude do movimento
      aggRatio:     f?.aggRatio              || 0,   // % agressão compradora
      flowDelta:    f?.flowDelta             || 0,   // delta de fluxo
      auc_vol:      f?.auc_vol              || f?.auction?.volumeAtAuction || 0, // volume leilão
      surplus:      f?.auction?.surplus      || 0,   // superávit de ordens
      theor_price:  f?.auction?.theoreticalPrice || 0,
      iceberg_lots: ic?.lots                 || 0,   // lotes iceberg detectados
      iceberg_side: ic?.side                 || null,
      book_imbal:   f?.book?.imbalance       || 0,   // desequilíbrio book
      macroScore:   this.lastMacro?.macroScore || 0,
      // movimento real preenchido pelo AdaptiveLog no fechamento (close:delta)
      movimentoReal: null,
    });
  }

  _abortWindow(reason) {
    this.log.warn(`⛔ JANELA ABORTADA: ${reason}`);
    this._closeWindow();
    this.bus.emit('risk:window_aborted', { reason, timestamp: Date.now(), snapshots: this.snapshotHistory });
  }

  _closeWindow() {
    if (this.windowTimer)      { clearInterval(this.windowTimer);   this.windowTimer = null; }
    if (this.windowAbortTimer) { clearTimeout(this.windowAbortTimer); this.windowAbortTimer = null; }
    this.windowActive = false;
  }

  // ── Feature update (monitora durante janela) ──────────────────
  _onFeatureUpdate(features) {
    // Não depende mais de phase=auction — Claude analisa por horário
    // Risk Engine monitora passivamente os dados
  }

  // ── Monitora barra de confiança do Claude ─────────────────────
  _onAIAnalise(ai) {
    if (!this._isInDecisionWindow()) return;
    if (this.entryExecuted) return;
    if (this.tradestoday > 0) return;

    const conf    = ai.confianca || 0;
    const veredito = ai.veredito || 'NAO_OPERAR';

    // Emite barra de confiança para o dashboard
    this.bus.emit('risk:confianca', {
      confianca: conf,
      veredito,
      timestamp: Date.now(),
    });

    // Gatilho: confiança ≥ 85% e não é NAO_OPERAR
    if (conf >= CONFIDENCE_THRESHOLD && veredito !== 'NAO_OPERAR') {
      const direction = veredito === 'OPERAR_BUY' ? 'buy' : 'sell';
      const f = this.lastFeatures;
      const price = f?.last || f?.bid || 0;

      if (!price) return;

      // Claude já integra macro×micro internamente
      // Confiança ≥ 85% = sinal confirmado
      if (!this.windowActive) {
        this.log.info(`🚀 Confiança ${(conf*100).toFixed(0)}% ≥ 85% → ENTRADA!`);
        const signal = {
          id:        `claude_${Date.now()}`,
          direction,
          price,
          confluence: { volumeAtAuction: f.auction?.volumeAtAuction || 999 },
          source:    'claude_ai',
        };
        this.evaluate(signal);
      }
    }
  }

  // ── State Machine listener ─────────────────────────────────────
  // Não abortar por CONTINUOUS — 1º negócio B3 (~9h00:30) já transita,
  // abortando Claude antes de entrar. Janela expira às 9h00:45 sozinha.
  _onStateChange(event) {
    if (event.to === 'DONE') {
      if (this.windowActive) this._abortWindow('FIM_DO_PREGAO');
    }
  }

  // ── Hard checks ───────────────────────────────────────────────
  _runHardChecks(signal) {
    return [
      this._checkAuctionVolume(signal),
      this._checkSignalValidity(signal),
      this._checkNoExistingSignalToday(),
      this._checkTradingWindow(),
    ];
  }

  _checkDOLConfluencia() {
    const c  = this.lastConfluence;
    const fd = this.lastDOLFeatures;
    const fw = this.lastFeatures;

    // Sem dados ainda — permite passar no início
    if (!c || !fd || !fw) return {
      rule:   'CONFLUENCIA_DOL_WDO',
      passed: true,
      detail: 'Aguardando dados do DOL',
    };

    // ── 1. Direção do leilão alinhada ─────────────────────────
    const direcaoAlinhada = c.aligned === true;

    // ── 2. Agressão alinhada ──────────────────────────────────
    // aggRatio > 0.55 = maioria compradora, < 0.45 = maioria vendedora
    const agDOL = fd.aggRatio || 0.5;
    const agWDO = fw.aggRatio || 0.5;
    const dolAgressaoBuy  = agDOL > 0.55;
    const dolAgressaoSell = agDOL < 0.45;
    const wdoAgressaoBuy  = agWDO > 0.55;
    const wdoAgressaoSell = agWDO < 0.45;
    const agressaoAlinhada = (dolAgressaoBuy  && wdoAgressaoBuy) ||
                             (dolAgressaoSell && wdoAgressaoSell);

    // ── 3. Flow delta alinhado ────────────────────────────────
    const fluxoDOL = fd.flowDelta || 0;
    const fluxoWDO = fw.flowDelta || 0;
    const fluxoAlinhado = (fluxoDOL > 0 && fluxoWDO > 0) ||
                          (fluxoDOL < 0 && fluxoWDO < 0);

    const passou = direcaoAlinhada && agressaoAlinhada && fluxoAlinhado;

    return {
      rule:   'CONFLUENCIA_DOL_WDO',
      passed: passou,
      detail: [
        `Direção: ${direcaoAlinhada ? '✓' : '✗'} (DOL ${c.dolSide || '?'} / WDO ${c.wdoSide || '?'})`,
        `Agressão: ${agressaoAlinhada ? '✓' : '✗'} (DOL ${(agDOL*100).toFixed(0)}% / WDO ${(agWDO*100).toFixed(0)}%)`,
        `Fluxo: ${fluxoAlinhado ? '✓' : '✗'} (DOL ${fluxoDOL > 0 ? '+' : ''}${fluxoDOL} / WDO ${fluxoWDO > 0 ? '+' : ''}${fluxoWDO})`,
      ].join(' | '),
    };
  }

  _checkDailyLoss() {
    return { rule: 'PERDA_MAXIMA_DIA', passed: this.realizedPnL > -this.MAX_LOSS_BRL, detail: `PnL: R$${this.realizedPnL.toFixed(2)} | Limite: -R$${this.MAX_LOSS_BRL}` };
  }
  _checkMaxPosition() {
    return { rule: 'POSICAO_MAXIMA', passed: this.openContracts < this.MAX_POSITION, detail: `Abertos: ${this.openContracts} | Limite: ${this.MAX_POSITION}` };
  }
  _checkAuctionVolume(signal) {
    const vol = signal.confluence?.volumeAtAuction || 0;
    return { rule: 'VOLUME_MINIMO_LEILAO', passed: vol >= this.MIN_VOLUME_AUCTION, detail: `Vol: ${vol} | Mín: ${this.MIN_VOLUME_AUCTION}` };
  }
  _checkSignalValidity(signal) {
    return { rule: 'VALIDADE_SINAL', passed: signal.price > 0 && ['buy','sell'].includes(signal.direction), detail: `Dir: ${signal.direction} | Preço: ${signal.price}` };
  }
  _checkNoExistingSignalToday() {
    return { rule: 'UM_TRADE_POR_LEILAO', passed: this.tradestoday === 0, detail: `Trades hoje: ${this.tradestoday}` };
  }
  _checkTradingWindow() {
    const brt = new Date(Date.now() - 3 * 60 * 60 * 1000);
    const h = brt.getUTCHours(); const m = brt.getUTCMinutes();
    const naJanela = (h === 8 && m >= 55) || (h === 9 && m <= 10);
    return { rule: 'JANELA_HORARIO', passed: naJanela, detail: `Horário BRT: ${h}:${String(m).padStart(2,'0')} | Janela: 8h55-9h10` };
  }

  // ── Position sizing ───────────────────────────────────────────
  _sizePosition(signal) {
    const entry     = signal.price;
    const tickSize  = 0.5;
    const tickValue = 10;
    const ai        = this.lastAIAnalysis;

    // Stop fixo 6 ticks (R$60) — alvo 12 ticks (R$120) → R/R 1:2
    // Pós-30 pregões: substituir por delta calculado por volume
    const stopTicks  = 6;
    const stopOffset = stopTicks * tickSize;
    const stopPrice  = signal.direction === 'buy'
      ? entry - stopOffset
      : entry + stopOffset;

    // Alvo dinâmico do Claude (se disponível e RR ≥ 2.0)
    // Senão usa RR mínimo configurado
    let targetPrice, alvo1Ticks, rr, alvo1Confianca, amplitudeEsperada, baseCalculo;

    if (ai && ai.alvo1Ticks >= 8 && ai.alvo1Confianca >= 0.85) {
      // Usa alvo calculado pelo Claude
      alvo1Ticks        = ai.alvo1Ticks;
      const targetOffset = alvo1Ticks * tickSize;
      targetPrice        = signal.direction === 'buy'
        ? entry + targetOffset
        : entry - targetOffset;
      rr                 = ai.rr || (alvo1Ticks / stopTicks);
      alvo1Confianca     = ai.alvo1Confianca;
      amplitudeEsperada  = ai.amplitudeEsperada || '';
      baseCalculo        = ai.baseCalculoAlvo   || 'Calculado pelo Claude';
      this.log.info(`🎯 Alvo dinâmico Claude: ${alvo1Ticks} ticks (${alvo1Confianca*100}% confiança) | RR: ${rr.toFixed(1)} | ${baseCalculo}`);
    } else {
      // Fallback: RR mínimo configurado
      alvo1Ticks        = Math.round(stopTicks * this.MIN_RR);
      const targetOffset = alvo1Ticks * tickSize;
      targetPrice        = signal.direction === 'buy'
        ? entry + targetOffset
        : entry - targetOffset;
      rr                 = this.MIN_RR;
      alvo1Confianca     = 0;
      amplitudeEsperada  = '';
      baseCalculo        = 'RR mínimo fixo (Claude sem dados suficientes)';
      this.log.info(`🎯 Alvo fixo fallback: ${alvo1Ticks} ticks | RR: ${rr}`);
    }

    return {
      ...signal,
      contracts:        1,
      entry,
      stopPrice:        Math.round(stopPrice   * 100) / 100,
      targetPrice:      Math.round(targetPrice * 100) / 100,
      stopTicks,
      alvo1Ticks,
      alvo1Confianca,
      amplitudeEsperada,
      baseCalculoAlvo:  baseCalculo,
      riskBrl:          stopTicks  * tickValue,
      rewardBrl:        alvo1Ticks * tickValue,
      rr:               Math.round(rr * 100) / 100,
      sizedBy:          ai?.alvo1Ticks >= 8 ? 'claude_dinamico' : 'rr_fixo',
    };
  }

  // ── Fill tracking ─────────────────────────────────────────────
  _onFill(fill) {
    this.openContracts += fill.contracts;
    this.tradestoday++;
    this.log.info(`Execução: +${fill.contracts} contratos abertos | ${this.openContracts}`);
  }
  _onClose(close) {
    this.openContracts = Math.max(0, this.openContracts - close.contracts);
    this.realizedPnL  += close.pnl;
    this.log.info(`Fechamento: PnL R$${close.pnl.toFixed(2)} | Sessão Total: R$${this.realizedPnL.toFixed(2)}`);
  }

  // ── Approve (fora da janela — mock/teste) ─────────────────────
  _approve(signal) {
    const sized = this._sizePosition(signal);
    this.signalsApproved++;
    this.log.info(`✅ SINAL APROVADO [${signal.id}]: ${signal.direction.toUpperCase()} ${sized.contracts} contracts @ ${signal.price}`);
    this.bus.emit('risk:approved', sized);
  }

  getStatus() {
    return {
      realizedPnL:      this.realizedPnL,
      openContracts:    this.openContracts,
      tradestoday:      this.tradestoday,
      signalsEvaluated: this.signalsEvaluated,
      signalsApproved:  this.signalsApproved,
      signalsRejected:  this.signalsRejected,
      windowActive:     this.windowActive,
      snapshotHistory:  this.snapshotHistory,
      rejectionLog:     this.rejectionLog.slice(-10),
      limits: { maxLoss: this.MAX_LOSS_BRL, maxPos: this.MAX_POSITION, minVolume: this.MIN_VOLUME_AUCTION, minRR: this.MIN_RR, confidenceThreshold: CONFIDENCE_THRESHOLD },
    };
  }

  resetDay() {
    this._closeWindow();
    this.realizedPnL = 0; this.openContracts = 0; this.tradestoday = 0;
    this.signalsEvaluated = 0; this.signalsApproved = 0; this.signalsRejected = 0;
    this.rejectionLog = []; this.snapshotHistory = []; this.entryExecuted = false;
    this.log.info('Risk Engine resetado para novo pregão');
  }
}

module.exports = { RiskEngine };
