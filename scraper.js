const express = require('express');
const puppeteer = require('puppeteer');

const app = express();
app.use(express.json());

const PORT = process.env.PORT || 3001;
const IFOOD_EMAIL = process.env.IFOOD_EMAIL;
const IFOOD_SENHA = process.env.IFOOD_SENHA;

// ─── Utilitários ────────────────────────────────────────────────────────────

function log(msg) {
  console.log(`[${new Date().toISOString()}] ${msg}`);
}

function sleep(ms) {
  return new Promise(r => setTimeout(r, ms));
}

function parseMoeda(str) {
  if (!str) return 0;
  return parseFloat(str.replace(/[R$\s.]/g, '').replace(',', '.')) || 0;
}

function parseInteiro(str) {
  if (!str) return 0;
  return parseInt(str.replace(/\D/g, ''), 10) || 0;
}

function parseDecimal(str) {
  if (!str) return 0;
  return parseFloat(str.replace(',', '.')) || 0;
}

// ─── Login ───────────────────────────────────────────────────────────────────

async function fazerLogin(page) {
  log('Navegando para o portal iFood...');
  await page.goto('https://restaurant.ifood.com.br/', {
    waitUntil: 'networkidle2',
    timeout: 60000,
  });

  // Aceitar cookies se aparecer
  try {
    await page.waitForSelector('button[data-testid="cookie-accept"]', { timeout: 5000 });
    await page.click('button[data-testid="cookie-accept"]');
    log('Cookies aceitos.');
  } catch (_) {
    log('Banner de cookies não encontrado, seguindo...');
  }

  log('Preenchendo e-mail...');
  await page.waitForSelector('input[type="email"], input[name="email"], input[placeholder*="mail"]', { timeout: 15000 });
  await page.type('input[type="email"], input[name="email"], input[placeholder*="mail"]', IFOOD_EMAIL, { delay: 60 });
  await sleep(500);

  // Clicar em "Continuar" ou "Próximo"
  const btnContinuar = await page.$('button[type="submit"], button:has-text("Continuar"), button:has-text("Próximo")');
  if (btnContinuar) await btnContinuar.click();
  await sleep(1500);

  log('Preenchendo senha...');
  await page.waitForSelector('input[type="password"]', { timeout: 15000 });
  await page.type('input[type="password"]', IFOOD_SENHA, { delay: 60 });
  await sleep(500);

  await page.click('button[type="submit"]');
  log('Aguardando autenticação...');
  await page.waitForNavigation({ waitUntil: 'networkidle2', timeout: 30000 });
  log('Login realizado com sucesso.');
}

// ─── Coleta de dados ─────────────────────────────────────────────────────────

async function coletarDados(page, date) {
  log(`Coletando dados para a data: ${date}`);

  // Navegar para a seção de relatórios/resumo
  await page.goto('https://restaurant.ifood.com.br/report', {
    waitUntil: 'networkidle2',
    timeout: 60000,
  });
  await sleep(2000);

  // Tentar definir o período via URL ou seletor de data
  // O portal iFood usa parâmetros de data ou datepicker
  try {
    // Tenta setar a data no datepicker
    const [ano, mes, dia] = date.split('-');
    const dataFormatada = `${dia}/${mes}/${ano}`;

    // Procura o campo de data inicial e final
    const camposData = await page.$$('input[type="date"], input[placeholder*="Data"], input[placeholder*="data"]');
    if (camposData.length >= 1) {
      await camposData[0].triple_click?.();
      await camposData[0].click({ clickCount: 3 });
      await camposData[0].type(dataFormatada, { delay: 50 });
    }
    if (camposData.length >= 2) {
      await camposData[1].click({ clickCount: 3 });
      await camposData[1].type(dataFormatada, { delay: 50 });
    }

    // Confirmar filtro
    const btnFiltrar = await page.$('button:has-text("Filtrar"), button:has-text("Aplicar"), button:has-text("Buscar")');
    if (btnFiltrar) {
      await btnFiltrar.click();
      await sleep(3000);
    }
    log('Filtro de data aplicado.');
  } catch (e) {
    log(`Aviso ao aplicar filtro de data: ${e.message}`);
  }

  await sleep(2000);

  // ── Extração dos indicadores ──────────────────────────────────────────────
  const dados = await page.evaluate(() => {
    function texto(seletor) {
      const el = document.querySelector(seletor);
      return el ? el.innerText.trim() : '';
    }

    // Tenta múltiplos seletores para cada métrica
    // (o portal pode variar entre versões)
    const pedidosTotal = texto('[data-testid="total-orders"]')
      || texto('.orders-count')
      || texto('[class*="ordersCount"]')
      || texto('[class*="total-orders"]')
      || '';

    const faturamento = texto('[data-testid="total-revenue"]')
      || texto('.revenue-amount')
      || texto('[class*="totalRevenue"]')
      || texto('[class*="gross-revenue"]')
      || '';

    const ticketMedio = texto('[data-testid="average-ticket"]')
      || texto('.average-ticket')
      || texto('[class*="averageTicket"]')
      || '';

    const cancelamentos = texto('[data-testid="canceled-orders"]')
      || texto('.canceled-orders')
      || texto('[class*="canceledOrders"]')
      || '';

    const avaliacaoMedia = texto('[data-testid="rating-average"]')
      || texto('.rating-average')
      || texto('[class*="ratingAverage"]')
      || texto('[class*="averageRating"]')
      || '';

    return { pedidosTotal, faturamento, ticketMedio, cancelamentos, avaliacaoMedia };
  });

  log(`Dados brutos extraídos: ${JSON.stringify(dados)}`);

  const resultado = {
    data_referencia: date,
    pedidos_total: parseInteiro(dados.pedidosTotal),
    faturamento: parseMoeda(dados.faturamento),
    ticket_medio: parseMoeda(dados.ticketMedio),
    cancelamentos: parseInteiro(dados.cancelamentos),
    avaliacao_media: parseDecimal(dados.avaliacaoMedia),
    coletado_em: new Date().toISOString(),
  };

  // Calcula ticket médio se não veio direto
  if (resultado.ticket_medio === 0 && resultado.pedidos_total > 0) {
    resultado.ticket_medio = parseFloat(
      (resultado.faturamento / resultado.pedidos_total).toFixed(2)
    );
  }

  log(`Dados processados: ${JSON.stringify(resultado)}`);
  return resultado;
}

// ─── Endpoint principal ───────────────────────────────────────────────────────

app.post('/scrape', async (req, res) => {
  const { date } = req.body;

  if (!date) {
    return res.status(400).json({ error: 'Campo "date" é obrigatório (formato: yyyy-MM-dd)' });
  }
  if (!IFOOD_EMAIL || !IFOOD_SENHA) {
    return res.status(500).json({ error: 'Variáveis IFOOD_EMAIL e IFOOD_SENHA não configuradas' });
  }

  log(`Iniciando scrape para: ${date}`);

  let browser;
  try {
    browser = await puppeteer.launch({
      headless: 'new',
      args: [
        '--no-sandbox',
        '--disable-setuid-sandbox',
        '--disable-dev-shm-usage',
        '--disable-gpu',
        '--window-size=1366,768',
      ],
    });

    const page = await browser.newPage();
    await page.setViewport({ width: 1366, height: 768 });
    await page.setUserAgent(
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
    );

    // Bloquear assets desnecessários para acelerar
    await page.setRequestInterception(true);
    page.on('request', req => {
      const tipo = req.resourceType();
      if (['image', 'font', 'media'].includes(tipo)) {
        req.abort();
      } else {
        req.continue();
      }
    });

    await fazerLogin(page);
    const dados = await coletarDados(page, date);

    await browser.close();
    log('Scrape concluído com sucesso.');
    return res.json(dados);

  } catch (err) {
    log(`ERRO no scrape: ${err.message}`);
    if (browser) await browser.close().catch(() => {});
    return res.status(500).json({
      error: err.message,
      date,
      coletado_em: new Date().toISOString(),
    });
  }
});

// ─── Health check ─────────────────────────────────────────────────────────────

app.get('/health', (_, res) => res.json({ status: 'ok', timestamp: new Date().toISOString() }));

// ─── Start ────────────────────────────────────────────────────────────────────

app.listen(PORT, () => {
  log(`Scraper iFood rodando na porta ${PORT}`);
  if (!IFOOD_EMAIL) log('⚠️  ATENÇÃO: IFOOD_EMAIL não definido');
  if (!IFOOD_SENHA) log('⚠️  ATENÇÃO: IFOOD_SENHA não definido');
});
