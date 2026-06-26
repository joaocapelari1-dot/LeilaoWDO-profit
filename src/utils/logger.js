class Logger {
  constructor(context = 'APP') {
    this.context = context;
  }

  _time() {
    return new Date().toISOString().split('T')[1].split('.')[0];
  }

  _format(level, msg) {
    return `[${this._time()}] [${level}] [${this.context}] ${msg}`;
  }

  info(msg) {
    console.log(this._format('INFO ', msg));
  }

  warn(msg) {
    console.log(this._format('WARN ', msg));
  }

  error(msg) {
    console.log(this._format('ERROR', msg));
  }

  debug(msg) {
    if (process.env.DEBUG) {
      console.log(this._format('DEBUG', msg));
    }
  }
}

module.exports = (context) => new Logger(context);
