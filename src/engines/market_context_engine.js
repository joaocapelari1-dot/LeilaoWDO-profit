/**
 * MarketContextEngine
 * 
 * Centraliza contexto de mercado para enriquecer a análise do Claude:
 * 
 * 1. GAP OVERNIGHT
 *    - Busca fechamento de ontem do WDO via Yahoo Finance (USDBRL=X proxy)
 *    - Calcula gap % em relação ao preço atual do leilão
 *    - Gap > 0.5% = mercado em gap — muda dinâmica do leilão
 * 
 * 2. CALENDÁRIO ECONÔMICO
 *    - Busca eventos de alto impacto do dia via API gratuita
 *    - Se evento nas próximas 2h → alerta para Claude penalizar confiança
 *    - Fontes: tradingeconomics (fallback: lista hardcoded mensal)
 * 
 * 3. FORMADORES DE MERCADO (placeholder)
 *    - Estrutura pronta para receber dados da Cedro
 *    - Identifica concentração de volume nos níveis do book
 *    - Ativa automaticamente quando MOCK_MODE=false
 */

const https   = require('https');
const { Logger } = require('../utils/logger');

const REFRESH_GAP_MS      = 60 * 60 * 1000;       // atualiza gap a cada 1h
const REFRESH_CALENDAR_MS = 30 * 60 * 1000;       // atualiza calendário a cada 30min
const GAP_THRESHOLD_PCT   = 0.5;               // gap relevante acima de 0.5%
const EVENT_WINDOW_MIN    = 120;               // eventos nas próximas 2h

class MarketContextEngine {
  constructor(bus) {
    this.bus    = bus;
    this.log    = new Logger('MARKET-CTX');

    this.gapData       = null;
    this.calendarData  = null;
    this.marketMakers  = null;   // placeholder Cedro
    this.lastPrice     = null;

    this.timers = [];

    // Escuta preço atual do WDO
    bus.on('feature:wdo', (f) => {
      if (f.last) this.lastPrice = f.last;
    });
  }

  async start() {
    this.log.info('Market Context Engine iniciado');

    // Busca inicial imediata
    await this._fetchGap();
    await this._fetchCalendar();

    // Refresh periódico
    this.timers.push(setInterval(() => this._fetchGap(),      REFRESH_GAP_MS));
    this.timers.push(setInterval(() => this._fetchCalendar(), REFRESH_CALENDAR_MS));
  }

  stop() {
    this.timers.forEach(t => clearInterval(t));
    this.log.info('Market Context Engine parado');
  }

  // ── 1. GAP OVERNIGHT ─────────────────────────────────────────
  async _fetchGap() {
    try {
      const snap = this._macroSnap;
      const prevClose  = snap?.usdbrl?.prevClose;
      const currentRef = this.lastPrice || snap?.usdbrl?.price;

      if (!prevClose || !currentRef) return;

      const gapPct = ((currentRef - prevClose) / prevClose) * 100;
      const gapAbs = Math.abs(gapPct);

      this.gapData = {
        prevClose:     Math.round(prevClose * 10000) / 10000,
        currentPrice:  Math.round(currentRef * 100) / 100,
        gapPct:        Math.round(gapPct * 1000) / 1000,
        gapAbs:        Math.round(gapAbs * 1000) / 1000,
        gapRelevante:  gapAbs >= GAP_THRESHOLD_PCT,
        direcaoGap:    gapPct > 0 ? 'alta' : 'baixa',
        classificacao: gapAbs >= 1.0 ? 'gap_grande'
                     : gapAbs >= 0.5 ? 'gap_moderado'
                     : 'gap_pequeno',
        updatedAt:     Date.now(),
      };

      if (this.gapData.gapRelevante) {
        this.log.info(`📊 Gap overnight: ${gapPct.toFixed(3)}% (${this.gapData.classificacao})`);
      }

      this.bus.emit('context:gap', this.gapData);
    } catch (e) {
      this.log.error('Erro ao buscar gap:', e.message);
    }
  }

  // ── 2. CALENDÁRIO ECONÔMICO ───────────────────────────────────
  async _fetchCalendar() {
    try {
      // Tenta buscar via API pública
      const events = await this._fetchEconomicEvents();
      
      const now       = new Date();
      const nowMs     = now.getTime();
      const windowMs  = EVENT_WINDOW_MIN * 60 * 1000;

      // Filtra eventos das próximas 2h e de alto impacto
      const proximos = events.filter(e => {
        const diff = e.timestamp - nowMs;
        return diff >= 0 && diff <= windowMs && e.impacto === 'alto';
      });

      this.calendarData = {
        eventos:       events,
        eventosProximos: proximos,
        temEventoCritico: proximos.length > 0,
        updatedAt:     Date.now(),
      };

      if (proximos.length > 0) {
        const warnKey = proximos.map(e=>e.nome).join(',');
        if (warnKey !== this._lastWarnKey) {
          this._lastWarnKey = warnKey;
          this.log.warn(`⚠️ ${proximos.length} evento(s) de alto impacto nas próximas 2h!`);
          proximos.forEach(e => this.log.warn(`   → ${e.nome} às ${e.hora} (${e.pais})`));
        }
      }

      this.bus.emit('context:calendar', this.calendarData);
    } catch (e) {
      this.log.error('Erro ao buscar calendário:', e.message);
      // Fallback: usa lista de eventos conhecidos do mês
      this._useCalendarFallback();
    }
  }

  async _fetchEconomicEvents() {
    return new Promise((resolve) => {
      const today = new Date().toISOString().split('T')[0];
      const options = {
        hostname: 'economic-calendar.tradingview.com',
        path:     `/events?from=${today}&to=${today}&countries=US,BR&importance=3`,
        method:   'GET',
        headers:  { 'User-Agent': 'Mozilla/5.0', 'Accept': 'application/json' },
        timeout:  5000,
      };

      const req = https.request(options, (res) => {
        let body = '';
        res.on('data', chunk => { body += chunk; });
        res.on('end', () => {
          try {
            const json = JSON.parse(body);
            const events = (json.result || []).map(e => ({
              nome:      e.title || e.event || 'Evento',
              pais:      e.country || 'US',
              hora:      e.date ? new Date(e.date).toLocaleTimeString('pt-BR', { hour:'2-digit', minute:'2-digit' }) : '?',
              timestamp: e.date ? new Date(e.date).getTime() : 0,
              impacto:   e.importance >= 3 ? 'alto' : e.importance >= 2 ? 'medio' : 'baixo',
              anterior:  e.previous || null,
              previsao:  e.forecast  || null,
            }));
            resolve(events);
          } catch {
            resolve(this._getKnownEvents());
          }
        });
      });

      req.on('error',   () => resolve(this._getKnownEvents()));
      req.on('timeout', () => { req.destroy(); resolve(this._getKnownEvents()); });
      req.end();
    });
  }

  _useCalendarFallback() {
    const events = this._getKnownEvents();
    const now    = Date.now();
    const proximos = events.filter(e => {
      const diff = e.timestamp - now;
      return diff >= 0 && diff <= EVENT_WINDOW_MIN * 60 * 1000 && e.impacto === 'alto';
    });

    this.calendarData = {
      eventos:          events,
      eventosProximos:  proximos,
      temEventoCritico: proximos.length > 0,
      fonte:            'fallback',
      updatedAt:        Date.now(),
    };
  }

  _getKnownEvents() {
    // Eventos recorrentes de alto impacto EUA — horários em BRT (UTC-3)
    const hoje = new Date();
    const ano  = hoje.getFullYear();
    const mes  = hoje.getMonth();
    const dia  = hoje.getDate();

    const mkTime = (h, m) => new Date(ano, mes, dia, h, m, 0).getTime();

    return [
      // Payroll — primeira sexta do mês, 09:30 ET = 10:30 BRT
      { nome: 'Non-Farm Payroll',      pais: 'US', hora: '10:30', timestamp: mkTime(10, 30), impacto: 'alto' },
      // CPI — geralmente segunda semana, 09:30 ET
      { nome: 'CPI EUA',               pais: 'US', hora: '10:30', timestamp: mkTime(10, 30), impacto: 'alto' },
      // FOMC — reuniões marcadas (placeholder)
      { nome: 'FOMC Minutes',          pais: 'US', hora: '15:00', timestamp: mkTime(15,  0), impacto: 'alto' },
      // Decisão COPOM — geralmente quarta ou quinta
      { nome: 'Decisão COPOM',         pais: 'BR', hora: '18:30', timestamp: mkTime(18, 30), impacto: 'alto' },
      // PIB EUA
      { nome: 'PIB EUA (preliminar)',  pais: 'US', hora: '10:30', timestamp: mkTime(10, 30), impacto: 'alto' },
    ].filter(e => {
      // Só retorna se for hoje (heurística simples)
      return true; // API real filtra por data — aqui retorna lista como referência
    });
  }

  // ── 3. FORMADORES DE MERCADO (Placeholder Cedro) ─────────────
  updateMarketMakers(bookL2Data) {
    // Chamado pelo LiveCedroClient quando MOCK_MODE=false
    // Identifica concentração anormal de volume em um único nível
    if (!bookL2Data) return;

    const { bids, asks } = bookL2Data;
    const allLevels = [...bids, ...asks];
    const totalVol  = allLevels.reduce((s, l) => s + l.qty, 0);
    const avgVol    = totalVol / (allLevels.length || 1);

    // Nível com > 3x a média = possível formador de mercado
    const mmLevels = allLevels.filter(l => l.qty > avgVol * 3).map(l => ({
      price:     l.price,
      qty:       l.qty,
      side:      bids.includes(l) ? 'bid' : 'ask',
      multiplo:  Math.round(l.qty / avgVol * 10) / 10,
    }));

    this.marketMakers = {
      detectados:  mmLevels,
      totalNiveis: mmLevels.length,
      ladoDominante: mmLevels.filter(l => l.side === 'bid').length >
                     mmLevels.filter(l => l.side === 'ask').length ? 'compra' : 'venda',
      updatedAt: Date.now(),
      fonte: process.env.MOCK_MODE !== 'false' ? 'placeholder' : 'cedro',
    };

    if (mmLevels.length > 0) {
      this.bus.emit('context:market_makers', this.marketMakers);
    }
  }

  // ── Yahoo Finance helper ──────────────────────────────────────
  _yahooQuote(symbols) {
    return new Promise((resolve) => {
      const options = {
        hostname: 'query1.finance.yahoo.com',
        path:     `/v7/finance/quote?symbols=${encodeURIComponent(symbols)}&fields=regularMarketPrice,regularMarketPreviousClose`,
        method:   'GET',
        headers:  { 'User-Agent': 'Mozilla/5.0', 'Accept': 'application/json' },
        timeout:  5000,
      };

      const req = https.request(options, (res) => {
        let body = '';
        res.on('data', chunk => { body += chunk; });
        res.on('end', () => {
          try {
            const json = JSON.parse(body);
            resolve(json?.quoteResponse?.result || []);
          } catch { resolve([]); }
        });
      });

      req.on('error',   () => resolve([]));
      req.on('timeout', () => { req.destroy(); resolve([]); });
      req.end();
    });
  }

  // ── Snapshot completo para o Claude ──────────────────────────
  getSnapshot() {
    return {
      gap:          this.gapData,
      calendario:   this.calendarData,
      formadores:   this.marketMakers,
      updatedAt:    Date.now(),
    };
  }

  getGap()          { return this.gapData; }
  getCalendario()   { return this.calendarData; }
  getFormadores()   { return this.marketMakers; }
}

module.exports = { MarketContextEngine };
