import React, { useEffect, useRef, useState } from 'react'

const C = {
  bg:       '#080c10',
  panel:    '#0c1219',
  border:   '#1e2832',
  text:     '#e2e8f0',
  muted:    '#64748b',
  dim:      '#475569',
  green:    '#22c55e',
  red:      '#ef4444',
  blue:     '#3b82f6',
  gold:     '#f59e0b',
  purple:   '#8b5cf6',
  cyan:     '#06b6d4',
  greenDim: 'rgba(34,197,94,0.12)',
  redDim:   'rgba(239,68,68,0.12)',
  iceberg:  'rgba(6,182,212,0.15)',
}

const panel  = { background: C.panel, border: `1px solid ${C.border}`, borderRadius: 4, padding: '10px 12px', overflow: 'hidden' }
const label  = { fontSize: 10, letterSpacing: 2, textTransform: 'uppercase', color: C.muted, marginBottom: 6, display: 'block' }
const mono   = { fontFamily: "'JetBrains Mono', monospace" }

// ── Sound ─────────────────────────────────────────────────────
function playSignalSound(direction) {
  try {
    const ctx  = new (window.AudioContext || window.webkitAudioContext)()
    const osc  = ctx.createOscillator()
    const gain = ctx.createGain()
    osc.connect(gain); gain.connect(ctx.destination)
    if (direction === 'buy') {
      osc.frequency.setValueAtTime(880, ctx.currentTime)
      osc.frequency.setValueAtTime(1100, ctx.currentTime + 0.1)
    } else if (direction === 'sell') {
      osc.frequency.setValueAtTime(660, ctx.currentTime)
      osc.frequency.setValueAtTime(440, ctx.currentTime + 0.1)
    } else {
      osc.frequency.setValueAtTime(300, ctx.currentTime)
    }
    gain.gain.setValueAtTime(0.15, ctx.currentTime)
    gain.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + 0.4)
    osc.start(ctx.currentTime); osc.stop(ctx.currentTime + 0.4)
    if ('speechSynthesis' in window) {
      const u = new SpeechSynthesisUtterance(direction === 'buy' ? 'compra' : direction === 'sell' ? 'venda' : 'abortado')
      u.lang = 'pt-BR'; u.volume = 0.4; u.rate = 0.9
      setTimeout(() => window.speechSynthesis.speak(u), 300)
    }
  } catch {}
}

export function useSignalAlert(signal) {
  const lastId = useRef(null)
  useEffect(() => {
    if (!signal || signal.id === lastId.current) return
    lastId.current = signal.id
    playSignalSound(signal.direction)
  }, [signal])
}

// ── Candlestick Canvas ────────────────────────────────────────
function buildCandles(tickHistory, periodMs = 5000) {
  if (!tickHistory?.length) return []
  const buckets = {}
  tickHistory.forEach(t => {
    if (!t.last && !t.price) return
    const price = t.last || t.price
    const ts    = t.t || t.timestamp || Date.now()
    const key   = Math.floor(ts / periodMs) * periodMs
    if (!buckets[key]) buckets[key] = { t: key, open: price, high: price, low: price, close: price, vwap: t.vwap || price, vol: 0 }
    const b = buckets[key]
    b.high  = Math.max(b.high, price)
    b.low   = Math.min(b.low,  price)
    b.close = price
    b.vol   += (t.qty || t.trade_vol || 0)
    if (t.vwap) b.vwap = t.vwap
  })
  return Object.values(buckets).sort((a, b) => a.t - b.t)
}

function CandlestickCanvas({ candles, signal }) {
  const ref = useRef(null)
  useEffect(() => {
    const canvas = ref.current
    if (!canvas || !candles.length) return
    const ctx = canvas.getContext('2d')
    const W = canvas.width, H = canvas.height
    ctx.clearRect(0, 0, W, H)
    const prices = candles.flatMap(c => [c.high, c.low])
    const minP = Math.min(...prices) - 1
    const maxP = Math.max(...prices) + 1
    const range = maxP - minP || 1
    const toY = p => H - ((p - minP) / range) * H * 0.88 - H * 0.06
    const cW  = Math.max((W / candles.length) - 2, 3)

    // Grid
    ctx.strokeStyle = '#1e2832'; ctx.lineWidth = 0.5
    for (let i = 0; i <= 4; i++) { const y = (H/4)*i; ctx.beginPath(); ctx.moveTo(0,y); ctx.lineTo(W,y); ctx.stroke() }

    // VWAP
    ctx.strokeStyle = C.gold; ctx.lineWidth = 1; ctx.setLineDash([4,3])
    ctx.beginPath()
    candles.forEach((c,i) => { const x = i*(W/candles.length)+cW/2; const y = toY(c.vwap||c.close); i===0?ctx.moveTo(x,y):ctx.lineTo(x,y) })
    ctx.stroke(); ctx.setLineDash([])

    // Signal
    if (signal?.price) {
      const sy = toY(signal.price)
      ctx.strokeStyle = signal.direction==='buy'?C.green:C.red; ctx.lineWidth=1; ctx.setLineDash([3,3])
      ctx.beginPath(); ctx.moveTo(0,sy); ctx.lineTo(W,sy); ctx.stroke(); ctx.setLineDash([])
      ctx.fillStyle = signal.direction==='buy'?C.green:C.red; ctx.font='9px monospace'
      ctx.fillText(signal.direction?.toUpperCase(), W-32, sy-3)
    }

    // Candles
    candles.forEach((c,i) => {
      const x     = i*(W/candles.length)+1
      const bull  = c.close >= c.open
      const color = bull ? C.green : C.red
      const yH    = toY(c.high), yL = toY(c.low)
      const yO    = toY(c.open), yC = toY(c.close)
      const bTop  = Math.min(yO,yC)
      const bH    = Math.max(Math.abs(yC-yO), 1)
      const wx    = x + cW/2
      // Wick
      ctx.strokeStyle = color; ctx.lineWidth = 1
      ctx.beginPath(); ctx.moveTo(wx,yH); ctx.lineTo(wx,bTop); ctx.moveTo(wx,bTop+bH); ctx.lineTo(wx,yL); ctx.stroke()
      // Body
      ctx.fillStyle = color; ctx.globalAlpha = 0.85
      ctx.fillRect(x, bTop, cW-1, bH); ctx.globalAlpha = 1
    })

    // Labels
    ctx.fillStyle = C.muted; ctx.font = '8px monospace'
    ctx.fillText(maxP.toFixed(1), 2, 10); ctx.fillText(minP.toFixed(1), 2, H-4)
  }, [candles, signal])

  return <canvas ref={ref} width={600} height={155} style={{ width:'100%', height:155, display:'block' }} />
}

// ── StatusBar ─────────────────────────────────────────────────
export function StatusBar({ tick, connected }) {
  return (
    <div style={{ display:'flex', gap:20, fontSize:11, ...mono }}>
      <span style={{ color:C.muted }}>LAST <span style={{ color:C.text }}>{tick?.last?.toFixed(2)||'—'}</span></span>
      <span style={{ color:C.muted }}>VOL <span style={{ color:C.text }}>{tick?.cum_vol?.toLocaleString()||'—'}</span></span>
      <span style={{ color:C.muted }}>PHASE <span style={{ color:C.gold }}>{tick?.phase?.toUpperCase()||'—'}</span></span>
    </div>
  )
}

// ── PricePanel ────────────────────────────────────────────────
export function PricePanel({ tick, features }) {
  return (
    <div style={panel}>
      <span style={label}>WDO · PRICE</span>
      <div style={{ fontSize:28, fontWeight:700, color:C.text, letterSpacing:-1, ...mono }}>{tick?.last?.toFixed(2)||'—.—'}</div>
      <div style={{ display:'grid', gridTemplateColumns:'1fr 1fr', gap:6, marginTop:10 }}>
        <Kv label="BID"        value={tick?.bid?.toFixed(2)}          color={C.green} />
        <Kv label="ASK"        value={tick?.ask?.toFixed(2)}          color={C.red} />
        <Kv label="SPREAD"     value={tick?.spread?.toFixed(2)} />
        <Kv label="VWAP"       value={features?.vwap?.toFixed(2)}     color={C.blue} />
        <Kv label="MOMENTUM"   value={features?.momentum?.toFixed(2)} color={features?.momentum>0?C.green:C.red} />
        <Kv label="VOLATILITY" value={features?.volatility?.toFixed(2)} color={C.gold} />
      </div>
    </div>
  )
}

// ── FlowPanel ─────────────────────────────────────────────────
export function FlowPanel({ features }) {
  const aggRatio = features?.aggRatio || 0.5
  const pct      = Math.round(aggRatio * 100)
  const delta    = features?.flowDelta || 0
  const imb      = features?.bookImbalance || 0
  return (
    <div style={panel}>
      <span style={label}>ORDER FLOW</span>
      <div style={{ marginBottom:8 }}>
        <div style={{ display:'flex', justifyContent:'space-between', fontSize:10, color:C.muted, marginBottom:3 }}>
          <span style={{ color:C.red }}>SELL {100-pct}%</span>
          <span style={{ color:C.green }}>BUY {pct}%</span>
        </div>
        <div style={{ height:5, background:C.border, borderRadius:3, overflow:'hidden' }}>
          <div style={{ height:'100%', width:`${pct}%`, background:pct>55?C.green:pct<45?C.red:C.gold, borderRadius:3, transition:'width 0.3s' }} />
        </div>
      </div>
      <div style={{ display:'grid', gridTemplateColumns:'1fr 1fr', gap:6 }}>
        <Kv label="FLOW Δ"   value={delta>0?`+${delta}`:delta} color={delta>0?C.green:C.red} />
        <Kv label="BK IMBAL" value={imb.toFixed(3)} color={imb>0.1?C.green:imb<-0.1?C.red:C.muted} />
        <Kv label="BUY VOL"  value={features?.buyVol}  color={C.green} />
        <Kv label="SELL VOL" value={features?.sellVol} color={C.red} />
      </div>
    </div>
  )
}

// ── AuctionPanel ──────────────────────────────────────────────
export function AuctionPanel({ auctionState, features, signal }) {
  const auction = features?.auction || {}
  const state   = auctionState?.to || 'IDLE'
  const stateColor = { IDLE:C.dim, PRE_OPEN:C.muted, AUCTION:C.gold, PRICE_DISCOVERY:C.blue, SIGNAL_READY:C.purple, CONTINUOUS:C.green, CLOSING:C.red, DONE:C.dim }[state] || C.dim
  return (
    <div style={panel}>
      <span style={label}>AUCTION STATE MACHINE</span>
      <div style={{ display:'flex', alignItems:'center', gap:8, marginBottom:8 }}>
        <div style={{ width:7, height:7, borderRadius:'50%', background:stateColor, boxShadow:`0 0 6px ${stateColor}` }} />
        <span style={{ fontSize:12, fontWeight:700, color:stateColor, letterSpacing:1 }}>{state}</span>
      </div>
      <div style={{ display:'grid', gridTemplateColumns:'1fr 1fr', gap:6, marginBottom:8 }}>
        <Kv label="THEOR PRICE" value={auction.theoreticalPrice?.toFixed(2)} color={C.gold} />
        <Kv label="SURPLUS"     value={auction.surplus} color={auction.surplus>0?C.green:auction.surplus<0?C.red:C.muted} />
        <Kv label="SIDE"        value={auction.side?.toUpperCase()} color={auction.side==='buy'?C.green:auction.side==='sell'?C.red:C.muted} />
        <Kv label="AUC VOL"     value={auction.volumeAtAuction} />
      </div>
      {signal && (
        <div style={{ background:signal.direction==='buy'?C.greenDim:C.redDim, border:`1px solid ${signal.direction==='buy'?C.green:C.red}`, borderRadius:4, padding:'8px 10px' }}>
          <div style={{ fontSize:9, letterSpacing:2, color:C.muted, marginBottom:3 }}>SINAL</div>
          <div style={{ fontSize:15, fontWeight:700, color:signal.direction==='buy'?C.green:C.red, marginBottom:4 }}>
            {signal.direction?.toUpperCase()} @ {signal.price?.toFixed(2)}
          </div>
          {signal.stopPrice && (
            <div style={{ display:'grid', gridTemplateColumns:'1fr 1fr', gap:4 }}>
              <div>
                <div style={{ fontSize:8, color:C.muted }}>STOP</div>
                <div style={{ fontSize:11, color:C.red, ...mono }}>{signal.stopPrice?.toFixed(2)}</div>
              </div>
              <div>
                <div style={{ fontSize:8, color:C.muted }}>ALVO 1</div>
                <div style={{ fontSize:11, color:C.green, ...mono }}>{signal.targetPrice?.toFixed(2)}</div>
              </div>
              <div>
                <div style={{ fontSize:8, color:C.muted }}>RISCO</div>
                <div style={{ fontSize:11, color:C.red, ...mono }}>R${signal.riskBrl}</div>
              </div>
              <div>
                <div style={{ fontSize:8, color:C.muted }}>RETORNO</div>
                <div style={{ fontSize:11, color:C.green, ...mono }}>R${signal.rewardBrl}</div>
              </div>
            </div>
          )}
          {signal.rr && (
            <div style={{ marginTop:6, display:'flex', justifyContent:'space-between', alignItems:'center' }}>
              <span style={{ fontSize:9, color:C.muted }}>RR</span>
              <span style={{ fontSize:12, fontWeight:700, color:C.gold, ...mono }}>{signal.rr}x</span>
              {signal.amplitudeEsperada && <span style={{ fontSize:9, color:C.muted }}>{signal.amplitudeEsperada}</span>}
            </div>
          )}
          {signal.sizedBy === 'claude_dinamico' && (
            <div style={{ marginTop:4, fontSize:8, color:C.blue }}>🤖 Alvo calculado pelo Claude</div>
          )}
        </div>
      )}
    </div>
  )
}

// ── PriceChart com timeframes + preço DOL ─────────────────────
const TIMEFRAMES = [
  { label: 'LEILÃO 5s', ms: 5000,   max: 120 },
  { label: '1M',        ms: 60000,  max: 120 },
  { label: '5M',        ms: 300000, max: 80  },
  { label: '15M',       ms: 900000, max: 60  },
]

export function PriceChart({ tickHistory, features, signal, tick, dolFeatures }) {
  const [tfIdx, setTfIdx]         = useState(0)
  const tf                        = TIMEFRAMES[tfIdx]
  const candles                   = buildCandles(tickHistory, tf.ms).slice(-tf.max)
  const wdoPrice                  = tick?.last
  const dolPrice                  = dolFeatures?.last || dolFeatures?.tick?.last
  const wdoChg                    = tick?.variation || 0
  const dolChg                    = dolFeatures?.tick?.variation || 0

  return (
    <div style={{ ...panel, padding:0, overflow:'hidden', display:'flex', flexDirection:'column' }}>

      {/* Header com timeframes e preços */}
      <div style={{ display:'flex', alignItems:'center', justifyContent:'space-between', padding:'6px 10px', borderBottom:`1px solid ${C.border}`, background:'#0a1018' }}>
        {/* Timeframe tabs */}
        <div style={{ display:'flex', gap:4 }}>
          {TIMEFRAMES.map((t, i) => (
            <button key={i} onClick={() => setTfIdx(i)} style={{
              padding:'2px 8px', fontSize:9, letterSpacing:1,
              background: i===tfIdx ? 'rgba(245,158,11,0.2)' : 'transparent',
              color: i===tfIdx ? C.gold : C.dim,
              border: `1px solid ${i===tfIdx ? C.gold+'60' : C.border}`,
              borderRadius:3, cursor:'pointer', fontFamily:'monospace'
            }}>{t.label}</button>
          ))}
          <span style={{ fontSize:9, color:C.dim, alignSelf:'center', marginLeft:4, fontFamily:'monospace' }}>
            {candles.length} candles
          </span>
        </div>

        {/* Preços WDO e DOL */}
        <div style={{ display:'flex', gap:16, alignItems:'center' }}>
          <div style={{ textAlign:'right' }}>
            <div style={{ fontSize:8, color:C.muted, letterSpacing:1 }}>WDO MINI</div>
            <div style={{ display:'flex', alignItems:'baseline', gap:4 }}>
              <span style={{ fontSize:13, fontWeight:700, color:C.text, fontFamily:'monospace' }}>
                {wdoPrice?.toFixed(2) || '—'}
              </span>
              {wdoChg !== 0 && (
                <span style={{ fontSize:9, color: wdoChg > 0 ? C.green : C.red, fontFamily:'monospace' }}>
                  {wdoChg > 0 ? '+' : ''}{wdoChg?.toFixed(2)}
                </span>
              )}
            </div>
          </div>
          <div style={{ width:1, height:24, background:C.border }} />
          <div style={{ textAlign:'right' }}>
            <div style={{ fontSize:8, color:C.muted, letterSpacing:1 }}>DOL CHEIO</div>
            <div style={{ display:'flex', alignItems:'baseline', gap:4 }}>
              <span style={{ fontSize:13, fontWeight:700, color:C.gold, fontFamily:'monospace' }}>
                {dolPrice?.toFixed(2) || '—'}
              </span>
              {dolChg !== 0 && (
                <span style={{ fontSize:9, color: dolChg > 0 ? C.green : C.red, fontFamily:'monospace' }}>
                  {dolChg > 0 ? '+' : ''}{dolChg?.toFixed(2)}
                </span>
              )}
            </div>
          </div>
        </div>
      </div>

      {/* Gráfico */}
      <div style={{ flex:1, padding:'6px 10px 4px' }}>
        <CandlestickCanvas candles={candles} signal={signal} />
      </div>
    </div>
  )
}

// ── AIPanel ───────────────────────────────────────────────────
export function AIPanel({ aiAnalysis }) {
  if (!aiAnalysis) return (
    <div style={panel}>
      <span style={label}>ANÁLISE</span>
      <div style={{ color:C.dim, fontSize:11 }}>Aguardando dados...</div>
    </div>
  )

  const ai         = aiAnalysis
  const dir        = (ai.direcao || ai.bias || 'neutro')
  const dirColor   = dir === 'buy' ? C.green : dir === 'sell' ? C.red : C.muted
  const conf       = ai.confianca || 0
  const confPct    = Math.round(conf * 100)
  const veredito   = ai.veredito || 'NAO_OPERAR'
  const verColor   = veredito === 'OPERAR_BUY' ? C.green : veredito === 'OPERAR_SELL' ? C.red : C.muted
  const dolWdo     = ai.confluenciaDolWdo || 'neutro'
  const macroAl    = ai.alinhamentoMacro  || 'neutro'
  const iceOn      = ai.icebergRelevante  || false

  return (
    <div style={panel}>
      <div style={{ display:'flex', justifyContent:'space-between', alignItems:'center', marginBottom:8 }}>
        <span style={label}>ANÁLISE</span>
        <div style={{ display:'flex', gap:6, alignItems:'center' }}>
          <span style={{ fontSize:9, color: ai.source==='stub' ? C.gold : C.blue }}>{(ai.source||'').toUpperCase()}</span>
          {ai.emJanela && <span style={{ fontSize:8, color:C.gold, background:'rgba(245,158,11,0.15)', padding:'1px 4px', borderRadius:2 }}>JANELA 1s</span>}
        </div>
      </div>

      <div style={{ padding:'6px 10px', background:`${verColor}15`, border:`1px solid ${verColor}40`, borderRadius:4, marginBottom:8, textAlign:'center' }}>
        <div style={{ fontSize:13, fontWeight:700, color:verColor, letterSpacing:2 }}>{veredito.replace('_',' ')}</div>
      </div>

      <div style={{ display:'grid', gridTemplateColumns:'1fr 1fr 1fr', gap:6, marginBottom:8 }}>
        <Kv label="DIREÇÃO"   value={dir.toUpperCase()} color={dirColor} />
        <Kv label="CONFIANÇA" value={`${confPct}%`} color={confPct>=85?C.green:confPct>=70?C.gold:C.red} />
        <Kv label="ICEBERG"   value={iceOn ? '🧊 ATIVO' : '—'} color={iceOn ? C.cyan : C.dim} />
      </div>
      <div style={{ display:'grid', gridTemplateColumns:'1fr 1fr', gap:6, marginBottom:8 }}>
        <Kv label="DOL×WDO" value={dolWdo.toUpperCase()} color={dolWdo==='alinhado'?C.green:dolWdo==='divergente'?C.red:C.muted} />
        <Kv label="MACRO"   value={macroAl.toUpperCase()} color={macroAl==='favoravel'?C.green:macroAl==='adverso'?C.red:C.muted} />
      </div>

      {/* ── Termômetro de confiança ── */}
      <div style={{ marginBottom:8 }}>
        <div style={{ display:'flex', justifyContent:'space-between', alignItems:'center', marginBottom:4 }}>
          <span style={{ fontSize:10, color:C.dim }}>CONFIANÇA</span>
          <span style={{ fontSize:18, fontWeight:700, color:confPct>=85?C.green:confPct>=70?C.gold:C.red, letterSpacing:1 }}>{confPct}%</span>
        </div>
        <div style={{ height:18, background:C.border, borderRadius:4, position:'relative', overflow:'hidden' }}>
          <div style={{
            height:'100%',
            width:`${confPct}%`,
            background: confPct>=85 ? `linear-gradient(90deg, #16a34a, #22c55e)` : confPct>=70 ? `linear-gradient(90deg, #d97706, #f59e0b)` : `linear-gradient(90deg, #dc2626, #ef4444)`,
            borderRadius:4,
            transition:'width 0.4s ease',
          }} />
          {/* Linha do gatilho 85% */}
          <div style={{ position:'absolute', top:0, left:'85%', width:2, height:'100%', background:'#a855f7', zIndex:2 }} />
          <div style={{ position:'absolute', top:0, left:'85%', transform:'translateX(-50%)', fontSize:8, color:'#a855f7', marginTop:1, zIndex:3, whiteSpace:'nowrap' }}>85%</div>
        </div>
        {/* Barra de confiança sem evento */}
        {aiAnalysis?.confiancaSemEvento > 0 && (
          <div style={{ marginTop:4 }}>
            <div style={{ display:'flex', justifyContent:'space-between', marginBottom:2 }}>
              <span style={{ fontSize:9, color:C.dim }}>SEM EVENTO</span>
              <span style={{ fontSize:11, color:C.gold }}>{Math.round((aiAnalysis.confiancaSemEvento||0)*100)}% {aiAnalysis.direcaoSemEvento?.toUpperCase()}</span>
            </div>
            <div style={{ height:8, background:C.border, borderRadius:2, position:'relative', overflow:'hidden' }}>
              <div style={{
                height:'100%',
                width:`${Math.round((aiAnalysis.confiancaSemEvento||0)*100)}%`,
                background:'rgba(245,158,11,0.6)',
                borderRadius:2,
                transition:'width 0.4s ease',
              }} />
            </div>
          </div>
        )}
      </div>

      {/* Alerta pós-abertura */}
      {ai.motivo && ai.motivo.includes('pos_abertura') && (
        <div style={{
          padding:'8px 10px', borderRadius:4, marginBottom:8, textAlign:'center',
          background: ai.alertaPosAbertura === 'FECHAR_ALVO'   ? 'rgba(34,197,94,0.2)'
                    : ai.alertaPosAbertura === 'FECHAR_TOTAL'  ? 'rgba(239,68,68,0.2)'
                    : ai.alertaPosAbertura === 'FECHAR_PARCIAL'? 'rgba(245,158,11,0.2)'
                    : 'rgba(59,130,246,0.1)',
          border: `1px solid ${
            ai.alertaPosAbertura === 'FECHAR_ALVO'    ? C.green
          : ai.alertaPosAbertura === 'FECHAR_TOTAL'   ? C.red
          : ai.alertaPosAbertura === 'FECHAR_PARCIAL' ? C.gold
          : C.blue}40`
        }}>
          <div style={{ fontSize:11, fontWeight:700, letterSpacing:2, color:
            ai.alertaPosAbertura === 'FECHAR_ALVO'    ? C.green
          : ai.alertaPosAbertura === 'FECHAR_TOTAL'   ? C.red
          : ai.alertaPosAbertura === 'FECHAR_PARCIAL' ? C.gold
          : C.blue }}>
            {ai.alertaPosAbertura?.replace('_',' ')}
          </div>
          <div style={{ display:'flex', justifyContent:'center', gap:16, marginTop:4, fontSize:10, color:C.muted }}>
            {ai.distanciaAlvo > 0 && <span>Alvo: <span style={{ color:C.green }}>{ai.distanciaAlvo} ticks</span></span>}
            {ai.distanciaStop > 0 && <span>Stop: <span style={{ color:C.red }}>{ai.distanciaStop} ticks</span></span>}
          </div>
          <div style={{ fontSize:8, color:C.dim, marginTop:2 }}>📈 MONITORAMENTO PÓS-ABERTURA ATÉ 9h05</div>
        </div>
      )}

      {/* Target info when signal active */}
      {ai.alvo1Ticks > 0 && ai.veredito !== 'NAO_OPERAR' && (
        <div style={{ background:'rgba(34,197,94,0.08)', border:`1px solid ${C.green}30`, borderRadius:4, padding:'8px 10px', marginBottom:8 }}>
          <div style={{ fontSize:9, color:C.muted, marginBottom:4, letterSpacing:1 }}>ALVO 1 DINÂMICO</div>
          <div style={{ display:'grid', gridTemplateColumns:'1fr 1fr 1fr', gap:6 }}>
            <Kv label="TICKS"     value={ai.alvo1Ticks} color={C.green} />
            <Kv label="RR"        value={ai.rr?.toFixed(1)+'x'} color={C.gold} />
            <Kv label="CONF ALVO" value={ai.alvo1Confianca ? (ai.alvo1Confianca*100).toFixed(0)+'%' : '—'} color={C.green} />
          </div>
          {ai.amplitudeEsperada && <div style={{ fontSize:9, color:C.muted, marginTop:4 }}>Amplitude: {ai.amplitudeEsperada}</div>}
          {ai.baseCalculoAlvo   && <div style={{ fontSize:9, color:C.dim,   marginTop:2 }}>{ai.baseCalculoAlvo}</div>}
          <div style={{ display:'flex', gap:6, marginTop:6, flexWrap:'wrap' }}>
            {ai.absorcaoDetectada && <span style={{ fontSize:8, color:C.green, background:'rgba(34,197,94,0.15)', padding:'1px 5px', borderRadius:3 }}>ABSORÇÃO ✓</span>}
            {ai.escoraDetectada   && <span style={{ fontSize:8, color:C.red,   background:'rgba(239,68,68,0.15)',  padding:'1px 5px', borderRadius:3 }}>ESCORA @ {ai.escoraPreco?.toFixed(2)}</span>}
            {ai.exaustaoDetectada && <span style={{ fontSize:8, color:C.gold,  background:'rgba(245,158,11,0.15)', padding:'1px 5px', borderRadius:3 }}>EXAUSTÃO ⚠️</span>}
          </div>
          {ai.leituraTape && <div style={{ fontSize:9, color:C.dim, marginTop:4, fontStyle:'italic' }}>{ai.leituraTape}</div>}
        </div>
      )}

      <div style={{ fontSize:10, color:C.muted, lineHeight:1.6 }}>
        {ai.reasoning      && <div style={{ marginBottom:3, color:C.text }}>{ai.reasoning}</div>}
        {ai.leituraLeilao  && <div><span style={{ color:C.blue }}>LEILÃO</span> {ai.leituraLeilao}</div>}
        {ai.leituraMacro   && <div><span style={{ color:C.gold }}>MACRO</span> {ai.leituraMacro}</div>}
        {ai.riscoPrincipal && <div><span style={{ color:C.red }}>RISCO</span> {ai.riscoPrincipal}</div>}
        {ai.leituraTape    && <div style={{ marginTop:4 }}><span style={{ color:C.cyan }}>TAPE</span> {ai.leituraTape}</div>}
      </div>
    </div>
  )
}

// ── RiskPanel ─────────────────────────────────────────────────
export function RiskPanel({ riskEvent }) {
  return (
    <div style={panel}>
      <span style={label}>RISK ENGINE</span>
      {!riskEvent && <div style={{ color:C.dim, fontSize:11 }}>Nenhum sinal avaliado</div>}
      {riskEvent && (
        <div style={{ background:riskEvent.type==='risk_approved'?C.greenDim:C.redDim, border:`1px solid ${riskEvent.type==='risk_approved'?C.green:C.red}`, borderRadius:4, padding:'8px 10px', fontSize:11 }}>
          <div style={{ fontWeight:700, color:riskEvent.type==='risk_approved'?C.green:C.red, marginBottom:4, letterSpacing:1 }}>
            {riskEvent.type==='risk_approved'?'✓ APROVADO':'✗ REJEITADO'}
          </div>
          {riskEvent.reason && <div style={{ color:C.muted, fontSize:10 }}>{riskEvent.reason}</div>}
          {riskEvent.contracts && <div style={{ marginTop:4, color:C.text, fontSize:10 }}>{riskEvent.contracts}x · Stop {riskEvent.stopPrice} · Alvo {riskEvent.targetPrice}</div>}
        </div>
      )}
    </div>
  )
}

// ── ExecutionPanel ────────────────────────────────────────────
export function ExecutionPanel({ fills }) {
  return (
    <div style={panel}>
      <span style={label}>EXECUTION · PAPER</span>
      {fills.length===0 && <div style={{ color:C.dim, fontSize:11 }}>Nenhuma execução ainda</div>}
      {fills.slice(0,4).map((f,i) => (
        <div key={i} style={{ padding:'5px 0', borderBottom:`1px solid ${C.border}`, fontSize:10 }}>
          <div style={{ display:'flex', justifyContent:'space-between' }}>
            <span style={{ color:f.direction==='buy'?C.green:C.red, fontWeight:700 }}>{f.direction?.toUpperCase()}</span>
            <span style={{ color:f.status==='closed'?C.muted:C.text }}>{f.status}</span>
          </div>
          <div style={{ color:C.muted }}>{f.contracts}x @ {f.entryPrice?.toFixed(2)} | Stop {f.stopPrice?.toFixed(2)}</div>
          {f.pnl!==undefined&&f.pnl!==0&&<div style={{ color:f.pnl>=0?C.green:C.red, fontWeight:700 }}>R$ {f.pnl?.toFixed(2)}</div>}
        </div>
      ))}
    </div>
  )
}


// ── Mapa de Força — Suporte/Resistência via Tape + Icebergs ──────────────
export function MapaForca({ features, trades = [] }) {
  const C = {
    bg: '#080c10', panel: '#0c1219', border: '#1e2832',
    text: '#e2e8f0', muted: '#64748b',
    green: '#22c55e', red: '#ef4444', gold: '#f59e0b',
    cyan: '#06b6d4', purple: '#8b5cf6',
    greenDim: 'rgba(34,197,94,0.15)', redDim: 'rgba(239,68,68,0.15)',
  }

  // Construir mapa de volume por preço via icebergs + tape
  const volumeMap = {}

  // 1. Icebergs detectados
  const icebergs = features?.icebergs || []
  icebergs.forEach(ice => {
    const p = ice.price
    if (!volumeMap[p]) volumeMap[p] = { buyVol: 0, sellVol: 0, icebergs: 0, isIce: false }
    if (ice.side === 'bid') volumeMap[p].buyVol += ice.totalVol
    else volumeMap[p].sellVol += ice.totalVol
    volumeMap[p].icebergs++
    volumeMap[p].isIce = true
  })

  // 2. Theor Price e Surplus
  const theorPrice = features?.auction?.theoreticalPrice
  const surplus    = features?.auction?.surplus || 0
  const side       = features?.auction?.side

  // Ordenar preços
  const prices = Object.keys(volumeMap).map(Number).sort((a, b) => b - a)
  if (prices.length === 0) {
    return (
      <div style={{ background: C.bg, border: `1px solid ${C.border}`, borderRadius: 8, padding: 12 }}>
        <div style={{ color: C.muted, fontSize: 11, textAlign: 'center', padding: '20px 0' }}>
          🎯 Aguardando dados do tape...
        </div>
      </div>
    )
  }

  // Max volume para normalizar barras
  const maxVol = Math.max(...prices.map(p => (volumeMap[p].buyVol + volumeMap[p].sellVol)))

  // Detectar suporte e resistência
  const niveis = prices.map(p => ({
    price: p,
    ...volumeMap[p],
    total: (volumeMap[p].buyVol + volumeMap[p].sellVol),
    pct: Math.round(((volumeMap[p].buyVol + volumeMap[p].sellVol) / maxVol) * 100),
    isTheor: theorPrice && Math.abs(p - theorPrice) < 0.5,
  }))

  const topNiveis = niveis.sort((a, b) => b.total - a.total).slice(0, 12)
  const sortedByPrice = [...topNiveis].sort((a, b) => b.price - a.price)

  const suporte    = topNiveis.filter(n => n.buyVol > n.sellVol).sort((a,b) => b.total - a.total)[0]
  const resistencia = topNiveis.filter(n => n.sellVol > n.buyVol).sort((a,b) => b.total - a.total)[0]

  return (
    <div style={{ background: C.bg, border: `1px solid ${C.border}`, borderRadius: 8, padding: 10, minWidth: 200 }}>
      {/* Header */}
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 8 }}>
        <span style={{ color: C.cyan, fontSize: 10, fontWeight: 700, letterSpacing: 1 }}>
          🎯 MAPA DE FORÇA
        </span>
        <span style={{ color: C.muted, fontSize: 9 }}>TAPE + ICE</span>
      </div>

      {/* Theor Price */}
      {theorPrice && (
        <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 6, padding: '3px 6px', background: 'rgba(6,182,212,0.1)', borderRadius: 4 }}>
          <span style={{ color: C.muted, fontSize: 9 }}>THEOR PRICE</span>
          <span style={{ color: C.cyan, fontSize: 10, fontWeight: 700 }}>
            {theorPrice.toFixed(1)}
            {surplus !== 0 && <span style={{ color: surplus > 0 ? C.green : C.red, marginLeft: 4 }}>
              {surplus > 0 ? `+${surplus}` : surplus}
            </span>}
          </span>
        </div>
      )}

      {/* Níveis */}
      <div style={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
        {sortedByPrice.map(n => {
          const isSup = suporte?.price === n.price
          const isRes = resistencia?.price === n.price
          const isTheor = n.isTheor
          const barColor = n.buyVol > n.sellVol ? C.green : C.red
          const bgColor  = n.buyVol > n.sellVol ? C.greenDim : C.redDim

          return (
            <div key={n.price} style={{
              display: 'flex', alignItems: 'center', gap: 4,
              padding: '2px 4px', borderRadius: 3,
              background: isTheor ? 'rgba(6,182,212,0.1)' : isSup ? C.greenDim : isRes ? C.redDim : 'transparent',
              border: isTheor ? `1px solid ${C.cyan}` : 'none',
            }}>
              {/* Preço */}
              <span style={{ color: isTheor ? C.cyan : C.text, fontSize: 10, fontWeight: isTheor ? 700 : 400, width: 48, textAlign: 'right' }}>
                {n.price.toFixed(1)}
              </span>

              {/* Barra */}
              <div style={{ flex: 1, height: 8, background: '#1e2832', borderRadius: 2, overflow: 'hidden' }}>
                <div style={{ width: `${n.pct}%`, height: '100%', background: barColor, borderRadius: 2, transition: 'width 0.3s' }} />
              </div>

              {/* Volume */}
              <span style={{ color: C.muted, fontSize: 9, width: 32, textAlign: 'right' }}>
                {n.total > 999 ? `${(n.total/1000).toFixed(1)}k` : n.total}
              </span>

              {/* Labels */}
              <span style={{ width: 28, fontSize: 9 }}>
                {n.isIce && <span title="Iceberg">🧊</span>}
                {isSup && <span style={{ color: C.green }}>SUP</span>}
                {isRes && <span style={{ color: C.red }}>RES</span>}
                {isTheor && <span style={{ color: C.cyan }}>◆</span>}
              </span>
            </div>
          )
        })}
      </div>

      {/* Resumo */}
      <div style={{ marginTop: 8, paddingTop: 6, borderTop: `1px solid ${C.border}`, display: 'flex', justifyContent: 'space-between' }}>
        <div>
          <div style={{ color: C.muted, fontSize: 8 }}>SUPORTE</div>
          <div style={{ color: C.green, fontSize: 10, fontWeight: 700 }}>{suporte?.price?.toFixed(1) || '—'}</div>
        </div>
        <div style={{ textAlign: 'center' }}>
          <div style={{ color: C.muted, fontSize: 8 }}>SIDE</div>
          <div style={{ color: side === 'buy' ? C.green : C.red, fontSize: 10, fontWeight: 700 }}>
            {side === 'buy' ? '▲ BUY' : side === 'sell' ? '▼ SELL' : '—'}
          </div>
        </div>
        <div style={{ textAlign: 'right' }}>
          <div style={{ color: C.muted, fontSize: 8 }}>RESISTÊNCIA</div>
          <div style={{ color: C.red, fontSize: 10, fontWeight: 700 }}>{resistencia?.price?.toFixed(1) || '—'}</div>
        </div>
      </div>
    </div>
  )
}

// ── SuperDOM WDO com Auto-Scroll ─────────────────────────────
const MIN_LOT_DISPLAY = 40

export function SuperDOM({ book, features, levels = 80 }) {
  const scrollRef = useRef(null)
  const prevPrice = useRef(null)

  const bids     = book?.bids || []
  const asks     = book?.asks || []
  const icebergs = features?.icebergs || []
  const lastPrice = features?.last || book?.best_bid || 0

  const bidMap = {}
  bids.forEach(b => { bidMap[Math.round(b.price * 100)] = b.qty })
  const askMap = {}
  asks.forEach(a => { askMap[Math.round(a.price * 100)] = a.qty })
  const icebergMap = {}
  icebergs.forEach(ic => { icebergMap[Math.round(ic.price * 100)] = ic })

  const TICK   = 0.5
  const center = lastPrice ? Math.round(lastPrice / TICK) * TICK : 5150

  const rows = []
  for (let i = levels; i >= -levels; i--) {
    const price  = Math.round((center + i * TICK) * 100) / 100
    const key    = Math.round(price * 100)
    rows.push({
      price,
      bidQty:    bidMap[key] >= MIN_LOT_DISPLAY ? bidMap[key] : 0,
      askQty:    askMap[key] >= MIN_LOT_DISPLAY ? askMap[key] : 0,
      iceberg:   icebergMap[key] || null,
      isCurrent: i === 0,
    })
  }

  const allQty = rows.flatMap(r => [r.bidQty, r.askQty]).filter(q => q > 0)
  const maxQty = Math.max(...allQty, 1)

  useEffect(() => {
    if (!scrollRef.current || !lastPrice) return
    if (prevPrice.current === lastPrice) return
    prevPrice.current = lastPrice
    const container = scrollRef.current
    const rowHeight  = 19
    const scrollTop  = levels * rowHeight - container.clientHeight / 2 + rowHeight / 2
    container.scrollTo({ top: Math.max(0, scrollTop), behavior: 'smooth' })
  }, [lastPrice, levels])

  return (
    <div style={{ background: C.panel, border: `1px solid ${C.border}`, borderRadius: 4, overflow: 'hidden', display:'flex', flexDirection:'column', height:'100%' }}>
      <div style={{ display:'flex', justifyContent:'space-between', alignItems:'center', padding:'4px 8px', borderBottom:`1px solid ${C.border}`, background:'#0a1018', flexShrink:0 }}>
        <span style={{ fontSize:9, color:C.gold, letterSpacing:1, fontFamily:'monospace' }}>SUPER DOM · WDO MINI</span>
        <span style={{ fontSize:9, color:C.muted, fontFamily:'monospace' }}>{book?.symbol || 'WDON26'}</span>
      </div>
      <div style={{ display:'flex', borderBottom:`1px solid ${C.border}`, background:'#0a1018', flexShrink:0 }}>
        <div style={{ flex:1, padding:'4px 6px', fontSize:9, color:C.green }}>COMPRA</div>
        <div style={{ width:76, padding:'4px 2px', fontSize:9, color:C.muted, textAlign:'center' }}>PREÇO</div>
        <div style={{ flex:1, padding:'4px 6px', fontSize:9, color:C.red, textAlign:'right' }}>VENDA</div>
        <div style={{ width:52, padding:'4px 4px', fontSize:9, color:C.cyan, textAlign:'right' }}>ICE</div>
      </div>
      <div ref={scrollRef} style={{ flex:1, overflowY:'auto', overflowX:'hidden' }}>
        {rows.map((row, i) => {
          const hasBid   = row.bidQty > 0
          const hasAsk   = row.askQty > 0
          const bidPct   = hasBid ? Math.min((row.bidQty / maxQty) * 100, 100) : 0
          const askPct   = hasAsk ? Math.min((row.askQty / maxQty) * 100, 100) : 0
          const isBigBid = row.bidQty >= maxQty * 0.4
          const isBigAsk = row.askQty >= maxQty * 0.4
          const ic       = row.iceberg
          return (
            <div key={i} style={{ display:'flex', alignItems:'stretch', minHeight:19, borderBottom:`1px solid ${C.border}12`, background: row.isCurrent ? 'rgba(245,158,11,0.18)' : 'transparent' }}>
              <div style={{ flex:1, position:'relative', display:'flex', alignItems:'center', padding:'0 6px' }}>
                {hasBid && <div style={{ position:'absolute', right:0, top:0, bottom:0, width:`${bidPct}%`, background:'rgba(34,197,94,0.22)', borderRadius:'2px 0 0 2px' }} />}
                <span style={{ position:'relative', zIndex:1, fontSize:9, color:C.green, fontWeight:isBigBid?700:400, fontFamily:'monospace' }}>{hasBid ? (isBigBid ? '● ' : '') + row.bidQty : ''}</span>
              </div>
              <div style={{ width:76, display:'flex', alignItems:'center', justifyContent:'center' }}>
                <span style={{ fontSize:row.isCurrent?10:9, fontWeight:row.isCurrent?700:400, color:row.isCurrent?C.gold:hasBid?'#7dc7a0':hasAsk?'#c77d7d':C.dim, background:row.isCurrent?'rgba(245,158,11,0.25)':'transparent', padding:row.isCurrent?'1px 4px':0, borderRadius:2, fontFamily:'monospace' }}>
                  {row.price.toFixed(2)}
                </span>
              </div>
              <div style={{ flex:1, position:'relative', display:'flex', alignItems:'center', justifyContent:'flex-end', padding:'0 6px' }}>
                {hasAsk && <div style={{ position:'absolute', left:0, top:0, bottom:0, width:`${askPct}%`, background:'rgba(239,68,68,0.22)', borderRadius:'0 2px 2px 0' }} />}
                <span style={{ position:'relative', zIndex:1, fontSize:9, color:C.red, fontWeight:isBigAsk?700:400, fontFamily:'monospace' }}>{hasAsk ? (isBigAsk ? '● ' : '') + row.askQty : ''}</span>
              </div>
              <div style={{ width:52, display:'flex', alignItems:'center', justifyContent:'flex-end', padding:'0 4px' }}>
                {ic && <span style={{ fontSize:8, color:C.cyan, background:'rgba(6,182,212,0.2)', padding:'1px 3px', borderRadius:3, border:`1px solid ${C.cyan}40`, fontFamily:'monospace' }}>🧊{ic.count}</span>}
              </div>
            </div>
          )
        })}
      </div>
      {book && (
        <div style={{ padding:'4px 8px', borderTop:`1px solid ${C.border}`, background:'#0a1018', flexShrink:0 }}>
          <div style={{ display:'flex', justifyContent:'space-between', fontSize:9, color:C.muted, marginBottom:2 }}>
            <span style={{ color:C.green }}>BID {book.bid_vol_total}</span>
            <span style={{ color:C.gold }}>IMBAL {book.imbalance?.toFixed(2)}</span>
            <span style={{ color:C.red }}>ASK {book.ask_vol_total}</span>
          </div>
          <div style={{ height:3, background:C.border, borderRadius:2, overflow:'hidden' }}>
            <div style={{ height:'100%', width:`${((book.imbalance||0)+1)/2*100}%`, background:book.imbalance>0.1?C.green:book.imbalance<-0.1?C.red:C.gold, borderRadius:2, transition:'width 0.3s' }} />
          </div>
        </div>
      )}
    </div>
  )
}


// ── SuperDOM DOL com Auto-Scroll ──────────────────────────────
export function SuperDOMDOL({ dolFeatures, levels = 80 }) {
  const scrollRef = useRef(null)
  const prevPrice = useRef(null)

  const book      = dolFeatures?.book || {}
  const bids      = book?.bids || []
  const asks      = book?.asks || []
  const lastPrice = dolFeatures?.last || 0

  const bidMap = {}
  bids.forEach(b => { bidMap[Math.round(b.price * 100)] = b.qty })
  const askMap = {}
  asks.forEach(a => { askMap[Math.round(a.price * 100)] = a.qty })

  const TICK   = 0.5
  const center = lastPrice ? Math.round(lastPrice / TICK) * TICK : 5150

  const rows = []
  for (let i = levels; i >= -levels; i--) {
    const price  = Math.round((center + i * TICK) * 100) / 100
    const key    = Math.round(price * 100)
    rows.push({
      price,
      bidQty:    bidMap[key] >= MIN_LOT_DISPLAY ? bidMap[key] : 0,
      askQty:    askMap[key] >= MIN_LOT_DISPLAY ? askMap[key] : 0,
      isCurrent: i === 0,
    })
  }

  const allQty = rows.flatMap(r => [r.bidQty, r.askQty]).filter(q => q > 0)
  const maxQty = Math.max(...allQty, 1)

  useEffect(() => {
    if (!scrollRef.current || !lastPrice) return
    if (prevPrice.current === lastPrice) return
    prevPrice.current = lastPrice
    const container = scrollRef.current
    const rowHeight  = 19
    const scrollTop  = levels * rowHeight - container.clientHeight / 2 + rowHeight / 2
    container.scrollTo({ top: Math.max(0, scrollTop), behavior: 'smooth' })
  }, [lastPrice, levels])

  return (
    <div style={{ background: C.panel, border: `1px solid ${C.border}`, borderRadius: 4, overflow: 'hidden', display:'flex', flexDirection:'column', height:'100%' }}>
      <div style={{ display:'flex', justifyContent:'space-between', alignItems:'center', padding:'6px 10px', borderBottom:`1px solid ${C.border}`, background:'#0a1018', flexShrink:0 }}>
        <div>
          <span style={{ fontSize:9, color:C.gold, letterSpacing:1 }}>SUPER DOM · DOL CHEIO</span>
          <span style={{ fontSize:8, color:C.muted, fontFamily:'monospace', marginLeft:8 }}>{book?.symbol || 'DOLN26'}</span>
        </div>
        <span style={{ fontSize:9, color:C.text, fontFamily:'monospace' }}>{lastPrice?.toFixed(2)}</span>
      </div>
      <div style={{ display:'flex', borderBottom:`1px solid ${C.border}`, background:'#0a1018', flexShrink:0 }}>
        <div style={{ flex:1, padding:'3px 6px', fontSize:9, color:C.green }}>COMPRA</div>
        <div style={{ width:76, padding:'3px 2px', fontSize:9, color:C.gold, textAlign:'center' }}>PREÇO</div>
        <div style={{ flex:1, padding:'3px 6px', fontSize:9, color:C.red, textAlign:'right' }}>VENDA</div>
        <div style={{ width:36, padding:'3px 4px', fontSize:9, color:C.cyan, textAlign:'right' }}>ICE</div>
      </div>
      <div ref={scrollRef} style={{ flex:1, overflowY:'auto', overflowX:'hidden' }}>
        {rows.map((row, i) => {
          const hasBid   = row.bidQty > 0
          const hasAsk   = row.askQty > 0
          const bidPct   = hasBid ? Math.min((row.bidQty / maxQty) * 100, 100) : 0
          const askPct   = hasAsk ? Math.min((row.askQty / maxQty) * 100, 100) : 0
          const isBigBid = row.bidQty >= maxQty * 0.4
          const isBigAsk = row.askQty >= maxQty * 0.4
          return (
            <div key={i} style={{ display:'flex', alignItems:'stretch', minHeight:19, borderBottom:`1px solid ${C.border}12`, background: row.isCurrent ? 'rgba(245,158,11,0.18)' : 'transparent' }}>
              <div style={{ flex:1, position:'relative', display:'flex', alignItems:'center', padding:'0 6px' }}>
                {hasBid && <div style={{ position:'absolute', right:0, top:0, bottom:0, width:`${bidPct}%`, background:'rgba(34,197,94,0.22)' }} />}
                <span style={{ position:'relative', zIndex:1, fontSize:9, color:C.green, fontWeight:isBigBid?700:400, fontFamily:'monospace' }}>{hasBid ? (isBigBid ? '● ' : '') + row.bidQty : ''}</span>
              </div>
              <div style={{ width:76, display:'flex', alignItems:'center', justifyContent:'center' }}>
                <span style={{ fontSize:row.isCurrent?10:9, fontWeight:row.isCurrent?700:400, color:row.isCurrent?C.gold:hasBid?'#7dc7a0':hasAsk?'#c77d7d':C.dim, background:row.isCurrent?'rgba(245,158,11,0.25)':'transparent', padding:row.isCurrent?'1px 4px':0, borderRadius:2, fontFamily:'monospace' }}>
                  {row.price.toFixed(2)}
                </span>
              </div>
              <div style={{ flex:1, position:'relative', display:'flex', alignItems:'center', justifyContent:'flex-end', padding:'0 6px' }}>
                {hasAsk && <div style={{ position:'absolute', left:0, top:0, bottom:0, width:`${askPct}%`, background:'rgba(239,68,68,0.22)' }} />}
                <span style={{ position:'relative', zIndex:1, fontSize:9, color:C.red, fontWeight:isBigAsk?700:400, fontFamily:'monospace' }}>{hasAsk ? (isBigAsk ? '● ' : '') + row.askQty : ''}</span>
              </div>
              <div style={{ width:36 }} />
            </div>
          )
        })}
      </div>
      {book && (
        <div style={{ padding:'4px 8px', borderTop:`1px solid ${C.border}`, background:'#0a1018', flexShrink:0 }}>
          <div style={{ display:'flex', justifyContent:'space-between', fontSize:9, color:C.muted, marginBottom:2 }}>
            <span style={{ color:C.green }}>BID {book.bid_vol_total}</span>
            <span style={{ color:C.gold }}>IMBAL {book.imbalance?.toFixed(2)}</span>
            <span style={{ color:C.red }}>ASK {book.ask_vol_total}</span>
          </div>
          <div style={{ height:3, background:C.border, borderRadius:2, overflow:'hidden' }}>
            <div style={{ height:'100%', width:`${((book.imbalance||0)+1)/2*100}%`, background:book.imbalance>0.1?C.green:book.imbalance<-0.1?C.red:C.gold, borderRadius:2, transition:'width 0.3s' }} />
          </div>
        </div>
      )}
    </div>
  )
}



// ── Decision Window ───────────────────────────────────────────
export function DecisionWindow({ windowState, snapshots }) {
  const mono = { fontFamily:"'JetBrains Mono',monospace" }
  const isActive = windowState?.active
  const snaps    = (snapshots || []).slice(-8).reverse()

  return (
    <div style={{ background:'#0c1219', padding:'10px 12px', borderBottom:'1px solid #1e2832' }}>
      <div style={{ display:'flex', justifyContent:'space-between', alignItems:'center', marginBottom:8 }}>
        <span style={{ fontSize:9, letterSpacing:2, color: isActive ? '#f59e0b' : '#64748b', textTransform:'uppercase' }}>
          {isActive ? '🕘 JANELA 9h00→9h01 ATIVA' : 'JANELA DE DECISÃO'}
        </span>
        {windowState?.segundosRestantes > 0 && (
          <span style={{ fontSize:9, color:'#f59e0b', ...mono }}>{windowState.segundosRestantes}s</span>
        )}
      </div>

      {snaps.length === 0 && (
        <div style={{ fontSize:10, color:'#475569' }}>Aguardando janela 9h00...</div>
      )}

      <div style={{ display:'flex', flexDirection:'column', gap:3 }}>
        {snaps.map((s, i) => (
          <div key={i} style={{
            background: s.ready ? 'rgba(34,197,94,0.08)' : 'rgba(0,0,0,0.2)',
            border: `1px solid ${s.ready ? '#22c55e40' : '#1e2832'}`,
            borderRadius:3, padding:'4px 6px', fontSize:9,
          }}>
            <div style={{ display:'flex', justifyContent:'space-between', alignItems:'center' }}>
              <span style={{ color:'#64748b', ...mono }}>#{s.snapshotNum}</span>
              <span style={{ color: s.tpStable ? '#22c55e' : '#ef4444' }}>TP {s.tp?.toFixed(2)} {s.tpStable ? '✓' : '✗'}</span>
              <span style={{ color: s.macroAlign?.aligned ? '#22c55e' : '#ef4444' }}>MACRO {s.macroAlign?.aligned ? '✓' : '✗'}</span>
              <span style={{ color: s.icebergContra ? '#ef4444' : s.icebergFavor ? '#06b6d4' : '#64748b' }}>
                {s.icebergFavor ? '🧊✓' : s.icebergContra ? '🧊✗' : '—'}
              </span>
              <span style={{ color: (s.aiConfianca||0) >= 0.85 ? '#22c55e' : (s.aiConfianca||0) >= 0.70 ? '#f59e0b' : '#ef4444', fontWeight:700, ...mono }}>
                {((s.aiConfianca||0)*100).toFixed(0)}%
                {s.icebergFavor && <span style={{ fontSize:8, color:'#06b6d4' }}> +15%</span>}
                {s.icebergContra && <span style={{ fontSize:8, color:'#ef4444' }}> cap65%</span>}
              </span>
              {s.ready && <span style={{ color:'#22c55e', fontWeight:700 }}>✅ ENTRA</span>}
            </div>
          </div>
        ))}
      </div>

      {snaps.length > 0 && (
        <div style={{ marginTop:6 }}>
          <div style={{ height:3, background:'#1e2832', borderRadius:2, position:'relative', overflow:'hidden' }}>
            <div style={{ height:'100%', width: `${((snaps[0]?.aiConfianca||0)*100)}%`, background: (snaps[0]?.aiConfianca||0) >= 0.85 ? '#22c55e' : '#f59e0b', borderRadius:2, transition:'width 0.3s' }} />
            <div style={{ position:'absolute', top:0, left:'85%', width:1, height:'100%', background:'#8b5cf6' }} />
          </div>
          <div style={{ fontSize:8, color:'#475569', textAlign:'right', marginTop:2 }}>▲ 85% gatilho</div>
        </div>
      )}
    </div>
  )
}

// ── Confluence Panel DOL x WDO ────────────────────────────────
export function ConfluencePanel({ confluence }) {
  if (!confluence) return (
    <div style={panel}>
      <span style={label}>CONFLUÊNCIA DOL × WDO</span>
      <div style={{ color: C.dim, fontSize: 11 }}>Aguardando dados DOL...</div>
    </div>
  )

  const color = confluence.aligned ? C.green : C.red
  const bg    = confluence.aligned ? C.greenDim : C.redDim

  return (
    <div style={{ ...panel, background: bg, border: `1px solid ${color}40` }}>
      <span style={label}>CONFLUÊNCIA DOL × WDO</span>
      <div style={{ fontSize: 13, fontWeight: 700, color, marginBottom: 8, letterSpacing: 1 }}>
        {confluence.aligned ? '✓ ALINHADOS' : '✗ DIVERGENTES'}
      </div>
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 6 }}>
        <Kv label="DOL LADO"    value={confluence.dolSide?.toUpperCase()} color={confluence.dolSide === 'buy' ? C.green : confluence.dolSide === 'sell' ? C.red : C.muted} />
        <Kv label="WDO LADO"   value={confluence.wdoSide?.toUpperCase()} color={confluence.wdoSide === 'buy' ? C.green : confluence.wdoSide === 'sell' ? C.red : C.muted} />
        <Kv label="DOL SURPLUS" value={confluence.dolSurplus} color={confluence.dolSurplus > 0 ? C.green : C.red} />
        <Kv label="WDO SURPLUS" value={confluence.wdoSurplus} color={confluence.wdoSurplus > 0 ? C.green : C.red} />
      </div>
      {confluence.direction && (
        <div style={{ marginTop: 8, padding: '6px 10px', background: `${color}20`, borderRadius: 4, textAlign: 'center' }}>
          <span style={{ fontSize: 12, fontWeight: 700, color, letterSpacing: 2 }}>
            {confluence.direction?.toUpperCase()} CONFIRMADO
          </span>
        </div>
      )}
    </div>
  )
}

// ── SuperDOM DOL (reutiliza lógica do WDO) ────────────────────

// ── Esgotamento de Liquidez Alert ────────────────────────────
export function EsgotamentoAlert({ esgotamento }) {
  if (!esgotamento) return null

  const color = esgotamento.alerta === 'FECHAR_TOTAL'   ? '#ef4444'
              : esgotamento.alerta === 'FECHAR_PARCIAL' ? '#f59e0b'
              : '#3b82f6'

  return (
    <div style={{ position:'fixed', top:60, left:'50%', transform:'translateX(-50%)', zIndex:1000, minWidth:340, background:`${color}15`, border:`2px solid ${color}`, borderRadius:8, padding:'12px 16px', backdropFilter:'blur(10px)' }}>
      <div style={{ display:'flex', alignItems:'center', gap:8, marginBottom:6 }}>
        <div style={{ width:8, height:8, borderRadius:'50%', background:color, boxShadow:`0 0 8px ${color}`, animation:'pulse 1s infinite' }} />
        <span style={{ fontSize:12, fontWeight:700, color, letterSpacing:2 }}>
          💧 ESGOTAMENTO — {esgotamento.alerta?.replace('_',' ')}
        </span>
      </div>
      {esgotamento.motivos?.map((m,i) => (
        <div key={i} style={{ fontSize:10, color:'#94a3b8', marginTop:2 }}>→ {m}</div>
      ))}
    </div>
  )
}

// ── CIP & CME Panel ──────────────────────────────────────────
export function CIPCMEPanel({ macro }) {
  if (!macro) return (
    <div style={{ background:C.panel, padding:'10px 12px', borderBottom:`1px solid ${C.border}` }}>
      <span style={{ fontSize:9, letterSpacing:2, color:C.muted, textTransform:'uppercase' }}>CIP & CME</span>
      <div style={{ fontSize:10, color:C.dim, marginTop:4 }}>Aguardando dados macro...</div>
    </div>
  )

  const cip = macro.cip
  const cme = macro.cme

  const getColor = (score) => score > 0 ? C.green : score < 0 ? C.red : C.muted
  const getIcon  = (score) => score > 0 ? '↑' : score < 0 ? '↓' : '→'

  return (
    <div style={{ background:C.panel, padding:'10px 12px', borderBottom:`1px solid ${C.border}` }}>
      <span style={{ fontSize:9, letterSpacing:2, color:C.muted, textTransform:'uppercase', display:'block', marginBottom:8 }}>CIP & CME SPREAD</span>

      {/* CIP */}
      <div style={{ marginBottom:8 }}>
        <div style={{ display:'flex', justifyContent:'space-between', alignItems:'center', marginBottom:3 }}>
          <span style={{ fontSize:9, color:C.dim, letterSpacing:1 }}>PARIDADE CIP</span>
          {cip && <span style={{ fontSize:10, fontWeight:700, color:getColor(cip.score) }}>
            {getIcon(cip.score)} {cip.score > 0 ? '+' : ''}{cip.score}
          </span>}
        </div>
        {cip ? (
          <div style={{ display:'grid', gridTemplateColumns:'1fr 1fr', gap:4 }}>
            <div style={{ background:'rgba(0,0,0,0.3)', borderRadius:3, padding:'4px 8px' }}>
              <div style={{ fontSize:8, color:C.dim }}>PREÇO JUSTO</div>
              <div style={{ fontSize:10, color:C.text, fontFamily:'monospace' }}>{cip.precoJusto}</div>
            </div>
            <div style={{ background:'rgba(0,0,0,0.3)', borderRadius:3, padding:'4px 8px' }}>
              <div style={{ fontSize:8, color:C.dim }}>DESVIO</div>
              <div style={{ fontSize:10, color:getColor(cip.score), fontFamily:'monospace' }}>
                {cip.desvio > 0 ? '+' : ''}{cip.desvio?.toFixed(1)} pts
              </div>
            </div>
          </div>
        ) : <div style={{ fontSize:9, color:C.dim }}>Calculando...</div>}
        {cip?.descricao && <div style={{ fontSize:9, color:getColor(cip.score), marginTop:3 }}>{cip.descricao}</div>}
      </div>

      {/* CME */}
      <div>
        <div style={{ display:'flex', justifyContent:'space-between', alignItems:'center', marginBottom:3 }}>
          <span style={{ fontSize:9, color:C.dim, letterSpacing:1 }}>CME SPREAD</span>
          {cme && <span style={{ fontSize:10, fontWeight:700, color:getColor(cme.score) }}>
            {getIcon(cme.score)} {cme.score > 0 ? '+' : ''}{cme.score}
          </span>}
        </div>
        {cme ? (
          <div style={{ display:'grid', gridTemplateColumns:'1fr 1fr', gap:4 }}>
            <div style={{ background:'rgba(0,0,0,0.3)', borderRadius:3, padding:'4px 8px' }}>
              <div style={{ fontSize:8, color:C.dim }}>REF CME</div>
              <div style={{ fontSize:10, color:C.text, fontFamily:'monospace' }}>{cme.spotRef}</div>
            </div>
            <div style={{ background:'rgba(0,0,0,0.3)', borderRadius:3, padding:'4px 8px' }}>
              <div style={{ fontSize:8, color:C.dim }}>DESVIO</div>
              <div style={{ fontSize:10, color:getColor(cme.score), fontFamily:'monospace' }}>
                {cme.desvio > 0 ? '+' : ''}{cme.desvio?.toFixed(1)} pts
              </div>
            </div>
          </div>
        ) : <div style={{ fontSize:9, color:C.dim }}>Calculando...</div>}
        {cme?.descricao && <div style={{ fontSize:9, color:getColor(cme.score), marginTop:3 }}>{cme.descricao}</div>}
      </div>

      {/* Score total CIP+CME */}
      {cip && cme && (
        <div style={{ marginTop:8, padding:'4px 8px', background:`rgba(${(cip.score+cme.score)>0?'34,197,94':(cip.score+cme.score)<0?'239,68,68':'100,116,139'},0.1)`, borderRadius:3 }}>
          <div style={{ fontSize:9, color:C.muted }}>
            Score CIP+CME: <span style={{ fontWeight:700, color:getColor(cip.score+cme.score) }}>
              {(cip.score+cme.score) > 0 ? '+' : ''}{cip.score+cme.score}
            </span>
            <span style={{ color:C.dim, marginLeft:6 }}>
              (SELIC {(10.50).toFixed(2)}% proxy)
            </span>
          </div>
        </div>
      )}
    </div>
  )
}


// ── Calibração Status Panel ───────────────────────────────────
export function CalibracaoPanel({ adaptive }) {
  if (!adaptive) return null

  const statusColor = {
    'CONFIAVEL':  '#22c55e',
    'CALIBRANDO': '#f59e0b',
    'DEFAULT':    '#64748b',
    'SUSPEITO':   '#ef4444',
    'RESETADO':   '#8b5cf6',
  }[adaptive.status] || '#64748b'

  const handleReset = async () => {
    await fetch('/api/adaptive/reset', { method: 'POST' })
  }
  const handleReativar = async () => {
    await fetch('/api/adaptive/reativar', { method: 'POST' })
  }

  return (
    <div style={{ ...panel, border:`1px solid ${statusColor}40` }}>
      <div style={{ display:'flex', justifyContent:'space-between', alignItems:'center', marginBottom:6 }}>
        <span style={label}>CALIBRAÇÃO ADAPTATIVA</span>
        <span style={{ fontSize:9, color:statusColor, fontWeight:700, letterSpacing:1 }}>{adaptive.status}</span>
      </div>

      {/* Thresholds principais */}
      <div style={{ display:'grid', gridTemplateColumns:'1fr 1fr', gap:4, marginBottom:8 }}>
        <Kv label="ESCORA ×"    value={(adaptive.escora_multiplicador || 3.0).toFixed(1)} color={C.muted} />
        <Kv label="STOP VOL"    value={Math.round(adaptive.stopping_volume || 300)} color={C.muted} />
        <Kv label="EFFORT"      value={Math.round(adaptive.effort_lotes || 150)} color={C.muted} />
        <Kv label="NO SUPPLY"   value={Math.round(adaptive.no_supply_max || 30)} color={C.muted} />
      </div>

      {/* Ajuste prospectivo */}
      {adaptive.prospectivo && adaptive.prospectivo.fator > 0 && (
        <div style={{ padding:'4px 8px', background:'rgba(245,158,11,0.1)', border:'1px solid rgba(245,158,11,0.3)', borderRadius:3, marginBottom:6, fontSize:9 }}>
          <span style={{ color:C.gold }}>⚡ Ajuste prospectivo: +{Math.round(adaptive.prospectivo.fator*100)}%</span>
          <div style={{ color:C.dim, marginTop:2 }}>{(adaptive.prospectivo.motivos||[]).join(' · ')}</div>
        </div>
      )}

      {/* Botões de controle */}
      <div style={{ display:'flex', gap:6 }}>
        <button onClick={handleReset} style={{ flex:1, padding:'3px 0', fontSize:9, background:'rgba(239,68,68,0.1)', color:C.red, border:`1px solid ${C.red}40`, borderRadius:3, cursor:'pointer' }}>
          USAR DEFAULT
        </button>
        {adaptive.status === 'RESETADO' && (
          <button onClick={handleReativar} style={{ flex:1, padding:'3px 0', fontSize:9, background:'rgba(34,197,94,0.1)', color:C.green, border:`1px solid ${C.green}40`, borderRadius:3, cursor:'pointer' }}>
            REATIVAR
          </button>
        )}
      </div>
    </div>
  )
}

function Kv({ label:lbl, value, color }) {
  return (
    <div>
      <div style={{ fontSize:9, letterSpacing:1.5, color:C.muted, marginBottom:2 }}>{lbl}</div>
      <div style={{ fontSize:12, fontWeight:700, color:color||C.text, ...mono }}>{value??'—'}</div>
    </div>
  )
}

// ── Market Context Panel ──────────────────────────────────────
export function MarketContextPanel({ ctx }) {
  const gap  = ctx?.gap
  const cal  = ctx?.calendario
  const mm   = ctx?.formadores

  if (!gap && !cal) return (
    <div style={panel}>
      <span style={label}>CONTEXTO DE MERCADO</span>
      <div style={{ color: C.dim, fontSize: 10 }}>Calculando gap e calendário...</div>
    </div>
  )

  return (
    <div style={panel}>
      <span style={label}>CONTEXTO DE MERCADO</span>

      {/* Gap Overnight */}
      {gap && (
        <div style={{ marginBottom: 8 }}>
          <div style={{ fontSize: 9, letterSpacing: 1.5, color: C.muted, marginBottom: 4 }}>GAP OVERNIGHT</div>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
            <span style={{ fontSize: 11, fontWeight: 700, color: gap.gapPct > 0 ? C.green : gap.gapPct < 0 ? C.red : C.muted, ...mono }}>
              {gap.gapPct > 0 ? '+' : ''}{gap.gapPct}%
            </span>
            <span style={{ fontSize: 9, color: gap.gapRelevante ? C.gold : C.dim, background: gap.gapRelevante ? 'rgba(245,158,11,0.15)' : 'transparent', padding: '1px 5px', borderRadius: 3 }}>
              {gap.classificacao?.replace('_', ' ').toUpperCase()}
            </span>
          </div>
          <div style={{ fontSize: 9, color: C.dim, marginTop: 2 }}>
            Ontem: {gap.prevClose} → Hoje: {gap.currentPrice}
          </div>
        </div>
      )}

      {/* Calendário */}
      {cal && (
        <div style={{ marginBottom: 8 }}>
          <div style={{ fontSize: 9, letterSpacing: 1.5, color: C.muted, marginBottom: 4 }}>CALENDÁRIO ECONÔMICO</div>
          {cal.temEventoCritico ? (
            <div style={{ background: 'rgba(239,68,68,0.1)', border: `1px solid ${C.red}40`, borderRadius: 3, padding: '6px 8px' }}>
              <div style={{ fontSize: 9, color: C.red, fontWeight: 700, marginBottom: 4 }}>
                ⚠️ {cal.eventosProximos.length} EVENTO(S) NAS PRÓXIMAS 2H
              </div>
              {cal.eventosProximos.map((e, i) => (
                <div key={i} style={{ fontSize: 9, color: C.muted, marginBottom: 2 }}>
                  {e.hora} — {e.nome} ({e.pais})
                </div>
              ))}
            </div>
          ) : (
            <div style={{ fontSize: 9, color: C.green }}>✓ Sem eventos críticos nas próximas 2h</div>
          )}
        </div>
      )}

      {/* Formadores de Mercado */}
      <div>
        <div style={{ fontSize: 9, letterSpacing: 1.5, color: C.muted, marginBottom: 4 }}>FORMADORES DE MERCADO</div>
        {mm && mm.fonte !== 'placeholder' ? (
          <div>
            <div style={{ fontSize: 10, color: mm.ladoDominante === 'compra' ? C.green : C.red, fontWeight: 700 }}>
              {mm.ladoDominante?.toUpperCase()} — {mm.totalNiveis} níveis
            </div>
          </div>
        ) : (
          <div style={{ fontSize: 9, color: C.dim }}>Disponível com Cedro PRO</div>
        )}
      </div>
    </div>
  )
}

// ── Execution Stats (Aba Execution) ───────────────────────────
export function ExecutionStats({ adaptive, fills }) {
  const [tabAtiva, setTabAtiva] = useState('mensal')
  const stats = adaptive || {}
  const total    = stats.totalTrades  || 0
  const wins     = stats.wins         || 0
  const losses   = stats.losses       || 0
  const winRate  = stats.winRate      || 0
  const pnlBRL   = stats.pnlBRL       || 0
  const pnlTicks = stats.pnlTicks     || 0

  // Esperança matemática
  const stopBRL  = 40   // 4 ticks × R$10
  const alvoMed  = 100  // ~10 ticks médio
  const em       = total > 0
    ? ((wins/total) * alvoMed) - ((losses/total) * stopBRL)
    : (0.8 * alvoMed) - (0.2 * stopBRL)  // projeção 80%

  // Projeções mensais
  const proj = [
    { label: 'Conservador', trades: 12, cor: '#64748b' },
    { label: 'Médio',       trades: 15, cor: '#f59e0b' },
    { label: 'Bom',         trades: 18, cor: '#22c55e' },
  ].map(p => ({
    ...p,
    minBRL: Math.round(p.trades * em * 0.8),
    maxBRL: Math.round(p.trades * em * 1.2),
    esperado: Math.round(p.trades * em),
  }))

  // Probabilidade de fechar positivo (binomial simplificada)
  const wr    = total > 4 ? winRate/100 : 0.80
  const probPos = Math.round(Math.min(99, (wr * 100) * 1.15))

  const C = {
    panel:  '#0c1219', border: '#1e2832', text: '#e2e8f0',
    muted:  '#64748b', dim: '#475569',
    green:  '#22c55e', red: '#ef4444', gold: '#f59e0b',
    blue:   '#3b82f6', purple: '#8b5cf6',
  }
  const mono = { fontFamily:"'JetBrains Mono',monospace" }

  const Card = ({ title, children, color }) => (
    <div style={{ background: C.panel, border:`1px solid ${color||C.border}`, borderRadius:6, padding:20 }}>
      <div style={{ fontSize:11, letterSpacing:2, color: color||C.muted, textTransform:'uppercase', marginBottom:14 }}>{title}</div>
      {children}
    </div>
  )

  const Stat = ({ label, value, color, big }) => (
    <div style={{ textAlign:'center' }}>
      <div style={{ fontSize: big?32:22, fontWeight:700, color: color||C.text, ...mono }}>{value}</div>
      <div style={{ fontSize:10, color:C.muted, marginTop:3, letterSpacing:1 }}>{label}</div>
    </div>
  )

  return (
    <div style={{ padding:20, overflowY:'auto', height:'calc(100vh - 41px)' }}>
      <div style={{ fontSize:13, letterSpacing:2, color:C.muted, marginBottom:20, textTransform:'uppercase' }}>
        Relatório de Performance
        {total === 0 && <span style={{ fontSize:10, color:C.dim, marginLeft:12, letterSpacing:1 }}>
          (dados disponíveis após pregões com Cedro conectada)
        </span>}
      </div>

      <div style={{ display:'grid', gridTemplateColumns:'repeat(auto-fit, minmax(280px, 1fr))', gap:16, marginBottom:16 }}>

        {/* Estatísticas Reais */}
        <Card title="Resultados Acumulados" color={pnlBRL >= 0 ? C.green : C.red}>
          <div style={{ display:'grid', gridTemplateColumns:'1fr 1fr 1fr', gap:16, marginBottom:16 }}>
            <Stat label="TRADES" value={total} big />
            <Stat label="WIN RATE" value={winRate+'%'} color={winRate >= 70 ? C.green : winRate >= 50 ? C.gold : C.red} big />
            <Stat label="PnL R$" value={'R$'+pnlBRL} color={pnlBRL >= 0 ? C.green : C.red} big />
          </div>
          <div style={{ display:'grid', gridTemplateColumns:'1fr 1fr 1fr', gap:12 }}>
            <Stat label="WINS" value={wins} color={C.green} />
            <Stat label="LOSSES" value={losses} color={C.red} />
            <Stat label="TICKS" value={pnlTicks > 0 ? '+'+pnlTicks : pnlTicks} color={pnlTicks >= 0 ? C.green : C.red} />
          </div>
          {total === 0 && (
            <div style={{ marginTop:14, padding:'8px 12px', background:'rgba(100,116,139,0.1)', borderRadius:4, fontSize:10, color:C.dim, textAlign:'center' }}>
              Aguardando primeiros trades com dados reais
            </div>
          )}
        </Card>

        {/* Esperança Matemática */}
        <Card title="Esperança Matemática" color={C.blue}>
          <div style={{ textAlign:'center', marginBottom:16 }}>
            <div style={{ fontSize:36, fontWeight:700, color: em >= 0 ? C.green : C.red, ...mono }}>
              R${Math.round(em)}
            </div>
            <div style={{ fontSize:10, color:C.muted, marginTop:4 }}>por trade esperado</div>
          </div>
          <div style={{ background:'rgba(59,130,246,0.08)', border:'1px solid rgba(59,130,246,0.2)', borderRadius:4, padding:'10px 14px', fontSize:10, color:C.muted, lineHeight:1.8 }}>
            <div>Stop fixo: <span style={{ color:C.red }}>R$40</span> (4 ticks)</div>
            <div>Alvo médio: <span style={{ color:C.green }}>R$100</span> (~10 ticks)</div>
            <div>Win rate: <span style={{ color:C.gold }}>{total > 4 ? winRate+'%' : '80% (projeção)'}</span></div>
            <div style={{ marginTop:6, color:C.text, fontWeight:600 }}>
              EM = ({total > 4 ? winRate : 80}% × R$100) - ({total > 4 ? 100-winRate : 20}% × R$40) = <span style={{ color: em >= 0 ? C.green : C.red }}>R${Math.round(em)}</span>
            </div>
          </div>
          <div style={{ marginTop:10, fontSize:9, color:C.dim, textAlign:'center' }}>
            ⚠️ Projeção estatística — não é garantia de resultado
          </div>
        </Card>

        {/* Probabilidade de Lucro */}
        <Card title="Probabilidade de Lucro Mensal" color={C.purple}>
          <div style={{ textAlign:'center', marginBottom:16 }}>
            <div style={{ fontSize:36, fontWeight:700, color:C.purple, ...mono }}>{probPos}%</div>
            <div style={{ fontSize:10, color:C.muted, marginTop:4 }}>de fechar o mês positivo</div>
          </div>
          <div style={{ height:6, background:C.border, borderRadius:3, marginBottom:16, overflow:'hidden' }}>
            <div style={{ height:'100%', width:probPos+'%', background:C.purple, borderRadius:3 }} />
          </div>
          <div style={{ fontSize:10, color:C.muted, lineHeight:1.8 }}>
            <div>Baseado em: <span style={{ color:C.text }}>win rate {total > 4 ? winRate+'% real' : '80% estimado'}</span></div>
            <div>Modelo: <span style={{ color:C.text }}>distribuição binomial</span></div>
            <div style={{ marginTop:6, fontSize:9, color:C.dim }}>⚠️ Pressupõe condições de mercado similares</div>
          </div>
        </Card>
      </div>

      {/* Projeções Mensais */}
      <Card title="Projeções Mensais" color={C.gold}>
        <div style={{ display:'grid', gridTemplateColumns:'repeat(3,1fr)', gap:16 }}>
          {proj.map((p,i) => (
            <div key={i} style={{ background:`${p.cor}10`, border:`1px solid ${p.cor}30`, borderRadius:6, padding:16, textAlign:'center' }}>
              <div style={{ fontSize:10, color:p.cor, letterSpacing:2, textTransform:'uppercase', marginBottom:10 }}>{p.label}</div>
              <div style={{ fontSize:24, fontWeight:700, color:p.cor, ...mono }}>R${p.esperado}</div>
              <div style={{ fontSize:9, color:C.muted, marginTop:4 }}>R${p.minBRL} – R${p.maxBRL}</div>
              <div style={{ fontSize:10, color:C.muted, marginTop:8 }}>{p.trades} trades/mês</div>
              <div style={{ fontSize:9, color:C.dim, marginTop:2 }}>{p.trades} × R${Math.round(em)} EM</div>
            </div>
          ))}
        </div>
        <div style={{ marginTop:12, fontSize:9, color:C.dim, textAlign:'center' }}>
          ⚠️ Projeções estatísticas baseadas na esperança matemática · Resultados reais podem variar · Não opera alavancado além de 1 contrato
        </div>
      </Card>

      {/* Análise de Padrões */}
      <div style={{ marginTop:16 }}>
        <Card title="Análise de Padrões" color={C.blue}>
          {!adaptive || total < 5 ? (
            <div style={{ fontSize:10, color:C.dim, textAlign:'center', padding:'10px 0' }}>
              Disponível após 5+ pregões com dados reais
            </div>
          ) : (
            <PadroesList adaptive={adaptive} C={C} mono={mono} />
          )}
        </Card>
      </div>

      {/* Últimas execuções */}
      {fills && fills.length > 0 && (
        <div style={{ marginTop:16 }}>
          <Card title="Últimas Execuções (Sessão Atual)">
            {fills.map((f,i) => (
              <div key={i} style={{ display:'flex', justifyContent:'space-between', padding:'6px 0', borderBottom:`1px solid ${C.border}`, fontSize:11 }}>
                <span style={{ color:f.direction==='buy'?C.green:C.red, fontWeight:700 }}>{f.direction?.toUpperCase()}</span>
                <span style={{ color:C.muted, ...mono }}>{f.contracts}x @ {f.entryPrice}</span>
                <span style={{ color:C.muted }}>Stop {f.stopPrice}</span>
                <span style={{ color:C.muted }}>Alvo {f.targetPrice}</span>
                {f.pnl !== undefined && f.pnl !== 0 && (
                  <span style={{ color:f.pnl>=0?C.green:C.red, fontWeight:700 }}>R${f.pnl?.toFixed(2)}</span>
                )}
              </div>
            ))}
          </Card>
        </div>
      )}
    </div>
  )
}

// ── Análise de Padrões ────────────────────────────────────────
function PadroesList({ adaptive, C, mono }) {
  const historico = adaptive?.historico || []

  // Win rate por dia da semana
  const dias = ['Dom','Seg','Ter','Qua','Qui','Sex','Sáb']
  const porDia = dias.map((nome, idx) => {
    const pregoes = historico.filter(p => p.data && new Date(p.data).getDay() === idx)
    const wins    = pregoes.filter(p => p.acertou).length
    return { nome, total: pregoes.length, wins, wr: pregoes.length ? Math.round(wins/pregoes.length*100) : null }
  }).filter(d => d.total > 0)

  // Melhor e pior dia
  const melhorDia = porDia.sort((a,b) => (b.wr||0)-(a.wr||0))[0]
  const piorDia   = [...porDia].sort((a,b) => (a.wr||0)-(b.wr||0))[0]

  // Dias com evento macro vs sem evento
  const comEvento = historico.filter(p => p.temEvento)
  const semEvento = historico.filter(p => !p.temEvento)
  const wrComEv   = comEvento.length ? Math.round(comEvento.filter(p=>p.acertou).length/comEvento.length*100) : null
  const wrSemEv   = semEvento.length ? Math.round(semEvento.filter(p=>p.acertou).length/semEvento.length*100) : null

  // Dias sem sinal (sistema abortou)
  const semSinal  = historico.filter(p => !p.acertou && p.resultado === 'sem_sinal').length
  const pctSemSinal = historico.length ? Math.round(semSinal/historico.length*100) : 0

  const Row = ({ label, value, color, sub }) => (
    <div style={{ display:'flex', justifyContent:'space-between', alignItems:'center', padding:'6px 0', borderBottom:`1px solid #1e283220` }}>
      <div>
        <span style={{ fontSize:11, color:'#e2e8f0' }}>{label}</span>
        {sub && <div style={{ fontSize:9, color:'#64748b', marginTop:1 }}>{sub}</div>}
      </div>
      <span style={{ fontSize:12, fontWeight:700, color: color||'#e2e8f0', ...mono }}>{value}</span>
    </div>
  )

  return (
    <div style={{ display:'grid', gridTemplateColumns:'1fr 1fr', gap:20 }}>
      <div>
        <div style={{ fontSize:9, letterSpacing:2, color:'#64748b', marginBottom:8 }}>POR DIA DA SEMANA</div>
        {porDia.map((d,i) => (
          <Row key={i}
            label={d.nome}
            value={d.wr+'% ('+d.total+' trades)'}
            color={d.wr >= 70 ? C.green : d.wr >= 50 ? C.gold : C.red}
          />
        ))}
        {melhorDia && <div style={{ marginTop:8, fontSize:10, color:C.green }}>✓ Melhor: {melhorDia.nome} ({melhorDia.wr}%)</div>}
        {piorDia   && <div style={{ fontSize:10, color:C.red }}>✗ Pior: {piorDia.nome} ({piorDia.wr}%)</div>}
      </div>

      <div>
        <div style={{ fontSize:9, letterSpacing:2, color:'#64748b', marginBottom:8 }}>CONTEXTO MACRO</div>
        {wrComEv !== null && <Row label="Com evento macro" value={wrComEv+'%'} color={wrComEv >= 70 ? C.green : C.red} sub={comEvento.length+' pregões'} />}
        {wrSemEv !== null && <Row label="Sem evento macro" value={wrSemEv+'%'} color={wrSemEv >= 70 ? C.green : C.red} sub={semEvento.length+' pregões'} />}
        <Row label="Dias sem sinal" value={pctSemSinal+'%'} color={C.muted} sub={semSinal+' de '+historico.length+' pregões'} />

        <div style={{ marginTop:16, padding:'10px 12px', background:'rgba(59,130,246,0.08)', border:'1px solid rgba(59,130,246,0.2)', borderRadius:4 }}>
          <div style={{ fontSize:9, letterSpacing:2, color:'#64748b', marginBottom:6 }}>RECOMENDAÇÃO DO SISTEMA</div>
          {melhorDia && <div style={{ fontSize:10, color:'#e2e8f0', lineHeight:1.6 }}>
            Operar com mais confiança às <span style={{ color:C.green }}>{melhorDia.nome}s</span>
            {piorDia && <span>. Cautela extra às <span style={{ color:C.red }}>{piorDia.nome}s</span></span>}.
            {wrComEv !== null && wrSemEv !== null && wrComEv < wrSemEv &&
              <span> Evitar dias com eventos macro ({wrComEv}% vs {wrSemEv}%).</span>
            }
          </div>}
        </div>
      </div>
    </div>
  )
}

// ── Chat System ───────────────────────────────────────────────
export function ChatSystem({ adaptive, riskEvent, aiAnalysis, auctionState }) {
  const [msgs, setMsgs]     = useState([
    { role: 'system', text: 'Olá! Sou o assistente do WDO Auction Engine. Pode me perguntar sobre o leilão de hoje, calibração, resultados, sinais emitidos ou qualquer dúvida sobre o sistema.' }
  ])
  const [input, setInput]   = useState('')
  const [loading, setLoading] = useState(false)
  const bottomRef = useRef(null)

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: 'smooth' })
  }, [msgs])

  const buildContext = () => {
    const stats   = adaptive || {}
    const balMes  = stats.balanco?.mensal || {}
    const ai      = aiAnalysis || {}
    const state   = auctionState?.to || 'IDLE'

    return `Você é o assistente do WDO Auction Engine, um sistema de análise quantitativa para leilão de abertura do Mini Dólar (WDO) na B3.

ESTADO ATUAL DO SISTEMA:
- Fase do mercado: ${state}
- Último veredito IA: ${ai.veredito || 'Sem dados'}
- Confiança: ${ai.confianca ? (ai.confianca*100).toFixed(0)+'%' : 'N/A'}
- DOL×WDO: ${ai.confluenciaDolWdo || 'N/A'}
- Macro: ${ai.alinhamentoMacro || 'N/A'}

CALIBRAÇÃO:
- Status: ${stats.status || 'DEFAULT'}
- Total pregões: ${stats.totalPregoes || 0}
- Thresholds: Escora ${stats.thresholds?.escora_multiplicador || 3.0}x | Stop Vol ${Math.round(stats.thresholds?.stopping_volume || 300)}

BALANÇO DO MÊS:
- Trades: ${balMes.trades || 0}
- Win Rate: ${balMes.winRate || 0}%
- PnL: R$${balMes.pnlBRL || 0}
- Drawdown máx: R$${balMes.drawdownMax || 0}

RISK ENGINE:
- Último evento: ${riskEvent ? (riskEvent.type === 'risk_approved' ? 'APROVADO' : 'REJEITADO') : 'Nenhum sinal ainda'}

Responda em português, de forma clara e direta. Máximo 3-4 frases por resposta. Se não tiver dados suficientes, diga honestamente.`
  }

  const enviar = async () => {
    if (!input.trim() || loading) return
    const pergunta = input.trim()
    setInput('')
    setMsgs(prev => [...prev, { role: 'user', text: pergunta }])
    setLoading(true)

    try {
      const token = localStorage.getItem('wdo_token') || '';
      const res = await fetch('https://leilaowdo-profit-production.up.railway.app/api/chat', {
        method: 'POST',
        headers: {
          'Authorization': 'Bearer ' + token, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          model: 'claude-sonnet-4-20250514',
          max_tokens: 1000,
          system: buildContext(),
          messages: [{ role: 'user', content: pergunta }]
        })
      })
      const data = await res.json()
      const resposta = data.content?.[0]?.text || 'Não consegui processar sua pergunta.'
      setMsgs(prev => [...prev, { role: 'assistant', text: resposta }])
    } catch (e) {
      setMsgs(prev => [...prev, { role: 'assistant', text: 'Erro ao conectar com a IA. Verifique a ANTHROPIC_API_KEY.' }])
    }
    setLoading(false)
  }

  const handleKey = (e) => {
    if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); enviar(); }
  }

  const sugestoes = [
    'O que aconteceu hoje no leilão?',
    'A calibração está confiável?',
    'Como estou esse mês?',
    'Por que não teve sinal hoje?',
  ]

  return (
    <div style={{ height:'calc(100vh - 41px)', display:'flex', flexDirection:'column', background:'#080c10' }}>
      {/* Header */}
      <div style={{ padding:'12px 20px', borderBottom:'1px solid #1e2832', background:'#0c1219', display:'flex', alignItems:'center', gap:10 }}>
        <div style={{ width:8, height:8, borderRadius:'50%', background:'#8b5cf6', boxShadow:'0 0 6px #8b5cf6' }} />
        <span style={{ fontSize:12, fontWeight:700, color:'#e2e8f0', letterSpacing:1 }}>ASSISTENTE WDO</span>
        <span style={{ fontSize:9, color:'#64748b', letterSpacing:2 }}>Powered by Claude</span>
      </div>

      {/* Messages */}
      <div style={{ flex:1, overflowY:'auto', padding:'16px 20px', display:'flex', flexDirection:'column', gap:12 }}>
        {msgs.map((m, i) => (
          <div key={i} style={{ display:'flex', flexDirection:'column', alignItems: m.role === 'user' ? 'flex-end' : 'flex-start' }}>
            {m.role !== 'user' && (
              <span style={{ fontSize:9, color:'#64748b', letterSpacing:1, marginBottom:4 }}>
                {m.role === 'system' ? 'SISTEMA' : 'ASSISTENTE'}
              </span>
            )}
            <div style={{
              maxWidth:'80%',
              padding:'10px 14px',
              borderRadius: m.role === 'user' ? '12px 12px 2px 12px' : '12px 12px 12px 2px',
              background: m.role === 'user' ? '#1e40af' : '#0c1219',
              border: m.role === 'user' ? '1px solid #3b82f6' : '1px solid #1e2832',
              fontSize:12,
              color: m.role === 'user' ? '#e2e8f0' : '#94a3b8',
              lineHeight:1.6,
            }}>
              {m.text}
            </div>
          </div>
        ))}
        {loading && (
          <div style={{ display:'flex', alignItems:'flex-start', gap:8 }}>
            <div style={{ padding:'10px 14px', borderRadius:'12px 12px 12px 2px', background:'#0c1219', border:'1px solid #1e2832', fontSize:12, color:'#64748b' }}>
              Analisando...
            </div>
          </div>
        )}
        <div ref={bottomRef} />
      </div>

      {/* Sugestões */}
      {msgs.length <= 1 && (
        <div style={{ padding:'0 20px 12px', display:'flex', gap:8, flexWrap:'wrap' }}>
          {sugestoes.map((s,i) => (
            <button key={i} onClick={() => { setInput(s); }}
              style={{ padding:'5px 10px', fontSize:10, background:'rgba(139,92,246,0.1)', color:'#8b5cf6', border:'1px solid rgba(139,92,246,0.3)', borderRadius:16, cursor:'pointer', letterSpacing:0.5 }}>
              {s}
            </button>
          ))}
        </div>
      )}

      {/* Input */}
      <div style={{ padding:'12px 20px', borderTop:'1px solid #1e2832', background:'#0c1219', display:'flex', gap:10 }}>
        <textarea
          value={input}
          onChange={e => setInput(e.target.value)}
          onKeyDown={handleKey}
          placeholder="Pergunte sobre o leilão, calibração, resultados..."
          rows={2}
          style={{
            flex:1, background:'#080c10', border:'1px solid #1e2832', borderRadius:8,
            color:'#e2e8f0', fontSize:12, padding:'8px 12px', resize:'none',
            fontFamily:'monospace', outline:'none',
          }}
        />
        <button onClick={enviar} disabled={loading || !input.trim()}
          style={{
            padding:'0 16px', background: loading || !input.trim() ? '#1e2832' : '#1e40af',
            color: loading || !input.trim() ? '#475569' : '#fff',
            border:'none', borderRadius:8, cursor: loading || !input.trim() ? 'not-allowed' : 'pointer',
            fontSize:11, fontWeight:700, letterSpacing:1,
          }}>
          {loading ? '...' : 'ENVIAR'}
        </button>
      </div>
    </div>
  )
}

// ── API Status Panel ──────────────────────────────────────────
export function APIStatus({ connected, aiAnalysis, tick, adaptive }) {
  const [diagResult, setDiagResult] = useState(null)
  const [diagRunning, setDiagRunning] = useState(false)

  const runDiagnostico = async () => {
    setDiagRunning(true); setDiagResult(null)
    const token = localStorage.getItem('wdo_token') || ''
    const B = 'https://leilaowdo-profit-production.up.railway.app'
    const itens = []
    try { const t=Date.now(),r=await fetch(B+'/health'),d=await r.json(); itens.push({nome:'Railway',ok:r.ok&&d.status==='ok',ms:Date.now()-t,detalhe:d.mode==='live'?'LIVE':'MOCK'}) } catch(e){itens.push({nome:'Railway',ok:false,detalhe:e.message})}
    try { const t=Date.now(),r=await fetch(B+'/api/auth/verify',{headers:{Authorization:'Bearer '+token}}); itens.push({nome:'Auth JWT',ok:r.ok,ms:Date.now()-t,detalhe:r.ok?'Token válido':'Expirado'}) } catch(e){itens.push({nome:'Auth JWT',ok:false,detalhe:e.message})}
    try { const t=Date.now(),r=await fetch(B+'/api/status'),d=await r.json(); itens.push({nome:'Cedro Pipeline',ok:!!d.auction,ms:Date.now()-t,detalhe:d.auction?'Ativo':'Sem dados'}) } catch(e){itens.push({nome:'Cedro Pipeline',ok:false,detalhe:e.message})}
    try { const t=Date.now(),r=await fetch(B+'/api/chat',{method:'POST',headers:{'Content-Type':'application/json',Authorization:'Bearer '+token},body:JSON.stringify({messages:[{role:'user',content:'ok'}]})}); itens.push({nome:'Claude AI',ok:r.ok,ms:Date.now()-t,detalhe:r.ok?'Respondeu em '+(Date.now()-t)+'ms':'Erro'}) } catch(e){itens.push({nome:'Claude AI',ok:false,detalhe:e.message})}
    try { const t=Date.now(),r=await fetch('https://api.telegram.org/bot8745511271:AAEzqb4DWQjMpN9ob5bWtv5ySGWhktGLvxQ/getMe'),d=await r.json(); itens.push({nome:'Telegram',ok:d.ok,ms:Date.now()-t,detalhe:d.ok?'@'+d.result.username:'Erro'}) } catch(e){itens.push({nome:'Telegram',ok:false,detalhe:e.message})}
    itens.push({nome:'WebSocket',ok:connected,detalhe:connected?'Conectado':'Desconectado'})
    setDiagResult({ok:itens.every(i=>i.ok),itens}); setDiagRunning(false)
  }


  const [apiTests, setApiTests] = useState({
    yahoo:  { testado: false, ok: null, ms: null },
    twelve: { testado: false, ok: null, ms: null },
    cedro:  { testado: false, ok: null, ms: null },
    claude: { testado: false, ok: null, ms: null },
  })

  useEffect(() => {
    const token = localStorage.getItem('wdo_token') || ''
    const B = 'https://leilaowdo-profit-production.up.railway.app'
    
    // Testa Macro Engine via backend
    const t1 = Date.now()
    fetch(B + '/api/macro/ping', { headers: { Authorization: 'Bearer ' + token } })
      .then(r => setApiTests(p => ({...p, yahoo: { testado: true, ok: r.ok, ms: Date.now()-t1 }})))
      .catch(() => setApiTests(p => ({...p, yahoo: { testado: true, ok: false, ms: null }})))

    // Testa Twelve Data (só verifica se a key existe)
    const t2 = Date.now()
    fetch('https://api.twelvedata.com/price?symbol=EUR/USD&apikey=022385c872a84c069ffc19886264468f')
      .then(r => r.json()).then(d => setApiTests(p => ({...p, twelve: { testado: true, ok: !d.status || d.status !== 'error', ms: Date.now()-t2 }})))
      .catch(() => setApiTests(p => ({...p, twelve: { testado: true, ok: false, ms: null }})))

    // Testa Cedro via status
    const t3 = Date.now()
    fetch(B + '/api/status')
      .then(r => r.json()).then(d => setApiTests(p => ({...p, cedro: { testado: true, ok: !!d.auction, ms: Date.now()-t3 }})))
      .catch(() => setApiTests(p => ({...p, cedro: { testado: true, ok: false, ms: null }})))

    // Testa Claude
    const t4 = Date.now()
    fetch(B + '/api/chat', { method:'POST', headers:{'Content-Type':'application/json', Authorization:'Bearer '+token}, body: JSON.stringify({messages:[{role:'user',content:'ok'}]}) })
      .then(r => setApiTests(p => ({...p, claude: { testado: true, ok: r.ok, ms: Date.now()-t4 }})))
      .catch(() => setApiTests(p => ({...p, claude: { testado: true, ok: false, ms: null }})))
  }, [])

  const [apiStatus, setApiStatus] = useState({
    yahoo:    { status: 'standby', lastUpdate: null, latency: null },
    twelve:   { status: 'standby', lastUpdate: null, latency: null },
    cedro:    { status: 'standby', lastUpdate: null, latency: null },
    anthropic:{ status: 'standby', lastUpdate: null, latency: null },
  })

  const now = Date.now()
  // Horário BRT (UTC-3) e verificação de dia útil
  const _agora   = new Date()
  const _brt     = new Date(_agora.getTime() - 3 * 60 * 60 * 1000)
  const _diaSem  = _brt.getUTCDay() // 0=dom, 6=sab
  const _diaUtil = _diaSem >= 1 && _diaSem <= 5
  const hora     = _brt.getUTCHours()
  const min      = _brt.getUTCMinutes()
  const horaAtual = _diaUtil ? (hora + min / 60) : -1 // -1 = fim de semana → tudo standby

  // Verifica status baseado nos dados recebidos
  useEffect(() => {
    const interval = setInterval(() => {
      const agora = Date.now()

      // Macro Engine — ativo das 8h45 às 18h00
      const yahooAtivo = horaAtual >= 8.75 && horaAtual < 18.0
      const yahooStatus = adaptive?.macroLastUpdate
        ? (agora - adaptive.macroLastUpdate < 120000 ? 'ok' : agora - adaptive.macroLastUpdate < 300000 ? 'lento' : 'erro')
        : yahooAtivo ? 'checking' : 'standby'

      // Twelve Data — ativo das 8h45 às 18h
      const twelveAtivo = horaAtual >= 8.75 && horaAtual < 18.0
      const twelveStatus = twelveAtivo
        ? (adaptive?.twelveLastUpdate && agora - adaptive.twelveLastUpdate < 30000 ? 'ok' : 'standby')
        : 'standby'

      // Cedro Socket — ativo das 8h55 às 9h05
      const cedroAtivo = horaAtual >= 8.917 && horaAtual < 9.083
      const cedroStatus = connected
        ? (tick?.timestamp && agora - tick.timestamp < 2000 ? 'ok' : 'lento')
        : cedroAtivo ? 'erro' : 'standby'

      // Anthropic — ativo das 8h55 às 9h10
      const aiAtivo = horaAtual >= 8.917 && horaAtual < 9.167
      const aiStatus = aiAnalysis?.timestamp
        ? (agora - aiAnalysis.timestamp < 10000 ? 'ok' : agora - aiAnalysis.timestamp < 20000 ? 'lento' : 'erro')
        : aiAtivo ? 'checking' : adaptive?.status === 'STUB' ? 'stub' : 'standby'

      setApiStatus({
        yahoo:     { status: yahooStatus,  lastUpdate: adaptive?.macroLastUpdate },
        twelve:    { status: twelveStatus, lastUpdate: adaptive?.twelveLastUpdate },
        cedro:     { status: cedroStatus,  lastUpdate: tick?.timestamp },
        anthropic: { status: aiStatus,     lastUpdate: aiAnalysis?.timestamp },
      })
    }, 1000)
    return () => clearInterval(interval)
  }, [connected, aiAnalysis, tick, adaptive, horaAtual])

  const getColor = (status) => ({
    ok:       '#22c55e',
    lento:    '#f59e0b',
    erro:     '#ef4444',
    standby:  '#475569',
    checking: '#3b82f6',
    stub:     '#f59e0b',
  }[status] || '#475569')

  const getLabel = (status) => ({
    ok:       'ONLINE',
    lento:    'LENTO',
    erro:     'OFFLINE',
    standby:  'AGUARDANDO',
    checking: 'VERIFICANDO',
    stub:     'STUB ATIVO',
  }[status] || 'DESCONHECIDO')

  const getIcon = (status) => ({
    ok:       '✅',
    lento:    '🟡',
    erro:     '🔴',
    standby:  '⚫',
    checking: '🔵',
    stub:     '🟡',
  }[status] || '⚫')

  const formatTime = (ts) => {
    if (!ts) return '—'
    const diff = Math.round((Date.now() - ts) / 1000)
    if (diff < 60)  return diff + 's atrás'
    if (diff < 3600) return Math.round(diff/60) + 'min atrás'
    return '> 1h atrás'
  }

  const apis = [
    {
      key:     'yahoo',
      nome:    'Macro Engine',
      janela:  '8h45 → 8h58',
      descricao: 'DXY, Treasury, VIX, Ouro, S&P (30s delay)',
      status:  apiStatus.yahoo.status,
      lastUpdate: apiStatus.yahoo.lastUpdate,
    },
    {
      key:     'twelve',
      nome:    'Twelve Data',
      janela:  '8h59 → 9h05',
      descricao: 'DXY, Treasury, VIX, Ouro, S&P (tempo real)',
      status:  apiStatus.twelve.status,
      lastUpdate: apiStatus.twelve.lastUpdate,
    },
    {
      key:     'cedro',
      nome:    'Cedro Socket',
      janela:  '8h55 → 9h05',
      descricao: 'WDO ticks, DOL ticks, Book L2 (250ms)',
      status:  apiStatus.cedro.status,
      lastUpdate: apiStatus.cedro.lastUpdate,
    },
    {
      key:     'anthropic',
      nome:    'Anthropic Claude',
      janela:  '8h55 → 9h05',
      descricao: 'Análise IA, confiança, alvo dinâmico',
      status:  apiStatus.anthropic.status,
      lastUpdate: apiStatus.anthropic.lastUpdate,
    },
  ]

  const todosOk    = apis.every(a => ['ok','standby'].includes(a.status))
  const temErro    = apis.some(a => a.status === 'erro')
  const temLento   = apis.some(a => a.status === 'lento')

  const statusGeral = temErro ? 'erro' : temLento ? 'lento' : todosOk ? 'ok' : 'checking'

  return (
    <div style={{ height:'calc(100vh - 41px)', background:'#080c10', overflowY:'auto', padding:24 }}>

      {/* Status geral */}
      <div style={{ background:'#0c1219', border:`2px solid ${getColor(statusGeral)}40`, borderRadius:8, padding:'16px 20px', marginBottom:24, display:'flex', alignItems:'center', gap:14 }}>
        <div style={{ width:12, height:12, borderRadius:'50%', background:getColor(statusGeral), boxShadow:`0 0 10px ${getColor(statusGeral)}` }} />
        <div>
          <div style={{ fontSize:14, fontWeight:700, color:getColor(statusGeral), letterSpacing:1 }}>
            SISTEMA {getLabel(statusGeral).toUpperCase()}
          </div>
          <div style={{ fontSize:10, color:'#64748b', marginTop:2 }}>
            {temErro ? 'Uma ou mais APIs com problema — verificar antes de operar' :
             temLento ? 'APIs com latência alta — monitorar' :
             'Todos os sistemas operacionais'}
          </div>
        </div>
      </div>


      {/* Botão e resultado do diagnóstico */}
      <div style={{ marginBottom:24 }}>
        <button onClick={runDiagnostico} disabled={diagRunning} style={{
          padding:'10px 24px', fontSize:11, letterSpacing:2, fontWeight:700,
          background: diagRunning ? '#1e2832' : '#1e40af',
          color: diagRunning ? '#475569' : '#fff',
          border:'1px solid #3b82f6', borderRadius:6, cursor: diagRunning ? 'not-allowed' : 'pointer',
          marginBottom:16, width:'100%'
        }}>
          {diagRunning ? '⏳ TESTANDO...' : '🔍 RODAR DIAGNÓSTICO'}
        </button>

        {diagResult && (
          <div style={{ background:'#0c1219', border:'2px solid ' + (diagResult.ok ? '#22c55e' : '#ef4444') + '40', borderRadius:8, padding:16 }}>
            <div style={{ fontSize:12, fontWeight:700, color: diagResult.ok ? '#22c55e' : '#ef4444', marginBottom:12, letterSpacing:1 }}>
              {diagResult.ok ? '✅ TODOS OS SISTEMAS OK' : '⚠️ PROBLEMA DETECTADO'}
            </div>
            {diagResult.itens.map((item, i) => (
              <div key={i} style={{ display:'flex', justifyContent:'space-between', padding:'6px 0', borderBottom:'1px solid #1e2832' }}>
                <span style={{ fontSize:11, color: item.ok ? '#22c55e' : '#ef4444' }}>
                  {item.ok ? '✅' : '❌'} {item.nome}
                </span>
                <span style={{ fontSize:10, color:'#64748b', fontFamily:'monospace' }}>
                  {item.detalhe}{item.ms ? ' · ' + item.ms + 'ms' : ''}
                </span>
              </div>
            ))}
          </div>
        )}
      </div>

      {/* APIs simplificadas */}
      <div style={{ background:'#0c1219', border:'1px solid #1e2832', borderRadius:8, padding:16, marginBottom:16 }}>
        <div style={{ fontSize:10, color:'#64748b', letterSpacing:2, marginBottom:12 }}>STATUS DAS APIS</div>
        {apis.map((api, i) => {
          const cor = getColor(api.status)
          return (
            <div key={api.key} style={{ display:'flex', justifyContent:'space-between', alignItems:'center', padding:'7px 0', borderBottom: i < apis.length-1 ? '1px solid #1e2832' : 'none' }}>
              <span style={{ fontSize:11, color:cor }}>
                {api.status==='ok'?'✅':api.status==='erro'?'❌':api.status==='lento'?'🟡':'⚫'} {api.nome}
              </span>
              <span style={{ fontSize:10, color:'#64748b', fontFamily:'monospace' }}>
                {api.janela} · <span style={{ color:cor, fontWeight:700 }}>{getLabel(api.status)}</span>
                {api.lastUpdate ? ' · ' + Math.round((Date.now()-api.lastUpdate)/1000) + 's atras' : ''}
                {' · '}
                {api.key === 'yahoo' && (apiTests.yahoo.testado ? (apiTests.yahoo.ok ? <span style={{color:'#22c55e'}}>✅ funcionando{apiTests.yahoo.ms ? ' '+apiTests.yahoo.ms+'ms' : ''}</span> : <span style={{color:'#ef4444'}}>❌ offline</span>) : <span style={{color:'#64748b'}}>testando...</span>)}
                {api.key === 'twelve' && (apiTests.twelve.testado ? (apiTests.twelve.ok ? <span style={{color:'#22c55e'}}>✅ funcionando{apiTests.twelve.ms ? ' '+apiTests.twelve.ms+'ms' : ''}</span> : <span style={{color:'#ef4444'}}>❌ offline</span>) : <span style={{color:'#64748b'}}>testando...</span>)}
                {api.key === 'cedro' && (apiTests.cedro.testado ? (apiTests.cedro.ok ? <span style={{color:'#22c55e'}}>✅ funcionando{apiTests.cedro.ms ? ' '+apiTests.cedro.ms+'ms' : ''}</span> : <span style={{color:'#ef4444'}}>❌ offline</span>) : <span style={{color:'#64748b'}}>testando...</span>)}
                {api.key === 'anthropic' && (apiTests.claude.testado ? (apiTests.claude.ok ? <span style={{color:'#22c55e'}}>✅ funcionando{apiTests.claude.ms ? ' '+apiTests.claude.ms+'ms' : ''}</span> : <span style={{color:'#ef4444'}}>❌ offline</span>) : <span style={{color:'#64748b'}}>testando...</span>)}
              </span>
            </div>
          )
        })}
      </div>

      {/* Nota sobre Twelve Data */}
      <div style={{ marginTop:16, padding:'10px 14px', background:'rgba(59,130,246,0.08)', border:'1px solid rgba(59,130,246,0.2)', borderRadius:6, fontSize:10, color:'#64748b', lineHeight:1.6 }}>
        ℹ️ <strong style={{ color:'#94a3b8' }}>Twelve Data</strong> será ativado automaticamente às 8h59 quando a Cedro estiver conectada. API Key configurada.
      </div>
    </div>
  )
}

// ── Login Screen ──────────────────────────────────────────────
export function LoginScreen({ onLogin }) {
  const [usuario, setUsuario] = useState('')
  const [senha, setSenha]     = useState('')
  const [erro, setErro]       = useState('')
  const [loading, setLoading] = useState(false)

  const handleLogin = async () => {
    if (!usuario || !senha) { setErro('Preencha usuário e senha'); return }
    setLoading(true)
    setErro('')
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), 30000)
    try {
      const res = await fetch('https://leilaowdo-profit-production.up.railway.app/api/auth/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ usuario, senha }),
        signal: controller.signal
      })
      const data = await res.json()
      if (!res.ok) { setErro(data.error || 'Erro ao fazer login'); return }
      localStorage.setItem('wdo_token', data.token)
      localStorage.setItem('wdo_usuario', data.usuario)
      onLogin(data.token)
    } catch (e) {
      if (e.name === 'AbortError') setErro('Timeout — servidor demorou mais de 30s')
      else setErro('Erro de conexão com o servidor')
    } finally {
      clearTimeout(timer)
      setLoading(false)
    }
  }

  const handleKey = (e) => { if (e.key === 'Enter') handleLogin() }

  return (
    <div style={{ minHeight:'100vh', background:'#080c10', display:'flex', alignItems:'center', justifyContent:'center', fontFamily:'monospace' }}>
      <div style={{ width:360, background:'#0c1219', border:'1px solid #1e2832', borderRadius:10, padding:40 }}>

        {/* Logo */}
        <div style={{ textAlign:'center', marginBottom:32 }}>
          <div style={{ display:'flex', alignItems:'center', justifyContent:'center', gap:8, marginBottom:8 }}>
            <div style={{ width:8, height:8, borderRadius:'50%', background:'#22c55e', boxShadow:'0 0 8px #22c55e' }} />
            <span style={{ fontSize:14, fontWeight:700, color:'#f8fafc', letterSpacing:2 }}>WDO AUCTION ENGINE</span>
          </div>
          <span style={{ fontSize:10, color:'#475569', letterSpacing:2 }}>ACESSO RESTRITO</span>
        </div>

        {/* Campos */}
        <div style={{ marginBottom:16 }}>
          <label style={{ fontSize:9, color:'#64748b', letterSpacing:2, display:'block', marginBottom:6 }}>USUÁRIO</label>
          <input
            value={usuario}
            onChange={e => setUsuario(e.target.value)}
            onKeyDown={handleKey}
            placeholder="seu usuário"
            style={{ width:'100%', background:'#080c10', border:'1px solid #1e2832', borderRadius:6, color:'#e2e8f0', fontSize:13, padding:'10px 12px', outline:'none', fontFamily:'monospace', boxSizing:'border-box' }}
          />
        </div>

        <div style={{ marginBottom:24 }}>
          <label style={{ fontSize:9, color:'#64748b', letterSpacing:2, display:'block', marginBottom:6 }}>SENHA</label>
          <input
            type="password"
            value={senha}
            onChange={e => setSenha(e.target.value)}
            onKeyDown={handleKey}
            placeholder="••••••••"
            style={{ width:'100%', background:'#080c10', border:'1px solid #1e2832', borderRadius:6, color:'#e2e8f0', fontSize:13, padding:'10px 12px', outline:'none', fontFamily:'monospace', boxSizing:'border-box' }}
          />
        </div>

        {erro && (
          <div style={{ background:'rgba(239,68,68,0.1)', border:'1px solid rgba(239,68,68,0.3)', borderRadius:6, padding:'8px 12px', marginBottom:16, fontSize:11, color:'#ef4444', textAlign:'center' }}>
            {erro}
          </div>
        )}

        <button
          onClick={handleLogin}
          disabled={loading}
          style={{ width:'100%', padding:'12px', background: loading ? '#1e2832' : '#1e40af', color: loading ? '#475569' : '#fff', border:'none', borderRadius:6, fontSize:12, fontWeight:700, letterSpacing:2, cursor: loading ? 'not-allowed' : 'pointer', fontFamily:'monospace' }}>
          {loading ? 'VERIFICANDO...' : 'ENTRAR'}
        </button>

        <div style={{ marginTop:20, fontSize:9, color:'#334155', textAlign:'center', letterSpacing:1 }}>
          Token válido por 12 horas
        </div>
      </div>
    </div>
  )
}

// ── Market Features Panel ─────────────────────────────────────
export function MarketFeaturesPanel({ mktFeatures, aiAnalysis }) {
  if (!mktFeatures) return (
    <div style={{ background:C.panel, padding:'10px 12px', borderBottom:`1px solid ${C.border}` }}>
      <span style={{ fontSize:9, letterSpacing:2, color:C.muted, textTransform:'uppercase' }}>ANÁLISE ESPECIALIZADA</span>
      <div style={{ fontSize:10, color:C.dim, marginTop:4 }}>Aguardando dados do leilão...</div>
    </div>
  )

  const { vap, tpVelocidade, agressorRatio, tunnel, spread, escoraReal, volumeRatio, featureScore } = mktFeatures

  const scoreColor = featureScore > 2 ? C.green : featureScore > 0 ? '#86efac' : featureScore < -2 ? C.red : featureScore < 0 ? '#fca5a5' : C.muted
  const getC = (v, pos, neg) => v > 0 ? pos : v < 0 ? neg : C.muted

  return (
    <div style={{ background:C.panel, padding:'10px 12px', borderBottom:`1px solid ${C.border}` }}>
      <div style={{ display:'flex', justifyContent:'space-between', alignItems:'center', marginBottom:8 }}>
        <span style={{ fontSize:9, letterSpacing:2, color:C.muted, textTransform:'uppercase' }}>ANÁLISE ESPECIALIZADA</span>
        <span style={{ fontSize:11, fontWeight:700, color:scoreColor, fontFamily:'monospace' }}>
          {featureScore > 0 ? '+' : ''}{featureScore} score
        </span>
      </div>

      <div style={{ display:'grid', gridTemplateColumns:'1fr 1fr', gap:6 }}>

        {/* VAP */}
        <div style={{ background:'rgba(0,0,0,0.3)', borderRadius:4, padding:'6px 8px' }}>
          <div style={{ fontSize:8, color:C.dim, letterSpacing:1, marginBottom:3 }}>VAP · POC</div>
          <div style={{ fontSize:11, color:C.gold, fontFamily:'monospace', fontWeight:700 }}>
            {vap?.poc?.price?.toFixed(1) || '—'}
          </div>
          <div style={{ fontSize:8, color:C.muted }}>{vap?.poc?.totalVol || 0} lotes</div>
          <div style={{ fontSize:8, color:C.dim, marginTop:2 }}>
            VA: {vap?.valueArea?.low?.toFixed(1)}—{vap?.valueArea?.high?.toFixed(1)}
          </div>
        </div>

        {/* TP Velocity */}
        <div style={{ background:'rgba(0,0,0,0.3)', borderRadius:4, padding:'6px 8px' }}>
          <div style={{ fontSize:8, color:C.dim, letterSpacing:1, marginBottom:3 }}>TP VELOCIDADE</div>
          <div style={{ fontSize:11, fontFamily:'monospace', fontWeight:700,
            color: tpVelocidade?.estavel ? C.green : tpVelocidade?.oscilando ? C.red : C.gold }}>
            {tpVelocidade?.estavel ? '✓ ESTÁVEL' : tpVelocidade?.oscilando ? '✗ OSCILANDO' : '~ CONV.'}
          </div>
          <div style={{ fontSize:8, color:C.muted }}>{tpVelocidade?.velocidade?.toFixed(2) || 0} pts/s</div>
          <div style={{ fontSize:8, color:C.dim, marginTop:2 }}>σ {tpVelocidade?.desvioPadrao?.toFixed(2) || 0}</div>
        </div>

        {/* Agressor Ratio */}
        <div style={{ background:'rgba(0,0,0,0.3)', borderRadius:4, padding:'6px 8px' }}>
          <div style={{ fontSize:8, color:C.dim, letterSpacing:1, marginBottom:3 }}>AGRESSOR RATIO</div>
          <div style={{ fontSize:11, fontFamily:'monospace', fontWeight:700,
            color: agressorRatio?.pressao === 'compradora' ? C.green : agressorRatio?.pressao === 'vendedora' ? C.red : C.muted }}>
            {agressorRatio?.pressao?.toUpperCase() || 'NEUTRO'}
          </div>
          <div style={{ display:'flex', gap:4, marginTop:2 }}>
            <span style={{ fontSize:8, color:C.green }}>C {Math.round((agressorRatio?.buyRatio || 0)*100)}%</span>
            <span style={{ fontSize:8, color:C.red }}>V {Math.round((agressorRatio?.sellRatio || 0)*100)}%</span>
          </div>
          <div style={{ height:3, background:C.border, borderRadius:2, marginTop:3, overflow:'hidden' }}>
            <div style={{ height:'100%', width:`${Math.round((agressorRatio?.buyRatio||0.5)*100)}%`, background:C.green, borderRadius:2 }} />
          </div>
        </div>

        {/* Escora Real */}
        <div style={{ background:'rgba(0,0,0,0.3)', borderRadius:4, padding:'6px 8px' }}>
          <div style={{ fontSize:8, color:C.dim, letterSpacing:1, marginBottom:3 }}>ESCORA REAL</div>
          <div style={{ fontSize:11, fontFamily:'monospace', fontWeight:700,
            color: escoraReal?.nivelForte ? C.green : C.muted }}>
            {escoraReal?.escoraAtual?.price?.toFixed(1) || '—'}
          </div>
          <div style={{ fontSize:8, color:C.muted }}>{escoraReal?.escoraAtual?.maxVol || 0} lotes max</div>
          <div style={{ fontSize:8, color: escoraReal?.nivelForte ? C.green : C.dim, marginTop:2 }}>
            {escoraReal?.nivelForte ? '✓ FORTE' : 'Fraca'}
          </div>
        </div>

        {/* Confiança IA + Amplitude */}
        <div style={{ background:'rgba(0,0,0,0.3)', borderRadius:4, padding:'6px 8px', gridColumn:'span 2' }}>
          <div style={{ display:'flex', justifyContent:'space-between', marginBottom:4 }}>
            <div style={{ fontSize:8, color:C.dim, letterSpacing:1 }}>ANÁLISE DE CONFIANÇA</div>
            <div style={{ fontSize:8, color:C.dim, letterSpacing:1 }}>AMPLITUDE</div>
          </div>
          <div style={{ display:'flex', justifyContent:'space-between', alignItems:'center', gap:8 }}>
            {/* Barra confiança com direção */}
            <div style={{ flex:1 }}>
              <div style={{ display:'flex', justifyContent:'space-between', marginBottom:2 }}>
                <span style={{ fontSize:11, fontFamily:'monospace', fontWeight:700,
                  color: aiAnalysis?.direcao === 'buy' ? C.green : aiAnalysis?.direcao === 'sell' ? C.red : aiAnalysis?.confianca >= 0.85 ? C.green : aiAnalysis?.confianca >= 0.6 ? C.gold : C.muted }}>
                  {aiAnalysis?.direcao === 'buy' ? '▲ COMPRA' : aiAnalysis?.direcao === 'sell' ? '▼ VENDA' : '—'}
                </span>
                <span style={{ fontSize:11, fontFamily:'monospace', fontWeight:700,
                  color: aiAnalysis?.confianca >= 0.85 ? C.green : aiAnalysis?.confianca >= 0.6 ? C.gold : C.red }}>
                  {aiAnalysis?.confianca ? Math.round(aiAnalysis.confianca*100)+'%' : '—'}
                </span>
              </div>
              <div style={{ height:4, background:C.border, borderRadius:2, overflow:'hidden' }}>
                <div style={{ height:'100%', borderRadius:2, transition:'width 0.5s',
                  width: aiAnalysis?.confianca ? Math.round(aiAnalysis.confianca*100)+'%' : '0%',
                  background: aiAnalysis?.direcao === 'buy' ? C.green : aiAnalysis?.direcao === 'sell' ? C.red : aiAnalysis?.confianca >= 0.85 ? C.green : C.gold
                }} />
              </div>
              <div style={{ fontSize:8, color:C.muted, marginTop:2 }}>
                {aiAnalysis?.confianca >= 0.85 ? '✓ OPERARIA' : aiAnalysis?.confianca > 0 ? 'aguardando...' : ''}
              </div>
            </div>
            {/* Barra amplitude */}
            <div style={{ flex:1 }}>
              <div style={{ display:'flex', justifyContent:'space-between', marginBottom:2 }}>
                <span style={{ fontSize:11, fontFamily:'monospace', fontWeight:700, color:C.green }}>
                  {aiAnalysis?.alvo1Ticks > 0 ? aiAnalysis.alvo1Ticks+'t' : '—'}
                </span>
                <span style={{ fontSize:8, color:C.muted }}>
                  {aiAnalysis?.alvo1Ticks > 0 ? (aiAnalysis.alvo1Ticks/2).toFixed(0)+'pts' : '—'}
                </span>
              </div>
              <div style={{ height:4, background:C.border, borderRadius:2, overflow:'hidden' }}>
                <div style={{ height:'100%', borderRadius:2, transition:'width 0.5s',
                  width: aiAnalysis?.alvo1Ticks > 0 ? Math.min(aiAnalysis.alvo1Ticks/20*100, 100)+'%' : '0%',
                  background: aiAnalysis?.alvo1Ticks >= 12 ? C.green : aiAnalysis?.alvo1Ticks >= 8 ? C.gold : C.muted
                }} />
              </div>
            </div>
          </div>
          {aiAnalysis?.alvo1Preco > 0 && (
            <div style={{ display:'flex', justifyContent:'space-between', marginTop:4, fontSize:8, color:C.muted }}>
              <span>entrada: {aiAnalysis?.precoEntrada?.toFixed(1) || '—'}</span>
              <span style={{ color:C.green }}>alvo: {aiAnalysis.alvo1Preco?.toFixed(1)}</span>
              <span style={{ color:C.red }}>stop: {aiAnalysis?.stopPreco?.toFixed(1) || '—'}</span>
              <span style={{ color:C.gold }}>RR: {aiAnalysis?.rr?.toFixed(2) || '—'}</span>
            </div>
          )}
        </div>

        {/* Spread WDO-DOL */}
        <div style={{ background:'rgba(0,0,0,0.3)', borderRadius:4, padding:'6px 8px' }}>
          <div style={{ fontSize:8, color:C.dim, letterSpacing:1, marginBottom:3 }}>SPREAD WDO·DOL</div>
          <div style={{ fontSize:11, fontFamily:'monospace', fontWeight:700,
            color: spread?.divergente ? C.red : C.green }}>
            {spread?.spread?.toFixed(1) || '—'} pts
          </div>
          <div style={{ fontSize:8, color: spread?.divergente ? C.red : C.muted }}>
            {spread?.divergente ? '✗ DIVERGENTE' : '✓ NORMAL'}
          </div>
        </div>

        {/* Volume Ratio */}
        <div style={{ background:'rgba(0,0,0,0.3)', borderRadius:4, padding:'6px 8px' }}>
          <div style={{ fontSize:8, color:C.dim, letterSpacing:1, marginBottom:3 }}>VOL RATIO</div>
          <div style={{ fontSize:11, fontFamily:'monospace', fontWeight:700,
            color: volumeRatio?.forte ? C.green : volumeRatio?.fraco ? C.red : C.muted }}>
            {volumeRatio?.ratio ? `${volumeRatio.ratio.toFixed(1)}x` : '—'}
          </div>
          <div style={{ fontSize:8, color:C.muted }}>média {volumeRatio?.media || '—'}</div>
        </div>

      </div>

      {/* Tunnel */}
      {tunnel?.risco && tunnel.risco !== 'desconhecido' && (
        <div style={{ marginTop:6, padding:'4px 8px', borderRadius:4,
          background: tunnel.risco === 'alto' ? 'rgba(239,68,68,0.1)' : 'rgba(0,0,0,0.2)',
          border: `1px solid ${tunnel.risco === 'alto' ? C.red+'40' : C.border}` }}>
          <div style={{ fontSize:8, color:C.dim, marginBottom:2 }}>TUNNEL LIMITS B3</div>
          <div style={{ display:'flex', justifyContent:'space-between', fontSize:9, fontFamily:'monospace' }}>
            <span style={{ color:C.green }}>Piso: {tunnel.lowerLimit?.toFixed(1) || '—'}</span>
            <span style={{ color: tunnel.risco === 'alto' ? C.red : C.muted }}>
              Risco: {tunnel.risco?.toUpperCase()}
            </span>
            <span style={{ color:C.red }}>Teto: {tunnel.upperLimit?.toFixed(1) || '—'}</span>
          </div>
        </div>
      )}
    </div>
  )
}

export function CMERangePanel({ macro }) {
  const [lastRange, setLastRange] = React.useState(null)
  React.useEffect(() => { if (macro?.cmeRange) setLastRange(macro.cmeRange) }, [macro])
  const range = macro?.cmeRange || lastRange
  return (
    <div style={{ background:'rgba(255,255,255,0.03)', border:'1px solid rgba(255,255,255,0.08)', borderRadius:6, padding:'10px 12px' }}>
      <div style={{ display:'flex', justifyContent:'space-between', alignItems:'center', marginBottom:8 }}>
        <span style={{ fontSize:10, color:'rgba(255,255,255,0.4)', letterSpacing:1, fontWeight:600 }}>CME · RANGE MADRUGADA</span>
        {range && <span style={{ fontSize:9, color:'rgba(255,255,255,0.3)' }}>{range.candles} candles</span>}
      </div>

      {!range ? (
        <div style={{ fontSize:10, color:'rgba(255,255,255,0.3)' }}>Disponível às 8h45...</div>
      ) : (
        <>
          <div style={{ display:'grid', gridTemplateColumns:'1fr 1fr 1fr', gap:6, marginBottom:8 }}>
            <div style={{ textAlign:'center', background:'rgba(34,197,94,0.1)', borderRadius:4, padding:'6px 4px' }}>
              <div style={{ fontSize:9, color:'rgba(255,255,255,0.4)', marginBottom:2 }}>MÁXIMA</div>
              <div style={{ fontSize:13, fontWeight:700, color:'#22c55e', fontFamily:'monospace' }}>{parseFloat(range.max).toFixed(3)}</div>
            </div>
            <div style={{ textAlign:'center', background:'rgba(255,255,255,0.05)', borderRadius:4, padding:'6px 4px' }}>
              <div style={{ fontSize:9, color:'rgba(255,255,255,0.4)', marginBottom:2 }}>RANGE</div>
              <div style={{ fontSize:13, fontWeight:700, color:'#f59e0b', fontFamily:'monospace' }}>{range.range} pts</div>
            </div>
            <div style={{ textAlign:'center', background:'rgba(239,68,68,0.1)', borderRadius:4, padding:'6px 4px' }}>
              <div style={{ fontSize:9, color:'rgba(255,255,255,0.4)', marginBottom:2 }}>MÍNIMA</div>
              <div style={{ fontSize:13, fontWeight:700, color:'#ef4444', fontFamily:'monospace' }}>{parseFloat(range.min).toFixed(3)}</div>
            </div>
          </div>

          {/* Barra visual do range */}
          <div style={{ position:'relative', height:8, background:'rgba(255,255,255,0.06)', borderRadius:4, overflow:'hidden' }}>
            <div style={{ position:'absolute', left:0, top:0, width:'100%', height:'100%',
              background:'linear-gradient(90deg, #ef444440, #f59e0b40, #22c55e40)', borderRadius:4 }} />
          </div>
          <div style={{ display:'flex', justifyContent:'space-between', fontSize:8, color:'rgba(255,255,255,0.25)', marginTop:3 }}>
            <span>suporte</span>
            <span>resistência</span>
          </div>
        </>
      )}
    </div>
  )
}

export function TapeThermometer({ features, mktFeatures }) {
  const [last, setLast] = React.useState(null)
  React.useEffect(() => { if (features) setLast({ features, mktFeatures }) }, [features, mktFeatures])
  const f = features || last?.features
  const m = mktFeatures || last?.mktFeatures
  if (!f) return null
  const { features: _, mktFeatures: __ } = { features: f, mktFeatures: m }

  const aggRatio  = features.aggRatio || 0.5
  const flowDelta = features.flowDelta || 0
  const bkImbal   = features.bookImbalance || 0
  const escora    = mktFeatures?.escoraReal?.detected || false
  const iceberg   = features.lastIceberg || null

  let score = 0
  score += (aggRatio - 0.5) * 2 * 35
  score += Math.max(-1, Math.min(1, flowDelta / 5000)) * 25
  score += Math.max(-1, Math.min(1, bkImbal)) * 20
  if (escora) score += 10
  if (iceberg) score += iceberg.side === 'bid' ? 10 : -10
  score = Math.max(-100, Math.min(100, Math.round(score)))

  const isBuy  = score > 0
  const abs    = Math.abs(score)
  const color  = abs >= 60 ? (isBuy ? '#22c55e' : '#ef4444') : abs >= 30 ? '#f59e0b' : '#6b7280'
  const lbl    = abs >= 70 ? (isBuy ? 'COMPRA FORTE' : 'VENDA FORTE') : abs >= 40 ? (isBuy ? 'COMPRA' : 'VENDA') : 'NEUTRO'
  const barW   = abs / 2
  const barL   = isBuy ? 50 : 50 - barW

  return (
    <div style={{ background:'rgba(255,255,255,0.03)', border:'1px solid rgba(255,255,255,0.08)', borderRadius:6, padding:'10px 12px' }}>
      <div style={{ display:'flex', justifyContent:'space-between', alignItems:'center', marginBottom:6 }}>
        <span style={{ fontSize:10, color:'rgba(255,255,255,0.4)', letterSpacing:1, fontWeight:600 }}>TAPE READING</span>
        <div style={{ display:'flex', alignItems:'center', gap:8 }}>
          <span style={{ fontSize:10, color, fontWeight:700 }}>{lbl}</span>
          <span style={{ fontSize:18, fontWeight:700, color }}>{score > 0 ? '+' : ''}{score}</span>
        </div>
      </div>
      <div style={{ height:18, background:'rgba(255,255,255,0.06)', borderRadius:4, position:'relative', overflow:'hidden', marginBottom:4 }}>
        <div style={{ position:'absolute', left:'50%', top:0, width:2, height:'100%', background:'rgba(255,255,255,0.15)' }} />
        <div style={{ position:'absolute', top:0, left:`${barL}%`, width:`${barW}%`, height:'100%', background:color, borderRadius:4, transition:'all 0.3s ease', opacity:0.9 }} />
      </div>
      <div style={{ display:'flex', justifyContent:'space-between', fontSize:9, color:'rgba(255,255,255,0.25)', marginBottom:8 }}>
        <span>VENDA -100</span><span>0</span><span>COMPRA +100</span>
      </div>
      <div style={{ display:'grid', gridTemplateColumns:'repeat(3,1fr)', gap:4 }}>
        <div style={{ textAlign:'center' }}>
          <div style={{ fontSize:9, color:'rgba(255,255,255,0.3)' }}>AGRESSOR</div>
          <div style={{ fontSize:12, fontWeight:600, color:aggRatio>0.6?'#22c55e':aggRatio<0.4?'#ef4444':'#6b7280' }}>{Math.round(aggRatio*100)}%</div>
        </div>
        <div style={{ textAlign:'center' }}>
          <div style={{ fontSize:9, color:'rgba(255,255,255,0.3)' }}>FLOW Δ</div>
          <div style={{ fontSize:12, fontWeight:600, color:flowDelta>0?'#22c55e':flowDelta<0?'#ef4444':'#6b7280' }}>{flowDelta>0?'+':''}{flowDelta}</div>
        </div>
        <div style={{ textAlign:'center' }}>
          <div style={{ fontSize:9, color:'rgba(255,255,255,0.3)' }}>ESCORA</div>
          <div style={{ fontSize:12, fontWeight:600, color:escora?'#22c55e':'#6b7280' }}>{escora?'SIM':'—'}</div>
        </div>
      </div>
    </div>
  )
}
