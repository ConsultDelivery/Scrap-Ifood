const express = require('express');
const puppeteer = require('puppeteer');

const app = express();
app.use(express.json());

const PORT  = process.env.PORT  || 3001;
const EMAIL = process.env.IFOOD_EMAIL;
const SENHA = process.env.IFOOD_SENHA;

function log(msg) { console.log(`[${new Date().toISOString()}] ${msg}`); }
function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

let sessao = null;
let resultado = null;

app.post('/scrape', async (req, res) => {
  const { date } = req.body;
  if (!date) return res.status(400).json({ error: '"date" obrigatório (yyyy-MM-dd)' });
  if (!EMAIL || !SENHA) return res.status(500).json({ error: 'IFOOD_EMAIL e IFOOD_SENHA não configurados' });

  log(`Iniciando scrape — ${date}`);
  resultado = null;
  res.json({ ok: true, status: 'iniciado', date });

  (async () => {
    let browser;
    try {
      browser = await puppeteer.launch({
        headless: 'new',
        executablePath: '/usr/bin/chromium',
        args: ['--no-sandbox','--disable-setuid-sandbox','--disable-dev-shm-usage','--disable-gpu'],
      });

      const page = await browser.newPage();
      await page.setViewport({ width: 1366, height: 768 });
      await page.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36');

      // 1. Abre o portal
      log('Acessando portal...');
      await page.goto('https://portal.ifood.com.br/login', { waitUntil: 'networkidle2', timeout: 30000 });
      await sleep(3000);

      // 2. Clica em "Acessar" se existir
      try {
        await page.waitForFunction(
          () => [...document.querySelectorAll('button')].some(b => b.innerText.includes('Acessar')),
          { timeout: 8000 }
        );
        const botoes = await page.$$('button');
        for (const btn of botoes) {
          const txt = await page.evaluate(el => el.innerText, btn);
          if (txt && txt.includes('Acessar')) { await btn.click(); await sleep(3000); break; }
        }
      } catch(e) { log('Botão Acessar não encontrado, continuando...'); }

      // 3. Digita email
      log('Aguardando campo email...');
      await page.waitForFunction(() => document.querySelector('input') !== null, { timeout: 20000 });
      await sleep(1000);

      const inputsEmail = await page.$$('input');
      log(`Inputs encontrados: ${inputsEmail.length}`);
      await inputsEmail[0].click({ clickCount: 3 });
      await inputsEmail[0].type(EMAIL, { delay: 80 });
      await sleep(500);
      log(`Email digitado: ${EMAIL}`);

      // Clica Continuar e aguarda navegação
      await page.waitForFunction(
        () => [...document.querySelectorAll('button')].some(b => b.innerText.includes('Continuar')),
        { timeout: 10000 }
      );
      const btns1 = await page.$$('button');
      for (const btn of btns1) {
        const txt = await page.evaluate(el => el.innerText, btn);
        if (txt && txt.includes('Continuar')) {
          await Promise.all([
            page.waitForNavigation({ waitUntil: 'networkidle2', timeout: 15000 }).catch(() => {}),
            btn.click()
          ]);
          break;
        }
      }
      await sleep(3000);
      log(`URL após continuar email: ${page.url()}`);

      // 4. Digita senha
      log('Aguardando campo senha...');
      await page.waitForFunction(
        () => document.querySelector('input[type="password"]') !== null,
        { timeout: 20000 }
      );
      await sleep(500);
      log('Digitando senha...');
      await page.type('input[type="password"]', SENHA, { delay: 80 });
      await sleep(500);

      // Clica Continuar (senha) e aguarda navegação
      const btns2 = await page.$$('button');
      for (const btn of btns2) {
        const txt = await page.evaluate(el => el.innerText, btn);
        if (txt && txt.includes('Continuar')) {
          await Promise.all([
            page.waitForNavigation({ waitUntil: 'networkidle2', timeout: 15000 }).catch(() => {}),
            btn.click()
          ]);
          break;
        }
      }
      await sleep(3000);
      log(`URL após continuar senha: ${page.url()}`);

      // 5. Seleciona E-mail no 2FA
      log('Aguardando tela 2FA...');
      try {
        await page.waitForFunction(
          () => document.body.innerText.includes('2 etapas') || document.body.innerText.includes('Verificação'),
          { timeout: 10000 }
        );
        log('Tela 2FA detectada, selecionando email...');
        const elementos = await page.$$('label, li, div, span, p');
        for (const el of elementos) {
          const txt = await page.evaluate(e => e.innerText, el);
          if (txt && txt.trim().toLowerCase() === 'e-mail') {
            await el.click();
            await sleep(1000);
            log('Email selecionado como canal 2FA');
            break;
          }
        }
        const btns3 = await page.$$('button');
        for (const btn of btns3) {
          const txt = await page.evaluate(el => el.innerText, btn);
          if (txt && txt.includes('Continuar')) {
            await Promise.all([
              page.waitForNavigation({ waitUntil: 'networkidle2', timeout: 15000 }).catch(() => {}),
              btn.click()
            ]);
            break;
          }
        }
        await sleep(2000);
        log(`URL após 2FA canal: ${page.url()}`);
      } catch(e) { log('Tela 2FA não apareceu: ' + e.message); }

      log('Aguardando código 2FA do n8n...');
      let codigoRecebido = null;
      sessao = { resolverCodigo: (cod) => { codigoRecebido = cod; } };

      const inicio = Date.now();
      while (!codigoRecebido && Date.now() - inicio < 180000) {
        await sleep(2000);
      }
      sessao = null;

      if (!codigoRecebido) {
        resultado = { error: 'Timeout aguardando código 2FA', date };
        await browser.close();
        return;
      }

      // 7. Digita o código 2FA
      log(`Digitando código 2FA: ${codigoRecebido}`);
      await page.waitForFunction(() => document.querySelector('input') !== null, { timeout: 15000 });
      await sleep(500);

      const inputs2fa = await page.$$('input[maxlength="1"]');
      if (inputs2fa.length >= 6) {
        log('Campos individuais detectados (6 inputs)');
        for (let i = 0; i < 6; i++) {
          await inputs2fa[i].type(codigoRecebido[i], { delay: 100 });
        }
      } else {
        log('Campo único de código detectado');
        const allInputs = await page.$$('input');
        if (allInputs.length > 0) await allInputs[0].type(codigoRecebido, { delay: 100 });
      }

      await sleep(1000);
      const btns4 = await page.$$('button');
      for (const btn of btns4) {
        const txt = await page.evaluate(el => el.innerText, btn);
        if (txt && txt.includes('Continuar')) {
          await Promise.all([
            page.waitForNavigation({ waitUntil: 'networkidle2', timeout: 15000 }).catch(() => {}),
            btn.click()
          ]);
          break;
        }
      }
      await sleep(4000);
      log(`URL após código 2FA: ${page.url()}`);

      // 8. Seleciona "Portal do Parceiro" se aparecer
      try {
        await page.waitForFunction(
          () => document.body.innerText.includes('Portal do Parceiro'),
          { timeout: 8000 }
        );
        log('Selecionando Portal do Parceiro...');
        const opcoes = await page.$$('a, button, div, li');
        for (const op of opcoes) {
          const txt = await page.evaluate(el => el.innerText, op);
          if (txt && txt.includes('Portal do Parceiro')) { await op.click(); await sleep(3000); break; }
        }
      } catch(e) { log('Seleção de portal não necessária'); }

      // 9. Navega para desempenho
      log('Navegando para página de desempenho...');
      await page.goto(`https://portal.ifood.com.br/performance?date=${date}`, { waitUntil: 'networkidle2', timeout: 30000 });
      await sleep(4000);

      // 10. Extrai dados
      log('Extraindo dados...');
      const dados = await page.evaluate(() => {
        const getAll = (sel) => [...document.querySelectorAll(sel)].map(el => el.innerText.trim()).filter(t => t);
        return {
          titulo: document.title,
          textos: getAll('h1, h2, h3, [class*="value"], [class*="total"], [class*="revenue"], [class*="order"], [class*="ticket"], [class*="rating"], [class*="cancel"]').slice(0, 40),
          html_resumo: document.body.innerText.slice(0, 3000),
        };
      });

      log(`Extração concluída. Título: ${dados.titulo}`);
      resultado = { date, raw: dados };
      await browser.close();

    } catch (err) {
      log(`ERRO: ${err.message}`);
      if (browser) await browser.close();
      sessao = null;
      resultado = { error: err.message, date };
    }
  })();
});

app.get('/resultado', (req, res) => {
  if (!resultado) return res.status(202).json({ status: 'aguardando' });
  const r = resultado;
  resultado = null;
  return res.json(r);
});

app.post('/codigo', (req, res) => {
  const { codigo } = req.body;
  if (!codigo) return res.status(400).json({ error: '"codigo" obrigatório' });
  if (!sessao) return res.status(404).json({ error: 'Nenhuma sessão ativa aguardando código' });
  log(`Código 2FA recebido: ${codigo}`);
  sessao.resolverCodigo(String(codigo));
  return res.json({ ok: true, codigo });
});

app.get('/health', (_, res) => res.json({ status: 'ok', timestamp: new Date().toISOString() }));

app.listen(PORT, () => {
  log(`Scraper iFood rodando na porta ${PORT}`);
  if (!EMAIL) log('⚠ IFOOD_EMAIL não definido');
  if (!SENHA) log('⚠ IFOOD_SENHA não definido');
});
