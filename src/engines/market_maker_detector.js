/**
 * Market Maker Detector
 * Detecta presenÃ§a de formadores de mercado no book do WDO
 * Usa os cÃ³digos de corretora do BQT (Ã­ndice <corretora>)
 */
const { getBroker, isMarketMaker, getBrokerName } = require('../utils/broker_map');
const { Logger } = require('../utils/logger');

class MarketMakerDetector {
  constructor(bus) {
    this.bus         = bus;
    this.log         = new Logger('MM-DETECTOR');
    this.mmBids      = {}; // price â { broker, qty, nome }
    this.mmAsks      = {}; // price â { broker, qty, nome }
    this.mmAtivos    = new Set(); // brokers ativos no book
    this.lastUpdate  = null;
    this._listen();
    this.log.info('Market Maker Detector iniciado');
  }

  _listen() {
    this.bus.on('market:book:raw', (data) => {
      this._processBookRaw(data);
    });

    // Emite snapshot a cada 1s
    setInterval(() => this._emitSnapshot(), 1000);
  }

  _processBookRaw(data) {
    // data = { symbol, tipo, parts }
    // A:<pos>:<dir>:<price>:<qty>:<broker>:<datetime>:<orderid>:<type>
    const { tipo, parts, symbol } = data;
    if (!symbol?.startsWith('WDO')) return;

    if (tipo === 'A') {
      const dir    = parts[4];
      const price  = parseFloat(parts[5]);
      const qty    = parseInt(parts[6]);
      const broker = parseInt(parts[7]);

      if (!isNaN(broker) && isMarketMaker(broker) && qty >= 100) {
        const key  = Math.round(price * 100);
        const info = { broker, qty, nome: getBrokerName(broker), price };

        if (dir === 'A') this.mmBids[key] = info;
        else             this.mmAsks[key] = info;

        this.mmAtivos.add(broker);
        this.lastUpdate = Date.now();
      }

    } else if (tipo === 'D') {
      // Remove entradas deletadas
      const cancelType = parseInt(parts[3]);
      if (cancelType === 3) {
        this.mmBids = {};
        this.mmAsks = {};
        this.mmAtivos.clear();
      }
    }
  }

  _emitSnapshot() {
    const mmBidsArr = Object.values(this.mmBids).sort((a,b) => b.qty - a.qty);
    const mmAsksArr = Object.values(this.mmAsks).sort((a,b) => b.qty - a.qty);

    const totalMMBid = mmBidsArr.reduce((s,m) => s + m.qty, 0);
    const totalMMask = mmAsksArr.reduce((s,m) => s + m.qty, 0);

    const mmPresente  = this.mmAtivos.size > 0;
    const mmDirecao   = totalMMBid > totalMMask ? 'compra' :
                        totalMMask > totalMMBid ? 'venda' : 'neutro';

    const maiorMMBid  = mmBidsArr[0] || null;
    const maiorMMAsk  = mmAsksArr[0] || null;

    const snapshot = {
      mmPresente,
      mmAtivos:    Array.from(this.mmAtivos).map(b => getBrokerName(b)),
      mmDirecao,
      totalMMBid,
      totalMMAsk:  totalMMask,
      maiorMMBid,
      maiorMMAsk,
      mmBids:      mmBidsArr.slice(0, 5),
      mmAsks:      mmAsksArr.slice(0, 5),
      score:       mmPresente ? (mmDirecao === 'compra' ? 2 : mmDirecao === 'venda' ? -2 : 0) : 0,
      descricao:   mmPresente
        ? `MM ${mmDirecao.toUpperCase()}: ${this.mmAtivos.size} formador(es) ativo(s)`
        : 'Sem formadores de mercado detectados',
    };

    this.bus.emit('market:makers', snapshot);
  }

  reset() {
    this.mmBids   = {};
    this.mmAsks   = {};
    this.mmAtivos.clear();
  }
}

module.exports = { MarketMakerDetector };
