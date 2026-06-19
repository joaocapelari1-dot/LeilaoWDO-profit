/**
 * MacroEngine
 * Puxa dados macro via Alpha Vantage + Twelve Data.
 * 
 * Schedule (horário de Brasília):
 *   08h45 → liga, atualiza a cada 30s
 *   08h59 → streaming contínuo (a cada 2s)
 *   09h00 → máxima frequência (a cada 500ms)
 *   Leilão → CONTINUOUS = para
 * 
 * Zero tokens de IA. Dados brutos em memória.
 * Claude só é chamado quando os dados mudam além dos thresholds.
 */

const https = require('https');
const { Logger } = require('../utils/logger');

// ── Ativos monitorados ────────────────────────────────────────
// ── Parâmetros CIP ───────────────────────────────────────────
const SELIC_ANUAL   = 0.1050;  // 10.50% ao ano — atualizar manualmente quando COPOM mudar
const TREASURY_ANUAL = 0.045;  // Treasury fallback

const SYMBOLS = {
  // Mercado americano
  SP500_FUT:  'ES=F',    // S&P500 futuros
  NASDAQ_FUT: 'NQ=F',    // Nasdaq futuros
  DOW_FUT:    'YM=F',    // Dow futuros
  VIX:        '^VIX',    // Volatilidade (medo)
  DXY:        'DX-Y.NYB',// Índice do dólar

  // Treasuries (yields)
  TNX:        '^TNX',    // Treasury 10 anos
  IRX:        '^IRX',    // Treasury 3 meses (proxy 2y)

  // Commodities
  OIL_WTI:   'CL=F',    // Petróleo WTI
  OIL_BRENT: 'BZ=F',    // Petróleo Brent
  GOLD:      'GC=F',    // Ouro

  // Brasil
  IBOV:      '^BVSP',   // Ibovespa
  USDBRL:    'BRL=X',   // USD/BRL spot
};

// ── Thresholds para alertar Claude ───────────────────────────
const CHANGE_THRESHOLDS = {
  DXY:        0.10,  // 0.10%
  VIX:        1.00,  // 1 ponto absoluto
  TNX:        0.02,  // 2 bps
  SP500_FUT:  0.20,  // 0.20%
  NASDAQ_FUT: 0.25,
  OIL_WTI:    0.30,
  USDBRL:     0.15,
  IBOV:       0.20,
};

// ── Horários BRT (UTC-3) ──────────────────────────────────────
const SCHEDULE = {
  START_HOUR:   8,
  START_MIN:    45,
  FAST_HOUR:    8,
  FAST_MIN:     59,
  ULTRA_HOUR:   9,
  ULTRA_MIN:    0,
};

const INTERVAL_NORMAL = 2 * 60 * 1000; // 2min — ~216 créditos/dia (limite 800/dia)   // 60s
const INTERVAL_FAST   = 2000;    // 2s
const INTERVAL_ULTRA  = 500;     // 500ms

class MacroEngine {
  constructor(bus) {
    this.bus       = bus;
    this.log       = new Logger('MACRO-ENGINE');
    this.snapshot  = {};           // dados mais recentes
    this.prevSnap  = {};           // snapshot anterior (para detectar mudanças)
    this.timer     = null;
    this.scheduleTimer = null;
    this.running   = false;
    this.mode      = 'stopped';    // stopped | normal | fast | ultra
    this.fetchCount = 0;

// Macro roda o dia todo em modo normal — sem dependência do AuctionSM
  }

  // ── Start ─────────────────────────────────────────────────
  start() {
    // Se já passou das 8h45 e ainda não são 18h, liga imediatamente
    const now  = new Date();
    const brt  = new Date(now.getTime() - 3 * 60 * 60 * 1000);
    const h    = brt.getUTCHours();
    const m    = brt.getUTCMinutes();
    const mins = h * 60 + m;
    const start845 = 8 * 60 + 45;
    const close18  = 18 * 60;

    if (mins >= start845 && mins < close18) {
      this.log.info('Macro Engine iniciado dentro da janela — ligando imediatamente');
    // Buscar range CME madrugada às 8h45
    const brtNow = new Date(Date.now() - 3 * 60 * 60 * 1000);
    const hNow = brtNow.getUTCHours(); const mNow = brtNow.getUTCMinutes();
    if (hNow === 8 && mNow >= 44 && mNow <= 50) {
      this._fetchCMERange().then(range => {
        if (range) {
          this.snapshot.cmeRange = range;
          this.log.info('CME Range madrugada: ' + range.min + '-' + range.max + ' (' + range.range + ' pts)');
          this.bus.emit('macro:update', this.snapshot);
        }
      });
    }
      this._startNormal();
      this._scheduleClose();
    } else {
      this.log.info('Macro Engine iniciado — aguardando janela 08h45 BRT');
      this._scheduleStart();
    }
  }

  stop() {
    if (this.timer)         { clearInterval(this.timer);  this.timer = null; }
    if (this.scheduleTimer) { clearTimeout(this.scheduleTimer); this.scheduleTimer = null; }
    this.running = false;
    this.mode    = 'stopped';
    this.log.info('Macro Engine parado');
  }

  // ── Agendamento ───────────────────────────────────────────
  _scheduleClose() {
    const raw = this._msUntil(18, 0);
    const msUntilClose = Math.min(Math.max(raw, 1000), 12 * 60 * 60 * 1000); // 1s a 12h
    setTimeout(() => {
      this.stop();
      this.log.info('B3 fechada — Macro Engine parado (18h BRT)');
      this._scheduleStart();
    }, msUntilClose);
    this.log.info('B3 fecha em ' + Math.round(msUntilClose/60000) + 'min (18h BRT)');
  }

  _scheduleStart() {
    const raw845 = this._msUntil(SCHEDULE.START_HOUR, SCHEDULE.START_MIN);
    const msUntil845 = Math.min(Math.max(raw845, 1000), 16 * 60 * 60 * 1000); // 1s a 16h
    this.log.info(`Próxima ativação em ${Math.round(msUntil845 / 1000)}s (08h45 BRT)`);

    this.scheduleTimer = setTimeout(() => {
      this._startNormal();
      this._scheduleClose();
    }, msUntil845);
  }

  _startNormal() {
    this.log.info('🟡 MACRO: Modo NORMAL — atualizando a cada 60s');
    this.bus.emit('macro:bom_dia', { hora: new Date().toLocaleTimeString('pt-BR') });
    this.running = true;
    this.mode    = 'normal';
    // Aguarda 90s antes da 1ª call — evita estouro se houver Redeploy
    // (múltiplos boots em sequência não chamam a API simultaneamente)
    this.log.info('Macro: aguardando 90s antes da 1ª call Twelve Data...');
    setTimeout(() => {
      if (this.running) {
        this._fetch();
        this.timer = setInterval(() => this._fetch(), INTERVAL_NORMAL);
      }
    }, 90000);
  }

  // Modos RAPIDO e ULTRA removidos — macro sempre 60s

  // ── Fetch Multi-Source ─────────────────────────────────
  // Alpha Vantage: SPY (S&P), VIXY (proxy VIX), UUP (proxy DXY), GLD (ouro)
  // Twelve Data:   USD/BRL, EUR/USD
  // FRED:          Treasury 10Y
  async _fetch() {
    try {
      // Throttle Twelve Data: máx 1 call a cada 30s independente do modo (evita rate limit)
      const now = Date.now();
      // Se rate limit ativo, não chama até meia-noite UTC
      if (this._rateLimitUntil && now < this._rateLimitUntil) {
        this.bus.emit('macro:update', this.snapshot);
        return;
      }
      if (this._lastTwelveFetch && (now - this._lastTwelveFetch) < 60000) {
        this.bus.emit('macro:update', this.snapshot);
        return;
      }
      this._lastTwelveFetch = now;
      const raw = await this._fetchTwelveDataAll();

      this.prevSnap = { ...this.snapshot };
      this.snapshot = this._normalizeMulti(raw);
      this.snapshot.fetchedAt  = Date.now();
      this.snapshot.fetchCount = ++this.fetchCount;
      this.snapshot.mode       = this.mode;

      this.bus.emit('macro:update', this.snapshot);
      this.log.info('Macro: SPY=' + (raw.SPY ? raw.SPY.price.toFixed(0) : 'null') +
        ' VIXY=' + (raw.VIXY ? raw.VIXY.price.toFixed(2) : 'null') +
        ' USDBRL=' + (raw.USDBRL ? raw.USDBRL.price.toFixed(3) : 'null'));

      const changes = this._detectChanges();
      if (changes.length > 0) {
        this.log.info('Mudanca macro: ' + changes.map(c => c.key).join(', '));
        this.bus.emit('macro:significant_change', { snapshot: this.snapshot, changes });
      }

    } catch (e) {
      this.log.error('Erro ao buscar dados macro:', e.message);
    }
  }

  // ── Twelve Data (todos os ativos) ──────────────────────
  // 800 calls/dia gratuito — não bloqueia datacenter
  _fetchAlphaVantage() {
    // Migrado para Twelve Data — Alpha Vantage tem limite 25 calls/dia
    return this._fetchTwelveDataAll();
  }

  _fetchTwelveDataAll() {
    const TD_KEY = '022385c872a84c069ffc19886264468f';
    const https  = require('https');

    const fetchJSON = (path) => new Promise((resolve) => {
      const options = { hostname: 'api.twelvedata.com', path, method: 'GET', headers: { 'User-Agent': 'Mozilla/5.0' }, timeout: 8000 };
      const req = https.request(options, (res) => {
        let body = '';
        res.on('data', c => body += c);
        res.on('end', () => { try { resolve(JSON.parse(body)); } catch { resolve(null); } });
      });
      req.on('error', () => resolve(null));
      req.on('timeout', () => { req.destroy(); resolve(null); });
      req.end();
    });

    const mk = (item) => {
      if (!item || item.code) return null;
      const price = parseFloat(item.close || item.price);
      if (!price) return null;
      return {
        price,
        prevClose: parseFloat(item.previous_close || price),
        change: parseFloat(item.change || 0),
        changePct: parseFloat(item.percent_change || 0),
      };
    };

    // 1 única call com 8 símbolos = 8 créditos (limite Basic = 8/min)
    return fetchJSON('/quote?symbol=SPY,VIXY,UUP,GLD,USO,EWZ,TLT,USD%2FBRL&apikey=' + TD_KEY)
    .then((batch) => {
      const result = {};
      if (!batch || batch.code) {
        this.log.warn('Twelve Data batch erro: ' + JSON.stringify(batch || {}).slice(0,150));
        if (batch && batch.code === 429) {
          const midnight = new Date(); midnight.setUTCHours(24,0,0,0);
          this._rateLimitUntil = midnight.getTime();
          this.log.warn('Rate limit ativo — pausando Twelve Data até ' + midnight.toISOString());
        }
        return result;
      }
      const MAP = [
        ['SPY','SPY'],['VIXY','VIXY'],['UUP','UUP'],['GLD','GLD'],
        ['USO','USO'],['EWZ','EWZ'],['TLT','TLT'],['USD/BRL','USDBRL']
      ];
      for (const [sym, key] of MAP) {
        const v = mk(batch[sym]);
        if (v) result[key] = { key, ...v };
      }
      return result;
    });
  }

  

  // ── Normalização Multi-Source ───────────────────────────
  _normalizeMulti(raw) {
    const mk = (r) => r ? { price: r.price, prevClose: r.prevClose || r.price, change: r.change || 0, changePct: r.changePct || 0 } : null;
    const sp500  = mk(raw.SPY);
    const vix    = mk(raw.VIXY);
    const dxy    = mk(raw.UUP);
    const gold   = mk(raw.GOLD);   // XAU/USD via Twelve Data
    const oilWTI = mk(raw.USO);
    const ibov   = mk(raw.EWZ);    // Brasil ETF proxy
    const usdbrl = mk(raw.USDBRL);
    const tnx    = mk(raw.TLT);   // Treasury 10Y ETF proxy
    const cip    = this._calcCIP(usdbrl, tnx);
    const cme    = this._calcCMESpread(usdbrl);
    const bias   = this._calcMacroBias({ sp500, nasdaq: null, vix, dxy, usdbrl, cip, cme });
    return {
      sp500, vix, dxy, gold, oilWTI, usdbrl, ibov,
      nasdaq: null, dow: null, oilBrent: null,
      treasury10y: tnx, treasury3m: null, yieldCurve: null,
      cip, cme,
      macroBias: bias, macroScore: bias.score, macroSignal: bias.signal,
      macroLastUpdate: Date.now(),
    };
  }

  // ── Normalização legada ───────────────────────────────────
  _normalize(results) {
    const map = {};
    results.forEach(r => { map[r.symbol] = r; });

    const get = (sym) => {
      const r = map[sym];
      if (!r) return null;
      return {
        price:      r.regularMarketPrice,
        change:     r.regularMarketChange,
        changePct:  r.regularMarketChangePercent,
        prevClose:  r.regularMarketPreviousClose,
        open:       r.regularMarketOpen,
      };
    };

    const sp500  = get(SYMBOLS.SP500_FUT);
    const nasdaq = get(SYMBOLS.NASDAQ_FUT);
    const dow    = get(SYMBOLS.DOW_FUT);
    const vix    = get(SYMBOLS.VIX);
    const dxy    = get(SYMBOLS.DXY);
    const tnx    = get(SYMBOLS.TNX);
    const irx    = get(SYMBOLS.IRX);
    const wti    = get(SYMBOLS.OIL_WTI);
    const brent  = get(SYMBOLS.OIL_BRENT);
    const gold   = get(SYMBOLS.GOLD);
    const ibov   = get(SYMBOLS.IBOV);
    const usdbrl = get(SYMBOLS.USDBRL);

    // ── CIP — Paridade Coberta de Juros ──────────────────────
    // F = S × (1 + r_BR) / (1 + r_US)
    // Usa SELIC como proxy do DI Futuro (erro ~1pt — aceitável)
    const cip  = this._calcCIP(usdbrl, tnx);

    // ── CME Spread ────────────────────────────────────────────
    // Compara WDO com USD/BRL spot (proxy do CME overnight)
    const cme  = this._calcCMESpread(usdbrl);

    // Bias macro composto: +1 = risk-on (bom para BRL), -1 = risk-off (ruim)
    const bias = this._calcMacroBias({ sp500, nasdaq, vix, dxy, usdbrl, cip, cme });

    return {
      // EUA
      sp500:   sp500,
      nasdaq:  nasdaq,
      dow:     dow,
      vix:     vix,
      dxy:     dxy,

      // Juros
      treasury10y: tnx,
      treasury3m:  irx,
      yieldCurve:  tnx && irx ? (tnx.price - irx.price).toFixed(3) : null, // spread 10y-3m

      // Commodities
      oilWTI:  wti,
      oilBrent: brent,
      gold:    gold,

      // Brasil
      ibov:    ibov,
      usdbrl:  usdbrl,

      // CIP e CME
      cip:         cip,            // { precoJusto, desvio, score, descricao }
      cme:         cme,            // { spotRef, desvio, score, descricao }

      // Síntese
      macroBias:   bias,           // 'risk_on' | 'risk_off' | 'neutral'
      macroScore:  bias.score,     // -10 a +10
      macroSignal: bias.signal,    // 'bullish_brl' | 'bearish_brl' | 'neutral'
    };
  }

  // ── Bias Macro ────────────────────────────────────────────
  _calcMacroBias({ sp500, nasdaq, vix, dxy, usdbrl, cip, cme }) {
    let score = 0;
    const factors = [];

    // S&P subindo = risk-on = BRL tende a valorizar (WDO cai)
    if (sp500?.changePct > 0.3)  { score += 2; factors.push('SP500 ↑ risk-on'); }
    if (sp500?.changePct < -0.3) { score -= 2; factors.push('SP500 ↓ risk-off'); }

    // Nasdaq
    if (nasdaq?.changePct > 0.4)  { score += 1; factors.push('NASDAQ ↑'); }
    if (nasdaq?.changePct < -0.4) { score -= 1; factors.push('NASDAQ ↓'); }

    // VIX alto = medo = risk-off = BRL fraqueja (WDO sobe)
    if (vix?.price > 25)  { score -= 3; factors.push(`VIX alto ${vix.price.toFixed(1)}`); }
    if (vix?.price > 30)  { score -= 2; factors.push(`VIX muito alto ${vix.price.toFixed(1)}`); }
    if (vix?.changePct > 5) { score -= 2; factors.push('VIX subindo forte'); }
    if (vix?.price < 15)  { score += 2; factors.push(`VIX baixo ${vix.price.toFixed(1)}`); }

    // DXY subindo = dólar forte = WDO sobe
    if (dxy?.changePct > 0.2)  { score -= 2; factors.push('DXY ↑ dólar forte'); }
    if (dxy?.changePct < -0.2) { score += 2; factors.push('DXY ↓ dólar fraco'); }

    // USD/BRL direto
    if (usdbrl?.changePct > 0.3)  { score -= 1; factors.push('BRL depreciando'); }
    if (usdbrl?.changePct < -0.3) { score += 1; factors.push('BRL apreciando'); }

    // ── CIP Score ────────────────────────────────────────────
    if (cip?.score) {
      score += cip.score;
      if (cip.score !== 0) factors.push(cip.descricao);
    }

    // ── CME Spread Score ──────────────────────────────────────
    if (cme?.score) {
      score += cme.score;
      if (cme.score !== 0) factors.push(cme.descricao);
    }

    const signal = score >= 2  ? 'bullish_brl'   // BRL forte → WDO tende a cair → SELL WDO
                : score <= -2  ? 'bearish_brl'   // BRL fraco → WDO tende a subir → BUY WDO
                : 'neutral';

    const bias = score >= 2  ? 'risk_on'
               : score <= -2 ? 'risk_off'
               : 'neutral';

    return { bias, score, signal, factors };
  }

  // ── CIP — Paridade Coberta de Juros ──────────────────────
  _calcCIP(usdbrl, tnx) {
    try {
      const spot     = usdbrl?.price;
      if (!spot) return null;

      const r_BR     = SELIC_ANUAL;                              // SELIC proxy do DI
      const r_US     = tnx?.price ? tnx.price / 100 : TREASURY_ANUAL;
      const dias     = this._diasAteVencimento();
      const frac     = dias / 252;                               // dias úteis

      // F = S × (1 + r_BR × t) / (1 + r_US × t)
      // precoJusto = preço teórico do WDO futuro pela paridade de juros
      const precoJusto = spot * (1 + r_BR * frac) / (1 + r_US * frac);

      // desvio = WDO futuro atual vs preço justo calculado
      // Usa theor_price da Cedro (preço teórico do leilão) como proxy do WDO
      // theor_price é muito mais preciso que o spot USD/BRL
      // O WDO é cotado em R$/US$1000, então theor_price/1000 = USD/BRL equivalente
      const theorPrice = this.snapshot?.wdo?.theor_price;
      const wdoProxy = theorPrice ? theorPrice / 1000 : spot;
      const desvio   = Math.round((wdoProxy - precoJusto) * 20 * 10) / 10; // em pontos WDO

      let score = 0;
      let descricao = '';

      // Se WDO spot está ABAIXO do justo → dólar barato → pressão de alta no WDO
      if (desvio < -0.25)      { score = +2; descricao = `CIP: WDO ${Math.abs(desvio).toFixed(1)}¢ abaixo do justo`; }
      else if (desvio < -0.10) { score = +1; descricao = `CIP: WDO levemente barato`; }
      else if (desvio > 0.25)  { score = -2; descricao = `CIP: WDO ${desvio.toFixed(1)}¢ acima do justo`; }
      else if (desvio > 0.10)  { score = -1; descricao = `CIP: WDO levemente caro`; }
      else                     { score =  0; descricao = `CIP: WDO próximo do justo`; }

      return { precoJusto: precoJusto.toFixed(4), desvio, score, descricao, r_BR, r_US, dias };
    } catch { return null; }
  }

  // ── CME Spread ────────────────────────────────────────────
  async _fetchCMERange() {
    // Busca max/min da madrugada (18h-8h50 BRT = 21h-11h50 UTC)
    try {
      const TD_KEY = '022385c872a84c069ffc19886264468f';
      const https  = require('https');
      const fetchJSON = (path) => new Promise((resolve) => {
        const options = { hostname: 'api.twelvedata.com', path, method: 'GET', headers: { 'User-Agent': 'Mozilla/5.0' }, timeout: 8000 };
        const req = https.request(options, (res) => {
          let body = '';
          res.on('data', c => body += c);
          res.on('end', () => { try { resolve(JSON.parse(body)); } catch { resolve(null); } });
        });
        req.on('error', () => resolve(null));
        req.on('timeout', () => { req.destroy(); resolve(null); });
        req.end();
      });

      // USD/BRL candles de 5min das últimas 16h
      const data = await fetchJSON('/time_series?symbol=USD/BRL&interval=5min&outputsize=192&apikey=' + TD_KEY);
      if (!data || data.code || !data.values) return null;

      // Filtrar apenas candles da madrugada (21h UTC de ontem até 11h50 UTC hoje)
      const now = new Date();
      const cutoff = new Date(now);
      cutoff.setUTCHours(21, 0, 0, 0);
      if (cutoff > now) cutoff.setDate(cutoff.getDate() - 1);

      const candles = data.values.filter(c => {
        const t = new Date(c.datetime + 'Z');
        return t >= cutoff && t <= now;
      });

      if (candles.length === 0) return null;

      const highs = candles.map(c => parseFloat(c.high));
      const lows  = candles.map(c => parseFloat(c.low));
      const max   = Math.max(...highs);
      const min   = Math.min(...lows);
      const range = Math.round((max - min) * 20 * 10) / 10; // em pontos WDO

      return { max: max.toFixed(4), min: min.toFixed(4), range, candles: candles.length };
    } catch(e) {
      return null;
    }
  }

  _calcCMESpread(usdbrl) {
    try {
      const spot    = usdbrl?.price;
      const prevClose = usdbrl?.prevClose;
      if (!spot || !prevClose) return null;

      // CME proxy: usa o fechamento anterior do USD/BRL como referência CME overnight
      // (quando B3 fecha às 18h, CME continua → prevClose captura o movimento noturno)
      const cmeRef  = prevClose;
      const desvio  = Math.round((spot - cmeRef) * 10000) / 100; // em centavos

      let score = 0;
      let descricao = '';

      // WDO spot ABAIXO do CME ref → dólar barato vs overnight → pressão compradora
      if (desvio < -0.20)      { score = +2; descricao = `CME: spot ${Math.abs(desvio).toFixed(2)}¢ abaixo do CME`; }
      else if (desvio < -0.10) { score = +1; descricao = `CME: spot levemente abaixo do CME`; }
      else if (desvio > 0.20)  { score = -2; descricao = `CME: spot ${desvio.toFixed(2)}¢ acima do CME`; }
      else if (desvio > 0.10)  { score = -1; descricao = `CME: spot levemente acima do CME`; }
      else                     { score =  0; descricao = `CME: spot alinhado com CME`; }

      return { spotRef: cmeRef?.toFixed(4), desvio, score, descricao };
    } catch { return null; }
  }

  // ── Dias até vencimento do WDO ────────────────────────────
  _diasAteVencimento() {
    // WDO vence na 1ª quarta-feira do mês seguinte
    const hoje = new Date();
    const mes  = hoje.getMonth();
    const ano  = hoje.getFullYear();
    // Próximo mês
    const proxMes = mes === 11 ? 0 : mes + 1;
    const proxAno = mes === 11 ? ano + 1 : ano;
    // Acha a 1ª quarta do próximo mês
    const d = new Date(proxAno, proxMes, 1);
    while (d.getDay() !== 3) d.setDate(d.getDate() + 1);
    const diff = Math.ceil((d - hoje) / (1000 * 60 * 60 * 24));
    return Math.max(diff, 1);
  }

  // ── Detecta Mudanças Relevantes ───────────────────────────
  _detectChanges() {
    if (!this.prevSnap || Object.keys(this.prevSnap).length === 0) return [];

    const changes = [];
    const checks = [
      { key: 'DXY',        curr: this.snapshot.dxy?.changePct,     prev: this.prevSnap.dxy?.changePct,     thresh: CHANGE_THRESHOLDS.DXY },
      { key: 'VIX',        curr: this.snapshot.vix?.price,         prev: this.prevSnap.vix?.price,         thresh: CHANGE_THRESHOLDS.VIX, absolute: true },
      { key: 'TNX',        curr: this.snapshot.treasury10y?.price,  prev: this.prevSnap.treasury10y?.price, thresh: CHANGE_THRESHOLDS.TNX, absolute: true },
      { key: 'SP500_FUT',  curr: this.snapshot.sp500?.changePct,   prev: this.prevSnap.sp500?.changePct,   thresh: CHANGE_THRESHOLDS.SP500_FUT },
      { key: 'NASDAQ_FUT', curr: this.snapshot.nasdaq?.changePct,  prev: this.prevSnap.nasdaq?.changePct,  thresh: CHANGE_THRESHOLDS.NASDAQ_FUT },
      { key: 'OIL_WTI',   curr: this.snapshot.oilWTI?.changePct,  prev: this.prevSnap.oilWTI?.changePct,  thresh: CHANGE_THRESHOLDS.OIL_WTI },
      { key: 'USDBRL',     curr: this.snapshot.usdbrl?.changePct,  prev: this.prevSnap.usdbrl?.changePct,  thresh: CHANGE_THRESHOLDS.USDBRL },
    ];

    for (const c of checks) {
      if (c.curr == null || c.prev == null) continue;
      const delta = Math.abs(c.curr - c.prev);
      if (delta >= c.thresh) {
        changes.push({ key: c.key, delta, curr: c.curr, prev: c.prev });
      }
    }

    return changes;
  }

  // ── Helpers ───────────────────────────────────────────────
  _msUntil(hour, minute) {
    // BRT = UTC-3
    const now = new Date();
    const brtOffset = -3 * 60;
    const brtMs = now.getTime() + (now.getTimezoneOffset() + brtOffset) * 60000;
    const nowBRT = new Date(brtMs);
    const target = new Date(nowBRT);
    target.setHours(hour, minute, 0, 0);
    if (target <= nowBRT) target.setDate(target.getDate() + 1);
    const rawMs = target - nowBRT;
    const ms = Math.min(Math.max(rawMs, 1000), 12 * 60 * 60 * 1000); // entre 1s e 12h
    if (process.env.MOCK_MODE !== 'false' && ms > 30 * 60 * 1000) {
      this.log.info(`[MOCK] Macro Engine: ativando em 5s (ignorando horário real)`);
      return 5000;
    }
    return ms;
  }

  getSnapshot() { return this.snapshot; }
  getMode()     { return this.mode; }
}

module.exports = { MacroEngine };
