const { chromium } = require('playwright');

(async () => {
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage();

  const url = 'https://www.mina-perhonen.jp/online_store/fabric/';

  console.log('minä perhonen Fabric を開きます');

  await page.goto(url, {
    waitUntil: 'domcontentloaded',
    timeout: 60000
  });

  await page.waitForTimeout(5000);

  // ページ内に表示されている SOLD OUT を確認
  const soldOutCount = await page.getByText('SOLD OUT', { exact: true }).count();

  console.log('------------------------------');
  console.log(`SOLD OUT 件数: ${soldOutCount}`);
  console.log('------------------------------');

  if (soldOutCount > 0) {
    console.log('OK: SOLD OUT を取得できました');
  } else {
    console.log('注意: SOLD OUT が取得できませんでした');
  }

  await browser.close();
})();
