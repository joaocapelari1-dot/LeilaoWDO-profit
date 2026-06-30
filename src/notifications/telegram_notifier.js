'use strict';
/**
 * TelegramNotifier — envia alertas via Telegram Bot API
 * Sem template literals, sem encoding especial
 */

const https = require('https');
const { Logger } = require('../utils/logger');

class TelegramNotifier {
  constructor(bus) {
    this.bus   = bus;
    this.log   = new Logger('TELEGRAM');
    this.token = process.env.TELEGRAM_BOT_TOKEN || '';
    this.chat  = process.env.TELEGRAM_CHAT_ID   || '';

    if (!this.token || !this.chat) {
      this.log.warn('Token ou ChatID nao configurado — notificacoes desativadas');
      return;
    }

    this._listen();
    this.log.info('Telegram ativo — chat ' + this.chat);
  }

  _listen() {
    // CRITICO: nomes corrigidos conforme eventos REAIS emitidos pelo
    // risk_engine.js e execution_engine.js. Os nomes antigos (risk:signal,
    // order:opened/closed, position:limit_hit) nunca existiram no sistema —
    // Telegram so funcionava para alerta de ghost feed, nunca avisava
    // sinais aprovados, ordens abertas/fechadas ou limite de perda atingido.
    this.bus.on('risk:approved',    (s) => this._onSinal(s));
    this.bus.on('execution:fill',   (o) => this._onOrdem(o));
    this.bus.on('execution:close',  (o) => this._onFechamento(o));
    this.bus.on('risk:rejected',    (r) => { if (r?.reason === 'daily_loss_limit') this._onLimite(); });
    this.bus.on('mdil:ghost_feed',  (d) => this._onGhost(d));
  }

  _onSinal(sinal) {
    const dir    = sinal.direction || '?';
    const emoji  = dir === 'BUY' ? 'COMPRA' : 'VENDA';
    const conf   = Math.round((sinal.score || 0) * 10);
    const surplus = sinal.surplus || 0;
    const entry  = (sinal.entry  || sinal.price || 0).toFixed(2);
    const stop   = (sinal.stop   || sinal.stopPrice || 0).toFixed(2);
    const alvo   = (sinal.target || sinal.targetPrice || 0).toFixed(2);

    const linhas = [
      '[SINAL] ' + emoji + ' WDO',
      'Entrada: ' + entry,
      'Stop: '   + stop  + ' | R$' + (sinal.riskBrl || 60),
      'Alvo: '   + alvo  + ' | R$' + (sinal.rewardBrl || 0),
      'RR: '     + (sinal.rr || 1) + 'x | Confianca: ' + conf + '%',
      'Surplus: ' + (surplus > 0 ? '+' : '') + surplus,
      'Macro: '  + (sinal.macroAlinhado ? 'Favoravel' : 'Neutro'),
    ];

    const fatores = (sinal.factors || []).join(', ');
    if (fatores) linhas.push('Fatores: ' + fatores);

    this._send(linhas.join('\n'));
  }

  _onOrdem(ordem) {
    const dir   = ordem.direction || '?';
    const entry = (ordem.entry || 0).toFixed(2);
    const mode  = ordem.mode || 'PAPER';
    this._send('[ORDEM ABERTA] ' + mode + '\n' + dir + ' @ ' + entry);
  }

  _onFechamento(result) {
    const pnl    = result.pnl || 0;
    const reason = result.reason || '?';
    const dia    = (result.dailyPnl || 0).toFixed(0);
    const emoji  = pnl >= 0 ? 'LUCRO' : 'PREJUIZO';
    this._send(
      '[FECHAMENTO] ' + emoji + '\n' +
      'Motivo: ' + reason + '\n' +
      'P&L: R$' + pnl.toFixed(0) + '\n' +
      'Dia: R$' + dia
    );
  }

  _onLimite() {
    this._send('[ALERTA] Limite de perda diaria atingido. Sem mais operacoes hoje.');
  }

  _onGhost(data) {
    this._send('[ALERTA FEED] Ghost feed detectado em ' + (data.sym || '?') + ' (score=' + (data.score || 0) + ')');
  }

  _send(text) {
    if (!this.token || !this.chat) return;

    const body = JSON.stringify({
      chat_id:    this.chat,
      text:       text,
      parse_mode: 'Markdown',
    });

    const opts = {
      hostname: 'api.telegram.org',
      path:     '/bot' + this.token + '/sendMessage',
      method:   'POST',
      headers:  { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) },
    };

    const req = https.request(opts, (res) => {
      if (res.statusCode !== 200) {
        this.log.warn('Telegram HTTP ' + res.statusCode);
      }
    });

    req.on('error', (e) => this.log.error('Telegram erro: ' + e.message));
    req.write(body);
    req.end();

    this.log.info('Telegram enviado: ' + text.split('\n')[0]);
  }
}

module.exports = { TelegramNotifier };
