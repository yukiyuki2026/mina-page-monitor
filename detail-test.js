const { chromium } = require('playwright');

(async () => {
  const browser = await chromium.launch({ headless: true });

  const page = await browser.newPage({
    viewport: { width: 1440, height: 1200 }
  });

  // 現在、再入荷に関する文章があるテスト商品
  const url =
  'https://www.mina-perhonen.jp/online_store/FC0598ELDT';

  console.log(`商品ページを開きます: ${url}`);

  await page.goto(url, {
    waitUntil: 'domcontentloaded',
    timeout: 60000
  });

  console.log('商品情報の読み込みを15秒待ちます');
  await page.waitForTimeout(15000);

  const result = await page.evaluate(() => {
    const pageText = document.body.innerText;

    // ページ内の文章を行単位に分割
    const lines = pageText
      .split('\n')
      .map(text => text.trim())
      .filter(Boolean);

    // 再入荷関連の文章を取得
    const restockLines = [
      ...new Set(
        lines.filter(text =>
          text.includes('再入荷') ||
          text.includes('再販売') ||
          text.includes('販売再開') ||
          text.includes('追加販売')
        )
      )
    ];

    // 商品名候補
    const heading =
      document.querySelector('h1') ||
      document.querySelector('h2');

    const productName =
      heading?.innerText.trim() ||
      document.title.replace(' - minä perhonen', '').trim();

    /*
     * カラーごとの購入可否を取得
     * disabledなし = 購入可能
     */
    const buttons = Array.from(
      document.querySelectorAll('button.btn_line')
    );

    const colors = [];

    for (const button of buttons) {
      const container =
        button.closest('li') ||
        button.parentElement?.parentElement ||
        button.parentElement;

      if (!container) continue;

      const texts = container.innerText
        .split('\n')
        .map(text => text.trim())
        .filter(Boolean);

      // 生地幅の数字と不要な文字を除外して色名候補を探す
      const colorName = texts.find(text =>
        text !== button.innerText.trim() &&
        text !== '生地巾(cm)' &&
        text !== 'カラー' &&
        !/^\d+$/.test(text) &&
        !/^\d+CM$/i.test(text)
      );

      if (!colorName) continue;

      if (colors.some(item => item.color === colorName)) {
        continue;
      }

      colors.push({
        color: colorName,
        width: button.innerText.trim(),
        available: !button.disabled
      });
    }

    return {
      productName,
      restockLines,
      colors
    };
  });

  console.log('================================');
  console.log(`商品名: ${result.productName}`);
  console.log(`商品URL: ${url}`);

  console.log('--------------------------------');
  console.log('再入荷関連の文章');

  if (result.restockLines.length === 0) {
    console.log('再入荷関連の文章は見つかりませんでした');
  } else {
    for (const text of result.restockLines) {
      console.log(`・${text}`);
    }
  }

  console.log('--------------------------------');
  console.log('カラー別の購入状態');

  if (result.colors.length === 0) {
    console.log('カラー情報を取得できませんでした');
  } else {
    for (const item of result.colors) {
      console.log(
        `・${item.color} / ${item.width} / ` +
        `${item.available ? '購入可能' : '購入不可'}`
      );
    }
  }

  console.log('================================');

  await browser.close();
})();
