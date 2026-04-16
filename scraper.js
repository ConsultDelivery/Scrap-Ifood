const express = require('express');
const puppeteer = require('puppeteer');
const fs = require('fs');

const app = express();
app.use(express.json());

const PORT  = process.env.PORT        || 3001;
const EMAIL = process.env.IFOOD_EMAIL;
const SENHA = process.env.IFOOD_SENHA;

const URL_LOGIN      = 'https://portal.ifood.com.br/login';
const URL_DESEMPENHO = 'https://portal.ifood.com.br/performance';

function log(msg) { console.log(`[${new Date().toISOString()}] ${msg}`); }
function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

function parseMoeda(str) {
  if (!str) return 0;
  return parseFloat(str.replace(/[R$\s]/g,'').replace(/\./g,'').replace(',','.')) || 0;
}
function parseInteiro(str) {
  if (!str) return 0;
  return parseInt(str.replace(/\D/g,''),10) || 0;
}
function parseDecimal(str) {
  if (!str) return 0;
  return parseFloat(str.replace(',','.')) || 0;
}

async function criarBrowser() {
  return puppeteer.launch({
    headless: 'new',
    args: [
      '--no-sandbox',
      '--disable-setuid-sandbox',
      '--disable-dev-shm-usage',
      '--disable-gpu',
      '--window-size=1366,768',
      // Anti-detecção
      '--disable-blink-features=AutomationControlled',
      '--disable-features=IsolateOrigins,site-per-process',
      '--disable-web-security',
      '--lang=pt-BR,pt',
    ],
  });
}

async function criarPagina(browser) {
  const page = await browser.newPage();
  await page.setViewport({ width: 1366, height: 768 });

  // User-agent real do Chrome
  await page.setUserAgent(
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
  );

  // Ocultar que é Puppeteer
  await page.evaluateOnNewDocument(() => {
    Object.defineProperty(navigator, 'webdriver', { get: () => undefined });
    Object.defineProperty(navigator, 'languages', { get: () => ['pt-BR','pt','en-US','en'] });
    Object.defineProperty(navigator, 'plugins', { get: () => [1,2,3,4,5] });
    window.chrome = { runtime: {} };
  });

  // Bloquear só mídia pesada, manter JS e CSS (necessário para React carregar)
  await page.setRequestInterception(true);
  page.on('request', req => {
    const tipo = req.resourceType();
    const url  = req.url();
    // Bloquear imagens e fontes externas, mas manter tudo do portal
    if (['media','font'].includes(tipo)) {
      req.abort();
    } else if (tipo === 'image' && !url.includes('portal.ifood.com.br')) {
      req.abort();
    } else {
      req.continue();
    }
  });

  return page;
}

// Salva screenshot para debug
async function screenshot(page, nome) {
  try {
    const path = `/tmp/debug_${nome}.png`;
    await page.screenshot({ path, fullPage: false });
    log(`Screenshot salvo: ${path}`);
  } catch (e) {
    log(`Erro ao salvar screenshot: ${e.message}`);
  }
}

// Digita via eventos React nativos
async function digitarReact(page, seletor, valor) {
  const el = await page.$(seletor);
  if (!el) throw new Error(`Elemento não encontrado: ${seletor}`);
  await el.click({ clickCount: 3 });
  await el.focus();
  await page.evaluate((sel, val) => {
    const input = document.querySelector(sel);
    const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
    setter.call(input, val);
    input.dispatchEvent(new Event('input',  { bubbles: true }));
    input.dispatchEvent(new Event('change', { bubbles: true }));
  }, seletor, valor);
  await sleep(300);
}

async function fazerLogin(page) {
  log('Acessando login...');
  await page.goto(URL_LOGIN, { waitUntil: 'domcontentloaded', timeout: 60000 });

  // Aguarda o React hidratar — espera document.readyState = complete E algum elemento renderizado
  await page.waitForFunction(() => document.readyState === 'complete', { timeout: 30000 });
  await sleep(4000); // Tempo extra para SPA carregar

  await screenshot(page, '01_pagina_login');

  // Aceitar cookies se aparecer
  try {
    await page.evaluate(() => {
      const btn = [...document.querySelectorAll('button,a')].find(b =>
        /aceitar|accept|ok|concordo|allow|fechar/i.test(b.innerText?.trim())
      );
      if (btn) { log_js('Clicando cookie'); btn.click(); }
    });
    await sleep(800);
  } catch (_) {}

  // Diagnóstico: listar todos os inputs na página
  const inputsInfo = await page.evaluate(() => {
    return [...document.querySelectorAll('input')].map(i => ({
      type: i.type,
      name: i.name,
      id: i.id,
      placeholder: i.placeholder,
      className: i.className?.substring(0, 60),
      visible: window.getComputedStyle(i).display !== 'none' && i.offsetParent !== null,
    }));
  });
  log(`Inputs encontrados na página: ${JSON.stringify(inputsInfo)}`);

  // Aguarda qualquer input visível (com espera longa para SPA)
  log('Aguardando input visível...');
  await page.waitForFunction(() => {
    return [...document.querySelectorAll('input')].some(i =>
      window.getComputedStyle(i).display !== 'none' &&
      window.getComputedStyle(i).visibility !== 'hidden' &&
      i.offsetParent !== null &&
      i.type !== 'hidden'
    );
  }, { timeout: 40000 });

  await screenshot(page, '02_input_visivel');

  // Pega o seletor dinâmico do primeiro input visível
  const seletorEmail = await page.evaluate(() => {
    const input = [...document.querySelectorAll('input')].find(i =>
      window.getComputedStyle(i).display !== 'none' &&
      window.getComputedStyle(i).visibility !== 'hidden' &&
      i.offsetParent !== null &&
      i.type !== 'hidden'
    );
    if (!input) return null;
    if (input.id) return `#${input.id}`;
    if (input.name) return `input[name="${input.name}"]`;
    if (input.className) {
      const cls = input.className.trim().split(/\s+/)[0];
      return `input.${cls}`;
    }
    return 'input:not([type="hidden"])';
  });

  log(`Usando seletor dinâmico: ${seletorEmail}`);

  if (!seletorEmail) throw new Error('Nenhum input visível encontrado na página de login');

  await digitarReact(page, seletorEmail, EMAIL);
  log('E-mail digitado.');

  // Clica em continuar
  await page.evaluate(() => {
    const btn =
      document.querySelector('button[type="submit"]') ||
      [...document.querySelectorAll('button')].find(b =>
        /continuar|entrar|próximo|next|login|acessar/i.test(b.innerText?.trim())
      );
    if (btn) btn.click();
  });
  await sleep(2500);
  await screenshot(page, '03_apos_email');

  // Campo de senha
  log('Aguardando campo de senha...');
  await page.waitForFunction(() => {
    return [...document.querySelectorAll('input[type="password"]')].some(i =>
      window.getComputedStyle(i).display !== 'none' && i.offsetParent !== null
    );
  }, { timeout: 25000 });

  await digitarReact(page, 'input[type="password"]', SENHA);
  log('Senha digitada.');

  await page.evaluate(() => {
    const btn =
      document.querySelector('button[type="submit"]') ||
      [...document.querySelectorAll('button')].find(b =>
        /entrar|login|acessar|continuar/i.test(b.innerText?.trim())
      );
    if (btn) btn.click();
  });

  log('Aguardando pós-login...');
  await page.waitForFunction(
    () => !window.location.href.includes('/login'),
    { timeout: 35000 }
  );
  log(`Login OK — ${page.url()}`);
  await screenshot(page, '04_logado');
}

async function coletarDesempenho(page, date) {
  const url = `${URL_DESEMPENHO}?startDate=${date}&endDate=${date}`;
  log(`Navegando: ${url}`);
  await page.goto(url, { waitUntil: 'networkidle2', timeout: 60000 });
  await sleep(4000);
  await screenshot(page, '05_desempenho');

  const metricas = await page.evaluate(() => {
    function pegar(sels) {
      for (const sel of sels) {
        const el = document.querySelector(sel);
        if (el && el.innerText.trim()) return el.innerText.trim();
      }
      return '';
    }
    const cards = [...document.querySelectorAll(
      '[class*="card"],[class*="Card"],[class*="metric"],[class*="Metric"],[class*="kpi"],[class*="summary"],[class*="Summary"],[class*="stat"],[class*="Stat"]'
    )].map(el => el.innerText?.trim()).filter(t => t && t.length < 300).slice(0, 40);

    return {
      pedidosTotal:    pegar(['[data-testid="orders-count"]','[data-testid="total-orders"]','[class*="ordersCount"]','[class*="orders-count"]','[class*="totalOrders"]']),
      faturamento:     pegar(['[data-testid="revenue"]','[data-testid="gross-revenue"]','[class*="grossRevenue"]','[class*="totalRevenue"]','[class*="revenue"]']),
      ticketMedio:     pegar(['[data-testid="average-ticket"]','[class*="averageTicket"]','[class*="average-ticket"]']),
      cancelamentos:   pegar(['[data-testid="canceled"]','[data-testid="cancellations"]','[class*="canceled"]','[class*="cancellations"]']),
      avaliacaoMedia:  pegar(['[data-testid="rating"]','[data-testid="average-rating"]','[class*="averageRating"]','[class*="rating"]']),
      _cards: cards,
    };
  });

  log(`Métricas: ${JSON.stringify(metricas)}`);
  return metricas;
}

// ── /scrape ───────────────────────────────────────────────────────────────────
app.post('/scrape', async (req, res) => {
  const { date } = req.body;
  if (!date)            return res.status(400).json({ error: '"date" obrigatório (yyyy-MM-dd)' });
  if (!EMAIL || !SENHA) return res.status(500).json({ error: 'IFOOD_EMAIL e IFOOD_SENHA não configurados' });

  log(`Iniciando scrape — ${date}`);
  let browser;
  try {
    browser = await criarBrowser();
    const page = await criarPagina(browser);

    await fazerLogin(page);
    const m = await coletarDesempenho(page, date);

    const pedidos     = parseInteiro(m.pedidosTotal);
    const faturamento = parseMoeda(m.faturamento);
    const cancelam    = parseInteiro(m.cancelamentos);
    let ticket        = parseMoeda(m.ticketMedio);
    const avaliacao   = parseDecimal(m.avaliacaoMedia);
    if (ticket === 0 && pedidos > 0) ticket = parseFloat((faturamento / pedidos).toFixed(2));

    const resultado = {
      data_referencia: date, pedidos_total: pedidos, faturamento,
      ticket_medio: ticket, cancelamentos: cancelam, avaliacao_media: avaliacao,
      coletado_em: new Date().toISOString(), _debug_cards: m._cards,
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

// ── /screenshot — retorna o último screenshot de debug ────────────────────────
app.get('/screenshot/:nome', (req, res) => {
  const path = `/tmp/debug_${req.params.nome}.png`;
  if (fs.existsSync(path)) {
    res.setHeader('Content-Type', 'image/png');
    res.sendFile(path, { root: '/' });
  } else {
    res.status(404).json({ error: `Screenshot ${req.params.nome} não encontrado. Opções: 01_pagina_login, 02_input_visivel, 03_apos_email, 04_logado, 05_desempenho` });
  }
});

// ── /health ───────────────────────────────────────────────────────────────────
app.get('/health', (_, res) => res.json({ status: 'ok', timestamp: new Date().toISOString() }));

app.listen(PORT, () => {
  log(`Scraper iFood rodando na porta ${PORT}`);
  if (!EMAIL) log('⚠️  IFOOD_EMAIL não definido');
  if (!SENHA) log('⚠️  IFOOD_SENHA não definido');
});
