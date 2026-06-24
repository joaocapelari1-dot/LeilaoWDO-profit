/**
 * MacroEngine
 * Puxa dados macro via Twelve Data.
 * 
 * Schedule (horário de Brasília):
 *   08h45 → liga, atualiza a cada 5min
 *   Leilão → CONTINUOUS = para
 * 
 * Zero tokens de IA. Dados brutos em memória.
 */

const https = require('https');
const { Logger } = require('../utils/logger');

// ── Parâmetros CIP ───────────────────────────────────────────
const SELIC_ANUAL   = 0.1050;  // 10.50% ao ano — atualizar manualmente quando COPOM mudar
const TREASURY_ANUAL = 0.045;  // Treasury fallback

const SYMBOLS = {
  SP500_FUT:  'ES=F',
  NASDAQ_FUT: 'NQ=F',
  DOW_FUT:    'YM=F',
  VIX:        '^VIX',
  DXY:        'DX-Y.NYB',
  TNX:        '^TNX',
  IRX:        '^IRX',
  OIL_WTI:   'CL=F',
  OIL_BRENT: 'BZ=F',
  GOLD:      'GC=F',
  IBOV:      '^BVSP',
  USDBRL:    'BRL=X',
};

// ── Thresholds para alertar Claude ───────────────────────────
const CHANGE_THRESHOLDS = {
  DXY:        0.10,
  VIX:        1.00,
  TNX:        0.02,
  SP500_FUT:  0.20,
  NASDAQ_FUT: 0.25,
  OIL_WTI:    0.30,
  USDBRL:     0.15,
  IBOV:       0.20,
};

const INTERVAL_NORMAL  = 5 * 60 * 1000; // 5min — Twelve Data (~110 calls/dia)

class MacroEngine {
  constructor(bus) {
    this.bus       = bus;
    this.log       = new Logger('MACRO-ENGINE');
    this.snapshot  = {};
    this.prevSnap  = {};
    this.timer     = null;
    this.scheduleTimer = null;
    this.running   = false;
    this.mode      = 'stopped';
    this.fetchCount = 0;
  }

  // ── Start ─────────────────────────────────────────────────
  start() {
    const now  = new Date();
    const brt  = new Date(now.getTime() - 3 * 60 * 60 * 1000);
    const h    = brt.getUTCHours();
    const m    = brt.getUTCMinutes();
    const mins = h * 60 + m;
    const start845 = 8 * 60 + 45;
    const close18  = 18 * 60 + 30; // estender até 18h30 para pegar fechamento

    const diaSem = brt.getUTCDay();
    const diaUtil = diaSem >= 1 && diaSem <= 5;

    if (diaUtil && mins >= start845 && mins < close18) {
      this.log.info('Macro Engine iniciado dentro da janela — ligando imediatamente');
      // Buscar range CME madrugada às 8h45
      const hNow = brt.getUTCHours(); const mNow = brt.getUTCMinutes();
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
    const msUntilClose = Math.min(Math.max(raw, 1000), 12 * 60 * 60 * 1000);
    setTimeout(() => {
      this.stop();
      this.log.info('B3 fechada — Macro Engine parado (18h BRT)');
      this._scheduleStart();
    }, msUntilClose);
    this.log.info('B3 fecha em ' + Math.round(msUntilClose/60000) + 'min (18h BRT)');
  }

  _scheduleStart() {
    const now = new Date();
    const brt = new Date(now.getTime() - 3 * 60 * 60 * 1000);
    const target = new Date(brt);
    target.setUTCHours(11, 45, 0, 0); // 8h45 BRT = 11h45 UTC
    if (target <= brt) target.setUTCDate(target.getUTCDate() + 1);
    while (target.getUTCDay() === 0 || target.getUTCDay() === 6) {
      target.setUTCDate(target.getUTCDate() + 1);
    }
    const msUntil845 = Math.max(target - now, 1000);
    this.log.info(`Próxima ativação em ${Math.round(msUntil845 / 1000)}s (08h45 BRT)`);

    this.scheduleTimer = setTimeout(() => {
      const nowBrt = new Date(Date.now() - 3 * 60 * 60 * 1000);
      const dia = nowBrt.getUTCDay();
      if (dia === 0 || dia === 6) {
        this.log.info('Macro Engine: fim de semana — reagendando...');
        this._scheduleStart();
        return;
      }
      this._startNormal();
      this._scheduleClose();
    }, msUntil845);
  }

  _startNormal() {
    this.log.info('🟡 MACRO: Modo NORMAL — atualizando a cada 5min');
    this.bus.emit('macro:bom_dia', { hora: new Date().toLocaleTimeString('pt-BR') });
    this.running = true;
    this.mode    = 'normal';
    // Aguarda 5s antes da 1ª call — tempo mínimo para Railway estabilizar
    setTimeout(() => {
      if (this.running) {
        this._fetch();
        this.timer = setInterval(() => this._fetch(), INTERVAL_NORMAL);
      }
    }, 5000);
  }

  // ── Fetch Principal ────────────────────────────────────────
  async _fetch() {
    try {
      const now = Date.now();
      // Rate limit ativo → não chama
      if (this._rateLimitUntil && now < this._rateLimitUntil) {
        this.bus.emit('macro:update', this.snapshot);
        return;
      }
      // Throttle: mín 60s entre calls
      if (this._lastTwelveFetch && (now - this._lastTwelveFetch) < 240000) {
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

  // ── Twelve Data — FIX: batch quote com parse correto ──────
  // BUG ANTERIOR: mk() lia item.close mas batch /quote retorna objeto com
  // chaves por símbolo. USD/BRL com barra era chave "USD/BRL" no JSON mas
  // o MAP usava "USD/BRL" → funcionava, porém batch com vírgula retorna
  // array quando símbolos são equity + forex misturados em planos Basic.
  // CORREÇÃO: usar /quote individual para forex (USD/BRL) e /quote batch
  // apenas para equities — garantindo que cada resposta é objeto simples.
  _fetchTwelveDataAll() {
    const TD_KEY = '022385c872a84c069ffc19886264468f';

    const fetchJSON = (path) => new Promise((resolve) => {
      const options = {
        hostname: 'api.twelvedata.com',
        path,
        method: 'GET',
        headers: { 'User-Agent': 'Mozilla/5.0' },
        timeout: 10000
      };
      const req = https.request(options, (res) => {
        let body = '';
        res.on('data', c => body += c);
        res.on('end', () => {
          try { resolve(JSON.parse(body)); }
          catch { resolve(null); }
        });
      });
      req.on('error', () => resolve(null));
      req.on('timeout', () => { req.destroy(); resolve(null); });
      req.end();
    });

    // Normaliza um item de /quote (objeto simples, não batch)
    const mkSingle = (item) => {
      if (!item || item.code || item.status === 'error') return null;
      // /quote retorna: close (último preço), previous_close, percent_change
      const price = parseFloat(item.close || item.price);
      if (!price || isNaN(price)) return null;
      return {
        price,
        prevClose: parseFloat(item.previous_close || price),
        change:    parseFloat(item.change || 0),
        changePct: parseFloat(item.percent_change || 0),
      };
    };

    // Normaliza resposta batch de /quote (objeto com chaves por símbolo)
    const mkBatch = (batch, symbol) => {
      if (!batch || batch.code) return null;
      const item = batch[symbol];
      if (!item || item.code || item.status === 'error') return null;
      const price = parseFloat(item.close || item.price);
      if (!price || isNaN(price)) return null;
      return {
        price,
        prevClose: parseFloat(item.previous_close || price),
        change:    parseFloat(item.change || 0),
        changePct: parseFloat(item.percent_change || 0),
      };
    };

    // FIX: separar equities (batch) de forex (individual)
    // Equities batch — 6 símbolos = 6 créditos por call
    const equitiesPromise = fetchJSON('/quote?symbol=SPY,VIXY,UUP,USO,EWZ,TLT&apikey=' + TD_KEY);
    // Forex individual — evita problema de encoding e plano Basic
    const forexPromise = fetchJSON('/quote?symbol=USD%2FBRL&apikey=' + TD_KEY);

    return Promise.all([equitiesPromise, forexPromise]).then(([equities, forex]) => {
      const result = {};

      // Log de diagnóstico para debug
      if (!equities || equities.code) {
        const msg = equities ? JSON.stringify(equities).slice(0, 150) : 'null';
        this.log.warn('Twelve Data equities batch erro: ' + msg);
        if (equities && equities.code === 429) {
          const midnight = new Date(); midnight.setUTCHours(24, 0, 0, 0);
          this._rateLimitUntil = midnight.getTime();
          this.log.warn('Rate limit ativo — pausando Twelve Data até ' + midnight.toISOString());
        }
      } else {
        // Equities batch — chaves são os símbolos exatos enviados
        const equityMap = [
          ['SPY', 'SPY'], ['VIXY', 'VIXY'], ['UUP', 'UUP'],
          ['USO', 'USO'], ['EWZ', 'EWZ'], ['TLT', 'TLT']
        ];
        for (const [sym, key] of equityMap) {
          const v = mkBatch(equities, sym);
          if (v) result[key] = { key, ...v };
          else this.log.warn(`Twelve Data: ${sym} retornou null (close=${equities[sym]?.close})`);
        }
      }

      // Forex individual — resposta é objeto simples (não batch)
      if (!forex || forex.code || forex.status === 'error') {
        const msg = forex ? JSON.stringify(forex).slice(0, 150) : 'null';
        this.log.warn('Twelve Data forex USD/BRL erro: ' + msg);
      } else {
        const v = mkSingle(forex);
        if (v) result['USDBRL'] = { key: 'USDBRL', ...v };
        else this.log.warn('Twelve Data: USD/BRL close=' + forex?.close + ' price=' + forex?.price);
      }

      this.log.info('Twelve Data resultado: ' + Object.keys(result).join(', ') + ' (' + Object.keys(result).length + '/7)');
      return result;
    });
  }

  // ── Normalização Multi-Source ───────────────────────────
  _normalizeMulti(raw) {
    const mk = (r) => r ? { price: r.price, prevClose: r.prevClose || r.price, change: r.change || 0, changePct: r.changePct || 0 } : null;
    const sp500  = mk(raw.SPY);
    const vix    = mk(raw.VIXY);
    const dxy    = mk(raw.UUP);
    const oilWTI = mk(raw.USO);
    const ibov   = mk(raw.EWZ);
    const usdbrl = mk(raw.USDBRL);
    const tnx    = mk(raw.TLT);
    const cip    = this._calcCIP(usdbrl, tnx);
    const cme    = this._calcCMESpread(usdbrl);
    const bias   = this._calcMacroBias({ sp500, nasdaq: null, vix, dxy, usdbrl, cip, cme });
    return {
      sp500, vix, dxy, oilWTI, usdbrl, ibov, gold: null,
      nasdaq: null, dow: null, oilBrent: null,
      treasury10y: tnx, treasury3m: null, yieldCurve: null,
      cip, cme,
      macroBias: bias, macroScore: bias.score, macroSignal: bias.signal,
      macroLastUpdate: Date.now(),
    };
  }

  // ── Bias Macro ────────────────────────────────────────────
  _calcMacroBias({ sp500, nasdaq, vix, dxy, usdbrl, cip, cme }) {
    let score = 0;
    const factors = [];

    if (sp500?.changePct > 0.3)  { score += 2; factors.push('SP500 ↑ risk-on'); }
    if (sp500?.changePct < -0.3) { score -= 2; factors.push('SP500 ↓ risk-off'); }
    if (nasdaq?.changePct > 0.4)  { score += 1; factors.push('NASDAQ ↑'); }
    if (nasdaq?.changePct < -0.4) { score -= 1; factors.push('NASDAQ ↓'); }
    if (vix?.price > 25)  { score -= 3; factors.push(`VIX alto ${vix.price.toFixed(1)}`); }
    if (vix?.price > 30)  { score -= 2; factors.push(`VIX muito alto ${vix.price.toFixed(1)}`); }
    if (vix?.changePct > 5) { score -= 2; factors.push('VIX subindo forte'); }
    if (vix?.price < 15)  { score += 2; factors.push(`VIX baixo ${vix.price.toFixed(1)}`); }
    if (dxy?.changePct > 0.2)  { score -= 2; factors.push('DXY ↑ dólar forte'); }
    if (dxy?.changePct < -0.2) { score += 2; factors.push('DXY ↓ dólar fraco'); }
    if (usdbrl?.changePct > 0.3)  { score -= 1; factors.push('BRL depreciando'); }
    if (usdbrl?.changePct < -0.3) { score += 1; factors.push('BRL apreciando'); }
    if (cip?.score) { score += cip.score; if (cip.score !== 0) factors.push(cip.descricao); }
    if (cme?.score) { score += cme.score; if (cme.score !== 0) factors.push(cme.descricao); }

    const signal = score >= 2  ? 'bullish_brl'
                : score <= -2  ? 'bearish_brl'
                : 'neutral';
    const bias = score >= 2  ? 'risk_on'
               : score <= -2 ? 'risk_off'
               : 'neutral';

    return { bias, score, signal, factors };
  }

  // ── CIP — Paridade Coberta de Juros ──────────────────────
  _calcCIP(usdbrl, tnx) {
    try {
      const spot = usdbrl?.price;
      if (!spot) return null;
      const r_BR = SELIC_ANUAL;
      const r_US = tnx?.price ? tnx.price / 100 : TREASURY_ANUAL;
      const dias = this._diasAteVencimento();
      const frac = dias / 252;
      const precoJusto = spot * (1 + r_BR * frac) / (1 + r_US * frac);
      const theorPrice = this.snapshot?.wdo?.theor_price;
      const wdoProxy = theorPrice ? theorPrice / 1000 : spot;
      const desvio = Math.round((wdoProxy - precoJusto) * 20 * 10) / 10;
      let score = 0, descricao = '';
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
    try {
      const TD_KEY = '022385c872a84c069ffc19886264468f';
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

      const data = await fetchJSON('/time_series?symbol=USD/BRL&interval=5min&outputsize=192&apikey=' + TD_KEY);
      if (!data || data.code || !data.values) return null;

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
      const range = Math.round((max - min) * 20 * 10) / 10;

      return { max: max.toFixed(4), min: min.toFixed(4), range, candles: candles.length };
    } catch(e) {
      return null;
    }
  }

  _calcCMESpread(usdbrl) {
    try {
      const spot = usdbrl?.price;
      const prevClose = usdbrl?.prevClose;
      if (!spot || !prevClose) return null;
      const cmeRef = prevClose;
      const desvio = Math.round((spot - cmeRef) * 10000) / 100;
      let score = 0, descricao = '';
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
    const hoje = new Date();
    const mes  = hoje.getMonth();
    const ano  = hoje.getFullYear();
    const proxMes = mes === 11 ? 0 : mes + 1;
    const proxAno = mes === 11 ? ano + 1 : ano;
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
      { key: 'VIX',        curr: this.snapshot.vix?.price,         prev: this.prevSnap.vix?.price,         thresh: CHANGE_THRESHOLDS.VIX },
      { key: 'TNX',        curr: this.snapshot.treasury10y?.price,  prev: this.prevSnap.treasury10y?.price, thresh: CHANGE_THRESHOLDS.TNX },
      { key: 'SP500_FUT',  curr: this.snapshot.sp500?.changePct,   prev: this.prevSnap.sp500?.changePct,   thresh: CHANGE_THRESHOLDS.SP500_FUT },
      { key: 'USDBRL',     curr: this.snapshot.usdbrl?.changePct,  prev: this.prevSnap.usdbrl?.changePct,  thresh: CHANGE_THRESHOLDS.USDBRL },
    ];
    for (const c of checks) {
      if (c.curr == null || c.prev == null) continue;
      const delta = Math.abs(c.curr - c.prev);
      if (delta >= c.thresh) changes.push({ key: c.key, delta, curr: c.curr, prev: c.prev });
    }
    return changes;
  }

  // ── Helpers ───────────────────────────────────────────────
  _msUntil(hour, minute) {
    const now = new Date();
    const brtOffset = -3 * 60;
    const brtMs = now.getTime() + (now.getTimezoneOffset() + brtOffset) * 60000;
    const nowBRT = new Date(brtMs);
    const target = new Date(nowBRT);
    target.setHours(hour, minute, 0, 0);
    if (target <= nowBRT) target.setDate(target.getDate() + 1);
    const rawMs = target - nowBRT;
    const ms = Math.min(Math.max(rawMs, 1000), 12 * 60 * 60 * 1000);
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
