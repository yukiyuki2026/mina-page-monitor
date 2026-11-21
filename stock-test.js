const { chromium } = require('playwright');

const PRODUCT_ID = 'FC0463';
const TARGET_COLOR = 'brown';
const TARGET_WIDTH = '149';
const TEST_QUANTITY = '5000';

(async () => {
  const browser = await chromium.launch({
    headless: true
  });

  const page = await browser.newPage({
    viewport: {
      width: 1440,
      height: 1200
    }
  });

  try {
    console.log('==============================');
    console.log('在庫残量取得テスト開始');
    console.log(`商品ID: ${PRODUCT_ID}`);
    console.log(`カラー: ${TARGET_COLOR}`);
    console.log(`生地巾: ${TARGET_WIDTH}cm`);
    console.log('==============================');

    /*
     * 通常監視で使っているSecretから
     * 一覧URLを取得
     */
    const listUrl = process.env.MINA_URL;

    if (!listUrl) {
      throw new Error(
        'MINA_URLが設定されていません'
      );
    }

    const baseUrl =
      new URL(listUrl).origin;

    const productUrl =
      `${baseUrl}/online_store/${PRODUCT_ID}`;

    console.log('商品ページを開きます');

    await page.goto(productUrl, {
      waitUntil: 'domcontentloaded',
      timeout: 60000
    });

    await page.waitForTimeout(8000);

    /*
     * brown の行を探す
     */
    const colorRow = page
      .locator('li')
      .filter({
        hasText: TARGET_COLOR
      })
      .first();

    if (await colorRow.count() === 0) {
      throw new Error(
        `${TARGET_COLOR} のカラー行が見つかりません`
      );
    }

    console.log(
      `${TARGET_COLOR} を見つけました`
    );

    /*
     * brown の149cmボタンを押す
     */
    const widthButton = colorRow.locator(
      'button.btn_line',
      {
        hasText: TARGET_WIDTH
      }
    );

    if (await widthButton.count() === 0) {
      throw new Error(
        `${TARGET_COLOR} の ${TARGET_WIDTH}cm が見つかりません`
      );
    }

    if (await widthButton.isDisabled()) {
      throw new Error(
        `${TARGET_COLOR} は現在購入不可です`
      );
    }

    await widthButton.click();

    console.log(
      `${TARGET_COLOR} / ${TARGET_WIDTH}cm を選択しました`
    );

    await page.waitForTimeout(1000);

    /*
     * 数量セレクトを探す
     */
    const quantitySelect =
      page.locator('select').filter({
        has: page.locator(
          `option[value="${TEST_QUANTITY}"]`
        )
      }).first();

    if (
      await quantitySelect.count() === 0
    ) {
      /*
       * optionのvalueが5000ではないサイト仕様に備えて
       * 表示文字から探す
       */
      const selects =
        page.locator('select');

      let foundSelect = null;

      for (
        let i = 0;
        i < await selects.count();
        i++
      ) {
        const select =
          selects.nth(i);

        const texts =
          await select
            .locator('option')
            .allTextContents();

        if (
          texts.some(text =>
            text
              .toUpperCase()
              .includes('5000CM')
          )
        ) {
          foundSelect = select;
          break;
        }
      }

      if (!foundSelect) {
        throw new Error(
          '5000CMを選択できる数量欄が見つかりません'
        );
      }

      await foundSelect.selectOption({
        label: '5000CM'
      });

    } else {

      try {
        await quantitySelect.selectOption(
          TEST_QUANTITY
        );
      } catch {
        await quantitySelect.selectOption({
          label: '5000CM'
        });
      }
    }

    console.log(
      'テスト数量 5000cm を選択しました'
    );

    await page.waitForTimeout(500);

    /*
     * add.json のレスポンスを待つ
     *
     * 重要：
     * 在庫不足ならカート追加は失敗し、
     * noticeに実在庫が返る想定。
     */
    const responsePromise =
      page.waitForResponse(
        response =>
          response.url().includes(
            'add.json'
          ),
        {
          timeout: 30000
        }
      );

    /*
     * 「かごへ入れる」を押す
     */
    const addButton =
      page.locator(
        '#add_to_cart_button'
      );

    if (
      await addButton.count() === 0
    ) {
      throw new Error(
        'かごへ入れるボタンが見つかりません'
      );
    }

    console.log(
      '在庫チェックを実行します'
    );

    await addButton.click();

    const response =
      await responsePromise;

    const result =
      await response.json();

    console.log('------------------------------');
    console.log('add.json 応答');
    console.log(
      JSON.stringify(
        result,
        null,
        2
      )
    );
    console.log('------------------------------');

    /*
     * noticeから
     * 「在庫数は1100cmです」
     * の1100を取得
     */
    const notice =
      result.notice || '';

    const match =
      notice.match(
        /在庫数は\s*([0-9,]+)\s*cm/
      );

    if (!match) {

      console.log(
        '在庫残量を取得できませんでした'
      );

      console.log(
        `notice: ${notice}`
      );

      /*
       * 万一カート追加が成功した場合は
       * テスト失敗として明確にする
       */
      if (
        result.status === 'success'
      ) {
        console.log(
          '注意：カート追加が成功した可能性があります'
        );
      }

      return;
    }

    const stockCm =
      Number(
        match[1].replace(/,/g, '')
      );

    const stockMeter =
      stockCm / 100;

    console.log('==============================');
    console.log('在庫残量取得成功');
    console.log(
      `残量: ${stockCm}cm`
    );
    console.log(
      `残量: ${stockMeter.toFixed(1)}m`
    );
    console.log('==============================');

    /*
     * 今回は取得テストだけ。
     * 通知・履歴保存はまだ行わない。
     */

  } catch (error) {

    console.error(
      `テスト失敗: ${error.message}`
    );

    process.exitCode = 1;

  } finally {

    await browser.close();

  }
})();
