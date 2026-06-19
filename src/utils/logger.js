const LEVELS = { debug: 0, info: 1, warn: 2, error: 3 };
const MIN_LEVEL = LEVELS[process.env.LOG_LEVEL || 'info'];

class Logger {
  constructor(module) {
    this.module = module.padEnd(14);
  }
  _fmt(level, args) {
    const ts  = new Date().toISOString().slice(11, 23); // HH:mm:ss.ms
    const lvl = level.toUpperCase().padEnd(5);
    console.log(`${ts} [${lvl}] [${this.module}]`, ...args);
  }
  debug(...a) { if (MIN_LEVEL <= 0) this._fmt('debug', a); }
  info(...a)  { if (MIN_LEVEL <= 1) this._fmt('info',  a); }
  warn(...a)  { if (MIN_LEVEL <= 2) this._fmt('warn',  a); }
  error(...a) { if (MIN_LEVEL <= 3) this._fmt('error', a); }
}

module.exports = { Logger };
