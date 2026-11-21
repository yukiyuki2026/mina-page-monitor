const { chromium } = require('playwright');

(async () => {
  const browser = await chromium.launch({ headless: true });

  const page = await browser.newPage({
    viewport: { width: 1440, height: 1200 }
  });

  const url = 'https://www.mina-perhonen.jp/online_store/fabric/';

  console.log('minä perhonen Fabric を開きます');

  await page.goto(url, {
    waitUntil: 'domcontentloaded',
    timeout: 60000
  });

  console.log('商品一覧の読み込みを15秒待ちます');
  await page.waitForTimeout(15000);

  const products = await page.evaluate(() => {
    const links = Array.from(
      document.querySelectorAll('a[href*="/online_store/FC"]')
    );

    const productMap = new Map();

    for (const link of links) {
      const href = link.href;

      // FCから始まる商品ページだけを対象にする
      const match = href.match(/\/online_store\/(FC[0-9A-Z]+)\/?$/);

      if (!match) {
        continue;
      }

      const productId = match[1];

      if (productMap.has(productId)) {
        continue;
      }

      // 商品カード全体を探す
      const card =
        link.closest('li') ||
        link.closest('article') ||
        link.parentElement;

      if (!card) {
        continue;
      }

      const soldOutElement =
        card.querySelector('[class*="soldout"]');

      let isSoldOut = false;

      if (soldOutElement) {
        const style = window.getComputedStyle(soldOutElement);
        const rect = soldOutElement.getBoundingClientRect();

        isSoldOut =
          style.display !== 'none' &&
          style.visibility !== 'hidden' &&
          Number(style.opacity) !== 0 &&
          rect.width > 0 &&
          rect.height > 0;
      }

      const textLines = card.innerText
        .split('\n')
        .map(text => text.trim())
        .filter(text => text !== '')
        .filter(text => text.toLowerCase() !== 'sold out')
        .filter(text => text !== 'ファブリック');

      const productName =
        textLines[0] || productId;

      productMap.set(productId, {
        productId,
        productName,
        url: href,
        isSoldOut
      });
    }

    return Array.from(productMap.values());
  });

  console.log('------------------------------');
  console.log(`取得した商品数: ${products.length}`);
  console.log('------------------------------');

  for (const product of products) {
    console.log(
      `${product.productName} | ` +
      `${product.productId} | ` +
      `${product.isSoldOut ? 'SOLD OUT' : '購入可能'}`
    );
  }

  const soldOutProducts =
    products.filter(product => product.isSoldOut);

  const availableProducts =
    products.filter(product => !product.isSoldOut);

  console.log('------------------------------');
  console.log(`SOLD OUT商品数: ${soldOutProducts.length}`);
  console.log(`購入可能商品数: ${availableProducts.length}`);
  console.log('------------------------------');

  await browser.close();
})();
