const express = require('express');
const puppeteer = require('puppeteer');

const app = express();
app.use(express.json());

const PORT    = process.env.PORT    || 3001;
const EMAIL   = process.env.IFOOD_EMAIL;
const SENHA   = process.env.IFOOD_SENHA;

const URL_LOGIN      = 'https://portal.ifood.com.br/login';
const URL_DESEMPENHO = 'https://portal.ifood.com.br/performance';

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

async function criarBrowser() {
  return puppeteer.launch({
    headless: 'new',
    args: ['--no-sandbox','--disable-setuid-sandbox','--disable-dev-shm-usage','--disable-gpu','--window-size=1366,768'],
  });
}

async function criarPagina(browser) {
  const page = await browser.newPage();
  await page.setViewport({ width: 1366, height: 768 });
  await page.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36');
  await page.setRequestInterception(true);
  page.on('request', req => {
    if (['image','font','media'].includes(req.resourceType())) req.abort();
    else req.continue();
  });
  return page;
}

// Digita num input usando eventos nativos do React
async function digitarInput(page, valor) {
  await page.evaluate((val) => {
    const inputs = [...document.querySelectorAll('input')].filter(i => {
      const s = window.getComputedStyle(i);
      return s.display !== 'none' && s.visibility !== 'hidden' && i.offsetParent !== null && i.type !== 'hidden';
    });
    const input = inputs[0];
    if (!input) return;
    const nativeInputValueSetter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
    nativeInputValueSetter.call(input, val);
    input.dispatchEvent(new Event('input',  { bubbles: true }));
    input.dispatchEvent(new Event('change', { bubbles: true }));
    input.focus();
  }, valor);
}

// Clica no botão principal da tela (submit ou próximo)
async function clicarBotaoPrincipal(page) {
  await page.evaluate(() => {
    const btn =
      document.querySelector('button[type="submit"]') ||
      [...document.querySelectorAll('button')].find(b =>
        /continuar|entrar|próximo|next|login|acessar|confirmar/i.test(b.innerText)
      );
    if (btn) btn.click();
  });
}

// Aguarda qualquer input visível aparecer
async function aguardarInput(page, timeout = 25000) {
  await page.waitForFunction(() => {
    return [...document.querySelectorAll('input')].some(i => {
      const s = window.getComputedStyle(i);
      return s.display !== 'none' && s.visibility !== 'hidden' && i.offsetParent !== null && i.type !== 'hidden';
    });
  }, { timeout });
}

async function fazerLogin(page) {
  log('Acessando login...');
  await page.goto(URL_LOGIN, { waitUntil: 'networkidle2', timeout: 60000 });
  await sleep(2500);

  // Aceitar cookies (busca por texto)
  try {
    await page.evaluate(() => {
      const btn = [...document.querySelectorAll('button,a')].find(b =>
        /aceitar|accept|ok|concordo|allow/i.test(b.innerText)
      );
      if (btn) btn.click();
    });
    await sleep(600);
  } catch (_) {}

  // ── Etapa 1: e-mail ──────────────────────────────────────────────────────
  log('Aguardando input visível para e-mail...');
  await aguardarInput(page, 25000);
  await sleep(500);

  log('Digitando e-mail...');
  await digitarInput(page, EMAIL);
  await sleep(600);

  // Também tenta via keyboard como fallback
  await page.evaluate(() => {
    const input = [...document.querySelectorAll('input')].find(i => {
      const s = window.getComputedStyle(i);
      return s.display !== 'none' && i.offsetParent !== null && i.type !== 'hidden';
    });
    if (input) input.focus();
  });
  await sleep(200);

  await clicarBotaoPrincipal(page);
  log('Botão de continuar clicado. Aguardando próxima etapa...');
  await sleep(2500);

  // ── Etapa 2: senha ───────────────────────────────────────────────────────
  log('Aguardando campo de senha...');
  await page.waitForFunction(() => {
    return [...document.querySelectorAll('input[type="password"]')].some(i => {
      const s = window.getComputedStyle(i);
      return s.display !== 'none' && i.offsetParent !== null;
    });
  }, { timeout: 25000 });

  log('Digitando senha...');
  await page.evaluate((senha) => {
    const input = document.querySelector('input[type="password"]');
    if (!input) return;
    const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
    setter.call(input, senha);
    input.dispatchEvent(new Event('input',  { bubbles: true }));
    input.dispatchEvent(new Event('change', { bubbles: true }));
    input.focus();
  }, SENHA);
  await sleep(600);

  await clicarBotaoPrincipal(page);
  log('Aguardando redirecionamento pós-login...');

  await page.waitForFunction(
    () => !window.location.href.includes('/login'),
    { timeout: 35000 }
  );
  log(`Login OK — ${page.url()}`);
}

async function coletarDesempenho(page, date) {
  const urlComData = `${URL_DESEMPENHO}?startDate=${date}&endDate=${date}`;
  log(`Navegando para: ${urlComData}`);
  await page.goto(urlComData, { waitUntil: 'networkidle2', timeout: 60000 });
  await sleep(4000);

  const metricas = await page.evaluate(() => {
    function pegar(seletores) {
      for (const sel of seletores) {
        const el = document.querySelector(sel);
        if (el && el.innerText.trim()) return el.innerText.trim();
      }
      return '';
    }
    const cards = Array.from(document.querySelectorAll(
      '[class*="card"],[class*="Card"],[class*="metric"],[class*="Metric"],[class*="kpi"],[class*="summary"],[class*="Summary"]'
    )).map(el => el.innerText?.trim()).filter(t => t && t.length < 300).slice(0, 40);

    return {
      pedidosTotal:   pegar(['[data-testid="orders-count"]','[data-testid="total-orders"]','[class*="ordersCount"]','[class*="orders-count"]','[class*="totalOrders"]']),
      faturamento:    pegar(['[data-testid="revenue"]','[data-testid="gross-revenue"]','[data-testid="total-revenue"]','[class*="grossRevenue"]','[class*="totalRevenue"]','[class*="revenue"]']),
      ticketMedio:    pegar(['[data-testid="average-ticket"]','[data-testid="ticket-medium"]','[class*="averageTicket"]','[class*="average-ticket"]']),
      cancelamentos:  pegar(['[data-testid="canceled"]','[data-testid="cancellations"]','[class*="canceled"]','[class*="cancellations"]']),
      avaliacaoMedia: pegar(['[data-testid="rating"]','[data-testid="average-rating"]','[class*="averageRating"]','[class*="rating"]']),
      _cards: cards,
    };
  });

  log(`Métricas: ${JSON.stringify(metricas)}`);
  return metricas;
}

// ── Endpoint /scrape ──────────────────────────────────────────────────────────
app.post('/scrape', async (req, res) => {
  const { date } = req.body;
  if (!date)           return res.status(400).json({ error: '"date" é obrigatório (yyyy-MM-dd)' });
  if (!EMAIL || !SENHA) return res.status(500).json({ error: 'IFOOD_EMAIL e IFOOD_SENHA não configurados' });

  log(`Iniciando scrape — ${date}`);
  let browser;
  try {
    browser = await criarBrowser();
    const page = await criarPagina(browser);

    await fazerLogin(page);
    const metricas = await coletarDesempenho(page, date);

    const pedidos     = parseInteiro(metricas.pedidosTotal);
    const faturamento = parseMoeda(metricas.faturamento);
    const cancelam    = parseInteiro(metricas.cancelamentos);
    let ticket        = parseMoeda(metricas.ticketMedio);
    const avaliacao   = parseDecimal(metricas.avaliacaoMedia);
    if (ticket === 0 && pedidos > 0) ticket = parseFloat((faturamento / pedidos).toFixed(2));

    const resultado = {
      data_referencia: date,
      pedidos_total: pedidos,
      faturamento,
      ticket_medio: ticket,
      cancelamentos: cancelam,
      avaliacao_media: avaliacao,
      coletado_em: new Date().toISOString(),
      _debug_cards: metricas._cards,
    };

    await browser.close();
    log(`Concluído: ${JSON.stringify(resultado)}`);
    return res.json(resultado);

  } catch (err) {
    log(`ERRO: ${err.message}`);
    if (browser) await browser.close().catch(() => {});
    return res.status(500).json({ error: err.message, date, coletado_em: new Date().toISOString() });
  }
});

// ── Health check ──────────────────────────────────────────────────────────────
app.get('/health', (_, res) => res.json({ status: 'ok', timestamp: new Date().toISOString() }));

app.listen(PORT, () => {
  log(`Scraper iFood rodando na porta ${PORT}`);
  if (!EMAIL) log('⚠️  IFOOD_EMAIL não definido');
  if (!SENHA) log('⚠️  IFOOD_SENHA não definido');
});
