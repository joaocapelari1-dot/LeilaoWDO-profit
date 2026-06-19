/**
 * Live Cedro Client v2
 * Protocolo TCP/Telnet na porta 81
 * Baseado na documentação oficial Cedro Crystal
 */

const net    = require('net');
const { Logger } = require('../utils/logger');

const HOST   = process.env.CEDRO_HOST     || 'datafeed1.cedrotech.com';
const PORT   = parseInt(process.env.CEDRO_PORT || '81');
const USER   = process.env.CEDRO_USERNAME || '';
const PASS   = process.env.CEDRO_PASSWORD || '';

// ── Símbolos dinâmicos baseados no vencimento atual ─────────
// WDO e DOL vencem no 1º dia útil de cada mês
// Letras: F=jan G=fev H=mar J=abr K=mai M=jun N=jul Q=ago U=set V=out X=nov Z=dez
// ── Símbolos dinâmicos WDO e DOL ────────────────────────────
// WDO: vence todo mês no 1º dia útil
// DOL: vence só nos meses PARES (fev G, abr J, jun M, ago Q, out V, dez Z)
// Rolagem automática: detecta 1º dia útil do mês e rola para o próximo contrato

// WDO (mini) e DOL (cheio) vencem nos MESMOS meses
// São o mesmo contrato, tamanhos diferentes
// Letras: F=jan G=fev H=mar J=abr K=mai M=jun N=jul Q=ago U=set V=out X=nov Z=dez
const MONTHS_LETRA = ['F','G','H','J','K','M','N','Q','U','V','X','Z'];

function _primeiroUtil(ano, mes) {
  const d = new Date(ano, mes, 1);
  while (d.getDay() === 0 || d.getDay() === 6) d.setDate(d.getDate() + 1);
  return d;
}

function _getLetra(data) {
  const hoje = data || new Date();
  let mes = hoje.getMonth();
  let ano = hoje.getFullYear();
  // Se hoje >= 1º dia útil → contrato venceu → usa próximo mês
  if (hoje >= _primeiroUtil(ano, mes)) {
    mes++; if (mes > 11) { mes = 0; ano++; }
  }
  return { letra: MONTHS_LETRA[mes], ano: String(ano).slice(-2) };
}

// Símbolos contínuos — Cedro sempre aponta para o contrato mais líquido
// Não precisa trocar a letra a cada vencimento
let SYM_WDO = process.env.SYM_WDO || 'WDON26'; // assina com contrato fixo
// WIN/IND vencem na 4ª quarta-feira dos meses PARES (fev G, abr J, jun M, ago Q, out V, dez Z)
function _symWIN(data) {
  const hoje = data || new Date();
  const MESES_PARES = [1,3,5,7,9,11]; // fev,abr,jun,ago,out,dez (0-indexed)
  const LETRAS_PARES = ['G','J','M','Q','V','Z'];
  let mes = hoje.getMonth();
  let ano = hoje.getFullYear();
  // Encontrar próximo vencimento (4ª quarta-feira do mês par)
  for (let i = 0; i < 6; i++) {
    const idx = MESES_PARES.indexOf(mes);
    if (idx !== -1) {
      // Calcular 4ª quarta-feira deste mês
      const d = new Date(ano, mes, 1);
      let quartas = 0;
      while (quartas < 4) { if (d.getDay() === 3) quartas++; if (quartas < 4) d.setDate(d.getDate() + 1); }
      if (hoje < d) return { letra: LETRAS_PARES[idx], ano: String(ano).slice(-2) };
    }
    mes++; if (mes > 11) { mes = 0; ano++; }
  }
  return { letra: 'M', ano: String(ano).slice(-2) };
}
let SYM_WIN = (() => { const {letra,ano} = _symWIN(); return `WIN${letra}${ano}`; })();
let SYM_IND = (() => { const {letra,ano} = _symWIN(); return `IND${letra}${ano}`; })();
let SYM_DOL = process.env.SYM_DOL || 'DOLN26'; // assina com contrato fixo

// Rolagem automática removida — WDOFUT/DOLFUT são símbolos contínuos
// Cedro responde com WDOFUT/DOLFUT mesmo quando assinamos WDON26/DOLN26
const SYM_WDO_ALIAS = ['WDOFUT', 'WDOQ26', 'WDO']; // Cedro responde com WDOFUT
const SYM_DOL_ALIAS = ['DOLFUT', 'DOLQ26', 'DOL']; // Cedro responde com DOLFUT


class LiveCedroClient {
  constructor(bus) {
    this.bus         = bus;
    this.log         = new Logger('CEDRO-LIVE');
    this.socket      = null;
    this.buffer      = '';
    this.connected   = false;
    this.authed      = false;
    this.authStep    = 0; // 0=softkey, 1=user, 2=pass, 3=done
    this.reconnTimer = null;
    this.bookWDO     = { bids: {}, asks: {} }; // price→qty
    this.bookDOL     = { bids: {}, asks: {} };
    this.lastWDO     = {};
    this.lastDOL     = {};
  }

  start() {
    this.log.info('Conectando ao Cedro Crystal...');
    this._connect();
  }

  stop() {
    if (this.reconnTimer) clearTimeout(this.reconnTimer);
    if (this.socket) {
      this.socket.destroy();
      this.socket = null;
    }
    this.connected = false;
    this.authed    = false;
    this.log.info('Cedro desconectado');
  }

  // ── Conexão TCP ─────────────────────────────────────────────
  _connect() {
    this.authStep = 0;
    this.buffer   = '';
    this.authed   = false;

    this.socket = new net.Socket();
    this.socket.setEncoding('latin1');
    this.socket.setKeepAlive(true, 30000);
    this.socket.setNoDelay(true);      // desativa Nagle — menor latência
    this.socket.setTimeout(60000);     // timeout se 60s sem dados

    this.socket.connect(PORT, HOST, () => {
      this.connected = true;
      this.log.info(`TCP conectado: ${HOST}:${PORT}`);
    });

    this.socket.on('data', (data) => {
      this.buffer += data;
      this._processBuffer();
    });

    this.socket.on('error', (err) => {
      this.log.warn('Erro TCP: ' + err.message);
    });

    this.socket.on('timeout', () => {
      this.log.warn('Socket timeout 60s sem dados — forçando reconexão');
      this.socket.destroy();
    });

    this.socket.on('end', () => {
      this.log.warn('Servidor encerrou conexão (FIN TCP)');
    });

    this.socket.on('close', () => {
      this.connected = false;
      this.authed    = false;

      // Log tempo offline
      const offlineSec = this._disconnectTime ? Math.round((Date.now() - this._disconnectTime)/1000) : 0;
      this._disconnectTime = Date.now();
      if (offlineSec > 0) this.log.warn('Tempo offline anterior: ' + offlineSec + 's');

      // Backoff progressivo: 1s leilão / 5s-60s fora
      const brtNow = new Date(Date.now() - 3 * 60 * 60 * 1000);
      const hNow = brtNow.getUTCHours(); const mNow = brtNow.getUTCMinutes();
      const emLeilao = (hNow === 8 && mNow >= 50) || (hNow === 9 && mNow < 10);
      let delay;
      if (emLeilao) {
        delay = 1000;
        this._retryCount = 0;
      } else {
        this._retryCount = (this._retryCount || 0) + 1;
        delay = Math.min(this._retryCount * 5000, 60000);
      }
      this.log.warn('Conexão fechada — reconectando em ' + (delay/1000) + 's' + (emLeilao ? ' (leilão)' : ' (backoff #' + this._retryCount + ')'));

      if (this._heartbeatTimer) { clearInterval(this._heartbeatTimer); this._heartbeatTimer = null; }
      if (this._leilaoHeartbeatTimer) { clearInterval(this._leilaoHeartbeatTimer); this._leilaoHeartbeatTimer = null; }
      if (this._watchdogTimer) { clearInterval(this._watchdogTimer); this._watchdogTimer = null; }

      this.reconnTimer = setTimeout(() => this._connect(), delay);
    });
  }

  // ── Processamento do Buffer ──────────────────────────────────
  _processBuffer() {
    this._lastDataTime = Date.now(); // watchdog: atualiza timestamp de dados
    const lines = this.buffer.split('\n');
    this.buffer = lines.pop(); // última linha pode estar incompleta

    for (const raw of lines) {
      const line = raw.trim();
      if (!line) continue;

      if (!this.authed) {
        this._handleAuth(line);
      } else {
        this._handleMessage(line);
      }
    }
  }

  // ── Autenticação ─────────────────────────────────────────────
  _handleAuth(line) {
    const l = line.toLowerCase();

    // Software Key
    if (l.includes('software key') || this.authStep === 0) {
      if (this.authStep === 0) {
        this._send(''); // sem software key — só ENTER
        this.authStep = 1;
        return;
      }
    }

    // Username
    if (l.includes('username') || this.authStep === 1) {
      if (this.authStep === 1) {
        this._send(USER);
        this.authStep = 2;
        return;
      }
    }

    // Password
    if (l.includes('password') || this.authStep === 2) {
      if (this.authStep === 2) {
        this._send(PASS);
        this.authStep = 3;
        return;
      }
    }

    // Códigos de erro da Cedro
    if (l.startsWith('E:')) {
      const code = l.trim();
      const erros = {
        'E:1': 'Usuário inválido',
        'E:2': 'Senha inválida',
        'E:3': 'Usuário bloqueado',
        'E:4': 'Licença expirada',
        'E:5': 'Servidor em manutenção',
        'E:6': 'Sessão duplicada — outra conexão ativa com esse usuário',
        'E:7': 'Limite de conexões atingido',
      };
      const msg = erros[code] || 'Erro desconhecido';
      this.log.warn('Cedro erro ' + code + ': ' + msg);

      if (code === 'E:6') {
        // Sessão duplicada — esperar mais antes de reconectar
        // A conexão anterior ainda está viva (ex: processo antigo do Redeploy)
        this.log.warn('E:6: aguardando 15s para sessão anterior expirar...');
        this._retryCount = 0; // não penaliza no backoff
        if (this.socket) { try { this.socket.destroy(); } catch(e) {} }
        setTimeout(() => this._connect(), 15000);
        return;
      }
      return;
    }

    // Conectado!
    if (l.includes('you are connected') || l.includes('You are connected')) {
      this.authed = true;
      this._retryCount = 0; // reset backoff
      this._disconnectTime = null; // reset timer offline
      this.log.info('✅ Autenticado no Cedro Crystal!');
      // Heartbeat a cada 30s para manter conexão viva
      if (this._heartbeatTimer) clearInterval(this._heartbeatTimer);
      // Heartbeat com GTC (Get Time Command) — comando oficial Cedro keepalive
      // Solicita horário do servidor, mantendo sessão ativa nativamente
      this._heartbeatTimer = setInterval(() => {
        try {
          if (this.socket && !this.socket.destroyed && this.authed) {
            this._send('GTC'); // Get Time Command — keepalive oficial Cedro
          }
        } catch(e) {}
      }, 30000);

      // Keepalive via GTC a cada 30s — suficiente para manter sessão ativa

      // Timer separado para heartbeat agressivo durante o leilão
      this._leilaoHeartbeatTimer = setInterval(() => {
        const now = new Date();
        const brt = new Date(now.getTime() - 3 * 60 * 60 * 1000);
        const h = brt.getUTCHours();
        const m = brt.getUTCMinutes();
      const noLeilao = (h === 8 && m >= 50) || (h === 9 && m < 10);
        if (noLeilao) {
          try {
            if (this.socket && !this.socket.destroyed && this.authed) {
              this._send('GTC'); // keepalive oficial durante leilão
            }
          } catch(e) {}
        }
      }, 5000);

      // Watchdog: se ficar 2min sem receber dados → reconecta forçado
      // Detecta conexão "zombie" (TCP conectado mas sem dados)
      this._lastDataTime = Date.now();
      this._watchdogTimer = setInterval(() => {
        const semDados = Date.now() - this._lastDataTime;
        const limite = 2 * 60 * 1000; // 2 minutos
        if (semDados > limite && this.authed) {
          this.log.warn('Watchdog: ' + Math.round(semDados/1000) + 's sem dados — reconectando forçado');
          if (this.socket) { try { this.socket.destroy(); } catch(e) {} }
        }
      }, 30000); // verifica a cada 30s
      this.bus.emit('cedro:connected');
      this._subscribeAtivos();
      return;
    }

    // Erros de auth
    if (l.includes('invalid') || l.includes('error') || l.startsWith('e:')) {
      this.log.warn('Erro de autenticação: ' + line);
    }
  }

  // ── Assina os ativos necessários ─────────────────────────────
  _subscribeAtivos() {
    // Quote (ticks + preço teórico + surplus)
    this._send(`SQT ${SYM_WDO}`);
    this._send(`SQT ${SYM_DOL}`);
    // WIN/IND removidos — leilões deles ativavam AuctionSM indevidamente

    // Book L2
    this._send(`BQT ${SYM_WDO}`);
    this._send(`BQT ${SYM_DOL}`);

    // Tape de negócios (Time & Sales)
    this._send(`GQT ${SYM_WDO} S`);
    this._send(`GQT ${SYM_DOL} S`);

    this.log.info(`Assinado: SQT + BQT + GQT para ${SYM_WDO}, ${SYM_DOL}`);
  }

  // ── Parser de Mensagens ──────────────────────────────────────
  _handleMessage(line) {
    if (!line) return;

    // Log diagnóstico — primeiras 20 linhas após boot para ver o que Cedro manda
    if (!this._diagCount) this._diagCount = 0;
    if (this._diagCount < 20) {
      this._diagCount++;
      this.log.info(`[CEDRO-RAW] ${line.slice(0, 100)}`);
    }

    if (line === 'SYN') {
      this._lastSYN = Date.now();
      this.bus.emit('cedro:syn', { timestamp: Date.now() });
      return;
    }

    // Erros
    if (line.startsWith('E:')) {
      this.log.warn('Cedro erro: ' + line);
      return;
    }

    const prefix = line.substring(0, 1);

    // T: = Quote (SQT)
    if (line.startsWith('T:')) {
      this._parseQuote(line);
      return;
    }

    // B: = Book (BQT)
    if (line.startsWith('B:')) {
      this._parseBook(line);
      return;
    }

    // Z: = Aggregated Book (SAB)
    if (line.startsWith('Z:')) {
      this._parseAggBook(line);
      return;
    }

    // V: = Trade (GQT) — Tape
    if (line.startsWith('V:')) {
      this._parseTrade(line);
      return;
    }
  }

  // ── Parser SQT (Quote) ───────────────────────────────────────
  _parseQuote(line) {
    // Formato: T:<ativo>:<hora>:<idx>:<val>:<idx>:<val>...!
    // Exemplo: T:WDOFUT:090000:2:5192.50:3:5192.00:4:5193.00:82:5192.50:83:380:56:A:57:380!
    try {
      const cleaned = line.endsWith('!') ? line.slice(0, -1) : line;
      const parts   = cleaned.split(':');
      if (parts.length < 3) return;

      const ativo = parts[1];
      const hora  = parts[2];
      const isWDO = ativo === SYM_WDO || SYM_WDO_ALIAS.includes(ativo);
      const isDOL = ativo === SYM_DOL || SYM_DOL_ALIAS.includes(ativo);
      if (!isWDO && !isDOL) return;

      // Parse pares índice:valor
      const data = {};
      for (let i = 3; i < parts.length - 1; i += 2) {
        const idx = parseInt(parts[i]);
        const val = parts[i + 1];
        if (!isNaN(idx)) data[idx] = val;
      }

      // Monta objeto normalizado
      const tick = {
        symbol:      ativo,
        timestamp:   Date.now(),
        hora,

        // Preços básicos
        last:        parseFloat(data[2])  || 0,
        bid:         parseFloat(data[3])  || 0,
        ask:         parseFloat(data[4])  || 0,
        trade_vol:   parseInt(data[6])    || 0,
        last_vol:    parseInt(data[7])    || 0,
        auc_vol:     parseInt(data[9])    || 0,

        // LEILÃO — dados críticos
        theor_price: parseFloat(data[82]) || 0,  // Preço teórico de abertura
        theor_qty:   parseInt(data[83])   || 0,  // Quantidade teórica
        surplus_side: data[56] || null,           // A=Compra, V=Venda, 0=Neutro
        surplus_qty:  parseInt(data[57])  || 0,  // Quantidade não atendida = SURPLUS

        // Status
        status:      parseInt(data[84])   || 0,  // 0=Normal, 3=Leilão
        phase:       data[88] || null,            // P=Pré, A=Abertura
        instr_status: parseInt(data[67])  || 0,  // 101=Normal, 102=Leilão

        // Referência
        prev_close:  parseFloat(data[13]) || 0,
        open:        parseFloat(data[14]) || 0,
        high:        parseFloat(data[11]) || 0,
        low:         parseFloat(data[12]) || 0,
        variation:   parseFloat(data[21]) || 0,
      };

      // Calcula surplus com sinal
      const surplus = tick.surplus_side === 'A' ? tick.surplus_qty :
                      tick.surplus_side === 'V' ? -tick.surplus_qty : 0;

      // ── Log diagnóstico durante leilão (8h55→9h05 BRT) ──────────
      const _brtD = new Date(Date.now() - 3*60*60*1000);
      const _hD = _brtD.getUTCHours(), _mD = _brtD.getUTCMinutes();
      const _naLeilao = (_hD === 8 && _mD >= 55) || (_hD === 9 && _mD <= 5);
      if (_naLeilao && isWDO) {
        this.log.info(
          `[DIAG-SQT] ${ativo} ` +
          `theor_price(82)=${tick.theor_price||'—'} ` +
          `theor_qty(83)=${tick.theor_qty||'—'} ` +
          `surplus_side(56)=${tick.surplus_side||'—'} ` +
          `surplus_qty(57)=${tick.surplus_qty||'—'} ` +
          `status(84)=${tick.status||'—'} ` +
          `phase(88)=${tick.phase||'—'} ` +
          `instr_status(67)=${tick.instr_status||'—'} ` +
          `last(2)=${tick.last||'—'}`
        );
      }

      if (isWDO) {
        this.lastWDO = { ...this.lastWDO, ...tick, surplus };
        this.bus.emit('cedro:tick:wdo', { ...this.lastWDO, surplus });
      } else {
        this.lastDOL = { ...this.lastDOL, ...tick, surplus };
        this.bus.emit('cedro:tick:dol', { ...this.lastDOL, surplus });
      }

    } catch (e) {
      this.log.warn('Erro parseQuote: ' + e.message);
    }
  }

  // ── Parser BQT (Book L2) ─────────────────────────────────────
  _parseBook(line) {
    // Formato: B:<ativo>:<tipo>:<campos>
    // A:0:A:5192.00:100:131:11041005:L = add
    // U:1:0:A:5192.00:500:37:11041130:L = update
    // D:1:A:4 = delete
    try {
      const parts = line.split(':');
      if (parts.length < 3) return;

      const ativo = parts[1];
      const isWDO = ativo === SYM_WDO || SYM_WDO_ALIAS.includes(ativo);
      const isDOL = ativo === SYM_DOL || SYM_DOL_ALIAS.includes(ativo);
      if (!isWDO && !isDOL) return;

      const book  = isWDO ? this.bookWDO : this.bookDOL;
      const tipo  = parts[2]; // A, U, D, E

      if (tipo === 'A') {
        // A:<pos>:<dir>:<price>:<qty>:<broker>:<datetime>:<orderid>:<type>
        const pos   = parseInt(parts[3]);
        const dir   = parts[4]; // A=Compra, V=Venda
        const price = parseFloat(parts[5]);
        const qty   = parseInt(parts[6]);
        const key   = Math.round(price * 100);

        if (dir === 'A') {
          book.bids[key] = (book.bids[key] || 0) + qty;
        } else {
          book.asks[key] = (book.asks[key] || 0) + qty;
        }

      } else if (tipo === 'U') {
        // U:<pos_nova>:<pos_antiga>:<dir>:<price>:<qty>...
        const dir   = parts[5];
        const price = parseFloat(parts[6]);
        const qty   = parseInt(parts[7]);
        const key   = Math.round(price * 100);

        if (dir === 'A') {
          book.bids[key] = qty;
        } else {
          book.asks[key] = qty;
        }

      } else if (tipo === 'D') {
        // D:<tipo_cancel>:<dir>:<pos>
        const cancelType = parseInt(parts[3]);
        if (cancelType === 3) {
          // Limpa tudo
          book.bids = {};
          book.asks = {};
        }

      } else if (tipo === 'E') {
        // Fim do snapshot inicial — emite book completo
        // Log diagnóstico durante leilão
        const _brtB = new Date(Date.now() - 3*60*60*1000);
        const _hB = _brtB.getUTCHours(), _mB = _brtB.getUTCMinutes();
        if ((_hB === 8 && _mB >= 55) || (_hB === 9 && _mB <= 5)) {
          const bids = Object.keys(book.bids).length;
          const asks = Object.keys(book.asks).length;
          this.log.info(`[DIAG-BQT] ${ativo} snapshot_E: bids=${bids} asks=${asks} raw=${line.slice(0,80)}`);
        }
        this._emitBook(ativo, book);
      }

      // Emite book atualizado
      this._emitBook(ativo, book);

    } catch (e) {
      this.log.warn('Erro parseBook: ' + e.message);
    }
  }

  // ── Emite Book Normalizado ───────────────────────────────────
  _emitBook(ativo, book) {
    const toArray = (map, asc) => {
      const arr = Object.entries(map)
        .map(([k, qty]) => ({ price: parseInt(k) / 100, qty }))
        .filter(l => l.qty > 0)
        .sort((a, b) => asc ? a.price - b.price : b.price - a.price);
      return arr;
    };

    const bids = toArray(book.bids, false); // desc — melhor bid primeiro
    const asks = toArray(book.asks, true);  // asc  — melhor ask primeiro

    const bidVol = bids.reduce((s, l) => s + l.qty, 0);
    const askVol = asks.reduce((s, l) => s + l.qty, 0);
    const imbal  = bidVol + askVol > 0 ? (bidVol - askVol) / (bidVol + askVol) : 0;

    const bookData = {
      symbol:       ativo,
      bids,
      asks,
      best_bid:     bids[0]?.price || 0,
      best_ask:     asks[0]?.price || 0,
      bid_vol_total: bidVol,
      ask_vol_total: askVol,
      imbalance:    Math.round(imbal * 1000) / 1000,
      timestamp:    Date.now(),
    };

    if (ativo === SYM_WDO || SYM_WDO_ALIAS.includes(ativo)) {
      this.bus.emit('cedro:book:wdo', bookData);
    } else {
      this.bus.emit('cedro:book:dol', bookData);
    }
  }

  // ── Parser Aggregated Book ───────────────────────────────────
  _parseAggBook(line) {
    // Mesma lógica do BQT mas formato Z:
    this._parseBook(line.replace(/^Z:/, 'B:'));
  }

  // ── Parser GQT (Tape de Negócios) ────────────────────────────
  _parseTrade(line) {
    // V:<ativo>:<op>:<hora>:<price>:<broker_c>:<broker_v>:<qty>:<trade_id>:<cond>:<agressor>
    try {
      const parts = line.split(':');
      if (parts.length < 8) return;

      const ativo    = parts[1];
      const isWDO    = ativo === SYM_WDO || SYM_WDO_ALIAS.includes(ativo);
      const isDOL    = ativo === SYM_DOL || SYM_DOL_ALIAS.includes(ativo);
      if (!isWDO && !isDOL) return;

      const op       = parts[2]; // A=add, D=remove, R=remove all
      if (op !== 'A') return;

      const hora     = parts[3];
      const price    = parseFloat(parts[4]);
      const qty      = parseInt(parts[7]);
      const tradeId  = parts[8];
      const agressor = parts[10] || 'I'; // A=Comprador, V=Vendedor, I=Indefinido

      const trade = {
        symbol:    ativo,
        timestamp: Date.now(),
        hora,
        price,
        qty,
        tradeId,
        agressor,
        side: agressor === 'A' ? 'buy' : agressor === 'V' ? 'sell' : 'neutral',
      };

      if (isWDO) {
        this.bus.emit('cedro:trade:wdo', trade);
      } else {
        this.bus.emit('cedro:trade:dol', trade);
      }

    } catch (e) {
      this.log.warn('Erro parseTrade: ' + e.message);
    }
  }

  // ── Envio de comandos ────────────────────────────────────────
  _send(cmd) {
    if (!this.socket || this.socket.destroyed) return;
    this.socket.write(cmd + '\r\n', 'latin1');
  }

  disconnect() {
    // Desconexão limpa no shutdown — evita E:6 no próximo boot
    this.log.info('Cedro: desconexão limpa (shutdown)');
    this._retryCount = 999; // bloqueia reconexão automática
    if (this._heartbeatTimer)      { clearInterval(this._heartbeatTimer);      this._heartbeatTimer = null; }
    if (this._leilaoHeartbeatTimer){ clearInterval(this._leilaoHeartbeatTimer);this._leilaoHeartbeatTimer = null; }
    if (this._watchdogTimer)       { clearInterval(this._watchdogTimer);        this._watchdogTimer = null; }
    if (this._resubTimer)          { clearInterval(this._resubTimer);           this._resubTimer = null; }
    if (this.reconnTimer)          { clearTimeout(this.reconnTimer);            this.reconnTimer = null; }
    try {
      if (this.socket && !this.socket.destroyed) {
        this.socket.destroy();
      }
    } catch(e) {}
    this.authed    = false;
    this.connected = false;
  }
}

module.exports = { LiveCedroClient };
