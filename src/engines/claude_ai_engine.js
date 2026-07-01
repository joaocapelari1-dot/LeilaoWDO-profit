/**
 * ClaudeAIEngine v2
 * 
 * Fora da janela: anÃ¡lise a cada 15s (contexto geral)
 * Janela 9h00â9h01: anÃ¡lise a cada 1s
 * Iceberg detectado: chamada imediata extra
 * 
 * ConfianÃ§a composta avalia:
 * - Micro: preÃ§o teÃ³rico, superÃ¡vit, volume, book, icebergs
 * - ConfluÃªncia DOL x WDO: direÃ§Ã£o + agressÃ£o + fluxo
 * - Macro: DXY, USD/BRL (proxy DI), Treasury, VIX
 */
const Anthropic = require('@anthropic-ai/sdk');
const { Logger } = require('../utils/logger');

const INTERVALO_NORMAL     = 60000; // 60s — conversa acumulativa   // 5s â call Claude ~3-4s, sem sobreposiÃ§Ã£o
const MAX_TOKENS = 600;

// HorÃ¡rios BRT

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

    // ── Conversa acumulativa ─────────────────────────────────────
    this.conversaHistorico = [];
    this.conversaIniciada  = false;
    this.updateCount       = 0;

    // ── AdaptiveLog temporário do leilão ─────────────────────────
    // Grava snapshots a cada 30s durante 8h55-9h01.
    // Se Claude cair, lê esse log para retomar contexto.
    this.leilaoLog      = [];
    this.leilaoLogTimer = null;

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

    // -- Timer por horario -- inicia as 8h55 independente de ticks --
    this._agendarInicio855();
    bus.on('feature:dol',        (f) => { this.lastDOL = f; });
    bus.on('macro:update',       (m) => { this.lastMacro = m; });

    // ââ ProteÃ§Ãµes de resiliÃªncia ââââââââââââââââââââââââââââââ
    this.lastAnaliseCache       = null;   // cache do Ãºltimo resultado
    this.claudeOffline           = false;  // flag se Anthropic caiu
    this.claudeErros             = 0;      // contador de erros consecutivos
    this.veredictoFinalEmitido   = false;  // garante 1 veredicto final por pregÃ£o
    bus.on('iceberg:detected',   (ic) => this._onIceberg(ic));
    bus.on('claude:reiniciar',    () => {
      this.lastAnaliseCache = null;
      this.claudeErros = 0;
      this.claudeOffline = false;
      this.log.info('Cache do Claude limpo manualmente — próxima análise será nova');
    });
    bus.on('risk:approved',      (s) => { this.lastSignalDirection = s.direction; });
// Janela encerra por horÃ¡rio â sem dependÃªncia do AuctionSM
  }

  _initClient() {
    const key = process.env.ANTHROPIC_API_KEY;
    if (!key || key.includes('YOUR_KEY')) {
      this.log.warn('ANTHROPIC_API_KEY nÃ£o configurado â modo STUB ativo');
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

  // ââ Janela encerrada â sem pÃ³s-abertura, sem estados ââââââââââ
  _sairJanela() {
    if (this.timer) { clearInterval(this.timer); this.timer = null; }
    if (this.leilaoLogTimer) { clearInterval(this.leilaoLogTimer); this.leilaoLogTimer = null; }
    if (this.leilaoLog && this.leilaoLog.length > 0) {
      this.log.info(`AdaptiveLog leilao: ${this.leilaoLog.length} snapshots — limpando`);
      this.leilaoLog = [];
    }
    // standby silencioso â nÃ£o logar fora da janela (evita spam no log)
  }

  // ââ Agendamento por horÃ¡rio â inicia Ã s 8h55 sem depender de ticks ââ
  _agendarInicio855() {
    const now  = new Date();
    const brt  = new Date(now.getTime() - 3 * 60 * 60 * 1000);
    const h = brt.getUTCHours(), m = brt.getUTCMinutes(), s = brt.getUTCSeconds();

    // JÃ¡ estÃ¡ na janela? â inicia imediatamente
    const naJanela = (h === 8 && m >= 55) || (h === 9 && m === 0 && s <= 50);
    if (naJanela) {
      this.log.info('Claude IA: jÃ¡ na janela 8h55 â iniciando timer agora');
      if (!this.timer) {
        this.timer = setInterval(() => this._analisar('pre_leilao_10s'), INTERVALO_NORMAL);
        this._analisar('inicio_janela');
      }
      return;
    }

    // Calcular ms atÃ© 8h55 BRT (BRT = UTC-3) â apenas dias Ãºteis (seg-sex)
    const alvo = new Date(now);
    alvo.setUTCHours(11, 55, 0, 0); // 8h55 BRT = 11h55 UTC
    let ms = alvo - now;
    if (ms <= 0) {
      // JÃ¡ passou hoje â agenda para o prÃ³ximo dia
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
      this.log.info('Claude IA: 8h55 â iniciando anÃ¡lise por horÃ¡rio');
      if (!this.timer) {
        this.timer = setInterval(() => this._analisar('pre_leilao_10s'), INTERVALO_NORMAL);
        this._analisar('inicio_janela');
      }
    }, ms);
  }

  // ââ Feature update ââââââââââââââââââââââââââââââââââââââââââââ
  _onFeatureWDO(features) {
    this.lastFeatures = features;
    // Timer de prÃ©-leilÃ£o inicia por horÃ¡rio â sem depender de phase
    // _analisar() jÃ¡ tem o filtro de janela 8h55â9h00:25 interno
    if (!this.timer) {
      this.timer = setInterval(() => this._analisar('pre_leilao_15s'), INTERVALO_NORMAL);
    }
  }

  // ââ Iceberg detectado â chamada imediata ââââââââââââââââââââââ
  _onIceberg(iceberg) {
    this.lastIceberg = { ...iceberg, detectedAt: Date.now() };
    // SÃ³ chama durante leilÃ£o real + cooldown 5s entre chamadas
    const now = Date.now();
    // Iceberg relevante apenas na janela 8h55â9h00:25
    const _brt2 = new Date(Date.now() - 3*60*60*1000);
    const _h2 = _brt2.getUTCHours(); const _m2 = _brt2.getUTCMinutes(); const _s2 = _brt2.getUTCSeconds();
    const naJanelaIce = (_h2 === 8 && _m2 >= 55) || (_h2 === 9 && _m2 === 0 && _s2 <= 25);
    if (!naJanelaIce) return;
    if (this._isAnalyzing) return;
    if (now - (this._lastIcebergCall || 0) < 5000) return;
    this._lastIcebergCall = now;
    this.log.info(`ð§ Iceberg detectado @ ${iceberg.price} (${iceberg.side}) â chamando Claude imediatamente`);
    this._analisar('iceberg_detectado');
  }

  // ââ AnÃ¡lise principal âââââââââââââââââââââââââââââââââââââââââ
  async _analisar(motivo) {
    if (this._isAnalyzing) return;
    // Permite analise com dados so macro se ProfitBridge ainda nao mandou ticks
    if (!this.lastFeatures) this.lastFeatures = {};

    // ââ SÃ³ analisa na janela de abertura (8h50-9h10 BRT) ââââââ
    const now = new Date();
    const brt = new Date(now.getTime() - 3 * 60 * 60 * 1000);
    const h = brt.getUTCHours();
    const m = brt.getUTCMinutes();
    const s = brt.getUTCSeconds();
    // ââ Janela de aquecimento: 8h55 â 9h00:20 ââââââââââââââââââ
    // ProfitBridge manda theor_price + surplus + auc_vol desde 8h55 (leilao teorico)
    // Claude analisa com dados reais â auc_vol cresce conforme ordens casam
    const naAquecimento = (h === 8 && m >= 55) ||
                          (h === 9 && m === 0 && s <= 20);

    // ââ Janela de veredicto: 9h00:20 â 9h00:50 ââââââââââââââââââ
    // Aguarda 1Âº negÃ³cio real (auc_vol >= 100) â dispara veredicto final â para
    const naJanelaVeredicto = (h === 9 && m === 0 && s > 20 && s <= 50);

    if (!naAquecimento && !naJanelaVeredicto) {
      this._claudeIniciouNotificado = false;
      this.veredictoFinalEmitido = false; // reset para prÃ³ximo pregÃ£o
      this._sairJanela();
      return;
    }

    // Veredicto final: dispara 1x quando 1Âº negÃ³cio chega (auc_vol â¥ 100)
    if (naJanelaVeredicto) {
      const auc_vol = this.lastFeatures?.auc_vol || this.lastFeatures?.auction?.volumeAtAuction || 0;
      if (auc_vol >= 100 && !this.veredictoFinalEmitido) {
        this.veredictoFinalEmitido = true;
        // Para o timer imediatamente â veredicto Ã© 1 call Ãºnica
        if (this.timer) { clearInterval(this.timer); this.timer = null; }
        this.log.info('ð 1Âº negÃ³cio detectado (auc_vol=' + auc_vol + ') â VEREDICTO FINAL');
        motivo = 'veredicto_final';
        // Continua para a call abaixo
      } else {
        return; // aguarda auc_vol â¥ 100 ou veredicto jÃ¡ emitido
      }
    }

    if (!naAquecimento && motivo !== 'veredicto_final') return;

    // Notifica Telegram imediatamente na 1Âª janela â ANTES da call
    if (!this._claudeIniciouNotificado) {
      this._claudeIniciouNotificado = true;
      this.conversaHistorico = [];
      this.conversaIniciada  = false;
      this.updateCount       = 0;
      this.leilaoLog         = [];
      if (this.leilaoLogTimer) clearInterval(this.leilaoLogTimer);
      this.leilaoLogTimer = setInterval(() => this._gravarLeilaoLog(), 30000);
      this._gravarLeilaoLog(); // snapshot imediato
      this.bus.emit('claude:iniciou', { hora: new Date().toLocaleTimeString('pt-BR') });
    }

    // Claude analisa por horÃ¡rio â nÃ£o depende de estado PRE_OPEN/AUCTION
    // Dados chegam desde 8h55 independente do estado
    this._isAnalyzing = true;
    try {

    if (this.stubMode) {
      this._emitirStub(motivo);
      return;
    }

    try {
      this.totalChamadas++;
      this.log.info(`Claude #${this.totalChamadas} [${motivo}]`);

      // ââ ProteÃ§Ã£o 1: Timeout adaptativo â 25s na janela crÃ­tica, 15s fora ââ
      // CRÃTICO: durante 8h55â9h00:50 o prompt Ã© maior e o sistema precisa de resposta real
      // Aumentar timeout evita cair em DEGRADED MODE com 90% aggressor ratio (bug 12/06)
      const _brtT = new Date(Date.now() - 3*60*60*1000);
      const _hT = _brtT.getUTCHours(); const _mT = _brtT.getUTCMinutes(); const _sT = _brtT.getUTCSeconds();
      const _naJanelaCritica = (_hT === 8 && _mT >= 55) || (_hT === 9 && _mT === 0 && _sT <= 50);
      const TIMEOUT_MS = _naJanelaCritica ? 25000 : 15000;
      const TIMEOUT_LABEL = _naJanelaCritica ? 'TIMEOUT_25S_CRITICO' : 'TIMEOUT_15S';
      const timeoutPromise = new Promise((_, reject) =>
        setTimeout(() => reject(new Error(TIMEOUT_LABEL)), TIMEOUT_MS)
      );

      // ── Conversa acumulativa ────────────────────────────────────
      this.updateCount++;
      const isFirst = !this.conversaIniciada;
      const isFinal = motivo === 'veredicto_final';
      const userMsg = isFirst
        ? this._buildPromptInicial(motivo)
        : isFinal
          ? this._buildPromptVeredictoFinal()
          : this._buildPromptUpdate(motivo);

      this.conversaHistorico.push({ role: 'user', content: userMsg });

      const claudePromise = this.client.messages.create({
        model:      'claude-sonnet-4-6',
        max_tokens: isFinal ? 800 : 300,
        system: [
          { type: 'text', text: this._systemPrompt(), cache_control: { type: 'ephemeral' } },
          { type: 'text', text: this._jsonSchema(),    cache_control: { type: 'ephemeral' } },
        ],
        messages: this.conversaHistorico,
      });

      const response = await Promise.race([claudePromise, timeoutPromise]);

      const text    = response.content[0]?.text || '';
      this.conversaHistorico.push({ role: 'assistant', content: text });
      this.conversaIniciada = true;
      if (this.conversaHistorico.length > 20) this.conversaHistorico.splice(2, 2);
      const analise = this._parsear(text, motivo);
      this.lastAnalise  = analise;
      this.lastAnaliseCache = { ...analise, cacheTs: Date.now() }; // ââ ProteÃ§Ã£o 2: salva cache
      this.claudeErros  = 0;
      this.claudeOffline = false;

      this.log.info(`Veredito: ${analise.veredito} | ConfianÃ§a: ${(analise.confianca*100).toFixed(0)}% | Motivo: ${motivo}`);
      this.bus.emit('ai:analise', analise);

    } catch (e) {
      this.claudeErros++;

      // Proteção do histórico: remove mensagem user sem resposta
      if (this.conversaHistorico.length > 0 &&
          this.conversaHistorico[this.conversaHistorico.length - 1].role === 'user') {
        this.conversaHistorico.pop();
        this.log.warn('Historico corrigido — removida msg user sem resposta');
      }

      // 3+ erros: resetar conversa usando leilaoLog para recuperação
      if (this.claudeErros >= 3) {
        const resumo = this._resumirLeilaoLog();
        this.conversaHistorico = resumo
          ? [{ role: 'user', content: 'RECUPERACAO APOS FALHA. Retome a analise:

' + resumo }]
          : [];
        this.conversaIniciada = this.conversaHistorico.length > 0;
        this.updateCount      = 0;
        this.log.warn('Conversa resetada — ' + (resumo ? 'leilaoLog injetado' : 'sem historico'));
      }

      if (e.message.startsWith('TIMEOUT_')) {
        this.log.warn(`â±ï¸ Claude timeout (${e.message}) â usando cache anterior`);
      } else {
        this.log.error('Erro Claude API:', e.message);
      }

      // ââ ProteÃ§Ã£o 2: usa cache se disponÃ­vel ââââââââââââââââââ
      if (this.lastAnaliseCache) {
        this.log.warn('ð¦ Usando anÃ¡lise em cache do Ãºltimo segundo');
        const cached = { ...this.lastAnaliseCache, fromCache: true, cacheTs: this.lastAnaliseCache?.cacheTs || Date.now() };
        this.bus.emit('ai:analise', cached);
        return;
      }

      // ââ ProteÃ§Ã£o 3: modo degradado se 3+ erros consecutivos ââ
      if (this.claudeErros >= 3) {
        this.claudeOffline = true;
        this.log.warn('ð´ Claude OFFLINE â ativando modo degradado');
        this._modoDegradado(motivo);
        return;
      }

      this._emitirStub(motivo);
    }
    } finally {
      this._isAnalyzing = false;
    }
  }

  // ââ System prompt âââââââââââââââââââââââââââââââââââââââââââââ
  _systemPrompt() {
    return `VocÃª Ã© um trader quantitativo especialista em leilÃ£o de abertura do WDO (Mini DÃ³lar Futuro B3).
Analisa dados em tempo real durante a janela 8h55â9h00:45 BRT e decide se hÃ¡ confluÃªncia suficiente para entrar.

IMPORTANTE: Durante o leilÃ£o o Book L2 (SuperDOM) fica BAGUNÃADO â NÃO use dados do book diretamente.
Baseie sua anÃ¡lise em: PreÃ§o TeÃ³rico, SuperÃ¡vit, Volume do LeilÃ£o, Agressor Ratio, Flow Delta e Macro.

SOBRE ICEBERG: A ProfitDLL NÃO informa diretamente se uma ordem Ã© iceberg.
O iceberg Ã© INFERIDO estatisticamente pelo sistema (mesmo preÃ§o reaparecendo, volume acumulado anÃ´malo).
Durante o leilÃ£o essa inferÃªncia Ã© MENOS confiÃ¡vel â trate com ceticismo moderado.
Se iceberg detectado: considere como sinal de suporte, mas nÃ£o como confirmaÃ§Ã£o absoluta.

Sua confianÃ§a deve refletir TODOS os critÃ©rios abaixo com seus pesos:

PESOS DA CONFIANÃA:
- Macro alinhado (DXY + USDBRL + Treasury): +20% se todos alinhados, -30% se divergente
- ConfluÃªncia DOL x WDO (direÃ§Ã£o + agressÃ£o + fluxo): +25% se alinhados, -35% se divergentes  
- PreÃ§o teÃ³rico estÃ¡vel: +15% se estÃ¡vel 3+ ticks, -20% se oscilando
- SuperÃ¡vit crescente: +15% se crescendo, -15% se estagnado
- Iceberg INFERIDO na direÃ§Ã£o do sinal: +10% (inferÃªncia estatÃ­stica â peso reduzido)
- Iceberg INFERIDO CONTRÃRIO ao sinal: confianÃ§a MÃXIMA 70% (sinal de alerta, mas nÃ£o certeza)
- Sem iceberg detectado: neutro (0%)
- Volume do leilÃ£o acelerando: +10% se crescendo

REGRA CRÃTICA: Se confluÃªncia DOL x WDO divergir â confianÃ§a MÃXIMA de 65% (nÃ£o entra).
REGRA CRÃTICA: Se macro divergir â confianÃ§a MÃXIMA de 70% (nÃ£o entra).
REGRA CRÃTICA: ConfianÃ§a â¥ 85% = OPERAR. Abaixo = NAO_OPERAR.

CÃLCULO DO ALVO 1 (quando confianÃ§a â¥ 85%):
O Alvo 1 deve ter 85% de confianÃ§a de ser atingido.

BASE DO MOVIMENTO (superÃ¡vit):
- SuperÃ¡vit pequeno (<200): 4-6 ticks (2-3pts)
- SuperÃ¡vit mÃ©dio (200-500): 8-12 ticks (4-6pts)
- SuperÃ¡vit grande (>500): 14-20 ticks (7-10pts)

AJUSTES MACRO:
- DXY moveu >0.2% â +4 ticks
- VIX>25 â -4 ticks (volatilidade adversa)
- Gap overnight >0.5% â +6 ticks (gap a fechar)
- DOL+WDO alinhados forte â +4 ticks

SUPORTE E RESISTÃNCIA VIA TAPE (book indisponÃ­vel durante leilÃ£o):
REGRA FUNDAMENTAL: Escora detectada pelo volume acumulado no tape â nÃ£o pelo book.

- ESCORA NO TAPE: nÃ­vel com muito volume negociado sem preÃ§o romper
  â ObstÃ¡culo real â alvo PARA ANTES da escora
- ABSORÃÃO: iceberg consumindo agressores no mesmo nÃ­vel por mÃºltiplos ticks
  â Escora sendo devorada â alvo cheio (rompimento provÃ¡vel)
- ABSORÃÃO PURA: iceberg + agressor forte sem resistÃªncia
  â ForÃ§a direcional confirmada â +4 ticks no alvo
- EXAUSTÃO: momentum fraco + volume contrÃ¡rio crescendo no tape
  â -4 ticks no alvo
- TAPE LIMPO: sem escoras, sem exaustÃ£o â alvo cheio conforme superÃ¡vit

Stop FIXO: 6 ticks (3pts) abaixo/acima da entrada.
RR mÃ­nimo aceitÃ¡vel: 2.0 (Alvo1 â¥ 12 ticks se stop=6 ticks).

Responda SOMENTE em JSON vÃ¡lido sem markdown.`;
  }

  // ââ Prompt completo âââââââââââââââââââââââââââââââââââââââââââ
  _buildPrompt(motivo) {
    const f  = this.lastFeatures;
    const fd = this.lastDOL;
    const m  = this.lastMacro;
    const ic = this.lastIceberg;

    const icebergAtivo = ic && (Date.now() - ic.detectedAt) < 30000;

    const macroTxt = m ? `
MACRO (atualizado ${Math.round((Date.now()-m.fetchedAt)/1000)}s atrÃ¡s):
- DXY: ${m.dxy?.price?.toFixed(3)} (${m.dxy?.changePct?.toFixed(3)}%)
- USD/BRL: ${m.usdbrl?.price?.toFixed(4)} (${m.usdbrl?.changePct?.toFixed(3)}%)
- Treasury 10y: ${m.treasury10y?.price?.toFixed(3)}% (${m.treasury10y?.changePct?.toFixed(2)}%)
- VIX: ${m.vix?.price?.toFixed(2)} ${m.vix?.price > 25 ? 'â ï¸ ELEVADO' : ''}
- S&P Fut: ${m.sp500?.price?.toFixed(2)} (${m.sp500?.changePct?.toFixed(2)}%)
- Score Macro: ${m.macroScore} | Sinal: ${m.macroSignal}` 
    : 'MACRO: NÃ£o disponÃ­vel ainda';

    const dolTxt = fd ? `
DOL CHEIO:
- Ãltimo: ${fd.last} | Fase: ${fd.phase}
- LeilÃ£o TP: ${fd.auction?.theoreticalPrice?.toFixed(2) ?? 'calculando'}
- SuperÃ¡vit: ${fd.auction?.surplus} | Lado: ${fd.auction?.side ?? '?'}
- AgressÃ£o: ${(fd.aggRatio*100).toFixed(0)}% compradores
- Flow Delta: ${fd.flowDelta}
- Vol leilÃ£o: ${fd.auction?.volumeAtAuction}`
    : 'DOL: Aguardando dados';

    // Contexto de mercado
    const ctx = this.lastContext || {};
    
    const gapTxt = ctx.gap ? `
GAP OVERNIGHT:
- Fechamento ontem: ${ctx.gap.prevClose}
- Gap atual: ${ctx.gap.gapPct > 0 ? '+' : ''}${ctx.gap.gapPct}% (${ctx.gap.classificacao})
- DireÃ§Ã£o gap: ${ctx.gap.direcaoGap?.toUpperCase()}
${ctx.gap.gapRelevante ? 'â ï¸ GAP RELEVANTE â considerar na anÃ¡lise' : 'â Gap pequeno â dinÃ¢mica normal'}` 
    : 'GAP: Calculando fechamento de ontem...';

    let calTxt = 'CALENDARIO: Verificando eventos do dia...';
    if (ctx.calendario) {
      if (ctx.calendario.temEventoCritico) {
        const evList = (ctx.calendario.eventosProximos || []).map(e => '  -> ' + e.nome + ' (' + e.pais + ') as ' + e.hora).join('\n');
        calTxt = 'CALENDARIO HOJE:\n' + (ctx.calendario.eventosProximos||[]).length + ' evento(s) ALTO IMPACTO proximas 2h:\n' + evList;
      } else { calTxt = 'CALENDARIO HOJE: Sem eventos criticos nas proximas 2h'; }
    }
    let mmTxt = 'FORMADORES: Indisponivel';
    if (ctx.formadores && ctx.formadores.fonte !== 'placeholder') {
      mmTxt = 'FORMADORES: ' + ctx.formadores.totalNiveis + ' niveis | Lado: ' + (ctx.formadores.ladoDominante||'').toUpperCase();
    }

    // ââ AnÃ¡lise de Tape/Book avanÃ§ada ââââââââââââââââââââââââ
    const tapeAnalysis = this._analyzeTape(f, fd);

    const icebergTxt = icebergAtivo ? `
ð§ ICEBERG ATIVO (${Math.round((Date.now()-ic.detectedAt)/1000)}s atrÃ¡s):
- PreÃ§o: ${ic.price} | Lado: ${ic.side === 'bid' ? 'COMPRADOR' : 'VENDEDOR'}
- Apareceu: ${ic.count}x | Volume acumulado: ${ic.totalVol} contratos`
    : 'ICEBERG: Nenhum ativo no momento';

    return `MOTIVO DA ANÃLISE: ${motivo}

${gapTxt}

${calTxt}

${mmTxt}

${macroTxt}

${dolTxt}

WDO MINI:
- Ãltimo: ${f.last} | VWAP: ${f.vwap} | vs VWAP: ${f.priceVsVwap}
- LeilÃ£o TP: ${f.auction?.theoreticalPrice?.toFixed(2) ?? 'calculando'}
- SuperÃ¡vit: ${f.auction?.surplus} | Lado: ${f.auction?.side ?? '?'}
- AgressÃ£o: ${(f.aggRatio*100).toFixed(0)}% compradores
- Flow Delta: ${f.flowDelta}
- Book Imbalance: ${f.bookImbalance?.toFixed(3)}
- Vol leilÃ£o: ${f.auction?.volumeAtAuction}
- Momentum: ${f.momentum} | Volatilidade: ${f.volatility}

CONFLUÃNCIA DOL x WDO:
- DireÃ§Ã£o: DOL ${fd?.auction?.side ?? '?'} / WDO ${f.auction?.side ?? '?'}
- AgressÃ£o: DOL ${fd ? (fd.aggRatio*100).toFixed(0) : '?'}% / WDO ${(f.aggRatio*100).toFixed(0)}%
- Fluxo: DOL ${fd?.flowDelta ?? '?'} / WDO ${f.flowDelta}

${icebergTxt}

Retorne o JSON conforme o schema definido nas instruÃ§Ãµes do sistema.`;
  }

  // ââ JSON Schema (cacheado â nÃ£o muda entre chamadas) ââââââââââ
  _jsonSchema() {
    return `FORMATO DE RESPOSTA â retorne EXATAMENTE este JSON, sem markdown. Seja telegrÃ¡fico. IMPORTANTE: mesmo que veredito=NAO_OPERAR por evento, preencha direcao_sem_evento e confianca_sem_evento com anÃ¡lise tÃ©cnica pura (ignorando o evento):
{
  "veredito": "OPERAR_BUY|OPERAR_SELL|NAO_OPERAR",
  "direcao": "buy|sell|neutro",
  "confianca": 0.0,
  "preco_entrada": 0.0,
  "confluencia_dol_wdo": "alinhado|divergente|neutro",
  "alinhamento_macro": "favoravel|adverso|neutro",
  "iceberg_relevante": true,
  "reasoning": "mÃ¡x 10 palavras",
  "risco_principal": "mÃ¡x 8 palavras",
  "leitura_leilao": "mÃ¡x 8 palavras",
  "leitura_macro": "mÃ¡x 8 palavras",
  "impacto_gap": "positivo|negativo|neutro",
  "risco_calendario": true,
  "alvo1_ticks": 0,
  "alvo1_preco": 0.0,
  "alvo1_confianca": 0.0,
  "stop_ticks": 6,
  "stop_preco": 0.0,
  "rr": 0.0,
  "amplitude_esperada": "X-Y pts",
  "base_calculo_alvo": "mÃ¡x 8 palavras",
  "escora_detectada": false,
  "escora_preco": 0.0,
  "absorcao_detectada": false,
  "exaustao_detectada": false,
  "leitura_tape": "mÃ¡x 8 palavras",
  "alerta_pos_abertura": "MANTER|FECHAR_ALVO|FECHAR_PARCIAL|FECHAR_TOTAL|AGUARDAR",
  "distancia_alvo_ticks": 0,
  "distancia_stop_ticks": 0,
  "direcao_sem_evento": "buy|sell|neutro",
  "confianca_sem_evento": 0.0,
  "motivo_bloqueio": "ex: NFP 10h30 | null"
}`;
  }

  // ââ Parse resposta ââââââââââââââââââââââââââââââââââââââââââââ
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

  // ââ Stub mode âââââââââââââââââââââââââââââââââââââââââââââââââ
  // ââ Modo Degradado â Risk Engine decide sem Claude ââââââââââ
  _modoDegradado(motivo) {
    const f = this.lastFeatures;
    if (!f) return;

    // Filtros hard â decisÃ£o sem IA
    const tpEstavel   = f.tpStable;
    const surpusFort  = (f.surplus || 0) > 300;
    const dolAlinhado = f.dolWdoConfluence?.aligned;
    const volOk       = (f.auc_vol || 0) >= 100;

    const aprovado = tpEstavel && surpusFort && dolAlinhado && volOk;
    const confianca = aprovado ? 0.72 : 0.35; // nunca chega a 85% â sÃ³ avisa

    const analise = {
      veredito:    aprovado ? 'COMPRA' : 'NAO_OPERAR',
      confianca,
      direcao:     f.surplus > 0 ? 'buy' : 'sell',
      alvo1Ticks:  10,
      stopTicks:   6,
      justificativa: `â ï¸ MODO DEGRADADO (Claude offline) â Filtros hard: TP=${tpEstavel?'â':'â'} Surplus=${surpusFort?'â':'â'} DOL=${dolAlinhado?'â':'â'}`,
      fromDegradado: true,
    };

    this.log.warn(`ð´ MODO DEGRADADO | ${analise.veredito} | ${(confianca*100).toFixed(0)}%`);
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
      reasoning:         '[STUB] Configure ANTHROPIC_API_KEY para anÃ¡lise real.',
      riscoPrincipal:    'Modo stub â sem anÃ¡lise de IA real',
      leituraLeilao:     `TP ${f.auction?.theoreticalPrice?.toFixed(2) ?? '?'}, superÃ¡vit ${f.auction?.surplus ?? 0}`,
      leituraMacro:      m ? `Score macro ${m.macroScore}` : 'Macro nÃ£o disponÃ­vel',
      source:            'stub',
      totalChamadas:     this.totalChamadas,
    };
    this.lastAnalise = analise;
    this.bus.emit('ai:analise', analise);
  }

  _defaultAnalise(motivo) {
    return { timestamp: Date.now(), veredito: 'NAO_OPERAR', direcao: 'neutro', confianca: 0.3, source: 'erro', motivo };
  }

  // ââ AnÃ¡lise de Tape/Book â Separado por Fase âââââââââââââââ
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

    // ââââââââââââââââââââââââââââââââââââââââââââââââââââââââ
    // FASE LEILÃO (pre_open / auction)
    // SÃ³ distribuiÃ§Ã£o de ordens â sem tape de negÃ³cios real
    // ââââââââââââââââââââââââââââââââââââââââââââââââââââââââ
    if (fase === 'auction' || fase === 'pre_open') {

      // 1. ESCORA âââââââââââââââââââââââââââââââââââââââââââ
      const escorasAsk = asks.filter(a => a.qty > avgQty * th.escora_multiplicador).sort((a,b) => b.qty-a.qty);
      const escorasBid = bids.filter(b => b.qty > avgQty * th.escora_multiplicador).sort((a,b) => b.qty-a.qty);

      // 2. ABSORÃÃO (iceberg consumindo escora) âââââââââââââ
      const absAsk = icebergAtivo && ic.side === 'bid' && escorasAsk.length > 0 && ic.totalVol >= escorasAsk[0].qty * th.absorcao_ratio;
      const absBid = icebergAtivo && ic.side === 'ask' && escorasBid.length > 0 && ic.totalVol >= escorasBid[0].qty * th.absorcao_ratio;
      const absPura = icebergAtivo && !absAsk && !absBid;

      if (escorasAsk.length > 0) {
        const e = escorasAsk[0];
        if (absAsk) {
          lines.push('ESCORA VENDEDORA @ ' + e.price + ' (' + e.qty + ' lotes) ABSORVIDA â rompimento provavel, alvo cheio');
          alerts.push('ABSORCAO_ROMPIMENTO');
        } else {
          lines.push('ESCORA VENDEDORA SOLIDA @ ' + e.price + ' (' + e.qty + ' lotes, ' + Math.round(e.qty/avgQty) + 'x media) â teto real, fechar antes');
          alerts.push('ESCORA_TETO');
        }
      }
      if (escorasBid.length > 0) {
        const e = escorasBid[0];
        if (absBid) {
          lines.push('ESCORA COMPRADORA @ ' + e.price + ' (' + e.qty + ' lotes) ABSORVIDA â suporte rompendo');
          alerts.push('ABSORCAO_SUPORTE');
        } else {
          lines.push('ESCORA COMPRADORA SOLIDA @ ' + e.price + ' (' + e.qty + ' lotes) â suporte forte, alvo seguro acima');
          alerts.push('ESCORA_SUPORTE');
        }
      }
      if (absPura) {
        const lado = ic.side === 'bid' ? 'COMPRADORA' : 'VENDEDORA';
        lines.push('ABSORCAO ' + lado + ' PURA: iceberg x' + ic.count + ' (' + ic.totalVol + ' lotes) â forca direcional confirmada, alvo cheio');
        alerts.push('ABSORCAO_PURA');
      }

      // 3. IMBALANCE DO BOOK âââââââââââââââââââââââââââââââââ
      if (Math.abs(imb) > 0.5) {
        lines.push('PRESSAO ' + (imb > 0 ? 'COMPRADORA' : 'VENDEDORA') + ' FORTE no book (imbalance ' + imb.toFixed(2) + ')');
      }

      // 4. PREÃO TEÃRICO OSCILANDO ââââââââââââââââââââââââââ
      const tp     = wdo?.auction?.theoreticalPrice;
      const surplus = wdo?.auction?.surplus || 0;
      if (tp) {
        if (Math.abs(surplus) > 500) {
          lines.push('SUPERAVIT FORTE: ' + surplus + ' lotes â pressao direcional intensa no leilao');
        } else if (Math.abs(surplus) < 50) {
          lines.push('LEILAO EQUILIBRADO: superavit apenas ' + surplus + ' â direcao indefinida, cautela');
        }
      }

      if (lines.length === 0) {
        lines.push('LEILAO: book em formacao, sem padroes relevantes ainda');
      }
    }

    // ââââââââââââââââââââââââââââââââââââââââââââââââââââââââ
    // FASE PÃS-ABERTURA (continuous)
    // Mercado aberto â tape de negÃ³cios real disponÃ­vel
    // ââââââââââââââââââââââââââââââââââââââââââââââââââââââââ
    else {
      const ticks      = wdo?.ticks || [];
      const ultimosTicks = ticks.slice(-5);
      const momentum   = wdo?.momentum   || 0;
      const aggRatio   = wdo?.aggRatio   || 0.5;

      // 1. ESCORA (ainda relevante no contÃ­nuo) âââââââââââââ
      const escorasAsk = asks.filter(a => a.qty > avgQty * th.escora_multiplicador).sort((a,b) => b.qty-a.qty);
      const escorasBid = bids.filter(b => b.qty > avgQty * th.escora_multiplicador).sort((a,b) => b.qty-a.qty);
      const absAsk = icebergAtivo && ic?.side === 'bid' && escorasAsk.length > 0;
      const absBid = icebergAtivo && ic?.side === 'ask' && escorasBid.length > 0;

      if (escorasAsk.length > 0 && !absAsk) {
        lines.push('ESCORA VENDEDORA @ ' + escorasAsk[0].price + ' (' + escorasAsk[0].qty + ' lotes) â resistencia a frente');
        alerts.push('ESCORA_TETO');
      }
      if (escorasAsk.length > 0 && absAsk) {
        lines.push('ESCORA VENDEDORA SENDO ABSORVIDA â rompimento em curso');
        alerts.push('ABSORCAO_ROMPIMENTO');
      }

      // 2. STOPPING VOLUME âââââââââââââââââââââââââââââââââââ
      const lastTick = ticks[ticks.length - 1];
      if (lastTick && lastTick.trade_vol >= th.stopping_volume && Math.abs(momentum) < 0.5) {
        lines.push('STOPPING VOLUME: ' + lastTick.trade_vol + ' lotes sem movimento â reversao iminente');
        alerts.push('STOPPING_VOLUME');
      }

      // 3. EFFORT VS RESULT ââââââââââââââââââââââââââââââââââ
      const volAlto = ultimosTicks.filter(t => (t.trade_vol||0) >= th.effort_lotes).length;
      if (volAlto >= 3 && Math.abs(momentum) < 1.0) {
        lines.push('EFFORT VS RESULT: volume alto (' + volAlto + '/5 ticks) sem resultado â exaustao de ' + (momentum > 0 ? 'compradores' : 'vendedores'));
        alerts.push('EFFORT_RESULT');
      }

      // 4. NO SUPPLY / NO DEMAND âââââââââââââââââââââââââââââ
      const ticksContrarios = ultimosTicks.filter(t => {
        const contra = momentum > 0
          ? t.last < (ticks[ticks.length-2]?.last || t.last)
          : t.last > (ticks[ticks.length-2]?.last || t.last);
        return contra && (t.trade_vol||0) < th.no_supply_max;
      });
      if (ticksContrarios.length >= 2) {
        lines.push((momentum > 0 ? 'NO SUPPLY' : 'NO DEMAND') + ': retracoes com volume baixo â sem resistencia real, caminho livre');
        alerts.push('NO_SUPPLY_DEMAND');
      }

      // 5. TEST ââââââââââââââââââââââââââââââââââââââââââââââ
      if (ticks.length >= 6) {
        const p0 = ticks[ticks.length-6]?.last || 0;
        const p1 = ticks[ticks.length-1]?.last  || 0;
        const retornou = Math.abs(p1 - p0) < 1.0;
        const volBaixo = ultimosTicks.every(t => (t.trade_vol||0) < th.test_max);
        if (retornou && volBaixo) {
          lines.push('TEST: nivel retestado com volume baixo â suporte/resistencia confirmado');
          alerts.push('TEST_CONFIRMADO');
        }
      }

      // 6. EXAUSTÃO REAL âââââââââââââââââââââââââââââââââââââ
      const exComp = momentum > 0 && aggRatio < 0.45 && imb < -0.2;
      const exVend = momentum < 0 && aggRatio > 0.55 && imb > 0.2;
      if (exComp) {
        lines.push('EXAUSTAO COMPRADORA: vendedor crescendo contra a alta â nao esticar alvo');
        alerts.push('EXAUSTAO');
      } else if (exVend) {
        lines.push('EXAUSTAO VENDEDORA: comprador crescendo contra a baixa â nao esticar alvo');
        alerts.push('EXAUSTAO');
      }

      if (lines.length === 0) {
        lines.push('POS-ABERTURA: sem padroes relevantes â monitorando');
      }
    }

    // Emite alertas para log adaptativo
    if (alerts.length > 0) {
      this.bus.emit('tape:alertas', { alerts, fase, timestamp: Date.now() });
    }

    return lines.join('\n');
  }


  // ââ Detector de Esgotamento de Liquidez âââââââââââââââââââââ
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

    // ââ Score 1: Volume decrescente na direÃ§Ã£o ââââââââââââââââ
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

    // ââ Score 2: Lote contrÃ¡rio crescendo âââââââââââââââââââââ
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
        motivos.push('Lote contrÃ¡rio crescendo: ' + volsContra[volsContra.length-1] + ' lotes');
      }
    }

    // ââ Score 3: Book secando âââââââââââââââââââââââââââââââââ
    if (book) {
      const bids = book.bids || [];
      const asks = book.asks || [];
      const ladoBook = isCompra ? bids : asks;
      const niveisFortes = ladoBook.filter(l => l.qty >= (th.no_supply_max * 2)).length;
      if (niveisFortes < 2) {
        scores.push(1);
        motivos.push('Book ' + (isCompra?'compra':'venda') + ' secando (' + niveisFortes + ' nÃ­veis)');
      }
    }

    // ââ Score 4: Velocidade caindo ââââââââââââââââââââââââââââ
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
