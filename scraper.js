const express = require('express');
const puppeteer = require('puppeteer');
const fs = require('fs');

const app = express();
app.use(express.json());

const PORT  = process.env.PORT  || 3001;
const EMAIL = process.env.IFOOD_EMAIL;
const SENHA = process.env.IFOOD_SENHA;

function log(msg) { console.log(`[${new Date().toISOString()}] ${msg}`); }
function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

// Estado global da sessão em andamento
let sessao = null;

// ── /scrape ──────────────────────────────────────────────────────────────────
app.post('/scrape', async (req, res) => {
  const { date } = req.body;
  if (!date) return res.status(400).json({ error: '"date" obrigatório (yyyy-MM-dd)' });
  if (!EMAIL || !SENHA) return res.status(500).json({ error: 'IFOOD_EMAIL e IFOOD_SENHA não configurados' });

  log(`Iniciando scrape — ${date}`);

  let browser;
  try {
    browser = await puppeteer.launch({
      headless: 'new',
      args: ['--no-sandbox','--disable-setuid-sandbox','--disable-dev-shm-usage','--disable-gpu'],
    });

    const page = await browser.newPage();
    await page.setViewport({ width: 1366, height: 768 });
    await page.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36');

    // 1. Abre o portal
    log('Acessando portal...');
    await page.goto('https://portal.ifood.com.br/login', { waitUntil: 'networkidle2', timeout: 30000 });

    // 2. Clica em "Acessar" se existir
    try {
      await page.waitForSelector('button', { timeout: 5000 });
      const botoes = await page.$$('button');
      for (const btn of botoes) {
        const txt = await page.evaluate(el => el.innerText, btn);
        if (txt && txt.toLowerCase().includes('acessar')) {
          await btn.click();
          await sleep(2000);
          break;
        }
      }
    } catch(e) { log('Botão Acessar não encontrado, continuando...'); }

    // 3. Digita email
    log('Digitando email...');
    await page.waitForSelector('input[type="text"], input[type="email"]', { timeout: 15000 });
    await page.type('input[type="text"], input[type="email"]', EMAIL, { delay: 80 });
    await sleep(500);

    // Clica em Continuar
    const btns1 = await page.$$('button');
    for (const btn of btns1) {
      const txt = await page.evaluate(el => el.innerText, btn);
      if (txt && txt.toLowerCase().includes('continuar')) { await btn.click(); break; }
    }
    await sleep(3000);

    // 4. Digita senha
    log('Digitando senha...');
    await page.waitForSelector('input[type="password"]', { timeout: 10000 });
    await page.type('input[type="password"]', SENHA, { delay: 80 });
    await sleep(500);

    const btns2 = await page.$$('button');
    for (const btn of btns2) {
      const txt = await page.evaluate(el => el.innerText, btn);
      if (txt && txt.toLowerCase().includes('continuar')) { await btn.click(); break; }
    }
    await sleep(3000);

    // 5. Escolhe canal E-mail no 2FA
    log('Selecionando 2FA por email...');
    try {
      await page.waitForSelector('input[type="radio"], [class*="option"], [class*="channel"]', { timeout: 8000 });
      // Tenta clicar na opção de email
      const opcoes = await page.$$('[class*="option"], [class*="channel"], label, li');
      for (const op of opcoes) {
        const txt = await page.evaluate(el => el.innerText, op);
        if (txt && txt.toLowerCase().includes('e-mail')) {
          await op.click();
          await sleep(1000);
          break;
        }
      }
      // Clica Continuar
      const btns3 = await page.$$('button');
      for (const btn of btns3) {
        const txt = await page.evaluate(el => el.innerText, btn);
        if (txt && txt.toLowerCase().includes('continuar')) { await btn.click(); break; }
      }
    } catch(e) { log('Tela de 2FA não apareceu ou já passou'); }

    await sleep(2000);
    log('Aguardando código 2FA do n8n...');

    // 6. Guarda browser/page na sessão global e aguarda o código por até 3 minutos
    let codigoRecebido = null;
    sessao = { resolverCodigo: (cod) => { codigoRecebido = cod; } };

    const inicio = Date.now();
    while (!codigoRecebido && Date.now() - inicio < 180000) {
      await sleep(2000);
    }

    if (!codigoRecebido) {
      await browser.close();
      sessao = null;
      return res.status(408).json({ error: 'Timeout aguardando código 2FA' });
    }

    // 7. Digita o código 2FA
    log(`Digitando código 2FA: ${codigoRecebido}`);
    await page.waitForSelector('input[maxlength="1"], input[type="tel"], input[type="number"]', { timeout: 10000 });

    const inputs2fa = await page.$$('input[maxlength="1"]');
    if (inputs2fa.length === 6) {
      for (let i = 0; i < 6; i++) {
        await inputs2fa[i].type(codigoRecebido[i], { delay: 100 });
      }
    } else {
      // campo único
      const inp = await page.$('input[type="tel"], input[type="number"], input[maxlength="6"]');
      if (inp) await inp.type(codigoRecebido, { delay: 100 });
    }

    await sleep(1000);
    const btns4 = await page.$$('button');
    for (const btn of btns4) {
      const txt = await page.evaluate(el => el.innerText, btn);
      if (txt && txt.toLowerCase().includes('continuar')) { await btn.click(); break; }
    }

    await sleep(4000);
    sessao = null;

    // 8. Navega para desempenho
    log('Navegando para página de desempenho...');
    await page.goto(`https://portal.ifood.com.br/performance?date=${date}`, { waitUntil: 'networkidle2', timeout: 30000 });
    await sleep(3000);

    // 9. Extrai dados
    log('Extraindo dados...');
    const dados = await page.evaluate(() => {
      const getText = (sel) => {
        const el = document.querySelector(sel);
        return el ? el.innerText.trim() : null;
      };
      const getAll = (sel) => [...document.querySelectorAll(sel)].map(el => el.innerText.trim());

      return {
        titulo: document.title,
        textos: getAll('h1, h2, h3, [class*="value"], [class*="total"], [class*="revenue"], [class*="order"], [class*="ticket"], [class*="rating"], [class*="cancel"]').slice(0, 30),
        html_resumo: document.body.innerText.slice(0, 2000),
      };
    });

    log(`Dados extraídos: ${JSON.stringify(dados).slice(0, 200)}`);
    await browser.close();

    return res.json({ date, raw: dados });

  } catch (err) {
    log(`ERRO: ${err.message}`);
    if (browser) await browser.close();
    sessao = null;
    return res.status(500).json({ error: err.message, date });
  }
});

// ── /codigo — recebe o código 2FA vindo do n8n ────────────────────────────────
app.post('/codigo', (req, res) => {
  const { codigo } = req.body;
  if (!codigo) return res.status(400).json({ error: '"codigo" obrigatório' });
  if (!sessao) return res.status(404).json({ error: 'Nenhuma sessão ativa aguardando código' });

  log(`Código 2FA recebido: ${codigo}`);
  sessao.resolverCodigo(String(codigo));
  return res.json({ ok: true, codigo });
});

// ── /health ───────────────────────────────────────────────────────────────────
app.get('/health', (_, res) => res.json({ status: 'ok', timestamp: new Date().toISOString() }));

app.listen(PORT, () => {
  log(`Scraper iFood rodando na porta ${PORT}`);
  if (!EMAIL) log('⚠ IFOOD_EMAIL não definido');
  if (!SENHA) log('⚠ IFOOD_SENHA não definido');
});
