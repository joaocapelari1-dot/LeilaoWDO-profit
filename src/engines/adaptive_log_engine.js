/**
 * AdaptiveLogEngine v3
 * 
 * 1. CALIBRAÇÃO HISTÓRICA — aprende com últimos N pregões
 * 2. REGIME DETECTION — identifica contexto similar e usa melhor threshold
 * 3. DEFAULT DINÂMICO — atualiza default com padrões históricos
 * 4. CICLO AUTOMÁTICO — detecta anomalia, reverte, tenta recalibrar sozinho
 * 5. TRADE JOURNAL — registro completo de cada trade
 * 6. BALANÇO MENSAL/ANUAL — PnL, win rate, drawdown, estatísticas
 */

const fs   = require('fs');
const path = require('path');
const { Logger } = require('../utils/logger');

const DATA_DIR      = process.env.DATA_DIR || '/app/data';
const LOG_FILE      = path.join(DATA_DIR, 'adaptive_log.json');
const JOURNAL_FILE  = path.join(DATA_DIR, 'trade_journal.json');
const MIN_PREGOES   = 5;
const ANOMALIA_DIAS = 3; // dias suspeitos antes de tentar recalibrar

// ── Defaults base ─────────────────────────────────────────────
const DEFAULTS_BASE = {
  escora_multiplicador: 3.0,
  stopping_volume:      300,
  effort_lotes:         150,
  no_supply_max:        30,
  test_max:             50,
  absorcao_ratio:       0.5,
  iceberg_threshold:    3,
};

const LIMITES = {
  escora_multiplicador: { min: 1.5,  max: 6.0  },
  stopping_volume:      { min: 150,  max: 800  },
  effort_lotes:         { min: 80,   max: 400  },
  no_supply_max:        { min: 10,   max: 80   },
  test_max:             { min: 20,   max: 100  },
  absorcao_ratio:       { min: 0.3,  max: 0.8  },
};

const AJUSTES_PROSPECTIVOS = {
  payroll: 0.40, cpi: 0.35, fomc: 0.40, copom: 0.30,
  pib: 0.20, evento_alto: 0.25, vix_alto: 0.25,
  vix_muito_alto: 0.40, dxy_gap: 0.15, vencimento: 0.20,
};

class AdaptiveLogEngine {
  constructor(bus) {
    this.bus         = bus;
    this.log         = new Logger('ADAPTIVE-LOG');
    this.historico   = [];
    this.journal     = [];
    this.thresholds  = { ...DEFAULTS_BASE };
    this.defaults    = { ...DEFAULTS_BASE }; // default dinâmico
    this.status      = 'DEFAULT';
    this.diasSuspeitos = 0;
    this.pregaoAtual = null;
    this.eventosHoje = [];
    this.tradeAtual  = null;
    this.lastMacro   = null;
    this.lastCalendario = null;
    this.useDefault  = false;

    this._ensureDataDir();
    this._loadHistorico();
    this._loadJournal();

    bus.on('macro:update',       (m) => { this.lastMacro = m; });
    bus.on('macro:snapshot',      (m) => { this.lastMacro = { ...this.lastMacro, ...m }; });
    bus.on('context:calendar',   (c) => { this.lastCalendario = c; });
    bus.on('risk:approved',      (s) => this._onAprovado(s));
    bus.on('execution:fill',     (f) => this._onFill(f));
    bus.on('execution:close',    (c) => this._onClose(c));
    bus.on('delta:snapshot',     (d) => { this.lastDeltaSnapshot = d; }); // coleta para calibração
    bus.on('iceberg:detected',   (ic) => this._onEvento('ICEBERG', ic));
    bus.on('ai:analise',         (a) => this._onAnalise(a));
    bus.on('tape:alertas',       (t) => this._onTapeAlerta(t));
  }

  start() {
    this.log.info('Adaptive Log Engine v3 iniciado');
    this._agendarCalibracao855();
    this._agendarFechamento18h();
  }

  // ── Fechamento diário às 18h (substitui _onStateChange DONE) ──
  _agendarFechamento18h() {
    const now  = new Date();
    const alvo = new Date();
    alvo.setHours(18, 0, 0, 0);
    let ms = alvo - now;
    if (ms <= 0) {
      alvo.setDate(alvo.getDate() + 1);
      ms = alvo - now;
    }
    setTimeout(() => {
      if (this.pregaoAtual && !this.pregaoAtual.resultado) {
        this.pregaoAtual.resultado = 'sem_sinal';
        this.historico.push({ ...this.pregaoAtual });
        this._saveHistorico();
        this.pregaoAtual = null;
        this.log.info('📁 Pregão encerrado às 18h — salvo no histórico');
      }
      this._agendarFechamento18h(); // reagenda para amanhã
    }, ms);
  }

  // ── Agendamento 8h55 ─────────────────────────────────────────
  _agendarCalibracao855() {
    const now  = new Date();
    const alvo = new Date();
    alvo.setHours(8, 55, 0, 0);
    let ms = alvo - now;
    if (ms <= 0) {
      ms = process.env.MOCK_MODE !== 'false' ? 3000 : (() => {
        alvo.setDate(alvo.getDate() + 1);
        return alvo - now;
      })();
      if (process.env.MOCK_MODE !== 'false') this.log.info('[MOCK] Calibração em 3s');
    } else {
      this.log.info('Calibração agendada para 8h55 (' + Math.round(ms/1000/60) + 'min)');
    }
    setTimeout(() => {
      this.log.info('⚙️  8h55 — Iniciando calibração pré-pregão...');
      this._calibrarCompleto();
      setTimeout(() => this._agendarCalibracao855(), 1000);
    }, ms);
  }

  // ── Calibração Completa ───────────────────────────────────────
  _calibrarCompleto() {
    // 1. Regime Detection — atualiza default dinâmico
    this._detectarRegime();

    // 1b. Análise de correlação automática após 30 pregões
    const tradesComFiltros = this.journal.filter(t => t.acertou !== null && t.filtros);
    if (tradesComFiltros.length >= 30) {
      this._aplicarCorrelacaoAutomatica();
    }

    // 2. Ciclo automático de anomalia
    if (this.status === 'SUSPEITO') {
      this.diasSuspeitos++;
      if (this.diasSuspeitos >= ANOMALIA_DIAS) {
        this.log.info('🔄 Auto-recalibração após ' + ANOMALIA_DIAS + ' dias suspeitos');
        this.useDefault  = false;
        this.diasSuspeitos = 0;
      } else {
        this.log.warn('Status SUSPEITO — usando defaults por mais ' + (ANOMALIA_DIAS - this.diasSuspeitos) + ' dia(s)');
        this.lastDeltaSnapshot = null; // dados de volume para calibração delta
        this.thresholds = { ...this.defaults };
        this.bus.emit('adaptive:thresholds', { ...this.thresholds, status: this.status });
        return;
      }
    }

    if (this.useDefault) {
      this.thresholds = { ...this.defaults };
      this.status     = 'RESETADO';
      this.log.info('Usando defaults manuais');
      this.bus.emit('adaptive:thresholds', { ...this.thresholds, status: this.status });
      return;
    }

    // 3. Calibração histórica
    const historico    = this._calibrarHistorico();
    const prospectivo  = this._calcularAjusteProspectivo();
    const confianca    = this._calcularConfianca();
    const blended      = this._blendarThresholds(historico, confianca);
    const ajustado     = this._aplicarProspectivo(blended, prospectivo);
    const final        = this._aplicarLimites(ajustado);
    const anomalia     = this._detectarAnomalia(final);

    if (anomalia) {
      this.log.warn('⚠️ Anomalia — revertendo para defaults dinâmicos');
      const safe      = this._aplicarProspectivo({ ...this.defaults }, prospectivo);
      this.thresholds = this._aplicarLimites(safe);
      this.status     = 'SUSPEITO';
      this.diasSuspeitos = 1;
    } else {
      this.thresholds    = final;
      this.status        = confianca.nivel;
      this.diasSuspeitos = 0;
    }

    this.log.info('✅ Calibração concluída | Status: ' + this.status + ' | Ajuste: +' + Math.round(prospectivo.fator*100) + '% | ' + prospectivo.motivos.join(', '));
    this.bus.emit('adaptive:thresholds', { ...this.thresholds, status: this.status, prospectivo, confianca });
  }

  // ── Regime Detection ──────────────────────────────────────────
  _detectarRegime() {
    if (this.historico.length < 10) return;

    const hoje = new Date();
    const diaSemana = hoje.getDay();
    const vixAtual  = this.lastMacro?.vix?.price || 0;
    const temEvento = this.lastCalendario?.temEventoCritico || false;

    // Busca pregões similares no histórico
    const similares = this.historico.filter(p => {
      const d = new Date(p.data);
      const mesmodia   = d.getDay() === diaSemana;
      const vixSimilar = p.vix ? Math.abs(p.vix - vixAtual) < 5 : true;
      const mesmoEvento = p.temEvento === temEvento;
      return mesmodia && vixSimilar && mesmoEvento && p.acertou !== null;
    }).slice(-20);

    if (similares.length < 3) return;

    // Calcula melhor threshold para este regime
    const vencedores = similares.filter(p => p.acertou);
    if (vencedores.length < 2) return;

    // Atualiza default dinâmico com média dos dias similares vencedores
    const avgSurplus = vencedores.reduce((s,p) => s + (p.surplus||0), 0) / vencedores.length;

    if (avgSurplus > 400) {
      this.defaults.escora_multiplicador = 2.5;
      this.defaults.stopping_volume      = 250;
    } else if (avgSurplus > 200) {
      this.defaults.escora_multiplicador = 3.0;
      this.defaults.stopping_volume      = 300;
    } else {
      this.defaults.escora_multiplicador = 3.5;
      this.defaults.stopping_volume      = 350;
    }

    this.defaults = this._aplicarLimites(this.defaults);
    this.log.info('🎯 Regime detectado: ' + similares.length + ' dias similares | Default atualizado | Surplus médio: ' + Math.round(avgSurplus));
  }

  // ── Trade Journal ─────────────────────────────────────────────
  _onAprovado(sinal) {
    const macro = this.lastMacro || {};
    this.tradeAtual = {
      id:           Date.now(),
      data:         new Date().toISOString().split('T')[0],
      hora_sinal:   new Date().toLocaleTimeString('pt-BR'),
      direcao:      sinal.direction,
      preco_entrada: sinal.entry || sinal.price,
      stop:         sinal.stopPrice,
      alvo:         sinal.targetPrice,
      stop_ticks:   sinal.stopTicks || 6,
      alvo_ticks:   sinal.alvo1Ticks || 0,
      rr:           sinal.rr || 0,
      contratos:    sinal.contracts || 1,
      risco_brl:    sinal.riskBrl || 60,
      retorno_brl:  sinal.rewardBrl || 0,
      surplus:      sinal.confluence?.surplus || 0,
      confianca_ia: 0,

      // ── Filtros para análise de hierarquia ──────────────────
      filtros: {
        // Bloqueadores
        iceberg_favor:       sinal.icebergFavor    || false,
        iceberg_contra:      sinal.icebergContra   || false,
        dol_wdo_confluente:  sinal.confluenciaDolWdo !== 'divergente',
        volume_ok:           (sinal.confluence?.auc_vol || 0) >= 100,

        // Pontuadores
        tp_estavel:          sinal.tpStable        || false,
        surplus_crescente:   (sinal.confluence?.surplus || 0) >= 200,
        macro_score:         macro.macroScore      || 0,
        macro_alinhado:      (macro.macroScore     || 0) > 0,
        cip_score:           macro.cip?.score      || 0,
        cme_score:           macro.cme?.score      || 0,
        cip_favoravel:       (macro.cip?.score     || 0) > 0,
        cme_favoravel:       (macro.cme?.score     || 0) > 0,

        // Contexto
        vix:                 macro.vix?.price      || 0,
        dxy_chg:             macro.dxy?.changePct  || 0,
        tem_evento:          this.lastCalendario?.temEventoCritico || false,
        surplus_valor:       sinal.confluence?.surplus || 0,
        imbalance:           sinal.confluence?.imbalance || 0,
      },

      vix:          macro.vix?.price      || 0,
      dxy_chg:      macro.dxy?.changePct  || 0,
      tem_evento:   this.lastCalendario?.temEventoCritico || false,
      dia_semana:   new Date().toLocaleDateString('pt-BR', { weekday:'long' }),
      thresholds:   { ...this.thresholds },
      status_calib: this.status,
      resultado:    null,
      pnl_ticks:    null,
      pnl_brl:      null,
      acertou:      null,
      hora_fechamento: null,
      duracao_min:  null,
      motivo_saida: null,
      leitura_tape: null,
      alertas_tape: [],
    };
  }

  _onFill(fill) {
    if (!this.tradeAtual) return;
    this.tradeAtual.hora_entrada = new Date().toLocaleTimeString('pt-BR');
    if (!this.pregaoAtual) return;
    this.pregaoAtual.fill = { preco: fill.entryPrice, stop: fill.stopPrice, alvo: fill.targetPrice, rr: fill.rr };
  }

  _onClose(close) {
    const agora = new Date();

    // ── Fecha Trade Journal ────────────────────────────────────
    if (this.tradeAtual) {
      const entrada = this.tradeAtual.hora_entrada
        ? new Date('1970-01-01T' + this.tradeAtual.hora_entrada)
        : null;
      const saida = agora;

      this.tradeAtual.resultado      = close.reason;
      this.tradeAtual.pnl_ticks      = Math.round(close.pnl / 10);
      this.tradeAtual.pnl_brl        = close.pnl;
      this.tradeAtual.acertou        = close.pnl > 0;
      this.tradeAtual.hora_fechamento = agora.toLocaleTimeString('pt-BR');
      this.tradeAtual.duracao_min    = entrada ? Math.round((saida - entrada) / 60000) : null;
      this.tradeAtual.motivo_saida   = close.reason;
      this.tradeAtual.alertas_tape   = this.eventosHoje.map(e => e.tipo);

      if (process.env.MOCK_MODE !== 'false') {
        this.log.info('[MOCK] Trade NÃO registrado — dados mock não alimentam journal');
      } else {
        this.journal.push({ ...this.tradeAtual });
        this._saveJournal();
        this.log.info('📒 Trade registrado: ' + close.reason + ' | PnL R$' + close.pnl?.toFixed(2));
        this.bus.emit('journal:trade_salvo', this.tradeAtual);
      }
      // ── Salva movimento real para calibração delta ──────────
      if (this.lastDeltaSnapshot) {
        const movTicks = Math.round(close.pnl / 10); // ticks reais do movimento
        const deltaRecord = {
          ...this.lastDeltaSnapshot,
          movimentoReal: movTicks,
          resultado:     close.reason,
          pnl_brl:       close.pnl,
        };
        if (!this.deltaHistory) this.deltaHistory = [];
        this.deltaHistory.push(deltaRecord);
        this.log.info(`📐 Delta registrado: agg=${deltaRecord.aggRatio.toFixed(2)} surplus=${deltaRecord.surplus} iceberg=${deltaRecord.iceberg_lots} → ${movTicks} ticks reais`);
        this.lastDeltaSnapshot = null;
      }

      this.tradeAtual = null;
    }

    // ── Fecha Pregão Adaptativo ───────────────────────────────
    if (!this.pregaoAtual) return;
    this.pregaoAtual.resultado  = close.reason;
    this.pregaoAtual.pnl_ticks  = Math.round(close.pnl / 10);
    this.pregaoAtual.acertou    = close.pnl > 0;
    this.pregaoAtual.eventos    = [...this.eventosHoje];
    this.pregaoAtual.encerrado  = agora.toLocaleTimeString('pt-BR');
    this.pregaoAtual.vix        = this.lastMacro?.vix?.price || 0;
    this.pregaoAtual.temEvento  = this.lastCalendario?.temEventoCritico || false;

    // Só salva histórico com dados reais (não mock)
    if (process.env.MOCK_MODE !== 'false') {
      this.log.info('[MOCK] Pregão NÃO salvo — dados mock não alimentam calibração');
    } else {
      this.historico.push({ ...this.pregaoAtual });
      this._saveHistorico();
      this._calibrarCompleto();
      this.log.info('Pregão salvo: ' + close.reason + ' | ' + this.pregaoAtual.pnl_ticks + ' ticks');
      this.bus.emit('adaptive:pregao_salvo', this.pregaoAtual);
    }
    this.pregaoAtual = null;
  }

  // ── Balanço Mensal/Anual ──────────────────────────────────────
  getBalanco(periodo = 'mensal') {
    const agora  = new Date();
    const trades = this.journal.filter(t => {
      if (!t.data) return false;
      const d = new Date(t.data);
      if (periodo === 'mensal') {
        return d.getMonth() === agora.getMonth() && d.getFullYear() === agora.getFullYear();
      } else if (periodo === 'anual') {
        return d.getFullYear() === agora.getFullYear();
      }
      return true;
    });

    if (trades.length === 0) return { periodo, trades: 0, mensagem: 'Sem trades no período' };

    const wins      = trades.filter(t => t.acertou);
    const losses    = trades.filter(t => !t.acertou);
    const pnlTotal  = trades.reduce((s,t) => s + (t.pnl_brl||0), 0);
    const pnlTicks  = trades.reduce((s,t) => s + (t.pnl_ticks||0), 0);

    // Drawdown máximo
    let pico = 0, drawdownMax = 0, acumulado = 0;
    trades.forEach(t => {
      acumulado += t.pnl_brl || 0;
      if (acumulado > pico) pico = acumulado;
      const dd = pico - acumulado;
      if (dd > drawdownMax) drawdownMax = dd;
    });

    // Maior gain e maior loss
    const maiorGain = Math.max(...trades.map(t => t.pnl_brl||0));
    const maiorLoss = Math.min(...trades.map(t => t.pnl_brl||0));

    // Sequência máxima de wins e losses
    let maxWinSeq = 0, maxLossSeq = 0, winSeq = 0, lossSeq = 0;
    trades.forEach(t => {
      if (t.acertou) { winSeq++; lossSeq = 0; if (winSeq > maxWinSeq) maxWinSeq = winSeq; }
      else           { lossSeq++; winSeq = 0; if (lossSeq > maxLossSeq) maxLossSeq = lossSeq; }
    });

    // Duração média dos trades
    const duracoes = trades.filter(t => t.duracao_min).map(t => t.duracao_min);
    const duracaoMedia = duracoes.length ? Math.round(duracoes.reduce((a,b) => a+b,0) / duracoes.length) : null;

    // Por dia da semana
    const porDia = {};
    trades.forEach(t => {
      const dia = t.dia_semana || 'Desconhecido';
      if (!porDia[dia]) porDia[dia] = { trades: 0, wins: 0, pnl: 0 };
      porDia[dia].trades++;
      if (t.acertou) porDia[dia].wins++;
      porDia[dia].pnl += t.pnl_brl || 0;
    });

    // Esperança matemática
    const em = trades.length
      ? ((wins.length/trades.length) * (maiorGain||100)) - ((losses.length/trades.length) * Math.abs(maiorLoss||40))
      : 0;

    return {
      periodo,
      trades:        trades.length,
      wins:          wins.length,
      losses:        losses.length,
      winRate:       Math.round(wins.length / trades.length * 100),
      pnlBRL:        Math.round(pnlTotal * 100) / 100,
      pnlTicks,
      drawdownMax:   Math.round(drawdownMax * 100) / 100,
      maiorGain:     Math.round(maiorGain * 100) / 100,
      maiorLoss:     Math.round(maiorLoss * 100) / 100,
      maxWinSeq,
      maxLossSeq,
      duracaoMedia,
      em:            Math.round(em * 100) / 100,
      porDia,
      trades_detalhe: trades,
    };
  }

  // ── Helpers ───────────────────────────────────────────────────
  _calibrarHistorico() {
    const result = { ...this.defaults };
    if (this.historico.length < MIN_PREGOES) return result;
    const ultimos = this.historico.slice(-15);

    const escorasReais = ultimos.flatMap(p => (p.eventos||[]).filter(e => e.tipo==='ESCORA' && e.resultado==='segurou'));
    if (escorasReais.length >= 3) {
      const avg = escorasReais.reduce((s,e) => s+(e.qty||e.lotes||200),0) / escorasReais.length;
      result.escora_multiplicador = Math.max(1.5, avg / (this._getAvgLote(ultimos)||100));
    }

    const svReais = ultimos.flatMap(p => (p.eventos||[]).filter(e => e.tipo==='STOPPING_VOLUME' && e.resultado==='reverteu'));
    if (svReais.length >= 3) result.stopping_volume = Math.max(150, Math.min(...svReais.map(e=>e.lotes||300)) * 0.9);

    const nsReais = ultimos.flatMap(p => (p.eventos||[]).filter(e => e.tipo==='NO_SUPPLY' && e.resultado==='continuou'));
    if (nsReais.length >= 3) result.no_supply_max = Math.min(80, Math.max(...nsReais.map(e=>e.lotes||30)) * 1.1);

    const efReais = ultimos.flatMap(p => (p.eventos||[]).filter(e => e.tipo==='EFFORT_RESULT' && e.resultado==='exaustao'));
    if (efReais.length >= 3) result.effort_lotes = Math.max(80, Math.min(...efReais.map(e=>e.lotes||150)) * 0.9);

    return result;
  }

  _calcularAjusteProspectivo() {
    let fator = 0;
    const motivos = [];
    if (this.lastCalendario?.temEventoCritico) {
      (this.lastCalendario.eventosProximos||[]).forEach(e => {
        const nome = (e.nome||'').toLowerCase();
        if (nome.includes('payroll')||nome.includes('nonfarm')) { fator+=AJUSTES_PROSPECTIVOS.payroll; motivos.push('Payroll'); }
        else if (nome.includes('cpi')||nome.includes('inflacao')) { fator+=AJUSTES_PROSPECTIVOS.cpi; motivos.push('CPI'); }
        else if (nome.includes('fomc')||nome.includes('fed'))    { fator+=AJUSTES_PROSPECTIVOS.fomc; motivos.push('FOMC'); }
        else if (nome.includes('copom'))                          { fator+=AJUSTES_PROSPECTIVOS.copom; motivos.push('COPOM'); }
        else                                                       { fator+=AJUSTES_PROSPECTIVOS.evento_alto; motivos.push(e.nome); }
      });
    }
    const vix = this.lastMacro?.vix?.price || 0;
    if (vix > 25) { fator+=AJUSTES_PROSPECTIVOS.vix_muito_alto; motivos.push('VIX>'+vix.toFixed(1)); }
    else if (vix > 20) { fator+=AJUSTES_PROSPECTIVOS.vix_alto; motivos.push('VIX>'+vix.toFixed(1)); }
    const dxyChg = Math.abs(this.lastMacro?.dxy?.changePct||0);
    if (dxyChg > 0.3) { fator+=AJUSTES_PROSPECTIVOS.dxy_gap; motivos.push('DXY gap'); }
    const hoje = new Date();
    if (hoje.getDay()===5 && Math.ceil(hoje.getDate()/7)===3) { fator+=AJUSTES_PROSPECTIVOS.vencimento; motivos.push('Vencimento'); }
    return { fator: Math.min(fator, 0.80), motivos: motivos.length ? motivos : ['Dia normal'] };
  }

  _calcularConfianca() {
    const n = this.historico.length;
    if (n < MIN_PREGOES) return { peso: 0, nivel: 'DEFAULT' };
    if (n < 15)  return { peso: 0.4, nivel: 'CALIBRANDO' };
    if (n < 30)  return { peso: 0.7, nivel: 'CALIBRANDO' };
    return { peso: 0.85, nivel: 'CONFIAVEL' };
  }

  _blendarThresholds(historico, confianca) {
    const result = {};
    Object.keys(this.defaults).forEach(k => {
      result[k] = (historico[k]||this.defaults[k]) * confianca.peso + this.defaults[k] * (1-confianca.peso);
    });
    return result;
  }

  _aplicarProspectivo(thresholds, prospectivo) {
    const result = { ...thresholds };
    const f = 1 + prospectivo.fator;
    result.stopping_volume      = thresholds.stopping_volume * f;
    result.effort_lotes         = thresholds.effort_lotes * f;
    result.escora_multiplicador = thresholds.escora_multiplicador * (1 + prospectivo.fator * 0.5);
    return result;
  }

  _aplicarLimites(thresholds) {
    const result = { ...thresholds };
    Object.keys(LIMITES).forEach(k => {
      if (result[k] !== undefined) {
        result[k] = Math.max(LIMITES[k].min, Math.min(LIMITES[k].max, result[k]));
        result[k] = Math.round(result[k] * 10) / 10;
      }
    });
    return result;
  }

  _detectarAnomalia(thresholds) {
    for (const k of Object.keys(this.defaults)) {
      if (!thresholds[k]) continue;
      const ratio = thresholds[k] / this.defaults[k];
      if (ratio > 2.0 || ratio < 0.3) {
        this.log.warn('Anomalia em ' + k + ': ratio ' + ratio.toFixed(2));
        return true;
      }
    }
    return false;
  }

  _getAvgLote(pregoes) {
    const todos = pregoes.flatMap(p => (p.eventos||[]).map(e => e.lotes||0)).filter(l => l > 0);
    return todos.length ? todos.reduce((a,b)=>a+b,0)/todos.length : 100;
  }

  // ── Listeners ─────────────────────────────────────────────────
  _onEvento(tipo, dados) {
    const evento = { tipo, timestamp: Date.now(), ...dados, resultado: 'pendente' };
    this.eventosHoje.push(evento);
    if (this.pregaoAtual) this.pregaoAtual.eventos = [...this.eventosHoje];
    if (this.tradeAtual)  this.tradeAtual.alertas_tape.push(tipo);
  }

  _onTapeAlerta(data) {
    (data.alerts||[]).forEach(tipo => this._onEvento(tipo, { fase: data.fase, lotes: 0 }));
  }

  _onAnalise(analise) {
    if (this.pregaoAtual) {
      this.pregaoAtual.analises = this.pregaoAtual.analises || [];
      this.pregaoAtual.analises.push({ timestamp: analise.timestamp, motivo: analise.motivo, confianca: analise.confianca, veredito: analise.veredito });
    }
    if (this.tradeAtual && analise.confianca > (this.tradeAtual.confianca_ia||0)) {
      this.tradeAtual.confianca_ia = analise.confianca;
      this.tradeAtual.leitura_tape = analise.leituraTape;
    }
  }

  // ── Persistência ──────────────────────────────────────────────
  _ensureDataDir() {
    try { if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true }); }
    catch (e) { this.log.warn('Erro ao criar diretório:', e.message); }
  }

  _loadHistorico() {
    try {
      if (fs.existsSync(LOG_FILE)) {
        this.historico = JSON.parse(fs.readFileSync(LOG_FILE, 'utf8'));
        this.log.info('Histórico: ' + this.historico.length + ' pregões');
      }
    } catch (e) { this.log.warn('Erro ao carregar histórico:', e.message); this.historico = []; }
  }

  _loadJournal() {
    try {
      if (fs.existsSync(JOURNAL_FILE)) {
        this.journal = JSON.parse(fs.readFileSync(JOURNAL_FILE, 'utf8'));
        this.log.info('Trade Journal: ' + this.journal.length + ' trades');
      }
    } catch (e) { this.log.warn('Erro ao carregar journal:', e.message); this.journal = []; }
  }

  _saveHistorico() {
    try { fs.writeFileSync(LOG_FILE, JSON.stringify(this.historico, null, 2)); }
    catch (e) { this.log.warn('Erro ao salvar histórico:', e.message); }
  }

  _saveJournal() {
    try { fs.writeFileSync(JOURNAL_FILE, JSON.stringify(this.journal, null, 2)); }
    catch (e) { this.log.warn('Erro ao salvar journal:', e.message); }
  }

  // ── Reset manual ──────────────────────────────────────────────
  resetar() {
    this.useDefault = true; this.thresholds = { ...this.defaults };
    this.status = 'RESETADO';
    this.bus.emit('adaptive:thresholds', { ...this.thresholds, status: this.status });
  }

  reativar() { this.useDefault = false; this._calibrarCompleto(); }

  // ── API pública ───────────────────────────────────────────────
  // ── Aplicação Automática da Correlação ───────────────────
  _aplicarCorrelacaoAutomatica() {
    try {
      const correlacao = this.getCorrelacaoFiltros();
      if (correlacao.erro) return;

      correlacao.recomendacoes.forEach(rec => {
        this.log.info('📊 Correlação: ' + rec);
      });

      // Ajusta peso do iceberg automaticamente
      const icebergFavor = correlacao.filtros.find(f => f.campo === 'iceberg_favor');
      if (icebergFavor?.diferenca > 20) {
        this.log.info('🔧 Auto-ajuste: iceberg_favor impacto alto — peso mantido em +15%');
      }

      // Detecta filtros com impacto mínimo e loga recomendação
      const semImpacto = correlacao.filtros.filter(f => f.diferenca !== null && Math.abs(f.diferenca) < 5);
      if (semImpacto.length > 0) {
        this.log.info('ℹ️  Filtros com impacto mínimo: ' + semImpacto.map(f => f.campo).join(', '));
      }

      this.bus.emit('adaptive:correlacao', correlacao);
    } catch(e) {
      this.log.warn('Erro na correlação automática:', e.message);
    }
  }

  // ── Análise de Correlação dos Filtros ────────────────────
  // Passo 2 — roda após 30+ pregões reais
  getCorrelacaoFiltros() {
    const trades = this.journal.filter(t => t.acertou !== null && t.filtros);
    if (trades.length < 10) return { erro: 'Mínimo 10 trades com filtros salvos', total: trades.length };

    const analisarFiltro = (campo) => {
      const com    = trades.filter(t => t.filtros?.[campo] === true);
      const sem    = trades.filter(t => t.filtros?.[campo] === false);
      const wrCom  = com.length  ? Math.round(com.filter(t=>t.acertou).length/com.length*100)  : null;
      const wrSem  = sem.length  ? Math.round(sem.filter(t=>t.acertou).length/sem.length*100)  : null;
      return { campo, com: com.length, sem: sem.length, wrCom, wrSem, diferenca: wrCom !== null && wrSem !== null ? wrCom - wrSem : null };
    };

    const filtros = [
      'iceberg_favor', 'iceberg_contra', 'dol_wdo_confluente',
      'tp_estavel', 'surplus_crescente', 'macro_alinhado',
      'cip_favoravel', 'cme_favoravel', 'tem_evento', 'volume_ok'
    ].map(analisarFiltro);

    // Ordena por maior impacto no win rate
    filtros.sort((a,b) => Math.abs(b.diferenca||0) - Math.abs(a.diferenca||0));

    // Recomendações automáticas
    const recomendacoes = filtros.map(f => {
      if (f.diferenca === null) return null;
      if (f.campo === 'iceberg_contra' && f.wrCom < 40) return `✅ Manter bloqueio iceberg_contra (win rate ${f.wrCom}% quando ativo)`;
      if (f.campo === 'dol_wdo_confluente' && f.wrSem < 40) return `✅ Manter bloqueio DOL×WDO (win rate ${f.wrSem}% quando divergente)`;
      if (f.diferenca > 20) return `⬆️ ${f.campo}: +${f.diferenca}% win rate quando ativo — considerar aumentar peso`;
      if (f.diferenca < -20) return `⬇️ ${f.campo}: ${f.diferenca}% win rate quando ativo — considerar reduzir peso`;
      if (Math.abs(f.diferenca) < 5) return `↔️ ${f.campo}: impacto mínimo (${f.diferenca}%) — pode relaxar este filtro`;
      return null;
    }).filter(Boolean);

    return { total: trades.length, filtros, recomendacoes };
  }

  getThresholds() { return { ...this.thresholds, status: this.status }; }
  getHistorico()  { return this.historico; }
  getJournal()    { return this.journal; }
  getStats() {
    const total = this.journal.filter(t => t.resultado && t.resultado !== 'sem_sinal');
    const wins  = total.filter(t => t.acertou);
    const pnl   = total.reduce((s,t) => s+(t.pnl_brl||0), 0);
    return {
      totalPregoes:  this.historico.length,
      totalTrades:   total.length,
      wins:          wins.length,
      losses:        total.length - wins.length,
      winRate:       total.length ? Math.round(wins.length/total.length*100) : 0,
      pnlBRL:        Math.round(pnl*100)/100,
      pnlTicks:      total.reduce((s,t)=>s+(t.pnl_ticks||0),0),
      status:        this.status,
      thresholds:    this.thresholds,
      historico:     this.historico,
      balanco_mensal: this.getBalanco('mensal'),
      balanco_anual:  this.getBalanco('anual'),
    };
  }
}

module.exports = { AdaptiveLogEngine, DEFAULTS_BASE, LIMITES };
