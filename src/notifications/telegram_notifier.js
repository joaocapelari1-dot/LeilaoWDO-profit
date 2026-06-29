/**
 * Telegram Notifier
 * Envia sinais do WDO Auction Engine via Telegram
 */

const https = require('https');
const { Logger } = require('../utils/logger');

const TOKEN   = process.env.TELEGRAM_TOKEN   || '';
const CHAT_ID = process.env.TELEGRAM_CHAT_ID || '';

class TelegramNotifier {
  constructor(bus) {
    this.bus          = bus;
    this.log          = new Logger('TELEGRAM');
    this.enabled      = !!(TOKEN && CHAT_ID);
    this.lastSignalId = null;
    this.sinaisHoje   = 0;
    this.rejeicoes    = [];
    this.maxConfianca = 0;
    this.ultimaAnalise = null;
    this.macroHoje    = null;
    this.resumoEnviado = false;

    if (!this.enabled) {
      this.log.warn('Telegram nÃ£o configurado â adicione TELEGRAM_TOKEN e TELEGRAM_CHAT_ID no Railway');
      return;
    }

    this.log.info('â Telegram Notifier ativo â grupo Wdo_auction');
    this._listenEvents();
    // Mensagem de startup removida â evita spam no Telegram
  }

  _listenEvents() {
    // ââ NotificaÃ§Ãµes de ciclo do pregÃ£o ââââââââââââââââââââââ
    // Claude liga Ã s 8h55 â notifica
    this.bus.on('claude:iniciou', (d) => {
      if (!this.enabled) return;
      this._send(`ð§  *Claude ligou â 8h55*\nAnalisando dados do leilÃ£o...\nAguarde veredicto atÃ© 9h00:40`);
    });

    this.bus.on('macro:bom_dia', (d) => {
      if (!this.enabled) return;
      const snap = d.snapshot || {};
      const spy  = snap.sp500?.price?.toFixed(0) || 'â';
      const vix  = snap.vix?.price?.toFixed(1)   || 'â';
      const usd  = snap.usdbrl?.price?.toFixed(3) || 'â';
      this._send(`ð¡ *MacroEngine ligou â 8h45*\nSPY: ${spy} | VIX: ${vix} | USD/BRL: ${usd}\nMacro Score: ${snap.macroScore ?? 0}/10`);
    });

    // auction:state_change removido â sistema opera por horÃ¡rio

    this.bus.on('ai:analise', (d) => {
      if (!this.enabled) return;
      if (!['auction','pre_open'].includes(d.phase)) return;
      const conf = Math.round((d.confianca || 0) * 100);
      const verd = d.veredito || 'NAO_OPERAR';
      this._send(`ð§  *Claude analisou*\nConfianÃ§a: ${conf}% | ${verd}\nMacro: ${d.macro_bias || 'NEUTRO'} | DOLÃWDO: ${d.confluencia || 'â'}`);
    });

    // Monitora status da ProfitDLL
    this.bus.on('cedro:connected', () => { this._cedroOk = true; this._cedroLastSYN = Date.now(); });
    this.bus.on('cedro:syn',       () => { this._cedroLastSYN = Date.now(); });
    this.bus.on('profit:ticker_state', () => { this._cedroOk = true; this._cedroLastSYN = Date.now(); });

    this.bus.on('risk:approved', (sinal) => {
      if (sinal.id === this.lastSignalId) return;
      this.lastSignalId = sinal.id;
      this._enviarSinal(sinal);
    });
  }

  _enviarSinal(sinal) {
    const dir  = sinal.direction === 'buy' ? 'ð¢ COMPRA' : 'ð´ VENDA';
    const emoji = sinal.direction === 'buy' ? 'ð' : 'ð';
    const hora = new Date().toLocaleTimeString('pt-BR', { hour:'2-digit', minute:'2-digit', second:'2-digit', timeZone:'America/Sao_Paulo' });
    const conf = Math.round((sinal.aiConfianca || 0) * 100);
    const surplus = sinal.confluence?.surplus || 0;

    const msg = `${emoji} *WDO AUCTION ENGINE*
âââââââââââââââââââ
*SINAL: ${dir}*
*Entrada:* \`${(sinal.entry || sinal.price)?.toFixed(2)}\`
*Stop:* \`${sinal.stopPrice?.toFixed(2)}\` â R$${sinal.riskBrl || 60} (${sinal.stopTicks || 6} ticks)
*Alvo:* \`${sinal.targetPrice?.toFixed(2)}\` â R$${sinal.rewardBrl || 0} (${sinal.alvo1Ticks || 0} ticks)
*RR:* ${sinal.rr || 0}x | *ConfianÃ§a:* ${conf}%
âââââââââââââââââââ
*Surplus:* ${surplus > 0 ? '+' : ''}${surplus}
*Iceberg:* ${sinal.icebergFavor ? 'â Favor' : sinal.icebergContra ? 'â Contra' : 'â Neutro'}
*Macro:* ${sinal.macroAlinhado ? 'â FavorÃ¡vel' : 'â ï¸ Neutro'}
*DOLÃWDO:* ${sinal.confluenciaDolWdo === 'confluente' ? 'â Confluente' : 'â Divergente'}
âââââââââââââââââââ
â° ${hora} BRT | ð PAPER`;

    this._send(msg);
  }

  async healthCheck() {
    if (!this.enabled) return;
    const resultados = [];
    const start = Date.now();

    // 1. Testar Anthropic API
    try {
      const Anthropic = require('@anthropic-ai/sdk');
      const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
      const t0 = Date.now();
      await client.messages.create({
        model: 'claude-sonnet-4-5',
        max_tokens: 10,
        messages: [{ role: 'user', content: 'OK' }]
      });
      resultados.push(`â Claude API: ${Date.now()-t0}ms`);
    } catch(e) {
      resultados.push(`â Claude API: ${e.message?.slice(0,40)}`);
    }

    // 2. Testar Twelve Data
    try {
      const https = require('https');
      const ok = await new Promise((resolve) => {
        const t0 = Date.now();
        const req = https.get('https://api.twelvedata.com/price?symbol=SPY&apikey=022385c872a84c069ffc19886264468f', (r) => {
          let d=''; r.on('data',c=>d+=c);
          r.on('end',()=>{
            try {
              const j = JSON.parse(d);
              resolve(j.price ? `â Twelve Data: ${Date.now()-t0}ms (SPY=${parseFloat(j.price).toFixed(0)})` : `â ï¸ Twelve Data: sem dados`);
            } catch { resolve('â Twelve Data: parse error'); }
          });
        });
        req.on('error', () => resolve('â Twelve Data: connection error'));
        req.on('timeout', () => resolve('â Twelve Data: timeout'));
      });
      resultados.push(ok);
    } catch(e) {
      resultados.push(`â Twelve Data: ${e.message?.slice(0,40)}`);
    }

    // 3. Testar Cedro â verifica SYN recente (Ãºltimos 90s)
    const synAge = this._cedroLastSYN ? Math.round((Date.now() - this._cedroLastSYN)/1000) : null;
    if (synAge !== null && synAge <= 90) {
      resultados.push(`â ProfitDLL: viva (tick ${synAge}s atrÃ¡s)`);
    } else if (this._cedroOk) {
      resultados.push(`â ï¸ ProfitDLL: conectou mas sem tick hÃ¡ ${synAge ?? '?'}s`);
    } else {
      resultados.push('â ProfitDLL: nÃ£o conectada');
    }

    const total = Date.now() - start;
    const allOk = resultados.every(r => r.startsWith('â'));
    const emoji = allOk ? 'ð¢' : 'ð¡';

    this._send(`${emoji} *Health Check 8h40 â ${total}ms*\n${resultados.join('\n')}\n\n${allOk ? 'Sistema PRONTO para o leilÃ£o â' : 'Verificar itens â ï¸'}`);
  }

  testar() {
    const hora = new Date().toLocaleTimeString('pt-BR', { timeZone:'America/Sao_Paulo' });
    this._send(`ð¤ *WDO Auction Engine Online*\nâ Sistema iniciado e conectado Ã  ProfitDLL\nâ° ${hora} BRT`);
  }

  _send(text) {
    if (!this.enabled) return;
    const body = JSON.stringify({ chat_id: CHAT_ID, text, parse_mode: 'Markdown' });
    const opts = {
      hostname: 'api.telegram.org',
      path:     `/bot${TOKEN}/sendMessage`,
      method:   'POST',
      headers:  { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) },
    };
    const req = https.request(opts, (res) => {
      let d = '';
      res.on('data', c => d += c);
      res.on('end', () => {
        const json = JSON.parse(d);
        if (json.ok) this.log.info('â Telegram enviado');
        else this.log.warn('Telegram erro: ' + json.description);
      });
    });
    req.on('error', () => {});
    req.on('timeout', () => { try { req.destroy(); } catch(e) {} });
    req.write(body); req.end();
  }
}

module.exports = { TelegramNotifier };
