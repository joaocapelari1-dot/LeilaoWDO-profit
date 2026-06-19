# LeilaoWDO — Migração ProfitDLL
## Resumo para nova janela de chat

---

## Contexto

Sistema LeilaoWDO atualmente usa **Cedro Crystal** como fonte de dados (R$854/mês).
Problema: Cedro não entrega Book L2 limpo durante o leilão de abertura (8h55→9h00).
Solução: migrar para **ProfitDLL da Nelogica** via Elliot Brasil.

---

## Economia

```
ATUAL (Cedro):
Cedro:        R$854/mês
Railway:       R$55/mês
Anthropic:     R$38/mês
TOTAL:        R$947/mês

COM PROFIT DLL:
Profit Ultra:  R$0 (isento operando 290 mini/mês)
VPS Windows:  ~R$100/mês
Railway:       R$55/mês
Anthropic:     R$38/mês
TOTAL:        ~R$193/mês

ECONOMIA:     ~R$754/mês
```

---

## O que já está pronto

- **Repositório:** `github.com/joaocapelari1-dot/LeilaoWDO-profit` (privado)
- **`profit_bridge/profit_bridge.py`** — Python/Windows, conecta ProfitDLL → WebSocket ws://0.0.0.0:8787
- **`src/adapters/profit_client.js`** — Node.js/Railway, consome WebSocket → emite eventos compatíveis
- **`src/index.js`** — alternância `MARKET_PROVIDER=PROFIT` ou `MARKET_PROVIDER=CEDRO`
- **`profit_bridge/SETUP_VPS.md`** — guia completo de configuração
- Sistema inteiro (Claude, Risk, Execution, Dashboard) **inalterado**

---

## Arquitetura

```
VPS Windows (Vultr/Azure ~R$100/mês):
├── Profit Ultra instalado + logado (Elliot)
├── Win64/ProfitDLL.dll (fornecida pela Nelogica)
└── profit_bridge.py (Python 64-bit) → WebSocket ws://0.0.0.0:8787

Railway (Linux — igual ao atual):
└── profit_client.js → conecta VPS → emite cedro:tick:wdo, cedro:book:wdo...
    → DataNormalizer → FeatureEngine → Claude → Risk → Execution → Dashboard
```

---

## Passos pendentes

1. **Contratar Elliot Brasil** — `elliot.com.br/black`
   - Contato: `atendimento@elliot.com.br` ou WhatsApp
   - Pedir: **Profit Ultra + acesso ProfitDLL** via parceria Nelogica
   - Custo: R$310/mês ou **grátis operando 290 minicontratos/mês**

2. **Receber da Nelogica:**
   - `ProfitDLL.dll` (Win64)
   - `PROFIT_ACTIVATION_KEY` (chave de ativação)
   - `PROFIT_USERNAME` e `PROFIT_PASSWORD`

3. **Contratar VPS Windows** (Claude indica qual na hora)
   - Vultr Cloud Compute 2vCPU 4GB Win2022 (~US$28/mês)
   - Ou Azure B2s Windows Server 2022 (~US$30/mês)

4. **Configurar VPS** (Claude faz junto por Remote Desktop)
   - Instalar Python 3.11 64-bit
   - Clonar repo `LeilaoWDO-profit`
   - Colocar `ProfitDLL.dll` em `profit_bridge/Win64/`
   - Configurar `.env` com credenciais
   - Rodar `python profit_bridge.py`
   - Criar serviço Windows com NSSM (auto-start 24h)
   - Abrir porta 8787 no firewall

5. **Railway — LeilaoWDO-profit:**
   - Deploy do novo repo
   - Variáveis: `MARKET_PROVIDER=PROFIT`, `PROFIT_BRIDGE_URL=ws://IP_VPS:8787`
   - Copiar demais vars do Railway atual

6. **Validar** — SuperDOM populado durante leilão ✅

7. **Cancelar Cedro** após validação

---

## Variáveis de ambiente Railway (LeilaoWDO-profit)

```
MARKET_PROVIDER=PROFIT
PROFIT_BRIDGE_URL=ws://SEU_IP_VPS:8787
ANTHROPIC_API_KEY=...
TELEGRAM_BOT_TOKEN=...
TELEGRAM_CHAT_ID=...
TWELVE_DATA_API_KEY=022385c872a84c069ffc19886264468f
NODE_ENV=production
MOCK_MODE=false
```

---

## Variáveis VPS Windows (.env do ProfitBridge)

```
PROFIT_ACTIVATION_KEY=chave_fornecida_nelogica
PROFIT_USERNAME=seu_usuario_nelogica
PROFIT_PASSWORD=sua_senha_nelogica
PROFIT_WS_PORT=8787
PROFIT_DLL_PATH=.\Win64\ProfitDLL.dll
SYMBOLS=WDOFUT,DOLFUT,WINFUT,INDFUT
```

---

## Contatos

- Elliot: `atendimento@elliot.com.br`
- Nelogica: `corporativo@nelogica.com.br`
- Guia VPS: `profit_bridge/SETUP_VPS.md` no GitHub

---

## Prazo alvo: 01/07/2026

Coincide com vencimento do WDON26 → rolagem para WDOQ26 → migração completa.
