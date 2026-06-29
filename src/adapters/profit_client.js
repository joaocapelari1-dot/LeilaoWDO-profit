'use strict';
/**
 * ProfitClient v3.2 — MDIL integrado
 * TinyBook nao sobrescreve OfferBook real quando >= 5 niveis disponiveis.
 * MDIL detecta ghost feed e marca dados sintéticos.
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
    console.log('[PROFIT-CLIENT] v3.2 Modo Invertido — MDIL ativo — aguardando VPS em /bridge');
    this.mdil.start();
    this._listenBus();
  }
  disconnect() {}
  _isWDO(s){return WDO_SYMBOLS.some(x=>s.includes(x));}
  _isDOL(s){return DOL_SYMBOLS.some(x=>s.includes(x));}
  _listenBus() {
    this.bus.on('profit:connection_state',(e)=>{
      console.log(`[PROFIT-CLIENT] DLL [${e.conn_type}] -> ${e.result}`);
      if(e.conn_type==='MARKET_DATA'&&e.result==='CONNECTED') this.bus.emit('cedro:connected');
      this.bus.emit('cedro:syn',{timestamp:Date.now()});
    });
    this.bus.on('profit:trade',(e)=>this._onTrade(e));
    this.bus.on('profit:theoretical_price',(e)=>this._onTheoreticalPrice(e));
    this.bus.on('profit:ticker_state',(e)=>this._onTickerState(e));
    this.bus.on('profit:offer_book',(e)=>this._onOfferBook(e));
    this.bus.on('profit:tiny_book',(e)=>this._onTinyBook(e));
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
      surplus:0,surplus_side:null,buy_agent:msg.buy_agent||0,sell_agent:msg.sell_agent||0,
      in_auction:this.auctionActive[sym]||false,phase:this.auctionActive[sym]?'auction':'continuous'};
    if(isWDO){this.lastWDO={...this.lastWDO,...tick};this.bus.emit('cedro:tick:wdo',{...this.lastWDO});this.bus.emit('cedro:trade:wdo',{symbol:sym,price:tick.last,qty:tick.trade_vol,agressor,timestamp:tick.timestamp});}
    else{this.lastDOL={...this.lastDOL,...tick};this.bus.emit('cedro:tick:dol',{...this.lastDOL});this.bus.emit('cedro:trade:dol',{symbol:sym,price:tick.last,qty:tick.trade_vol,agressor,timestamp:tick.timestamp});}
    this.bus.emit('cedro:syn',{timestamp:Date.now()});
  }
  _onTheoreticalPrice(msg) {
    const sym=msg.ticker||''; const isWDO=this._isWDO(sym); const isDOL=this._isDOL(sym);
    if(!isWDO&&!isDOL) return;
    const price=msg.theoretical_price; const qty=msg.theoretical_qty||0;
    if(!isFinite(price)||price<=0) return;
    if(isWDO){this.theorWDO={price,qty};this.lastWDO={...this.lastWDO,theor_price:price,theor_qty:qty,last:(this.lastWDO.last||price),in_auction:true,phase:'auction'};this.bus.emit('cedro:tick:wdo',{...this.lastWDO});}
    else{this.theorDOL={price,qty};this.lastDOL={...this.lastDOL,theor_price:price,theor_qty:qty,last:(this.lastDOL.last||price),in_auction:true,phase:'auction'};this.bus.emit('cedro:tick:dol',{...this.lastDOL});}
  }
  _onTickerState(msg) {
    const sym=msg.ticker||''; this.auctionActive[sym]=msg.in_auction||false;
    if(msg.in_auction) console.log(`[PROFIT-CLIENT] LEILAO ATIVO: ${sym}`);
    this.bus.emit('cedro:ticker_state',{symbol:sym,state:msg.state,in_auction:msg.in_auction,timestamp:msg.timestamp});
  }
  _onOfferBook(msg) {
    // Notificar MDIL — recebeu OfferBook real
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
      if(isWDO)this.bus.emit('cedro:book:wdo',{symbol:sym,bids,asks,timestamp:Date.now(),source:'offer_book'});
      else this.bus.emit('cedro:book:dol',{symbol:sym,bids,asks,timestamp:Date.now(),source:'offer_book'});
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
    if(isWDO)this.bus.emit('cedro:book:wdo',{symbol:sym,bids,asks,timestamp:Date.now(),source:'offer_book'});
    else this.bus.emit('cedro:book:dol',{symbol:sym,bids,asks,timestamp:Date.now(),source:'offer_book'});
  }
  _onTinyBook(msg) {
    // Notificar MDIL — apenas TinyBook chegou
    this.mdil.onTinyBook(msg.ticker || '');
    const sym=msg.ticker||''; const isWDO=this._isWDO(sym); const isDOL=this._isDOL(sym);
    if(!isWDO&&!isDOL) return;
    if(isWDO){if(msg.side==='BUY')this.lastWDO.bid=msg.price;else this.lastWDO.ask=msg.price;}
    else{if(msg.side==='BUY')this.lastDOL.bid=msg.price;else this.lastDOL.ask=msg.price;}
    // NAO sobrescrever OfferBook real com dados sinteticos
    const realBook = isWDO ? this.bookWDO : this.bookDOL;
    const bidCount = Object.keys(realBook.bids||{}).length;
    const askCount = Object.keys(realBook.asks||{}).length;
    if(bidCount >= 5 || askCount >= 5) {
      return; // OfferBook real disponivel — ignorar TinyBook
    }
    // Log diagnostico (quando sem OfferBook real)
    if(!this._tinyCounts) this._tinyCounts={};
    this._tinyCounts[sym]=(this._tinyCounts[sym]||0)+1;
    if(this._tinyCounts[sym]===1||this._tinyCounts[sym]%200===0) console.log('[TINY_BOOK]',sym,'SINTETICO (sem OfferBook real) #'+this._tinyCounts[sym]);
    const ref = isWDO ? this.lastWDO : this.lastDOL;
    const bid = ref.bid || 0;
    const ask = ref.ask || 0;
    // Estimar o lado faltante com 0.5 pts de spread (WDO tick size)
    const TICK = 0.5;
    const effectiveBid = bid || (ask ? ask - TICK : 0);
    const effectiveAsk = ask || (bid ? bid + TICK : 0);
    if(!effectiveBid || !effectiveAsk) return;
    const TICK = 0.5;
    const LEVELS = 40;
    const bids = Array.from({length:LEVELS},(_,i)=>({
      price: Math.round((effectiveBid - i*TICK)*100)/100,
      qty: Math.max(1, Math.round(50 * Math.exp(-i * 0.15)))
    }));
    const asks = Array.from({length:LEVELS},(_,i)=>({
      price: Math.round((effectiveAsk + i*TICK)*100)/100,
      qty: Math.max(1, Math.round(50 * Math.exp(-i * 0.15)))
    }));
    const totalBid = bids.reduce((s,b)=>s+b.qty,0);
    const totalAsk = asks.reduce((s,a)=>s+a.qty,0);
    const book = {symbol:sym,bids,asks,bid_vol_total:totalBid,ask_vol_total:totalAsk,
      imbalance:0,best_bid:effectiveBid,best_ask:effectiveAsk,timestamp:Date.now(),source:'tiny_book'};
    if(isWDO) this.bus.emit('cedro:book:wdo', book);
    else this.bus.emit('cedro:book:dol', book);
  }
  _onDaily(msg) {
    const sym=msg.ticker||''; if(!this._isWDO(sym)) return;
    this.lastWDO.auc_vol=msg.qty||0;this.lastWDO.open=msg.open||0;this.lastWDO.high=msg.high||0;this.lastWDO.low=msg.low||0;
  }
}
module.exports={ProfitClient};
