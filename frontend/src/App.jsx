import { useState, useEffect } from 'react'
import { useWDOSocket } from './hooks/useWDOSocket'
import {
  useSignalAlert, StatusBar,
  PricePanel, FlowPanel, AuctionPanel, DecisionWindow,
  AIPanel,
  RiskPanel, ExecutionPanel, TimesAndTrades,
  MarketContextPanel, CalibracaoPanel, ExecutionStats, EsgotamentoAlert, ChatSystem, APIStatus, LoginScreen, CIPCMEPanel, TapeThermometer, CMERangePanel, MarketFeaturesPanel, MapaForca
} from './components/index.jsx'

function Clock() {
  const [time, setTime] = useState(new Date())
  useEffect(() => {
    const t = setInterval(() => setTime(new Date()), 1000)
    return () => clearInterval(t)
  }, [])
  const h = String(time.getHours()).padStart(2,'0')
  const m = String(time.getMinutes()).padStart(2,'0')
  const s = String(time.getSeconds()).padStart(2,'0')
  return (
    <span style={{ fontFamily:"'JetBrains Mono',monospace", fontSize:13, fontWeight:700, color:'#e2e8f0', letterSpacing:2 }}>
      {h}:{m}:{s}
    </span>
  )
}

function LeilaoStatus({ auctionState, connected }) {
  const state  = auctionState?.to || 'IDLE'
  const online = connected && ['AUCTION','PRICE_DISCOVERY','SIGNAL_READY','PRE_OPEN'].includes(state)
  // Verificar dia útil e horário BRT
  const _brt    = new Date(Date.now() - 3 * 60 * 60 * 1000)
  const _dia    = _brt.getUTCDay() // 0=dom, 6=sab
  const _hora   = _brt.getUTCHours() + _brt.getUTCMinutes() / 60
  const _diaUtil = _dia >= 1 && _dia <= 5
  const _mercadoAberto = _diaUtil && _hora >= 9.0 && _hora < 18.0
  const color  = online ? '#22c55e' : _mercadoAberto ? '#f59e0b' : '#ef4444'
  const label  = online ? 'LEILÁO ONLINE' : (!_diaUtil || !_mercadoAberto) ? 'AGUARDANDO' : state === 'CONTINUOUS' ? 'MERCADO ABERTO' : state === 'CLOSING' ? 'FECHAMENTO' : 'AGUARDANDO'
  return (
    <div style={{ display:'flex', alignItems:'center', gap:6, padding:'3px 10px', background:`${color}15`, border:`1px solid ${color}40`, borderRadius:20 }}>
      <div style={{ width:7, height:7, borderRadius:'50%', background:color, boxShadow:`0 0 6px ${color}`, animation: online ? 'pulse 1.5s infinite' : 'none' }} />
      <span style={{ fontSize:10, fontWeight:700, color, letterSpacing:1.5, fontFamily:'monospace' }}>{label}</span>
    </div>
  )
}

function MercadoMundialPanel({ macro, tick, dolFeatures }) {
  const C = { panel:'#0c1219', border:'#1e2832', text:'#e2e8f0', muted:'#64748b', green:'#22c55e', red:'#ef4444', gold:'#f59e0b', cyan:'#06b6d4' }

  const wdoPrice = tick?.theor_price || tick?.last  // Preferir preço teórico durante leilão
  const dolPrice = dolFeatures?.last || dolFeatures?.tick?.last

  const ativos = [
    { label:'WDO MINI',  val: wdoPrice,        chg: tick?.variation,     cor: C.cyan  },
    { label:'DOL CHEIO', val: dolPrice,         chg: null,                cor: C.gold  },
    { label:'DXY',       val: macro?.dxy?.price,         chg: macro?.dxy?.changePct,       inv: false   },
    { label:'USD/BRL',   val: macro?.usdbrl?.price,      chg: macro?.usdbrl?.changePct,    inv: false   },
    { label:'TREAS 10Y', val: macro?.treasury10y?.price, chg: macro?.treasury10y?.changePct, inv: false, dec:2 },
    { label:'VIX',       val: macro?.vix?.price,         chg: macro?.vix?.changePct,       inv: true    },
    { label:'S&P 500',   val: macro?.sp500?.price,       chg: macro?.sp500?.changePct,     inv: true    },
    { label:'PETRÓLEO',  val: macro?.oilWTI?.price,      chg: macro?.oilWTI?.changePct,    inv: true    },
  ]

  return (
    <div style={{ background:C.panel, borderTop:`1px solid ${C.border}`, padding:'8px 10px', flexShrink:0 }}>
      <div style={{ fontSize:8, color:C.muted, letterSpacing:2, marginBottom:5 }}>MERCADOS</div>
      <div style={{ display:'flex', flexDirection:'column', gap:2 }}>
        {ativos.map((a, i) => {
          const v   = a.val ? Number(a.val) : null
          const val = v ? v.toFixed(a.dec || (v > 1000 ? 0 : v > 10 ? 2 : 3)) : '→'
          const chg = a.chg ? Number(a.chg) : null
          const up  = chg > 0
          const textCor = a.cor || C.text
          const chgCor  = chg === null ? C.muted : (a.inv ? (up ? C.red : C.green) : (up ? C.green : C.red))
          return (
            <div key={i} style={{ display:'flex', justifyContent:'space-between', alignItems:'center' }}>
              <span style={{ fontSize:8, color: a.cor || C.muted, letterSpacing:1 }}>{a.label}</span>
              <div>
                <span style={{ fontSize:10, color:textCor, fontFamily:'monospace', fontWeight:600 }}>{val}</span>
                {chg !== null && (
                  <span style={{ fontSize:8, color:chgCor, marginLeft:3 }}>
                    {up?'▲':'▼'}{Math.abs(chg).toFixed(2)}%
                  </span>
                )}
              </div>
            </div>
          )
        })}
      </div>
      {macro?.macroScore !== undefined && (
        <div style={{ marginTop:5, paddingTop:4, borderTop:`1px solid ${C.border}`, display:'flex', justifyContent:'space-between' }}>
          <span style={{ fontSize:8, color:C.muted }}>MACRO SCORE</span>
          <span style={{ fontSize:11, fontWeight:700, fontFamily:'monospace',
            color: macro.macroScore > 2 ? C.green : macro.macroScore < -2 ? C.red : C.gold }}>
            {macro.macroScore > 0 ? '+' : ''}{macro.macroScore}/10
          </span>
        </div>
      )}
    </div>
  )
}

export default function App() {
  const token = 'bypass'
  const handleLogout = () => {}

  const socket = useWDOSocket(token)
  const [tab, setTab] = useState('dashboard')
  useSignalAlert(socket.signal)

  return (
    <div style={{ minHeight:'100vh', background:'#080c10', color:'#e2e8f0', fontFamily:'monospace' }}>
      <EsgotamentoAlert esgotamento={socket.esgotamento} />
      <style>{`
        @keyframes pulse {
          0%,100% { opacity:1; box-shadow:0 0 6px #22c55e; }
          50%      { opacity:.6; box-shadow:0 0 12px #22c55e; }
        }
        ::-webkit-scrollbar { width:4px; height:4px; }
        ::-webkit-scrollbar-track { background:#0c1219; }
        ::-webkit-scrollbar-thumb { background:#1e2832; border-radius:2px; }
      `}</style>

      {/* Top Bar */}
      <div style={{ borderBottom:'1px solid #1e2832', padding:'6px 16px', display:'flex', alignItems:'center', justifyContent:'space-between', background:'#0c1219' }}>
        <div style={{ display:'flex', alignItems:'center', gap:12 }}>
          <div style={{ width:7, height:7, borderRadius:'50%', background:socket.connected?'#22c55e':'#ef4444', boxShadow:socket.connected?'0 0 8px #22c55e':'none' }} />
          <span style={{ fontSize:12, fontWeight:700, color:'#f8fafc', letterSpacing:1 }}>WDO AUCTION ENGINE</span>
          <span style={{ fontSize:9, color:'#22c55e', letterSpacing:2 }}>LIVE</span>
        </div>
        <div style={{ display:'flex', alignItems:'center', gap:14 }}>
          <Clock />
          <LeilaoStatus auctionState={socket.auctionState} connected={socket.connected} />
        </div>
        <div style={{ display:'flex', gap:6, alignItems:'center' }}>
          <span style={{ fontSize:9, color:'#475569', marginRight:4 }}>{localStorage.getItem('wdo_usuario')}</span>
          <button onClick={handleLogout} style={{ padding:'3px 10px', fontSize:9, letterSpacing:1, background:'transparent', color:'#475569', border:'1px solid #1e2832', borderRadius:3, cursor:'pointer', marginRight:6 }}>SAIR</button>
          {['dashboard','execution'].map(t => (
            <button key={t} onClick={() => setTab(t)} style={{ padding:'3px 12px', fontSize:9, letterSpacing:1.5, textTransform:'uppercase', background:tab===t?'#1e40af':'transparent', color:tab===t?'#fff':'#64748b', border:`1px solid ${tab===t?'#3b82f6':'#1e2832'}`, borderRadius:3, cursor:'pointer' }}>{t}</button>
          ))}
        </div>
      </div>

      {tab === 'dashboard' && (
        <div style={{ display:'grid', gridTemplateColumns:'200px 1fr 480px', gap:1, padding:1, height:'calc(100vh - 39px)', overflow:'hidden' }}>

          {/* Coluna esquerda */}
          <div style={{ display:'flex', flexDirection:'column', gap:1, overflow:'hidden' }}>
            <div style={{ flex:1, display:'flex', flexDirection:'column', gap:1, overflowY:'auto' }}>
              <PricePanel      tick={socket.tick} features={socket.features} macro={socket.macro} />
              <AuctionPanel    auctionState={socket.auctionState} features={socket.features} signal={socket.signal} />
              <FlowPanel       features={socket.features} />
            </div>
            <MercadoMundialPanel macro={socket.macro} tick={socket.tick} dolFeatures={socket.dolFeatures} />
          </div>

          {/* Centro */}
          <div style={{ display:'flex', flexDirection:'column', gap:1, overflow:'hidden' }}>
            <div style={{ flex:'0 0 12%', overflow:'hidden' }}>
              <AIPanel aiAnalysis={socket.aiAnalysis} />
            </div>
            <div style={{ flex:1, display:'grid', gridTemplateColumns:'1fr 1fr', gridTemplateRows:'1fr 1fr 1fr', gap:1, overflow:'hidden' }}>
              <MarketFeaturesPanel mktFeatures={socket.mktFeatures} aiAnalysis={socket.aiAnalysis} />
              <CIPCMEPanel         macro={socket.macro} />
              {/* CalibracaoPanel removido → calibração automática pelo AdaptiveLog */}
              <RiskPanel           riskEvent={socket.riskEvent} />
              <CMERangePanel       macro={socket.macro} />
              <TapeThermometer     features={socket.features} mktFeatures={socket.mktFeatures} />
              <ExecutionPanel      fills={socket.fills} />
            </div>
          </div>

          {/* Coluna direita → Times&Trades + janelas de leilao embaixo de cada um */}
          <div style={{ display:'flex', flexDirection:'column', gap:1, overflow:'hidden', height:'100%' }}>
            <div style={{ display:'grid', gridTemplateColumns:'1fr 1fr', gap:1, flex:1, overflow:'hidden' }}>
              <div style={{ display:'flex', flexDirection:'column', gap:1, overflow:'hidden' }}>
                <div style={{ flex:'0 0 55%', overflow:'hidden' }}>
                  <TimesAndTrades tape={socket.tape} symbol="WDOQ26" mdilStatus={socket.mdilStatus?.['WDOQ26']} />
                </div>
                <div style={{ flex:'0 0 auto', maxHeight:'40%', overflowY:'auto' }}>
                  <MarketContextPanel ctx={socket.marketContext} />
                </div>
              </div>
              <div style={{ display:'flex', flexDirection:'column', gap:1, overflow:'hidden' }}>
                <div style={{ flex:'0 0 55%', overflow:'hidden' }}>
                  <TimesAndTrades tape={socket.tapeDol} symbol="DOLQ26" mdilStatus={socket.mdilStatus?.['DOLQ26']} />
                </div>
                <div style={{ flex:'0 0 auto', maxHeight:'40%', overflowY:'auto' }}>
                  <DecisionWindow windowState={socket.windowState} snapshots={socket.snapshots} />
                </div>
              </div>
            </div>
          </div>

        </div>
      )}

      {tab === 'execution' && <ExecutionStats adaptive={socket.adaptive} fills={socket.fills} />}

    </div>
  )
}

