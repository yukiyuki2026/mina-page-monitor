const { chromium } = require('playwright');
const fs = require('fs');

(async () => {
  const browser = await chromium.launch({ headless: true });

  const page = await browser.newPage({
    viewport: { width: 1440, height: 1200 }
  });

  const url = 'https://www.mina-perhonen.jp/online_store/fabric/';

  console.log('minä perhonen Fabric を開きます');

  // products や在庫関係の通信をログに出す
  page.on('response', response => {
    const u = response.url();

    if (
      u.includes('products') ||
      u.includes('stock') ||
      u.includes('inventory')
    ) {
      console.log(
        '通信:',
        response.status(),
        u
      );
    }
  });

  await page.goto(url, {
    waitUntil: 'domcontentloaded',
    timeout: 60000
  });

  console.log('ページ読み込み完了。15秒待ちます');

  await page.waitForTimeout(15000);

  // JavaScript実行後のHTMLを保存
  const html = await page.content();
  fs.writeFileSync('page.html', html);

  // 実際にGitHub側で見えている画面を保存
  await page.screenshot({
    path: 'page.png',
    fullPage: true
  });

  const soldOutTextCount =
    await page.getByText('SOLD OUT', { exact: true }).count();

  const soldOutClassCount =
    await page.locator('[class*="soldout"]').count();

  console.log('------------------------------');
  console.log(`SOLD OUT文字の件数: ${soldOutTextCount}`);
  console.log(`soldoutクラスの件数: ${soldOutClassCount}`);
  console.log(`ページタイトル: ${await page.title()}`);
  console.log(`現在URL: ${page.url()}`);
  console.log('------------------------------');

  console.log('page.html と page.png を保存しました');

  await browser.close();
})();
