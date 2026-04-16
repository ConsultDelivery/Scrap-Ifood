const express = require('express');
const puppeteer = require('puppeteer');

const app = express();
app.use(express.json());

const PORT = process.env.PORT || 3001;
const IFOOD_EMAIL = process.env.IFOOD_EMAIL;
const IFOOD_SENHA = process.env.IFOOD_SENHA;

// ─── URLs do portal ────────────────────────────────────────────────────────────
const URL_LOGIN      = 'https://portal.ifood.com.br/login';
const URL_DESEMPENHO = 'https://portal.ifood.com.br/performance';

// ─── Utilitários ───────────────────────────────────────────────────────────────
function log(msg) { console.log(`[${new Date().toISOString()}] ${msg}`); }
function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

function parseMoeda(str) {
  if (!str) return 0;
  return parseFloat(str.replace(/[R$\s]/g, '').replace(/\./g, '').replace(',', '.')) || 0;
}
function parseInteiro(str) {
  if (!str) return 0;
  return parseInt(str.replace(/\D/g, ''), 10) || 0;
}
function parseDecimal(str) {
  if (!str) return 0;
  return parseFloat(str.replace(',', '.')) || 0;
}

// ─── Browser ──────────────────────────────────────────────────────────────────
async function criarBrowser() {
  return puppeteer.launch({
    headless: 'new',
    args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage', '--disable-gpu', '--window-size=1366,768'],
  });
}

async function criarPagina(browser) {
  const page = await browser.newPage();
  await page.setViewport({ width: 1366, height: 768 });
  await page.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36');
  await page.setRequestInterception(true);
  page.on('request', req => {
    if (['image', 'font', 'media'].includes(req.resourceType())) req.abort();
    else req.continue();
  });
  return page;
}

// ─── Login ────────────────────────────────────────────────────────────────────
async function fazerLogin(page) {
  log('Acessando portal.ifood.com.br/login...');
  await page.goto(URL_LOGIN, { waitUntil: 'networkidle2', timeout: 60000 });
  await sleep(2000);

  // Aceitar cookies
  try {
    const btnCookie = await page.$('#onetrust-accept-btn-handler, [data-testid="cookie-accept-button"]');
    if (btnCookie) { await btnCookie.click(); await sleep(500); log('Cookies aceitos.'); }
  } catch (_) {}

  // E-mail
  log('Preenchendo e-mail...');
  await page.waitForSelector('input[type="email"], input[name="email"], input[id*="email"]', { timeout: 20000 });
  const campoEmail = await page.$('input[type="email"], input[name="email"], input[id*="email"]');
  await campoEmail.click({ clickCount: 3 });
  await campoEmail.type(IFOOD_EMAIL, { delay: 60 });
  await sleep(400);

  // Clica em Continuar (pode ser fluxo de 2 etapas)
  await page.click('button[type="submit"]');
  await sleep(1500);

  // Senha
  log('Preenchendo senha...');
  await page.waitForSelector('input[type="password"]', { timeout: 20000 });
  const campoSenha = await page.$('input[type="password"]');
  await campoSenha.click({ clickCount: 3 });
  await campoSenha.type(IFOOD_SENHA, { delay: 60 });
  await sleep(400);

  await page.click('button[type="submit"]');
  log('Aguardando pós-login...');

  await page.waitForFunction(() => !window.location.href.includes('/login'), { timeout: 30000 });
  log(`Login OK — ${page.url()}`);
}

// ─── Coleta de dados ──────────────────────────────────────────────────────────
async function coletarDesempenho(page, date) {
  // Tenta carregar com filtro de data na URL
  const urlComData = `${URL_DESEMPENHO}?startDate=${date}&endDate=${date}`;
  log(`Navegando para: ${urlComData}`);
  await page.goto(urlComData, { waitUntil: 'networkidle2', timeout: 60000 });
  await sleep(4000);

  // Tenta aplicar datepicker se disponível
  try {
    const [ano, mes, dia] = date.split('-');
    const dataFormatadaBR = `${dia}/${mes}/${ano}`;
    const inputs = await page.$$('[class*="datepicker"] input, [class*="DatePicker"] input, [class*="date-picker"] input');
    for (const input of inputs.slice(0, 2)) {
      await input.click({ clickCount: 3 });
      await input.type(dataFormatadaBR, { delay: 50 });
      await sleep(300);
    }
    if (inputs.length > 0) {
      await page.keyboard.press('Enter');
      await sleep(2500);
    }
  } catch (e) { log(`Aviso datepicker: ${e.message}`); }

  await sleep(2000);

  // Extração de métricas
  const metricas = await page.evaluate(() => {
    function pegar(seletores) {
      for (const sel of seletores) {
        const el = document.querySelector(sel);
        if (el && el.innerText.trim()) return el.innerText.trim();
      }
      return '';
    }

    // Captura todos os cards para debug
    const cards = Array.from(document.querySelectorAll(
      '[class*="card"], [class*="Card"], [class*="metric"], [class*="Metric"], [class*="kpi"], [class*="summary"]'
    )).map(el => el.innerText?.trim()).filter(t => t && t.length < 200).slice(0, 30);

    return {
      pedidosTotal: pegar(['[data-testid="orders-count"]','[data-testid="total-orders"]','[class*="ordersCount"]','[class*="orders-count"]','[class*="totalOrders"]']),
      faturamento:  pegar(['[data-testid="revenue"]','[data-testid="gross-revenue"]','[data-testid="total-revenue"]','[class*="grossRevenue"]','[class*="totalRevenue"]','[class*="revenue"]']),
      ticketMedio:  pegar(['[data-testid="average-ticket"]','[data-testid="ticket-medium"]','[class*="averageTicket"]','[class*="average-ticket"]']),
      cancelamentos:pegar(['[data-testid="canceled"]','[data-testid="cancellations"]','[class*="canceled"]','[class*="cancellations"]']),
      avaliacaoMedia:pegar(['[data-testid="rating"]','[data-testid="average-rating"]','[class*="averageRating"]','[class*="rating"]']),
      _cards: cards,
    };
  });

  log(`Métricas brutas extraídas: ${JSON.stringify(metricas)}`);
  return metricas;
}

// ─── Endpoint /scrape ─────────────────────────────────────────────────────────
app.post('/scrape', async (req, res) => {
  const { date } = req.body;
  if (!date) return res.status(400).json({ error: 'Campo "date" é obrigatório (formato: yyyy-MM-dd)' });
  if (!IFOOD_EMAIL || !IFOOD_SENHA) return res.status(500).json({ error: 'IFOOD_EMAIL e IFOOD_SENHA não configurados' });

  log(`Iniciando scrape — ${date}`);
  let browser;
  try {
    browser = await criarBrowser();
    const page = await criarPagina(browser);

    await fazerLogin(page);
    const metricas = await coletarDesempenho(page, date);

    const pedidos      = parseInteiro(metricas.pedidosTotal);
    const faturamento  = parseMoeda(metricas.faturamento);
    const cancelamentos= parseInteiro(metricas.cancelamentos);
    let ticketMedio    = parseMoeda(metricas.ticketMedio);
    const avaliacao    = parseDecimal(metricas.avaliacaoMedia);
    if (ticketMedio === 0 && pedidos > 0) ticketMedio = parseFloat((faturamento / pedidos).toFixed(2));

    const resultado = { date_referencia: date, pedidos_total: pedidos, faturamento, ticket_medio: ticketMedio, cancelamentos, avaliacao_media: avaliacao, coletado_em: new Date().toISOString(), _debug_cards: metricas._cards };

    await browser.close();
    log(`Concluído: ${JSON.stringify(resultado)}`);
    return res.json(resultado);

  } catch (err) {
    log(`ERRO: ${err.message}`);
    if (browser) await browser.close().catch(() => {});
    return res.status(500).json({ error: err.message, date, coletado_em: new Date().toISOString() });
  }
});

// ─── Health check ─────────────────────────────────────────────────────────────
app.get('/health', (_, res) => res.json({ status: 'ok', timestamp: new Date().toISOString() }));

app.listen(PORT, () => {
  log(`Scraper iFood rodando na porta ${PORT}`);
  if (!IFOOD_EMAIL) log('⚠️  IFOOD_EMAIL não definido');
  if (!IFOOD_SENHA) log('⚠️  IFOOD_SENHA não definido');
});
