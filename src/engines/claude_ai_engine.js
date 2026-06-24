/**
 * ClaudeAIEngine v2
 * 
 * Fora da janela: análise a cada 15s (contexto geral)
 * Janela 9h00→9h01: análise a cada 1s
 * Iceberg detectado: chamada imediata extra
 * 
 * Confiança composta avalia:
 * - Micro: preço teórico, superávit, volume, book, icebergs
 * - Confluência DOL x WDO: direção + agressão + fluxo
 * - Macro: DXY, USD/BRL (proxy DI), Treasury, VIX
 */
const Anthropic = require('@anthropic-ai/sdk');
const { Logger } = require('../utils/logger');

const INTERVALO_NORMAL     = 5000;   // 5s — call Claude ~3-4s, sem sobreposição
const MAX_TOKENS = 600;

// Horários BRT

class ClaudeAIEngine {
  constructor(bus) {
    this.bus          = bus;
    this.log          = new Logger('CLAUDE-IA');
    this.client       = null;
    this.timer        = null;
    this.lastFeatures = null;
    this.lastDOL      = null;
    this.lastMacro    = null;
    this.lastAnalise  = null;
    this.lastIceberg  = null;
    this.totalChamadas = 0;
    this.stubMode     = false;

    this._initClient();

    // Thresholds adaptativos
    this.thresholds = {
      escora_multiplicador: 3.0,
      stopping_volume:      300,
      effort_lotes:         150,
      no_supply_max:        30,
      test_max:             50,
      absorcao_ratio:       0.5,
    };
    bus.on('adaptive:thresholds', (t) => {
      this.thresholds = { ...this.thresholds, ...t };
      this.log.info('Thresholds adaptativos atualizados');
    });

    // Contexto de mercado
    this.lastContext = null;
    bus.on('context:gap',          (d) => { if (!this.lastContext) this.lastContext = {}; this.lastContext.gap = d; });
    bus.on('context:calendar',     (d) => { if (!this.lastContext) this.lastContext = {}; this.lastContext.calendario = d; });
    bus.on('context:market_makers',(d) => { if (!this.lastContext) this.lastContext = {}; this.lastContext.formadores = d; });

    // Escuta eventos
    bus.on('feature:wdo',        (f) => this._onFeatureWDO(f));

    // ── Timer por horário — inicia às 8h55 independente de ticks Cedro ──
    this._agendarInicio855();
    bus.on('feature:dol',        (f) => { this.lastDOL = f; });
    bus.on('macro:update',       (m) => { this.lastMacro = m; });

    // ── Proteções de resiliência ──────────────────────────────
    this.lastAnaliseCache       = null;   // cache do último resultado
    this.claudeOffline           = false;  // flag se Anthropic caiu
    this.claudeErros             = 0;      // contador de erros consecutivos
    this.veredictoFinalEmitido   = false;  // garante 1 veredicto final por pregão
    bus.on('iceberg:detected',   (ic) => this._onIceberg(ic));
    bus.on('risk:approved',      (s) => { this.lastSignalDirection = s.direction; });
// Janela encerra por horário — sem dependência do AuctionSM
  }

  _initClient() {
    const key = process.env.ANTHROPIC_API_KEY;
    if (!key || key.includes('YOUR_KEY')) {
      this.log.warn('ANTHROPIC_API_KEY não configurado — modo STUB ativo');
      this.stubMode = true;
      return;
    }
    try {
      this.client   = new Anthropic({ apiKey: key });
      this.stubMode = false;
      this.log.info('Claude IA inicializado');
    } catch (e) {
      this.log.error('Erro ao inicializar Claude:', e.message);
      this.stubMode = true;
    }
  }

  // ── Janela encerrada — sem pós-abertura, sem estados ──────────
  _sairJanela() {
    if (this.timer) { clearInterval(this.timer); this.timer = null; }
    // standby silencioso — não logar fora da janela (evita spam no log)
  }

  // ── Agendamento por horário — inicia às 8h55 sem depender de ticks ──
  _agendarInicio855() {
    const now  = new Date();
    const brt  = new Date(now.getTime() - 3 * 60 * 60 * 1000);
    const h = brt.getUTCHours(), m = brt.getUTCMinutes(), s = brt.getUTCSeconds();

    // Já está na janela? → inicia imediatamente
    const naJanela = (h === 8 && m >= 55) || (h === 9 && m === 0 && s <= 50);
    if (naJanela) {
      this.log.info('Claude IA: já na janela 8h55 — iniciando timer agora');
      if (!this.timer) {
        this.timer = setInterval(() => this._analisar('pre_leilao_10s'), INTERVALO_NORMAL);
        this._analisar('inicio_janela');
      }
      return;
    }

    // Calcular ms até 8h55 BRT (BRT = UTC-3) — apenas dias úteis (seg-sex)
    const alvo = new Date(now);
    alvo.setUTCHours(11, 55, 0, 0); // 8h55 BRT = 11h55 UTC
    let ms = alvo - now;
    if (ms <= 0) {
      // Já passou hoje → agenda para o próximo dia
      alvo.setUTCDate(alvo.getUTCDate() + 1);
      ms = alvo - now;
    }
    // Pular fins de semana
    while (alvo.getUTCDay() === 0 || alvo.getUTCDay() === 6) {
      alvo.setUTCDate(alvo.getUTCDate() + 1);
      ms = alvo - now;
    }

    this.log.info(`Claude IA: timer agendado para 8h55 BRT (${Math.round(ms/1000)}s)`);
    setTimeout(() => {
      this.log.info('Claude IA: 8h55 — iniciando análise por horário');
      if (!this.timer) {
        this.timer = setInterval(() => this._analisar('pre_leilao_10s'), INTERVALO_NORMAL);
        this._analisar('inicio_janela');
      }
    }, ms);
  }

  // ── Feature update ────────────────────────────────────────────
  _onFeatureWDO(features) {
    this.lastFeatures = features;
    // Timer de pré-leilão inicia por horário — sem depender de phase
    // _analisar() já tem o filtro de janela 8h55→9h00:25 interno
    if (!this.timer) {
      this.timer = setInterval(() => this._analisar('pre_leilao_15s'), INTERVALO_NORMAL);
    }
  }

  // ── Iceberg detectado → chamada imediata ──────────────────────
  _onIceberg(iceberg) {
    this.lastIceberg = { ...iceberg, detectedAt: Date.now() };
    // Só chama durante leilão real + cooldown 5s entre chamadas
    const now = Date.now();
    // Iceberg relevante apenas na janela 8h55→9h00:25
    const _brt2 = new Date(Date.now() - 3*60*60*1000);
    const _h2 = _brt2.getUTCHours(); const _m2 = _brt2.getUTCMinutes(); const _s2 = _brt2.getUTCSeconds();
    const naJanelaIce = (_h2 === 8 && _m2 >= 55) || (_h2 === 9 && _m2 === 0 && _s2 <= 25);
    if (!naJanelaIce) return;
    if (this._isAnalyzing) return;
    if (now - (this._lastIcebergCall || 0) < 5000) return;
    this._lastIcebergCall = now;
    this.log.info(`🧊 Iceberg detectado @ ${iceberg.price} (${iceberg.side}) — chamando Claude imediatamente`);
    this._analisar('iceberg_detectado');
  }

  // ── Análise principal ─────────────────────────────────────────
  async _analisar(motivo) {
    if (this._isAnalyzing) return;
    // Permite análise com dados só macro se Cedro ainda não mandou ticks
    if (!this.lastFeatures) this.lastFeatures = {};

    // ── Só analisa na janela de abertura (8h50-9h10 BRT) ──────
    const now = new Date();
    const brt = new Date(now.getTime() - 3 * 60 * 60 * 1000);
    const h = brt.getUTCHours();
    const m = brt.getUTCMinutes();
    const s = brt.getUTCSeconds();
    // ── Janela de aquecimento: 8h55 → 9h00:20 ──────────────────
    // Cedro já manda theor_price + surplus + auc_vol desde 8h55 (leilão teórico)
    // Claude analisa com dados reais — auc_vol cresce conforme ordens casam
    const naAquecimento = (h === 8 && m >= 55) ||
                          (h === 9 && m === 0 && s <= 20);

    // ── Janela de veredicto: 9h00:20 → 9h00:50 ──────────────────
    // Aguarda 1º negócio real (auc_vol >= 100) → dispara veredicto final → para
    const naJanelaVeredicto = (h === 9 && m === 0 && s > 20 && s <= 50);

    if (!naAquecimento && !naJanelaVeredicto) {
      this._claudeIniciouNotificado = false;
      this.veredictoFinalEmitido = false; // reset para próximo pregão
      this._sairJanela();
      return;
    }

    // Veredicto final: dispara 1x quando 1º negócio chega (auc_vol ≥ 100)
    if (naJanelaVeredicto) {
      const auc_vol = this.lastFeatures?.auc_vol || this.lastFeatures?.auction?.volumeAtAuction || 0;
      if (auc_vol >= 100 && !this.veredictoFinalEmitido) {
        this.veredictoFinalEmitido = true;
        // Para o timer imediatamente — veredicto é 1 call única
        if (this.timer) { clearInterval(this.timer); this.timer = null; }
        this.log.info('🏁 1º negócio detectado (auc_vol=' + auc_vol + ') → VEREDICTO FINAL');
        motivo = 'veredicto_final';
        // Continua para a call abaixo
      } else {
        return; // aguarda auc_vol ≥ 100 ou veredicto já emitido
      }
    }

    if (!naAquecimento && motivo !== 'veredicto_final') return;

    // Notifica Telegram imediatamente na 1ª janela — ANTES da call
    if (!this._claudeIniciouNotificado) {
      this._claudeIniciouNotificado = true;
      this.bus.emit('claude:iniciou', { hora: new Date().toLocaleTimeString('pt-BR') });
    }

    // Claude analisa por horário — não depende de estado PRE_OPEN/AUCTION
    // Dados da Cedro chegam desde 8h55 independente do estado
    this._isAnalyzing = true;
    try {

    if (this.stubMode) {
      this._emitirStub(motivo);
      return;
    }

    try {
      this.totalChamadas++;
      this.log.info(`Claude #${this.totalChamadas} [${motivo}]`);

      // ── Proteção 1: Timeout adaptativo — 25s na janela crítica, 15s fora ──
      // CRÍTICO: durante 8h55→9h00:50 o prompt é maior e o sistema precisa de resposta real
      // Aumentar timeout evita cair em DEGRADED MODE com 90% aggressor ratio (bug 12/06)
      const _brtT = new Date(Date.now() - 3*60*60*1000);
      const _hT = _brtT.getUTCHours(); const _mT = _brtT.getUTCMinutes(); const _sT = _brtT.getUTCSeconds();
      const _naJanelaCritica = (_hT === 8 && _mT >= 55) || (_hT === 9 && _mT === 0 && _sT <= 50);
      const TIMEOUT_MS = _naJanelaCritica ? 25000 : 15000;
      const TIMEOUT_LABEL = _naJanelaCritica ? 'TIMEOUT_25S_CRITICO' : 'TIMEOUT_15S';
      const timeoutPromise = new Promise((_, reject) =>
        setTimeout(() => reject(new Error(TIMEOUT_LABEL)), TIMEOUT_MS)
      );

      const claudePromise = this.client.messages.create({
        model:      'claude-sonnet-4-6',
        max_tokens: MAX_TOKENS,
        system: [
          { type: 'text', text: this._systemPrompt(), cache_control: { type: 'ephemeral' } },
          { type: 'text', text: this._jsonSchema(),    cache_control: { type: 'ephemeral' } },
        ],
        messages:   [{ role: 'user', content: this._buildPrompt(motivo) }],
      });

      const response = await Promise.race([claudePromise, timeoutPromise]);

      const text    = response.content[0]?.text || '';
      const analise = this._parsear(text, motivo);
      this.lastAnalise  = analise;
      this.lastAnaliseCache = analise; // ── Proteção 2: salva cache
      this.claudeErros  = 0;
      this.claudeOffline = false;

      this.log.info(`Veredito: ${analise.veredito} | Confiança: ${(analise.confianca*100).toFixed(0)}% | Motivo: ${motivo}`);
      this.bus.emit('ai:analise', analise);

    } catch (e) {
      this.claudeErros++;

      if (e.message.startsWith('TIMEOUT_')) {
        this.log.warn(`⏱️ Claude timeout (${e.message}) — usando cache anterior`);
      } else {
        this.log.error('Erro Claude API:', e.message);
      }

      // ── Proteção 2: usa cache se disponível ──────────────────
      if (this.lastAnaliseCache) {
        this.log.warn('📦 Usando análise em cache do último segundo');
        const cached = { ...this.lastAnaliseCache, fromCache: true };
        this.bus.emit('ai:analise', cached);
        return;
      }

      // ── Proteção 3: modo degradado se 3+ erros consecutivos ──
      if (this.claudeErros >= 3) {
        this.claudeOffline = true;
        this.log.warn('🔴 Claude OFFLINE — ativando modo degradado');
        this._modoDegradado(motivo);
        return;
      }

      this._emitirStub(motivo);
    }
    } finally {
      this._isAnalyzing = false;
    }
  }

  // ── System prompt ─────────────────────────────────────────────
  _systemPrompt() {
    return `Você é um trader quantitativo especialista em leilão de abertura do WDO (Mini Dólar Futuro B3).
Analisa dados em tempo real durante a janela 8h55→9h00:45 BRT e decide se há confluência suficiente para entrar.

IMPORTANTE: Durante o leilão o Book L2 (SuperDOM) fica BAGUNÇADO — NÃO use dados do book diretamente.
Baseie sua análise em: Preço Teórico, Superávit, Volume do Leilão, Agressor Ratio, Flow Delta e Macro.

SOBRE ICEBERG: A ProfitDLL NÃO informa diretamente se uma ordem é iceberg.
O iceberg é INFERIDO estatisticamente pelo sistema (mesmo preço reaparecendo, volume acumulado anômalo).
Durante o leilão essa inferência é MENOS confiável — trate com ceticismo moderado.
Se iceberg detectado: considere como sinal de suporte, mas não como confirmação absoluta.

Sua confiança deve refletir TODOS os critérios abaixo com seus pesos:

PESOS DA CONFIANÇA:
- Macro alinhado (DXY + USDBRL + Treasury): +20% se todos alinhados, -30% se divergente
- Confluência DOL x WDO (direção + agressão + fluxo): +25% se alinhados, -35% se divergentes  
- Preço teórico estável: +15% se estável 3+ ticks, -20% se oscilando
- Superávit crescente: +15% se crescendo, -15% se estagnado
- Iceberg INFERIDO na direção do sinal: +10% (inferência estatística — peso reduzido)
- Iceberg INFERIDO CONTRÁRIO ao sinal: confiança MÁXIMA 70% (sinal de alerta, mas não certeza)
- Sem iceberg detectado: neutro (0%)
- Volume do leilão acelerando: +10% se crescendo

REGRA CRÍTICA: Se confluência DOL x WDO divergir → confiança MÁXIMA de 65% (não entra).
REGRA CRÍTICA: Se macro divergir → confiança MÁXIMA de 70% (não entra).
REGRA CRÍTICA: Confiança ≥ 85% = OPERAR. Abaixo = NAO_OPERAR.

CÁLCULO DO ALVO 1 (quando confiança ≥ 85%):
O Alvo 1 deve ter 85% de confiança de ser atingido.

BASE DO MOVIMENTO (superávit):
- Superávit pequeno (<200): 4-6 ticks (2-3pts)
- Superávit médio (200-500): 8-12 ticks (4-6pts)
- Superávit grande (>500): 14-20 ticks (7-10pts)

AJUSTES MACRO:
- DXY moveu >0.2% → +4 ticks
- VIX>25 → -4 ticks (volatilidade adversa)
- Gap overnight >0.5% → +6 ticks (gap a fechar)
- DOL+WDO alinhados forte → +4 ticks

SUPORTE E RESISTÊNCIA VIA TAPE (book indisponível durante leilão):
REGRA FUNDAMENTAL: Escora detectada pelo volume acumulado no tape — não pelo book.

- ESCORA NO TAPE: nível com muito volume negociado sem preço romper
  → Obstáculo real → alvo PARA ANTES da escora
- ABSORÇÃO: iceberg consumindo agressores no mesmo nível por múltiplos ticks
  → Escora sendo devorada → alvo cheio (rompimento provável)
- ABSORÇÃO PURA: iceberg + agressor forte sem resistência
  → Força direcional confirmada → +4 ticks no alvo
- EXAUSTÃO: momentum fraco + volume contrário crescendo no tape
  → -4 ticks no alvo
- TAPE LIMPO: sem escoras, sem exaustão → alvo cheio conforme superávit

Stop FIXO: 6 ticks (3pts) abaixo/acima da entrada.
RR mínimo aceitável: 2.0 (Alvo1 ≥ 12 ticks se stop=6 ticks).

Responda SOMENTE em JSON válido sem markdown.`;
  }

  // ── Prompt completo ───────────────────────────────────────────
  _buildPrompt(motivo) {
    const f  = this.lastFeatures;
    const fd = this.lastDOL;
    const m  = this.lastMacro;
    const ic = this.lastIceberg;

    const icebergAtivo = ic && (Date.now() - ic.detectedAt) < 30000;

    const macroTxt = m ? `
MACRO (atualizado ${Math.round((Date.now()-m.fetchedAt)/1000)}s atrás):
- DXY: ${m.dxy?.price?.toFixed(3)} (${m.dxy?.changePct?.toFixed(3)}%)
- USD/BRL: ${m.usdbrl?.price?.toFixed(4)} (${m.usdbrl?.changePct?.toFixed(3)}%)
- Treasury 10y: ${m.treasury10y?.price?.toFixed(3)}% (${m.treasury10y?.changePct?.toFixed(2)}%)
- VIX: ${m.vix?.price?.toFixed(2)} ${m.vix?.price > 25 ? '⚠️ ELEVADO' : ''}
- S&P Fut: ${m.sp500?.price?.toFixed(2)} (${m.sp500?.changePct?.toFixed(2)}%)
- Score Macro: ${m.macroScore} | Sinal: ${m.macroSignal}` 
    : 'MACRO: Não disponível ainda';

    const dolTxt = fd ? `
DOL CHEIO:
- Último: ${fd.last} | Fase: ${fd.phase}
- Leilão TP: ${fd.auction?.theoreticalPrice?.toFixed(2) ?? 'calculando'}
- Superávit: ${fd.auction?.surplus} | Lado: ${fd.auction?.side ?? '?'}
- Agressão: ${(fd.aggRatio*100).toFixed(0)}% compradores
- Flow Delta: ${fd.flowDelta}
- Vol leilão: ${fd.auction?.volumeAtAuction}`
    : 'DOL: Aguardando dados';

    // Contexto de mercado
    const ctx = this.lastContext || {};
    
    const gapTxt = ctx.gap ? `
GAP OVERNIGHT:
- Fechamento ontem: ${ctx.gap.prevClose}
- Gap atual: ${ctx.gap.gapPct > 0 ? '+' : ''}${ctx.gap.gapPct}% (${ctx.gap.classificacao})
- Direção gap: ${ctx.gap.direcaoGap?.toUpperCase()}
${ctx.gap.gapRelevante ? '⚠️ GAP RELEVANTE — considerar na análise' : '✓ Gap pequeno — dinâmica normal'}` 
    : 'GAP: Calculando fechamento de ontem...';

    let calTxt = 'CALENDARIO: Verificando eventos do dia...';
    if (ctx.calendario) {
      if (ctx.calendario.temEventoCritico) {
        const evList = (ctx.calendario.eventosProximos || []).map(e => '  -> ' + e.nome + ' (' + e.pais + ') as ' + e.hora).join('\n');
        calTxt = 'CALENDARIO HOJE:\n' + (ctx.calendario.eventosProximos||[]).length + ' evento(s) ALTO IMPACTO proximas 2h:\n' + evList;
      } else { calTxt = 'CALENDARIO HOJE: Sem eventos criticos nas proximas 2h'; }
    }
    let mmTxt = 'FORMADORES: Disponivel com Cedro PRO';
    if (ctx.formadores && ctx.formadores.fonte !== 'placeholder') {
      mmTxt = 'FORMADORES (Cedro): ' + ctx.formadores.totalNiveis + ' niveis | Lado: ' + (ctx.formadores.ladoDominante||'').toUpperCase();
    }

    // ── Análise de Tape/Book avançada ────────────────────────
    const tapeAnalysis = this._analyzeTape(f, fd);

    const icebergTxt = icebergAtivo ? `
🧊 ICEBERG ATIVO (${Math.round((Date.now()-ic.detectedAt)/1000)}s atrás):
- Preço: ${ic.price} | Lado: ${ic.side === 'bid' ? 'COMPRADOR' : 'VENDEDOR'}
- Apareceu: ${ic.count}x | Volume acumulado: ${ic.totalVol} contratos`
    : 'ICEBERG: Nenhum ativo no momento';

    return `MOTIVO DA ANÁLISE: ${motivo}

${gapTxt}

${calTxt}

${mmTxt}

${macroTxt}

${dolTxt}

WDO MINI:
- Último: ${f.last} | VWAP: ${f.vwap} | vs VWAP: ${f.priceVsVwap}
- Leilão TP: ${f.auction?.theoreticalPrice?.toFixed(2) ?? 'calculando'}
- Superávit: ${f.auction?.surplus} | Lado: ${f.auction?.side ?? '?'}
- Agressão: ${(f.aggRatio*100).toFixed(0)}% compradores
- Flow Delta: ${f.flowDelta}
- Book Imbalance: ${f.bookImbalance?.toFixed(3)}
- Vol leilão: ${f.auction?.volumeAtAuction}
- Momentum: ${f.momentum} | Volatilidade: ${f.volatility}

CONFLUÊNCIA DOL x WDO:
- Direção: DOL ${fd?.auction?.side ?? '?'} / WDO ${f.auction?.side ?? '?'}
- Agressão: DOL ${fd ? (fd.aggRatio*100).toFixed(0) : '?'}% / WDO ${(f.aggRatio*100).toFixed(0)}%
- Fluxo: DOL ${fd?.flowDelta ?? '?'} / WDO ${f.flowDelta}

${icebergTxt}

Retorne o JSON conforme o schema definido nas instruções do sistema.`;
  }

  // ── JSON Schema (cacheado — não muda entre chamadas) ──────────
  _jsonSchema() {
    return `FORMATO DE RESPOSTA — retorne EXATAMENTE este JSON, sem markdown. Seja telegráfico. IMPORTANTE: mesmo que veredito=NAO_OPERAR por evento, preencha direcao_sem_evento e confianca_sem_evento com análise técnica pura (ignorando o evento):
{
  "veredito": "OPERAR_BUY|OPERAR_SELL|NAO_OPERAR",
  "direcao": "buy|sell|neutro",
  "confianca": 0.0,
  "preco_entrada": 0.0,
  "confluencia_dol_wdo": "alinhado|divergente|neutro",
  "alinhamento_macro": "favoravel|adverso|neutro",
  "iceberg_relevante": true,
  "reasoning": "máx 10 palavras",
  "risco_principal": "máx 8 palavras",
  "leitura_leilao": "máx 8 palavras",
  "leitura_macro": "máx 8 palavras",
  "impacto_gap": "positivo|negativo|neutro",
  "risco_calendario": true,
  "alvo1_ticks": 0,
  "alvo1_preco": 0.0,
  "alvo1_confianca": 0.0,
  "stop_ticks": 6,
  "stop_preco": 0.0,
  "rr": 0.0,
  "amplitude_esperada": "X-Y pts",
  "base_calculo_alvo": "máx 8 palavras",
  "escora_detectada": false,
  "escora_preco": 0.0,
  "absorcao_detectada": false,
  "exaustao_detectada": false,
  "leitura_tape": "máx 8 palavras",
  "alerta_pos_abertura": "MANTER|FECHAR_ALVO|FECHAR_PARCIAL|FECHAR_TOTAL|AGUARDAR",
  "distancia_alvo_ticks": 0,
  "distancia_stop_ticks": 0,
  "direcao_sem_evento": "buy|sell|neutro",
  "confianca_sem_evento": 0.0,
  "motivo_bloqueio": "ex: NFP 10h30 | null"
}`;
  }

  // ── Parse resposta ────────────────────────────────────────────
  _parsear(text, motivo) {
    try {
      const clean  = text.replace(/```json|```/g, '').trim();
      const parsed = JSON.parse(clean);
      return {
        timestamp:          Date.now(),
        fase:               this.lastFeatures?.phase,
        motivo,
        veredito:           parsed.veredito           || 'NAO_OPERAR',
        direcao:            parsed.direcao            || 'neutro',
        confianca:          parseFloat(parsed.confianca || 0),
        precoEntrada:       parseFloat(parsed.preco_entrada || 0),
        confluenciaDolWdo:  parsed.confluencia_dol_wdo || 'neutro',
        alinhamentoMacro:   parsed.alinhamento_macro   || 'neutro',
        icebergRelevante:   parsed.iceberg_relevante   || false,
        reasoning:          parsed.reasoning           || '',
        riscoPrincipal:     parsed.risco_principal     || '',
        impactoGap:         parsed.impacto_gap         || 'neutro',
        riscoCalendario:    parsed.risco_calendario     || false,
        alvo1Ticks:         parsed.alvo1_ticks          || 0,
        alvo1Preco:         parseFloat(parsed.alvo1_preco || 0),
        alvo1Confianca:     parseFloat(parsed.alvo1_confianca || 0),
        stopTicks:          parsed.stop_ticks            || 6,
        stopPreco:          parseFloat(parsed.stop_preco  || 0),
        rr:                 parseFloat(parsed.rr          || 0),
        amplitudeEsperada:  parsed.amplitude_esperada    || '',
        baseCalculoAlvo:    parsed.base_calculo_alvo     || '',
        escoraDetectada:    parsed.escora_detectada      || false,
        escoraPreco:        parseFloat(parsed.escora_preco || 0),
        absorcaoDetectada:  parsed.absorcao_detectada    || false,
        exaustaoDetectada:  parsed.exaustao_detectada    || false,
        leituraTape:        parsed.leitura_tape          || '',
        alertaPosAbertura:  parsed.alerta_pos_abertura   || 'AGUARDAR',
        distanciaAlvo:      parsed.distancia_alvo_ticks  || 0,
        distanciaStop:      parsed.distancia_stop_ticks  || 0,
        leituraLeilao:      parsed.leitura_leilao      || '',
        leituraMacro:       parsed.leitura_macro       || '',
        direcaoSemEvento:   parsed.direcao_sem_evento   || 'neutro',
        confiancaSemEvento: parseFloat(parsed.confianca_sem_evento || 0),
        motivoBloqueio:     parsed.motivo_bloqueio       || null,
        source:             'claude',
        totalChamadas:      this.totalChamadas,
      };
    } catch {
      this.log.warn('Falha ao parsear JSON do Claude');
      return this._defaultAnalise(motivo);
    }
  }

  // ── Stub mode ─────────────────────────────────────────────────
  // ── Modo Degradado — Risk Engine decide sem Claude ──────────
  _modoDegradado(motivo) {
    const f = this.lastFeatures;
    if (!f) return;

    // Filtros hard — decisão sem IA
    const tpEstavel   = f.tpStable;
    const surpusFort  = (f.surplus || 0) > 300;
    const dolAlinhado = f.dolWdoConfluence?.aligned;
    const volOk       = (f.auc_vol || 0) >= 100;

    const aprovado = tpEstavel && surpusFort && dolAlinhado && volOk;
    const confianca = aprovado ? 0.72 : 0.35; // nunca chega a 85% — só avisa

    const analise = {
      veredito:    aprovado ? 'COMPRA' : 'NAO_OPERAR',
      confianca,
      direcao:     f.surplus > 0 ? 'buy' : 'sell',
      alvo1Ticks:  10,
      stopTicks:   6,
      justificativa: `⚠️ MODO DEGRADADO (Claude offline) — Filtros hard: TP=${tpEstavel?'✓':'✗'} Surplus=${surpusFort?'✓':'✗'} DOL=${dolAlinhado?'✓':'✗'}`,
      fromDegradado: true,
    };

    this.log.warn(`🔴 MODO DEGRADADO | ${analise.veredito} | ${(confianca*100).toFixed(0)}%`);
    this.bus.emit('ai:analise', analise);
  }

  _emitirStub(motivo) {
    const f  = this.lastFeatures || {};
    const fd = this.lastDOL || {};
    const m  = this.lastMacro;

    const direcaoWDO = f.auction?.side;
    const direcaoDOL = fd.auction?.side;
    const confluente = direcaoWDO && direcaoDOL && direcaoWDO === direcaoDOL;

    const direcao = confluente ? direcaoWDO : 'neutro';
    const baseConf = confluente ? 0.55 : 0.35;
    const macroBonus = m?.macroScore > 0 ? 0.1 : m?.macroScore < 0 ? -0.1 : 0;
    const confianca = Math.min(0.82, Math.max(0.2, baseConf + macroBonus));

    const analise = {
      timestamp:         Date.now(),
      fase:              f.phase,
      motivo,
      veredito:          'NAO_OPERAR',
      direcao,
      confianca,
      precoEntrada:      f.auction?.theoreticalPrice || f.last || 0,
      confluenciaDolWdo: confluente ? 'alinhado' : 'divergente',
      alinhamentoMacro:  m?.macroSignal || 'neutro',
      icebergRelevante:  false,
      reasoning:         '[STUB] Configure ANTHROPIC_API_KEY para análise real.',
      riscoPrincipal:    'Modo stub — sem análise de IA real',
      leituraLeilao:     `TP ${f.auction?.theoreticalPrice?.toFixed(2) ?? '?'}, superávit ${f.auction?.surplus ?? 0}`,
      leituraMacro:      m ? `Score macro ${m.macroScore}` : 'Macro não disponível',
      source:            'stub',
      totalChamadas:     this.totalChamadas,
    };
    this.lastAnalise = analise;
    this.bus.emit('ai:analise', analise);
  }

  _defaultAnalise(motivo) {
    return { timestamp: Date.now(), veredito: 'NAO_OPERAR', direcao: 'neutro', confianca: 0.3, source: 'erro', motivo };
  }

  // ── Análise de Tape/Book — Separado por Fase ───────────────
  _analyzeTape(wdo, dol) {
    const fase  = wdo?.phase || 'continuous';
    const book  = wdo?.book;
    const ic    = this.lastIceberg;
    const icebergAtivo = ic && (Date.now() - (ic.detectedAt||0)) < 30000;
    const th    = this.thresholds;

    if (!book) return 'Book nao disponivel ainda';

    const bids   = book.bids || [];
    const asks   = book.asks || [];
    const allQty = [...bids, ...asks].map(l => l.qty);
    const avgQty = allQty.reduce((a,b) => a+b, 0) / (allQty.length || 1);
    const imb    = book.imbalance || 0;
    const lines  = [];
    const alerts = [];

    // ════════════════════════════════════════════════════════
    // FASE LEILÃO (pre_open / auction)
    // Só distribuição de ordens — sem tape de negócios real
    // ════════════════════════════════════════════════════════
    if (fase === 'auction' || fase === 'pre_open') {

      // 1. ESCORA ───────────────────────────────────────────
      const escorasAsk = asks.filter(a => a.qty > avgQty * th.escora_multiplicador).sort((a,b) => b.qty-a.qty);
      const escorasBid = bids.filter(b => b.qty > avgQty * th.escora_multiplicador).sort((a,b) => b.qty-a.qty);

      // 2. ABSORÇÃO (iceberg consumindo escora) ─────────────
      const absAsk = icebergAtivo && ic.side === 'bid' && escorasAsk.length > 0 && ic.totalVol >= escorasAsk[0].qty * th.absorcao_ratio;
      const absBid = icebergAtivo && ic.side === 'ask' && escorasBid.length > 0 && ic.totalVol >= escorasBid[0].qty * th.absorcao_ratio;
      const absPura = icebergAtivo && !absAsk && !absBid;

      if (escorasAsk.length > 0) {
        const e = escorasAsk[0];
        if (absAsk) {
          lines.push('ESCORA VENDEDORA @ ' + e.price + ' (' + e.qty + ' lotes) ABSORVIDA — rompimento provavel, alvo cheio');
          alerts.push('ABSORCAO_ROMPIMENTO');
        } else {
          lines.push('ESCORA VENDEDORA SOLIDA @ ' + e.price + ' (' + e.qty + ' lotes, ' + Math.round(e.qty/avgQty) + 'x media) — teto real, fechar antes');
          alerts.push('ESCORA_TETO');
        }
      }
      if (escorasBid.length > 0) {
        const e = escorasBid[0];
        if (absBid) {
          lines.push('ESCORA COMPRADORA @ ' + e.price + ' (' + e.qty + ' lotes) ABSORVIDA — suporte rompendo');
          alerts.push('ABSORCAO_SUPORTE');
        } else {
          lines.push('ESCORA COMPRADORA SOLIDA @ ' + e.price + ' (' + e.qty + ' lotes) — suporte forte, alvo seguro acima');
          alerts.push('ESCORA_SUPORTE');
        }
      }
      if (absPura) {
        const lado = ic.side === 'bid' ? 'COMPRADORA' : 'VENDEDORA';
        lines.push('ABSORCAO ' + lado + ' PURA: iceberg x' + ic.count + ' (' + ic.totalVol + ' lotes) — forca direcional confirmada, alvo cheio');
        alerts.push('ABSORCAO_PURA');
      }

      // 3. IMBALANCE DO BOOK ─────────────────────────────────
      if (Math.abs(imb) > 0.5) {
        lines.push('PRESSAO ' + (imb > 0 ? 'COMPRADORA' : 'VENDEDORA') + ' FORTE no book (imbalance ' + imb.toFixed(2) + ')');
      }

      // 4. PREÇO TEÓRICO OSCILANDO ──────────────────────────
      const tp     = wdo?.auction?.theoreticalPrice;
      const surplus = wdo?.auction?.surplus || 0;
      if (tp) {
        if (Math.abs(surplus) > 500) {
          lines.push('SUPERAVIT FORTE: ' + surplus + ' lotes — pressao direcional intensa no leilao');
        } else if (Math.abs(surplus) < 50) {
          lines.push('LEILAO EQUILIBRADO: superavit apenas ' + surplus + ' — direcao indefinida, cautela');
        }
      }

      if (lines.length === 0) {
        lines.push('LEILAO: book em formacao, sem padroes relevantes ainda');
      }
    }

    // ════════════════════════════════════════════════════════
    // FASE PÓS-ABERTURA (continuous)
    // Mercado aberto — tape de negócios real disponível
    // ════════════════════════════════════════════════════════
    else {
      const ticks      = wdo?.ticks || [];
      const ultimosTicks = ticks.slice(-5);
      const momentum   = wdo?.momentum   || 0;
      const aggRatio   = wdo?.aggRatio   || 0.5;

      // 1. ESCORA (ainda relevante no contínuo) ─────────────
      const escorasAsk = asks.filter(a => a.qty > avgQty * th.escora_multiplicador).sort((a,b) => b.qty-a.qty);
      const escorasBid = bids.filter(b => b.qty > avgQty * th.escora_multiplicador).sort((a,b) => b.qty-a.qty);
      const absAsk = icebergAtivo && ic?.side === 'bid' && escorasAsk.length > 0;
      const absBid = icebergAtivo && ic?.side === 'ask' && escorasBid.length > 0;

      if (escorasAsk.length > 0 && !absAsk) {
        lines.push('ESCORA VENDEDORA @ ' + escorasAsk[0].price + ' (' + escorasAsk[0].qty + ' lotes) — resistencia a frente');
        alerts.push('ESCORA_TETO');
      }
      if (escorasAsk.length > 0 && absAsk) {
        lines.push('ESCORA VENDEDORA SENDO ABSORVIDA — rompimento em curso');
        alerts.push('ABSORCAO_ROMPIMENTO');
      }

      // 2. STOPPING VOLUME ───────────────────────────────────
      const lastTick = ticks[ticks.length - 1];
      if (lastTick && lastTick.trade_vol >= th.stopping_volume && Math.abs(momentum) < 0.5) {
        lines.push('STOPPING VOLUME: ' + lastTick.trade_vol + ' lotes sem movimento — reversao iminente');
        alerts.push('STOPPING_VOLUME');
      }

      // 3. EFFORT VS RESULT ──────────────────────────────────
      const volAlto = ultimosTicks.filter(t => (t.trade_vol||0) >= th.effort_lotes).length;
      if (volAlto >= 3 && Math.abs(momentum) < 1.0) {
        lines.push('EFFORT VS RESULT: volume alto (' + volAlto + '/5 ticks) sem resultado — exaustao de ' + (momentum > 0 ? 'compradores' : 'vendedores'));
        alerts.push('EFFORT_RESULT');
      }

      // 4. NO SUPPLY / NO DEMAND ─────────────────────────────
      const ticksContrarios = ultimosTicks.filter(t => {
        const contra = momentum > 0
          ? t.last < (ticks[ticks.length-2]?.last || t.last)
          : t.last > (ticks[ticks.length-2]?.last || t.last);
        return contra && (t.trade_vol||0) < th.no_supply_max;
      });
      if (ticksContrarios.length >= 2) {
        lines.push((momentum > 0 ? 'NO SUPPLY' : 'NO DEMAND') + ': retracoes com volume baixo — sem resistencia real, caminho livre');
        alerts.push('NO_SUPPLY_DEMAND');
      }

      // 5. TEST ──────────────────────────────────────────────
      if (ticks.length >= 6) {
        const p0 = ticks[ticks.length-6]?.last || 0;
        const p1 = ticks[ticks.length-1]?.last  || 0;
        const retornou = Math.abs(p1 - p0) < 1.0;
        const volBaixo = ultimosTicks.every(t => (t.trade_vol||0) < th.test_max);
        if (retornou && volBaixo) {
          lines.push('TEST: nivel retestado com volume baixo — suporte/resistencia confirmado');
          alerts.push('TEST_CONFIRMADO');
        }
      }

      // 6. EXAUSTÃO REAL ─────────────────────────────────────
      const exComp = momentum > 0 && aggRatio < 0.45 && imb < -0.2;
      const exVend = momentum < 0 && aggRatio > 0.55 && imb > 0.2;
      if (exComp) {
        lines.push('EXAUSTAO COMPRADORA: vendedor crescendo contra a alta — nao esticar alvo');
        alerts.push('EXAUSTAO');
      } else if (exVend) {
        lines.push('EXAUSTAO VENDEDORA: comprador crescendo contra a baixa — nao esticar alvo');
        alerts.push('EXAUSTAO');
      }

      if (lines.length === 0) {
        lines.push('POS-ABERTURA: sem padroes relevantes — monitorando');
      }
    }

    // Emite alertas para log adaptativo
    if (alerts.length > 0) {
      this.bus.emit('tape:alertas', { alerts, fase, timestamp: Date.now() });
    }

    return lines.join('\n');
  }


  // ── Detector de Esgotamento de Liquidez ─────────────────────
  _detectarEsgotamento(wdo, direction) {
    if (!wdo) return null;
    const ticks  = wdo.ticks || [];
    const book   = wdo.book;
    const th     = this.thresholds;
    const scores = [];
    const motivos = [];

    if (ticks.length < 4) return null;

    const ultimos = ticks.slice(-4);
    const isCompra = direction === 'buy';

    // ── Score 1: Volume decrescente na direção ────────────────
    const volsDirecao = ultimos
      .filter(t => isCompra ? t.last >= (t.ask||t.last) : t.last <= (t.bid||t.last))
      .map(t => t.trade_vol || 0);

    if (volsDirecao.length >= 3) {
      let decrescente = true;
      for (let i = 1; i < volsDirecao.length; i++) {
        if (volsDirecao[i] >= volsDirecao[i-1]) { decrescente = false; break; }
      }
      if (decrescente) {
        const queda = volsDirecao.length > 1
          ? (volsDirecao[0] - volsDirecao[volsDirecao.length-1]) / (volsDirecao[0] || 1)
          : 0;
        if (queda >= 0.70) {
          scores.push(2);
          motivos.push('Volume ' + direction + ' caiu ' + Math.round(queda*100) + '%');
        }
      }
    }

    // ── Score 2: Lote contrário crescendo ─────────────────────
    const volsContra = ultimos
      .filter(t => isCompra ? t.last <= (t.bid||t.last) : t.last >= (t.ask||t.last))
      .map(t => t.trade_vol || 0);

    if (volsContra.length >= 3) {
      let crescente = true;
      for (let i = 1; i < volsContra.length; i++) {
        if (volsContra[i] <= volsContra[i-1]) { crescente = false; break; }
      }
      if (crescente && volsContra[volsContra.length-1] >= 50) {
        scores.push(2);
        motivos.push('Lote contrário crescendo: ' + volsContra[volsContra.length-1] + ' lotes');
      }
    }

    // ── Score 3: Book secando ─────────────────────────────────
    if (book) {
      const bids = book.bids || [];
      const asks = book.asks || [];
      const ladoBook = isCompra ? bids : asks;
      const niveisFortes = ladoBook.filter(l => l.qty >= (th.no_supply_max * 2)).length;
      if (niveisFortes < 2) {
        scores.push(1);
        motivos.push('Book ' + (isCompra?'compra':'venda') + ' secando (' + niveisFortes + ' níveis)');
      }
    }

    // ── Score 4: Velocidade caindo ────────────────────────────
    if (ticks.length >= 8) {
      const antes  = ticks.slice(-8,-4);
      const agora  = ticks.slice(-4);
      const velAntes = antes.length > 1 ? (antes[antes.length-1].timestamp - antes[0].timestamp) / antes.length : 0;
      const velAgora = agora.length > 1 ? (agora[agora.length-1].timestamp - agora[0].timestamp) / agora.length : 0;
      if (velAgora > velAntes * 2.5 && velAntes > 0) {
        scores.push(1);
        motivos.push('Mercado esfriando (velocidade -' + Math.round((1-velAntes/velAgora)*100) + '%)');
      }
    }

    const totalScore = scores.reduce((a,b) => a+b, 0);
    if (totalScore === 0) return null;

    return {
      score:   totalScore,
      alerta:  totalScore >= 4 ? 'FECHAR_TOTAL' : totalScore >= 2 ? 'FECHAR_PARCIAL' : 'MONITORAR',
      motivos,
      timestamp: Date.now(),
    };
  }

  stop() {
    if (this.timer)            { clearInterval(this.timer);            this.timer = null; }
    this.veredictoFinalEmitido = false;
  }

  getLastAnalise() { return this.lastAnalise; }
}

module.exports = { ClaudeAIEngine };
