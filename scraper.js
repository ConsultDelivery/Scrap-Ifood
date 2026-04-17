const express = require('express');
const puppeteer = require('puppeteer-core');

const app = express();
const PORT = 3001;

const IFOOD_EMAIL = process.env.IFOOD_EMAIL || 'SEU_EMAIL';
const IFOOD_SENHA = process.env.IFOOD_SENHA || 'SUA_SENHA';

app.get('/scrape', async (req, res) => {
  let browser;
  try {
    browser = await puppeteer.launch({
      executablePath: '/usr/bin/chromium' // ou /usr/bin/google-chrome
      args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage'],
      headless: true,
    });

    const page = await browser.newPage();
    await page.setViewport({ width: 1280, height: 800 });

    // 1. Acessa o portal
    await page.goto('https://portal.ifood.com.br', { waitUntil: 'networkidle2', timeout: 60000 });

    // 2. Login
    await page.waitForSelector('input[type="email"], input[name="email"]', { timeout: 15000 });
    await page.type('input[type="email"], input[name="email"]', IFOOD_EMAIL, { delay: 50 });
    await page.keyboard.press('Tab');
    await page.type('input[type="password"]', IFOOD_SENHA, { delay: 50 });
    await page.click('button[type="submit"]');
    await page.waitForNavigation({ waitUntil: 'networkidle2', timeout: 30000 });

    // 3. Aguarda carregar o dashboard
    await page.waitForTimeout(3000);

    // 4. Extrai os dados da página
    const dados = await page.evaluate(() => {
      const getText = (selector) => {
        const el = document.querySelector(selector);
        return el ? el.innerText.trim() : null;
      };

      return {
        pedidos_total: getText('[data-testid="orders-count"], .orders-count, .total-orders'),
        faturamento: getText('[data-testid="revenue"], .revenue, .total-revenue'),
        ticket_medio: getText('[data-testid="average-ticket"], .average-ticket'),
        cancelamentos: getText('[data-testid="cancellations"], .cancellations'),
        avaliacao_media: getText('[data-testid="rating"], .rating, .average-rating'),
        nome_restaurante: getText('[data-testid="merchant-name"], .merchant-name, .restaurant-name'),
      };
    });

    const hoje = new Date();
    const pad = n => String(n).padStart(2, '0');
    dados.data_referencia = `${pad(hoje.getDate())}/${pad(hoje.getMonth()+1)}/${hoje.getFullYear()}`;

    await browser.close();
    res.json(dados);

  } catch (err) {
    if (browser) await browser.close();
    console.error('Erro no scraper:', err.message);
    res.status(500).json({ erro: err.message });
  }
});

app.listen(PORT, () => console.log(`Scraper rodando na porta ${PORT}`));
