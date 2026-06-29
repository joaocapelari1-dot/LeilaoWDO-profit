class Logger {
  constructor(context = 'APP') {
    this.context = context.padEnd(14).slice(0, 14);
  }

  _time() {
    return new Date().toISOString().split('T')[1].split('.')[0];
  }

  _format(level, msg) {
    return `[${this._time()}] [${level}] [${this.context}] ${msg}`;
  }

  info(msg)  { console.log(this._format('INFO ', msg)); }
  warn(msg)  { console.log(this._format('WARN ', msg)); }
  error(msg) { console.log(this._format('ERROR', msg)); }
  debug(msg) { if (process.env.DEBUG) console.log(this._format('DEBUG', msg)); }
}

// Exporta tanto a classe (new Logger) quanto a função factory (legacy)
// Compatível com: const { Logger } = require('...') e require('...')('ctx')
module.exports = (context) => new Logger(context);
module.exports.Logger = Logger;
