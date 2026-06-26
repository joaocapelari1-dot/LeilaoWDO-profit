const chalk = require('chalk');

class Logger {
  constructor(context = 'APP') {
    this.context = context;
  }

  _format(level, msg) {
    const time = new Date().toISOString().split('T')[1].split('.')[0];
    return `[${time}] [${level}] [${this.context}] ${msg}`;
  }

  info(msg) {
    console.log(chalk.cyan(this._format('INFO ', msg)));
  }

  warn(msg) {
    console.log(chalk.yellow(this._format('WARN ', msg)));
  }

  error(msg) {
    console.log(chalk.red(this._format('ERROR', msg)));
  }

  debug(msg) {
    if (process.env.DEBUG) {
      console.log(chalk.gray(this._format('DEBUG', msg)));
    }
  }
}

// export compatível com require()
module.exports = (context) => new Logger(context);
module.exports.Logger = Logger;
