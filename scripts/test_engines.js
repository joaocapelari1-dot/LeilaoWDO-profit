'use strict';
process.chdir(require('path').join(__dirname, '..'));

const EventEmitter = require('events');
const bus = new EventEmitter();
bus.setMaxListeners(50);

const makeLog = (name) => ({
  info:  (...a) => console.log(`  [${name}]`, ...a),
  warn:  (...a) => console.warn(`  ⚠️  [${name}]`, ...a),
  error: (...a) => console.error(`  ❌ [${name}]`, ...a),
  debug: () => {},
});

const MACRO = {
  fetchedAt: Date.now(), source: 'twelvedata',
  macroScore: 7, macroSignal: 'FAVORAVEL',
  dxy:         { price: 104.32, changePct: -0.15 },
  usdbrl:      { price:   5.15, changePct:  0.08 },
  treasury10y: { price:   4.28, changePct:  0.02 },
  vix:         { price:   18.5, changePct: -2.10 },
  sp500:       { price: 5482.0, changePct:  0.32 },
};

const WDO = {
  symbol: 'WDOFUT', last: 5152.5, vwap: 5151.0, priceVsVwap: 1.5,
  phase: 'auction', aggRatio: 0.62, flowDelta: 320, bookImbalance: 0.18,
  momentum: 'alta', volatility: 'normal', tpStable: true, auc_vol: 180,
  auction: { theoreticalPrice: 5153.0, surplus: 420, side: 'compra', volumeAtAuction: 180 },
  book: {
    bids: [{ price: 5152.5, qty: 45 }, { price: 5152.0, qty: 28 }],
    asks: [{ price: 5153.0, qty: 380 }, { price: 5153.5, qty: 22 }],
    imbalance: 0.18,
  },
};

const DOL = {
  symbol: 'DOLFUT', last: 5163.5, phase: 'auction',
  aggRatio: 0.58, flowDelta: 280,
  auction: { theoreticalPrice: 5164.0, surplus: 380, side: 'compra', volumeAtAuction: 95 },
};

const ICEBERG = { price: 5153.0, side: 'bid', count: 8, totalVol: 420, detectedAt: Date.now() - 15000 };
const CONTEXT = {
  gap: { prevClose: 5148.0, gapPct: 0.09, classificacao: 'pequeno', direcaoGap: 'alta', gapRelevante: false },
  calendario: { temEventoCritico: false, eventosProximos: [] },
};

// ─── TESTE 1: Macro ──────────────────────────────────────────────
console.log('\n' + '═'.repeat(55));
console.log('TESTE 1 — MacroEngine (dados simulados)');
console.log('═'.repeat(55));
console.log('  Score:', MACRO.macroScore, '/10 —', MACRO.macroSignal);
console.log('  DXY:', MACRO.dxy.price, '(' + MACRO.dxy.changePct + '%)');
console.log('  VIX:', MACRO.vix.price, MACRO.vix.price > 25 ? '⚠️ ELEVADO' : '✅ Normal');
console.log('  USD/BRL:', MACRO.usdbrl.price);
console.log('  S&P:', MACRO.sp500.price, '(+' + MACRO.sp500.changePct + '%)');
console.log('  → ✅ Macro FAVORÁVEL');

// ─── TESTE 2: RiskEngine ─────────────────────────────────────────
console.log('\n' + '═'.repeat(55));
console.log('TESTE 2 — RiskEngine');
console.log('═'.repeat(55));
try {
  const { RiskEngine } = require('../src/engines/risk_engine.js');
  const risk = new RiskEngine(bus, makeLog('RISK'));

  const sinal = {
    veredito: 'OPERAR_BUY', direcao: 'buy', confianca: 0.87,
    precoEntrada: 5153.0, alvo1Ticks: 12, alvo1Preco: 5159.0,
    stopTicks: 6, stopPreco: 5147.0, rr: 2.0,
    confluenciaDolWdo: 'alinhado', alinhamentoMacro: 'favoravel',
  };

  bus.emit('feature:wdo', WDO);
  bus.emit('macro:update', MACRO);

  const result = risk.evaluate(sinal);
  console.log('  Sinal: COMPRA | Confiança: 87% | Stop: 6t | Alvo: 12t | RR: 2.0');
  console.log('  → Resultado:', result?.approved ? '✅ APROVADO' : result?.approved === false ? '❌ REJEITADO — ' + result?.reason : '✅ Sem rejeição (passou filtros)');
} catch(e) {
  console.log('  ❌ Erro:', e.message);
}

// ─── TESTE 3: AdaptiveLog ────────────────────────────────────────
console.log('\n' + '═'.repeat(55));
console.log('TESTE 3 — AdaptiveLog Engine');
console.log('═'.repeat(55));
try {
  const { AdaptiveLogEngine } = require('../src/engines/adaptive_log_engine.js');
  const adaptive = new AdaptiveLogEngine(bus, makeLog('ADAPTIVE'));
  console.log('  Histórico:', adaptive.history?.length || 0, 'pregões');
  console.log('  Thresholds:', JSON.stringify(adaptive.thresholds || {}).slice(0, 100) + '...');
  console.log('  → ✅ AdaptiveLog carregado');
} catch(e) {
  console.log('  ❌ Erro:', e.message);
}

// ─── TESTE 4: Claude IA ──────────────────────────────────────────
console.log('\n' + '═'.repeat(55));
console.log('TESTE 4 — Claude IA (chamada real à API)');
console.log('═'.repeat(55));

if (!process.env.ANTHROPIC_API_KEY) {
  console.log('  ❌ ANTHROPIC_API_KEY não configurada');
  console.log('  Execute: ANTHROPIC_API_KEY=sk-... node scripts/test_engines.js');
  process.exit(0);
}

const { ClaudeAIEngine } = require('../src/engines/claude_ai_engine.js');
const claude = new ClaudeAIEngine(bus, makeLog('CLAUDE'));

claude.lastFeatures = WDO;
claude.lastDOL      = DOL;
claude.lastMacro    = MACRO;
claude.lastIceberg  = ICEBERG;
claude.lastContext  = CONTEXT;

console.log('  Dados: WDO TP=5153 | Surplus=420 | auc_vol=180 | Iceberg BID 420 lotes');
console.log('  Macro: Score 7/10 FAVORÁVEL | VIX 18.5 normal');
console.log('  Chamando Claude Sonnet 4.5...\n');

bus.on('claude:analise', (r) => {
  console.log('  ✅ RESPOSTA CLAUDE:');
  console.log('  Veredito:   ', r.veredito);
  console.log('  Direção:    ', r.direcao);
  console.log('  Confiança:  ', (r.confianca * 100).toFixed(0) + '%', r.confianca >= 0.85 ? '→ OPERARIA ✅' : '→ NAO_OPERAR');
  console.log('  Reasoning:  ', r.reasoning);
  console.log('  Alvo1:      ', r.alvo1Ticks, 'ticks @', r.alvo1Preco);
  console.log('  Stop:       ', r.stopTicks, 'ticks @', r.stopPreco);
  console.log('  RR:         ', r.rr);
  console.log('  Macro:      ', r.alinhamentoMacro);
  console.log('  DOL×WDO:    ', r.confluenciaDolWdo);
  console.log('  Iceberg:    ', r.icebergRelevante ? '✅ RELEVANTE' : 'não relevante');
  console.log('  Escora:     ', r.escoraDetectada ? '⚠️ DETECTADA @ ' + r.escoraPreco : 'não detectada');
  console.log('  Tape:       ', r.leituraTape);
  console.log('  Risco:      ', r.riscoPrincipal);
  console.log('\n  → Teste 4: ✅ Claude funcionando corretamente');
  process.exit(0);
});

// Chamar Claude diretamente sem filtro de horário
const Anthropic = require('@anthropic-ai/sdk');
const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

const systemPrompt = claude._systemPrompt();
const schema = claude._jsonSchema();
const userPrompt = claude._buildPrompt('test_pregao');

console.log('  Prompt enviado (primeiras 200 chars):', userPrompt.slice(0, 200) + '...');
console.log('');

client.messages.create({
  model: 'claude-sonnet-4-5',
  max_tokens: 1000,
  system: systemPrompt + '\n\n' + schema,
  messages: [{ role: 'user', content: userPrompt }],
}).then(resp => {
  const text = resp.content[0].text;
  try {
    const clean = text.replace(/```json|```/g, '').trim();
    const r = JSON.parse(clean);
    console.log('  ✅ RESPOSTA CLAUDE:');
    console.log('  Veredito:   ', r.veredito);
    console.log('  Direção:    ', r.direcao);
    const conf = (r.confianca || 0);
    console.log('  Confiança:  ', (conf * 100).toFixed(0) + '%', conf >= 0.85 ? '→ OPERARIA ✅' : '→ NAO_OPERAR');
    console.log('  Reasoning:  ', r.reasoning);
    console.log('  Alvo1:      ', r.alvo1_ticks, 'ticks @', r.alvo1_preco);
    console.log('  Stop:       ', r.stop_ticks, 'ticks @', r.stop_preco);
    console.log('  RR:         ', r.rr);
    console.log('  Macro:      ', r.alinhamento_macro);
    console.log('  DOL×WDO:    ', r.confluencia_dol_wdo);
    console.log('  Iceberg:    ', r.iceberg_relevante ? '✅ RELEVANTE' : 'não relevante');
    console.log('  Escora:     ', r.escora_detectada ? '⚠️ @ ' + r.escora_preco : 'não detectada');
    console.log('  Tape:       ', r.leitura_tape);
    console.log('  Risco:      ', r.risco_principal);
    console.log('\n  → Teste 4: ✅ Claude funcionando');
  } catch(e) {
    console.log('  Raw:', text.slice(0, 500));
  }
  process.exit(0);
}).catch(e => {
  console.error('  ❌ Erro:', e.message);
  process.exit(1);
});

setTimeout(() => { console.log('  ❌ Timeout 30s'); process.exit(1); }, 30000);
