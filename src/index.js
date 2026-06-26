require('dotenv').config();

const { Worker, isMainThread, parentPort, workerData } = require('worker_threads');
const path = require('path');

if (isMainThread) {

  const { createServer } = require('./api/server');
  const { Logger } = require('./utils/logger');
  const { EventBus } = require('./utils/event_bus');

  const log = new Logger('MAIN');

  log.info('═══════════════════════════════════════');
  log.info(' WDO Auction Production Engine v1.2');
  log.info(` MODE: ${process.env.MOCK_MODE === 'false' ? 'LIVE' : 'MOCK'}`);
  log.info('═══════════════════════════════════════');

  const bus = new EventBus();
  global.__bus = bus;

  let workerRef = null;

  const { start, stop } = createServer(bus, {});
  global.__getWorker = () => workerRef;

  start()
    .then(() => {
      log.info('HTTP Server pronto');

      // WORKER PRINCIPAL
      const worker = new Worker(__filename, {
        workerData: { isWorker: true }
      });

      workerRef = worker;

      worker.on('message', (msg) => {
        try {
          bus.emit(msg.type, msg.data);
        } catch (e) {
          log.warn('Worker message error', e.message);
        }
      });

      worker.on('exit', (code) => {
        log.warn('Worker saiu:', code);
        if (code !== 0) process.exit(1);
      });

      worker.on('error', (err) => {
        log.error('Worker crash:', err);
        process.exit(1);
      });

      process.on('SIGTERM', shutdown);
      process.on('SIGINT', shutdown);

      function shutdown() {
        log.info('Shutdown iniciado...');

        try {
          worker.postMessage({ type: 'shutdown' });
        } catch {}

        setTimeout(() => {
          worker.terminate();
          stop();
          process.exit(0);
        }, 2000);
      }
    })
    .catch(err => {
      log.error('Falha ao iniciar server:', err);
      process.exit(1);
    });

} else {

  // ================= WORKER =================

  const { Logger } = require('./utils/logger');
  const { EventBus } = require('./utils/event_bus');

  const log = new Logger('WORKER');
  const bus = new EventBus();

  log.info('Worker iniciado OK');

  if (parentPort) {
    parentPort.on('message', (msg) => {
      if (msg.type === 'shutdown') {
        log.info('Worker shutdown recebido');
        process.exit(0);
      }
    });
  }

  // mock básico pra não crashar se adapters não existirem ainda
  bus.on('raw:tick', d => {
    bus.emit('normalized:tick', d);
  });

}
