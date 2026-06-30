import { useState, useEffect, useRef, useCallback } from 'react'

const WS_URL = 'wss://leilaowdo-profit-production.up.railway.app/ws'

export function useWDOSocket(token) {
  const [connected, setConnected]     = useState(false)
  const [tick, setTick]               = useState(null)
  const [book, setBook]               = useState(null)
  const [bookDol, setBookDol]           = useState(null)
  const [dolTick, setDolTick]           = useState(null)
  const [mdilStatus, setMdilStatus]     = useState({})
  const [features, setFeatures]       = useState(null)
  const [auctionState, setAuction]    = useState(null)
  const [signal, setSignal]           = useState(null)
  const [aiAnalysis, setAI]           = useState(null)
  const [riskEvent, setRisk]          = useState(null)
  const [fills, setFills]             = useState([])
  const [tickHistory, setTickHistory] = useState([])
  const [tape, setTape]               = useState([])
  const [dolFeatures, setDolFeatures] = useState(null)
  const [confluence, setConfluence]   = useState(null)
  const [marketContext, setContext]    = useState({})
  const [adaptive, setAdaptive]       = useState(null)
  const [esgotamento, setEsgotamento] = useState(null)
  const [macro, setMacro]             = useState(null)
  const [symbols, setSymbols]         = useState({ wdo: 'WDOQ26', dol: 'DOLQ26' })
  const [mktFeatures, setMktFeatures] = useState(null)
  const [histTrades, setHistTrades]   = useState([])
  const [historico, setHistorico]     = useState([])
  const [journal, setJournal]         = useState([])
  const [balanco, setBalanco]         = useState({ mensal: null, anual: null })

  // Busca histórico e balanço via REST
  useEffect(() => {
    if (!token) return
    const fetchDados = async () => {
      try {
        const [rHist, rBalMes, rBalAno, rJournal] = await Promise.all([
          fetch('https://leilaowdo-profit-production.up.railway.app/api/adaptive/historico', { headers: { Authorization: 'Bearer ' + token } }),
          fetch('https://leilaowdo-profit-production.up.railway.app/api/adaptive/balanco/mensal', { headers: { Authorization: 'Bearer ' + token } }),
          fetch('https://leilaowdo-profit-production.up.railway.app/api/adaptive/balanco/anual', { headers: { Authorization: 'Bearer ' + token } }),
          fetch('https://leilaowdo-profit-production.up.railway.app/api/adaptive/journal', { headers: { Authorization: 'Bearer ' + token } }),
        ])
        const hist    = await rHist.json()
        const balMes  = await rBalMes.json()
        const balAno  = await rBalAno.json()
        const journal = await rJournal.json()
        if (Array.isArray(hist))    setHistorico(hist)
        if (Array.isArray(journal)) setJournal(journal)
        setBalanco({ mensal: balMes, anual: balAno })
      } catch {}
    }
    fetchDados()
    const t = setInterval(fetchDados, 60000)
    return () => clearInterval(t)
  }, [token])
  const [windowState, setWindow]      = useState(null)
  const [snapshots, setSnapshots]     = useState([])

  const wsRef = useRef(null)
  const reconnectRef = useRef(null)

  const connect = useCallback(() => {
    try {
      const ws = new WebSocket(WS_URL)
      wsRef.current = ws
      ws.onopen = () => { setConnected(true); clearTimeout(reconnectRef.current) }
      ws.onmessage = (evt) => {
        try {
          const msg = JSON.parse(evt.data)
          switch (msg.type) {
            case 'tick':
              setTick(msg.data)
              setTickHistory(prev => { const n = [...prev.slice(-99), { ...msg.data, t: Date.now() }]; return n; })
              if (msg.data.trade_vol > 0) {
                const side = msg.data.last >= msg.data.ask ? 'buy' : 'sell'
                setTape(prev => [{ ts: Date.now(), price: msg.data.last, vol: msg.data.trade_vol, side }, ...prev].slice(0, 100))
              }
              break
            case 'book':          setBook(msg.data);     break
            case 'book_dol':      setBookDol(msg.data);  break
            case 'features_dol':  if(msg.data) setDolFeatures(msg.data); break
            case 'mdil_status':   if(msg.data) setMdilStatus(prev => ({...prev, [msg.data.sym]: msg.data})); break
            case 'mdil_ghost':    if(msg.data) setMdilStatus(prev => ({...prev, [msg.data.sym]: {...(prev[msg.data.sym]||{}), ghost:true}})); break
            case 'mdil_real':     if(msg.data) setMdilStatus(prev => ({...prev, [msg.data.sym]: {...(prev[msg.data.sym]||{}), ghost:false}})); break
            case 'tick_dol':      if(msg.data) setDolTick(msg.data); break
            case 'context_gap':
              setContext(prev => ({ ...prev, gap: msg.data })); break
            case 'context_calendar':
              setContext(prev => ({ ...prev, calendario: msg.data })); break
            case 'context_mm':
              setContext(prev => ({ ...prev, formadores: msg.data })); break
            case 'adaptive_thresh': setAdaptive(prev => ({ ...prev, ...msg.data })); break
            case 'esgotamento':     setEsgotamento(msg.data); setTimeout(() => setEsgotamento(null), 30000); break
            case 'macro_update':     setMacro(msg.data); break
            case 'symbols_update':    setSymbols(msg.data); break
            case 'market_features':    setMktFeatures(msg.data); break
            case 'hist_trades':         setHistTrades(prev => [...prev, ...msg.data].slice(-200)); break
            case 'adaptive_pregao': break
            case 'features':
              setFeatures(msg.data)
              if (msg.data.confluence) setConfluence(msg.data.confluence)
              break
            case 'auction_state': setAuction(msg.data);  break
            case 'state_snapshot':
              setAuction({ to: msg.data?.auction?.state, from: null });
              if (msg.data?.macro)    setMacro(msg.data.macro);
              if (msg.data?.adaptive) setAdaptive(prev => ({ ...prev, ...msg.data.adaptive }));
              if (msg.data?.gap)       setContext(prev => ({ ...prev, gap: msg.data.gap }));
              if (msg.data?.calendario) setContext(prev => ({ ...prev, calendario: msg.data.calendario }));
              break
            case 'signal':        setSignal(msg.data);   break
            case 'ai_analise':    setAI(msg.data);        break
            case 'iceberg':       setFeatures(prev => prev ? { ...prev, iceberg: msg.data } : { iceberg: msg.data }); break
            case 'risk_confianca': break // usado internamente pelo risk engine
            case 'close':         setFills(prev => [{ ...msg.data, tipo: 'close' }, ...prev].slice(0, 20)); break
            case 'risk_approved':
            case 'risk_rejected': setRisk({ ...msg.data, type: msg.type }); break
            case 'risk_snapshot': setSnapshots(prev => [...prev.slice(-5), msg.data]); break
            case 'risk_window':   setWindow(msg.data); break
            case 'fill':          setFills(prev => [msg.data, ...prev].slice(0, 20)); break
          }
        } catch {}
      }
      ws.onclose = () => { setConnected(false); reconnectRef.current = setTimeout(connect, 2500) }
      ws.onerror = () => ws.close()
    } catch {}
  }, [])

  useEffect(() => {
    connect()
    return () => { clearTimeout(reconnectRef.current); wsRef.current?.close() }
  }, [])

  // Merge historical trades + live ticks for chart
  const fullTickHistory = [...histTrades, ...(tickHistory || [])]

  return { connected, tick, book, bookDol, dolTick, mdilStatus, features, mktFeatures, auctionState, signal, aiAnalysis, riskEvent, fills, tickHistory: fullTickHistory, tape, windowState, snapshots, dolFeatures, confluence, marketContext, adaptive: adaptive ? { ...adaptive, historico, journal, balanco } : { historico, journal, balanco }, esgotamento, macro, symbols }
}
