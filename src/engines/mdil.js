/**
 * MDIL Engine - versão corrigida
 * Corrige erro: logger.info is not a function
 */

const createLogger = require('../utils/logger');
const logger = createLogger('MDIL');

class MDILEngine {
  constructor() {
    this.initialized = false;

    logger.info('MDIL Engine sendo inicializado...');
  }

  init() {
    try {
      logger.info('Inicializando MDIL...');

      // exemplo de inicialização segura
      this.initialized = true;

      logger.info('MDIL inicializado com sucesso');
    } catch (err) {
      logger.error(`Erro ao inicializar MDIL: ${err.message}`);
      throw err;
    }
  }

  start() {
    if (!this.initialized) {
      this.init();
    }

    logger.info('MDIL Engine rodando...');
  }

  stop() {
    logger.warn('MDIL Engine sendo finalizado...');
    this.initialized = false;
  }
}

// export padrão
module.exports = MDILEngine;

// caso o arquivo esteja sendo instanciado automaticamente em outro lugar
if (require.main === module) {
  const engine = new MDILEngine();
  engine.start();
}
