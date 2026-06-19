/**
 * EventBus — thin wrapper around Node.js EventEmitter
 * with logging support for debugging event flow.
 */
const { EventEmitter } = require('events');

class EventBus extends EventEmitter {
  constructor() {
    super();
    this.setMaxListeners(50); // multiple modules listen to same events
  }
}

module.exports = { EventBus };
