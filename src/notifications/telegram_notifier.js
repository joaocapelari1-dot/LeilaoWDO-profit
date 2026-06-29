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
      this.log.warn('Telegram nÃ£o configurado - adicione TELEGRAM_TOKEN e TELEGRAM_CHAT_ID no Railway');
      return;
    }

    this.log.info('OK Telegram Notifier ativo â grupo Wdo_auction');
    this._listenEvents();
    // Mensagem de startup removida - evita spam no Telegram
  }

  _listenEvents() {
    // ââ NotificaÃ§Ãµes de ciclo do pregÃ£o ââââââââââââââââââââââ
    // Claude liga Ã s 8h55 - notifica
    this.bus.on('claude:iniciou', (d) => {
      if (!this.enabled) return;
      this._send(`ð§  *Claude ligou - 8h55*\nAnalisando dados do leilÃ£o...\nAguarde veredicto atÃ© 9h00:40`);
    });

    this.bus.on('macro:bom_dia', (d) => {
      if (!this.enabled) return;
      const snap = d.snapshot || {};
      const spy  = snap.sp500?.price?.toFixed(0) || '-';
      const vix  = snap.vix?.price?.toFixed(1)   || '-';
      const usd  = snap.usdbrl?.price?.toFixed(3) || '-';
      this._send(`ð¡ *MacroEngine ligou - 8h45*\nSPY: ${spy} | VIX: ${vix} | USD/BRL: ${usd}\nMacro Score: ${snap.macroScore ?? 0}/10`);
    });

    // auction:state_change removido - sistema opera por horÃ¡rio

    this.bus.on('ai:analise', (d) => {
      if (!this.enabled) return;
      if (!['auction','pre_open'].includes(d.phase)) return;
      const conf = Math.round((d.confianca || 0) * 100);
      const verd = d.veredito || 'NAO_OPERAR';
      this._send(`ð§  *Claude analisou*\nConfianÃ§a: ${conf}% | ${verd}\nMacro: ${d.macro_bias || 'NEUTRO'} | DOLÃWDO: ${d.confluencia || '-'}`);
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

    const entry = (sinal.entry || sinal.price)?.toFixed(2) || '-';
    const stop  = sinal.stopPrice?.toFixed(2) || '-';
    const alvo  = sinal.targetPrice?.toFixed(2) || '-';
    const msg = emoji + ' *WDO AUCTION ENGINE*\n'
      + '-------------------\n'
      + '*SINAL: ' + dir + '*\n'
      + '*Entrada:* ' + entry + '\n'
      + '*Stop:* ' + stop + ' => R$' + (sinal.riskBrl || 60) + ' (' + (sinal.stopTicks || 6) + ' ticks)\n'
      + '*Alvo:* ' + alvo + ' => R$' + (sinal.rewardBrl || 0) + ' (' + (sinal.alvo1Ticks || 0) + ' ticks)\n'
      + '*RR:* ' + (sinal.rr || 0) + 'x | *Confianca:* ' + conf + '%\n'
      + '-------------------\n'
      + '*Surplus:* ' + (surplus > 0 ? '+' : '') + surplus + '\n'
      + '*Iceberg:* ' + (sinal.icebergFavor ? 'Favor' : sinal.icebergContra ? 'Contra' : 'Neutro') + '\n'
      + '*Macro:* ' + (sinal.macroAlinhado ? 'Favoravel' : 'Neutro') + '\n'
      + '*DOLxWDO:* ' + (sinal.confluenciaDolWdo === 'confluente' ? 'Confluente' : 'Divergente') + '\n'
      + '*Agressor:* ' + (sinal.agressor || '-') + '\n'
      + '*Escora:* ' + (sinal.escoraReal || '-') + '\n'
      + '*Macro Score:* ' + (sinal.macroScore || 0) + '/10\n'
      + '-------------------\n'
      + '_Railway LeilaoWDO Engine_';