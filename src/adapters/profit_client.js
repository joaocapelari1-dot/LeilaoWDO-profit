'use strict';
/**
 * ProfitClient v3.2 ÃÂ¢ÃÂÃÂ MDIL integrado
 * TinyBook nao sobrescreve OfferBook real quando >= 5 niveis disponiveis.
 * MDIL detecta ghost feed e marca dados sintÃÂÃÂ©ticos.
 */
const WDO_SYMBOLS = ['WDOFUT','WDON26','WDOQ26','WDOV26','WDO'];
const DOL_SYMBOLS = ['DOLFUT','DOLN26','DOLQ26','DOLV26','DOL'];
const { MarketDataIntegrityLayer } = require('../engines/mdil');

class ProfitClient {
  constructor(bus) {
    this.bus=bus; this.bookWDO={bids:{},asks:{}}; this.bookDOL={bids:{},asks:{}};
    this.lastWDO={}; this.lastDOL={}; this.theorWDO={price:0,qty:0}; this.theorDOL={price:0,qty:0};
    this.auctionActive={};
    this.mdil = new MarketDataIntegrityLayer(bus);
  }
  start() {
    console.log('[PROFIT-CLIENT] v3.2 Modo Invertido ÃÂ¢ÃÂÃÂ MDIL ativo ÃÂ¢ÃÂÃÂ aguardando VPS em /bridge');
    this.mdil.start();
    this._listenBus();
  }
  disconnect() {}
  _isWDO(s){return WDO_SYMBOLS.some(x=>s.includes(x));}
  _isDOL(s){return DOL_SYMBOLS.some(x=>s.includes(x));}
  _listenBus() {
    this.bus.on('profit:connection_state',(e)=>{
      console.log(`[PROFIT-CLIENT] DLL [${e.conn_type}] -> ${e.result}`);
      if(e.conn_type==='MARKET_DATA'&&e.result==='CONNECTED') this.bus.emit('market:connected');
      this.bus.emit('market:syn',{timestamp:Date.now()});
    });
    this.bus.on('profit:trade',(e)=>this._onTrade(e));
    this.bus.on('profit:theoretical_price',(e)=>this._onTheoreticalPrice(e));
    this.bus.on('profit:ticker_state',(e)=>this._onTickerState(e));
    this.bus.on('profit:offer_book',(e)=>this._onOfferBook(e));
    this.bus.on('profit:tiny_book',(e)=>this._onTinyBook(e));
    this.bus.on('profit:price_depth',(e)=>this._onPriceDepth(e));
    this.bus.on('profit:daily',(e)=>this._onDaily(e));
  }
  _onTrade(msg) {
    this.mdil.onTrade(msg.ticker || msg.symbol || '');
    const sym=msg.ticker||''; const isWDO=this._isWDO(sym); const isDOL=this._isDOL(sym);
    if(!isWDO&&!isDOL) return;
    const agressor=msg.aggressor==='BUY'?'buy':msg.aggressor==='SELL'?'sell':'balanced';
    const tick={symbol:sym,timestamp:msg.timestamp||Date.now(),last:msg.price||0,
      bid:isWDO?(this.lastWDO.bid||0):(this.lastDOL.bid||0),
      ask:isWDO?(this.lastWDO.ask||0):(this.lastDOL.ask||0),
      trade_vol:msg.quantity||0,auc_vol:0,
      theor_price:isWDO?this.theorWDO.price:this.theorDOL.price,
      theor_qty:isWDO?this.theorWDO.qty:this.theorDOL.qty,
      surplus:0,surplus_side:null,buy_agent:msg.buy_agent||0,sell_agent:msg.sell_agent||0,aggressor:agressor==='buy'?'buyer':agressor==='sell'?'seller':null,
      in_auction:this.auctionActive[sym]||false,phase:this.auctionActive[sym]?'auction':'continuous'};
    if(isWDO){this.lastWDO={...this.lastWDO,...tick};this.bus.emit('market:tick:wdo',{...this.lastWDO});this.bus.emit('market:trade:wdo',{symbol:sym,price:tick.last,qty:tick.trade_vol,agressor,timestamp:tick.timestamp});}
    else{this.lastDOL={...this.lastDOL,...tick};this.bus.emit('market:tick:dol',{...this.lastDOL});this.bus.emit('market:trade:dol',{symbol:sym,price:tick.last,qty:tick.trade_vol,agressor,timestamp:tick.timestamp});}
    this.bus.emit('market:syn',{timestamp:Date.now()});
  }
  _onTheoreticalPrice(msg) {
    const sym=msg.ticker||''; const isWDO=this._isWDO(sym); const isDOL=this._isDOL(sym);
    if(!isWDO&&!isDOL) return;
    const price=msg.theoretical_price; const qty=msg.theoretical_qty||0;
    if(!isFinite(price)||price<=0) return;
    if(isWDO){this.theorWDO={price,qty};this.lastWDO={...this.lastWDO,theor_price:price,theor_qty:qty,last:(this.lastWDO.last||price),in_auction:true,phase:'auction'};this.bus.emit('market:tick:wdo',{...this.lastWDO});}
    else{this.theorDOL={price,qty};this.lastDOL={...this.lastDOL,theor_price:price,theor_qty:qty,last:(this.lastDOL.last||price),in_auction:true,phase:'auction'};this.bus.emit('market:tick:dol',{...this.lastDOL});}
  }
  _onTickerState(msg) {
    const sym=msg.ticker||''; this.auctionActive[sym]=msg.in_auction||false;
    if(msg.in_auction) console.log(`[PROFIT-CLIENT] LEILAO ATIVO: ${sym}`);
    this.bus.emit('market:ticker_state',{symbol:sym,state:msg.state,in_auction:msg.in_auction,timestamp:msg.timestamp});
  }
  _onOfferBook(msg) {
    // Notificar MDIL ÃÂ¢ÃÂÃÂ recebeu OfferBook real
    const _sym2 = msg.ticker || '';
    const _bids = Object.values(this.bookWDO.bids).length + Object.values(this.bookDOL.bids).length;
    this.mdil.onOfferBook(_sym2, _bids);
    const sym=msg.ticker||''; const isWDO=this._isWDO(sym); const isDOL=this._isDOL(sym);
    if(!isWDO&&!isDOL) return;
    // Log diagnostico
    if(!this._offerCounts) this._offerCounts={};
    this._offerCounts[sym]=(this._offerCounts[sym]||0)+1;
    const cnt=this._offerCounts[sym];
    if(cnt<=50||cnt%500===0) console.log('[OFFER_BOOK]',sym,msg.action,'side='+msg.side,'qty='+msg.quantity,'p='+msg.price,'#'+cnt);
    const book=isWDO?this.bookWDO:this.bookDOL;
    if(msg.action==='FULL_BOOK'){
      if(!book._snapActive){book.bids={};book.asks={};book._snapActive=true;}
      if(msg.price==null) return;
      const key=Math.round(msg.price*100);
      const side=msg.side==='BUY'?book.bids:book.asks;
      const prev=side[key]?.qty||0;
      side[key]={price:msg.price,qty:prev+(msg.quantity||0),agent:msg.agent||0};
      const bids=Object.values(book.bids).sort((a,b)=>b.price-a.price).slice(0,20);
      const asks=Object.values(book.asks).sort((a,b)=>a.price-b.price).slice(0,20);
      if(isWDO)this.bus.emit('market:book:wdo',{symbol:sym,bids,asks,timestamp:Date.now(),source:'offer_book'});
      else this.bus.emit('market:book:dol',{symbol:sym,bids,asks,timestamp:Date.now(),source:'offer_book'});
      return;
    }
    book._snapActive=false;
    if(msg.price==null) return;
    const key=Math.round(msg.price*100);
    if(msg.action==='DELETE'||!msg.quantity){if(msg.side==='BUY')delete book.bids[key];else delete book.asks[key];}
    else{
      const side=msg.side==='BUY'?book.bids:book.asks;
      if(msg.action==='INSERT'){const prev=side[key]?.qty||0;side[key]={price:msg.price,qty:prev+msg.quantity,agent:msg.agent||0};}
      else{side[key]={price:msg.price,qty:msg.quantity,agent:msg.agent||0};}
    }
    const bids=Object.values(book.bids).sort((a,b)=>b.price-a.price).slice(0,20);
    const asks=Object.values(book.asks).sort((a,b)=>a.price-b.price).slice(0,20);
    if(isWDO)this.bus.emit('market:book:wdo',{symbol:sym,bids,asks,timestamp:Date.now(),source:'offer_book'});
    else this.bus.emit('market:book:dol',{symbol:sym,bids,asks,timestamp:Date.now(),source:'offer_book'});
  }
  _onPriceDepth(msg) {
    // Dados reais de profundidade (Level 2) — popula bookWDO/bookDOL,
    // o que automaticamente ativa a trava existente em _onTinyBook
    // (bidCount>=5||askCount>=5 ignora o book sintetico).
    const sym=msg.ticker||''; const isWDO=this._isWDO(sym); const isDOL=this._isDOL(sym);
    if(!isWDO&&!isDOL) return;
    this.mdil.onOfferBook(sym, (msg.bids||[]).length + (msg.asks||[]).length);
    const book = isWDO ? this.bookWDO : this.bookDOL;
    book.bids = {}; book.asks = {};
    for (const b of (msg.bids||[])) {
      const key = Math.round(b.price*100);
      book.bids[key] = { price: b.price, qty: b.qty||0, agent: 0 };
    }
    for (const a of (msg.asks||[])) {
      const key = Math.round(a.price*100);
      book.asks[key] = { price: a.price, qty: a.qty||0, agent: 0 };
    }
    // CRITICO: atualizar bid/ask de referencia com o melhor preco do book
    // real. Sem isso, _onTrade monta tick com bid/ask zerados (pois
    // _onTinyBook nao gera mais book sintetico), e _validateTick no
    // data_normalizer descarta o tick inteiro por falta de bid/ask —
    // quebrando preco na tela e Times&Trades.
    const bestBid = Math.max(0, ...(msg.bids||[]).map(b=>b.price), 0);
    const bestAsk = (msg.asks||[]).length ? Math.min(...msg.asks.map(a=>a.price)) : 0;
    const ref = isWDO ? this.lastWDO : this.lastDOL;
    if (bestBid > 0) ref.bid = bestBid;
    if (bestAsk > 0) ref.ask = bestAsk;
    if(!this._depthCounts) this._depthCounts={};
    this._depthCounts[sym]=(this._depthCounts[sym]||0)+1;
    if(this._depthCounts[sym]===1||this._depthCounts[sym]%500===0) console.log('[PRICE_DEPTH]',sym,'REAL — bids='+(msg.bids||[]).length,'asks='+(msg.asks||[]).length,'#'+this._depthCounts[sym]);
    const bids=Object.values(book.bids).sort((a,b)=>b.price-a.price).slice(0,40);
    const asks=Object.values(book.asks).sort((a,b)=>a.price-b.price).slice(0,40);
    if(isWDO)this.bus.emit('market:book:wdo',{symbol:sym,bids,asks,timestamp:Date.now(),source:'price_depth'});
    else this.bus.emit('market:book:dol',{symbol:sym,bids,asks,timestamp:Date.now(),source:'price_depth'});
  }
  _onTinyBook(msg) {
    // Notifica a camada de integridade (MDIL ainda usa isso para detectar feed)
    this.mdil.onTinyBook(msg.ticker || '');
    const sym=msg.ticker||''; const isWDO=this._isWDO(sym); const isDOL=this._isDOL(sym);
    if(!isWDO&&!isDOL) return;
    // Apenas guarda bid/ask de topo para calculo de spread/referencia.
    // NAO gera mais book sintetico nem emite market:book:* — isso agora
    // e responsabilidade exclusiva de _onPriceDepth (dados reais Level 2).
    if(isWDO){
      if(msg.side==='BUY') this.lastWDO.bid=msg.price; else this.lastWDO.ask=msg.price;
    } else {
      if(msg.side==='BUY') this.lastDOL.bid=msg.price; else this.lastDOL.ask=msg.price;
    }
  }
  _onDaily(msg) {
    const sym=msg.ticker||''; if(!this._isWDO(sym)) return;
    this.lastWDO.auc_vol=msg.qty||0;this.lastWDO.open=msg.open||0;this.lastWDO.high=msg.high||0;this.lastWDO.low=msg.low||0;
  }
}
module.exports={ProfitClient};
