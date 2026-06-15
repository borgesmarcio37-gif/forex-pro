# Forex Master Pro v7

## O que há de novo na v7
- Clica num par → relatório completo gerado por IA em tempo real
- Pip Probability Ladder de 50 a 500 pips com dados reais (ATR, RSI, MACD)
- Análise de volume, posicionamento institucional inferido, recomendação de entrada/saída
- Layout sidebar + relatório — fluxo natural de trabalho
- Auto-refresh de dados a cada 3 minutos

## Instalação
1. Copia `.env.example` → `.env`
2. Coloca a tua `TWELVE_DATA_API_KEY` no `.env`
3. Duplo clique em `START.bat`
4. Abre http://localhost:3000

## Nota sobre a API Claude (relatórios IA)
O relatório IA usa a API da Anthropic directamente do browser.
Se vires erros de autenticação nos relatórios, é necessário
configurar um proxy no servidor para passar a API key de forma segura.
Nesse caso, avisamos e configuramos juntos.
