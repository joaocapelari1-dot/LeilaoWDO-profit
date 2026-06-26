/**
 * MDIL Engine - versão estável (fallback seguro)
 * Evita crash por MODULE_NOT_FOUND e mantém o sistema vivo
 */

const EventEmitter = require('events');

// ===============================
// LOGGER SAFE (NUNCA QUEBRA)
// ===============================
let logger;

try {
  logger = require('../utils/logger');
} catch (e) {
  logger = {
    info: (...args) => console.log('[INFO]', ...args),
    warn: (...args) => console.warn('[WARN]', ...args),
    error: (...args) => console.error('[ERROR]', ...args),
    debug: (...args) => console.log('[DEBUG]', ...args),
  };
}

// ===============================
// ENGINE CORE
// ===============================
class MDILEngine extends EventEmitter {
  constructor(config = {}) {
    super();

    this.config = {
      enabled: true,
      mode: 'live',
      ...config,
    };

    this.state = {
      running: false,
      lastTick: null,
    };

    logger.info('[MDIL] Engine instanciado');
  }

  // ===============================
  // START
  // ===============================
  start() {
    try {
      if (this.state.running) {
        logger.warn('[MDIL] Engine já está rodando');
        return;
      }

      this.state.running = true;

      logger.info('[MDIL] Iniciando engine...');
      this.emit('start');

      // loop simples seguro (placeholder)
      this._loop();

    } catch (err) {
      logger.error('[MDIL] Erro ao iniciar engine:', err);
      this.state.running = false;
    }
  }

  // ===============================
  // STOP
  // ===============================
  stop() {
    logger.warn('[MDIL] Parando engine...');
    this.state.running = false;
    this.emit('stop');
  }

  // ===============================
  // LOOP (SAFE)
  // ===============================
  _loop() {
    if (!this.state.running) return;

    try {
      this.state.lastTick = Date.now();

      // aqui entra lógica futura (macro / signal / etc)
      logger.debug('[MDIL] tick', this.state.lastTick);

      this.emit('tick', this.state.lastTick);

    } catch (err) {
      logger.error('[MDIL] erro no loop:', err);
    }

    // loop controlado (evita CPU 100%)
    setTimeout(() => this._loop(), 1000);
  }

  // ===============================
  // STATUS
  // ===============================
  getStatus() {
    return {
      running: this.state.running,
      mode: this.config.mode,
      lastTick: this.state.lastTick,
    };
  }
}

// ===============================
// EXPORT SAFE
// ===============================
module.exports = new MDILEngine();
module.exports.MDILEngine = MDILEngine;
