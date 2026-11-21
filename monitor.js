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

    // 商品カードそのものを取得
    const cards = Array.from(
      document.querySelectorAll('div[id^="item-FC"]')
    );

    const productMap = new Map();

    for (const card of cards) {

      // id="item-FC0611RYRK" → FC0611RYRK
      const productId = card.id.replace('item-', '');

      if (!productId.startsWith('FC')) {
        continue;
      }

      // 商品詳細ページへのリンク
      const link = card.querySelector(
        `a[href*="/online_store/${productId}"]`
      );

      if (!link) {
        continue;
      }

      const href = link.href;

      // 商品画像
      const img = card.querySelector('img');

      // ★ 商品名は画像のaltから取得
      const productName =
        img?.getAttribute('alt')?.trim() || productId;

      // SOLD OUT表示
      const soldOutElement =
        card.querySelector('[class*="soldout"]');

      let isSoldOut = false;

      if (soldOutElement) {

        const style =
          window.getComputedStyle(soldOutElement);

        const rect =
          soldOutElement.getBoundingClientRect();

        isSoldOut =
          style.display !== 'none' &&
          style.visibility !== 'hidden' &&
          Number(style.opacity) !== 0 &&
          rect.width > 0 &&
          rect.height > 0;
      }

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
      `${product.isSoldOut ? 'SOLD OUT' : '購入可能'} | ` +
      `${product.url}`
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
