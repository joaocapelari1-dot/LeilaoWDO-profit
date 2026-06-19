# LeilaoWDO — Profit DLL Edition

Sistema de análise do leilão de abertura WDO com **ProfitDLL da Nelogica** como fonte de dados.

## Arquitetura

```
VPS Windows:
├── Win64/ProfitDLL.dll         ← fornecida pela Nelogica
└── profit_bridge/
    └── profit_bridge.py        ← Python 64-bit → WebSocket ws://0.0.0.0:8787

Railway (Linux):
└── src/
    ├── adapters/profit_client.js  ← consome WebSocket do ProfitBridge
    └── ... sistema inteiro igual
```

## Como rodar

### 1. VPS Windows — ProfitBridge

```bash
cd profit_bridge
pip install -r requirements.txt
```

Configurar `.env` na pasta `profit_bridge/`:
```
PROFIT_ACTIVATION_KEY=sua_chave_nelogica
PROFIT_USERNAME=seu_usuario
PROFIT_PASSWORD=sua_senha
PROFIT_WS_PORT=8787
PROFIT_DLL_PATH=.\Win64\ProfitDLL.dll
SYMBOLS=WDOFUT,DOLFUT,WINFUT,INDFUT
```

Colocar `ProfitDLL.dll` em `profit_bridge/Win64/ProfitDLL.dll`

Rodar:
```bash
python profit_bridge.py
```

### 2. Railway — Node.js

Variáveis de ambiente no Railway:
```
MARKET_PROVIDER=PROFIT
PROFIT_BRIDGE_URL=ws://SEU_VPS_IP:8787
ANTHROPIC_API_KEY=...
TELEGRAM_BOT_TOKEN=...
TELEGRAM_CHAT_ID=...
TWELVE_DATA_API_KEY=...
```

### 3. Alternar entre Cedro e Profit

```
MARKET_PROVIDER=CEDRO   → usa Cedro Crystal (fallback)
MARKET_PROVIDER=PROFIT  → usa ProfitDLL via ProfitBridge
```

## Vantagens sobre a Cedro

| Dado | Cedro | Profit DLL |
|------|-------|------------|
| Book L2 durante leilão | ❌ bagunçado | ✅ limpo |
| Tape reading leilão | ✅ | ✅ |
| Theor Price | ⚠️ | ✅ |
| Surplus | ⚠️ | ✅ |
| Custo mensal | R$854 | R$0 (isento 290 mini/mês) |

## Custo estimado

```
Profit Ultra (Elliot): R$0 (isento operando 290 mini/mês)
VPS Windows:           ~R$100/mês
Railway:               R$55/mês
Anthropic:             R$38/mês
TOTAL:                 ~R$193/mês

Economia vs Cedro:     ~R$754/mês
```
