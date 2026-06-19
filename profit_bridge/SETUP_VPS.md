# Guia de Configuração VPS Windows — ProfitBridge

## 1. Contratar VPS Windows

**Opções recomendadas (custo ~R$80-150/mês):**

| Provider | Plano | Preço | Link |
|----------|-------|-------|------|
| Vultr | Cloud Compute 2vCPU 4GB Win2022 | ~US$28/mês | vultr.com |
| Azure | B2s Windows Server 2022 | ~US$30/mês | azure.com |
| AWS | t3.small Windows Server 2022 | ~US$25/mês | aws.amazon.com |

**Requisitos mínimos:**
- Windows Server 2019 ou 2022 (64-bit)
- 2 vCPU, 4GB RAM
- 50GB disco
- IP público fixo

---

## 2. Acessar a VPS (Remote Desktop)

No seu Mac:
1. Baixar **Microsoft Remote Desktop** na App Store (gratuito)
2. Adicionar a VPS com o IP público + usuário + senha fornecidos pelo provider
3. Conectar

---

## 3. Instalar Python 64-bit

1. Abrir **PowerShell como Administrador** na VPS
2. Baixar e instalar Python 3.11 64-bit:

```powershell
# Baixar Python 3.11.9 64-bit
Invoke-WebRequest -Uri "https://www.python.org/ftp/python/3.11.9/python-3.11.9-amd64.exe" -OutFile "python-installer.exe"

# Instalar silencioso com pip e PATH
.\python-installer.exe /quiet InstallAllUsers=1 PrependPath=1

# Verificar instalação
python --version   # deve mostrar Python 3.11.9
pip --version
```

---

## 4. Instalar Profit Ultra

1. Baixar o instalador do Profit Ultra no site da Nelogica/Elliot
2. Instalar normalmente
3. Abrir e fazer login com suas credenciais Elliot
4. **Deixar o Profit aberto e conectado** (obrigatório para a DLL funcionar)

---

## 5. Obter a ProfitDLL

Após contratar via Elliot, a Nelogica envia:
- `ProfitDLL.dll` (Win64)
- `PROFIT_ACTIVATION_KEY` (chave de ativação)

Salvar o arquivo em:
```
C:\LeilaoWDO\profit_bridge\Win64\ProfitDLL.dll
```

---

## 6. Clonar o repositório

```powershell
# Instalar Git
Invoke-WebRequest -Uri "https://github.com/git-for-windows/git/releases/download/v2.45.2.windows.1/Git-2.45.2-64-bit.exe" -OutFile "git-installer.exe"
.\git-installer.exe /SILENT

# Clonar
git clone https://github.com/joaocapelari1-dot/LeilaoWDO-profit.git C:\LeilaoWDO
cd C:\LeilaoWDO\profit_bridge
```

---

## 7. Instalar dependências Python

```powershell
cd C:\LeilaoWDO\profit_bridge
pip install -r requirements.txt
```

---

## 8. Configurar variáveis de ambiente

Criar arquivo `C:\LeilaoWDO\profit_bridge\.env`:

```env
PROFIT_ACTIVATION_KEY=sua_chave_aqui
PROFIT_USERNAME=seu_usuario_nelogica
PROFIT_PASSWORD=sua_senha_nelogica
PROFIT_WS_PORT=8787
PROFIT_DLL_PATH=.\Win64\ProfitDLL.dll
SYMBOLS=WDOFUT,DOLFUT,WINFUT,INDFUT
```

---

## 9. Abrir porta 8787 no firewall

```powershell
# Abrir porta 8787 no Windows Firewall
New-NetFirewallRule -DisplayName "ProfitBridge WebSocket" -Direction Inbound -Protocol TCP -LocalPort 8787 -Action Allow
```

No painel do provider (Vultr/Azure/AWS), também abrir a porta 8787 no Security Group/Firewall externo.

---

## 10. Testar manualmente

```powershell
cd C:\LeilaoWDO\profit_bridge
python profit_bridge.py
```

Deve aparecer:
```
08:55:00 [INFO] Carregando DLL: C:\LeilaoWDO\profit_bridge\Win64\ProfitDLL.dll
08:55:01 [INFO] ✅ Login conectado
08:55:02 [INFO] ✅ Market Data conectado
08:55:02 [INFO] ✅ Ativação válida
08:55:02 [INFO] 🟢 DLL pronta — assinando: WDOFUT, DOLFUT, WINFUT, INDFUT
08:55:02 [INFO] WebSocket ouvindo em ws://0.0.0.0:8787
```

---

## 11. Rodar como serviço Windows (24h automático)

Para rodar o ProfitBridge automaticamente ao iniciar a VPS:

```powershell
# Instalar NSSM (Non-Sucking Service Manager)
Invoke-WebRequest -Uri "https://nssm.cc/release/nssm-2.24.zip" -OutFile "nssm.zip"
Expand-Archive nssm.zip -DestinationPath C:\nssm
$env:PATH += ";C:\nssm\nssm-2.24\win64"

# Criar serviço Windows
nssm install ProfitBridge python C:\LeilaoWDO\profit_bridge\profit_bridge.py
nssm set ProfitBridge AppDirectory C:\LeilaoWDO\profit_bridge
nssm set ProfitBridge AppStdout C:\LeilaoWDO\profit_bridge\logs\output.log
nssm set ProfitBridge AppStderr C:\LeilaoWDO\profit_bridge\logs\error.log
nssm set ProfitBridge Start SERVICE_AUTO_START

# Iniciar serviço
nssm start ProfitBridge
```

Verificar status:
```powershell
nssm status ProfitBridge  # deve mostrar: SERVICE_RUNNING
```

---

## 12. Configurar Railway

No Railway (LeilaoWDO-profit), adicionar variáveis:

```
MARKET_PROVIDER=PROFIT
PROFIT_BRIDGE_URL=ws://SEU_IP_VPS:8787
ANTHROPIC_API_KEY=...
TELEGRAM_BOT_TOKEN=...
TELEGRAM_CHAT_ID=...
TWELVE_DATA_API_KEY=...
NODE_ENV=production
MOCK_MODE=false
```

---

## 13. Verificar conexão Railway → VPS

Nos logs do Railway deve aparecer:
```
📡 Market Data: PROFIT DLL via ProfitBridge
✅ Conectado ao ProfitBridge
ProfitBridge conectado — símbolos: WDOFUT, DOLFUT, WINFUT, INDFUT
```

---

## Checklist Final

- [ ] VPS Windows contratada e acessível via RDP
- [ ] Python 3.11 64-bit instalado
- [ ] Profit Ultra instalado e logado
- [ ] ProfitDLL.dll em `Win64/ProfitDLL.dll`
- [ ] `.env` configurado com chave de ativação
- [ ] Porta 8787 aberta (firewall Windows + provider)
- [ ] `python profit_bridge.py` rodando sem erros
- [ ] Serviço Windows criado com NSSM (auto-start)
- [ ] Railway com `MARKET_PROVIDER=PROFIT` e `PROFIT_BRIDGE_URL`
- [ ] Log Railway mostra "Conectado ao ProfitBridge"
- [ ] SuperDOM populado durante o leilão ✅

---

## Troubleshooting

**DLL não encontrada:**
```
Verificar caminho em PROFIT_DLL_PATH=.\Win64\ProfitDLL.dll
```

**Timeout na conexão (30s):**
```
- Verificar PROFIT_ACTIVATION_KEY, PROFIT_USERNAME, PROFIT_PASSWORD
- Verificar se Profit Ultra está aberto e conectado
- Verificar conexão com internet na VPS
```

**Railway não conecta na VPS:**
```
- Verificar IP da VPS em PROFIT_BRIDGE_URL
- Verificar porta 8787 aberta no firewall Windows e no provider
- Testar: curl ws://SEU_IP:8787 (deve conectar)
```

**Suporte:**
- Nelogica: corporativo@nelogica.com.br
- Elliot: atendimento@elliot.com.br
