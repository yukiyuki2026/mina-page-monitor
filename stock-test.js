const { chromium } = require('playwright');

const PRODUCT_ID = 'FC0463';
const TARGET_COLOR = 'brown';
const TARGET_WIDTH = '149';

// 数量欄では
// value="500" = 5000cm
const TEST_QUANTITY_VALUE = '500';
const TEST_QUANTITY_CM = 5000;

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
     * 監視先URLはGitHub Secretから取得
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
     * brown の149cmボタンを探す
     */
    const widthButton =
      colorRow.locator(
        'button.btn_line',
        {
          hasText: TARGET_WIDTH
        }
      );

    if (
      await widthButton.count() === 0
    ) {
      throw new Error(
        `${TARGET_COLOR} の ${TARGET_WIDTH}cm が見つかりません`
      );
    }

    if (
      await widthButton.isDisabled()
    ) {
      console.log(
        `${TARGET_COLOR} は現在購入不可です`
      );

      console.log(
        'SOLD OUTの可能性があります'
      );

      return;
    }

    /*
     * brown / 149cm を選択
     */
    await widthButton.click();

    console.log(
      `${TARGET_COLOR} / ${TARGET_WIDTH}cm を選択しました`
    );

    await page.waitForTimeout(1000);

    /*
     * 数量欄を取得
     */
    const quantitySelect =
      page.locator('select.select').first();

    if (
      await quantitySelect.count() === 0
    ) {
      throw new Error(
        '数量選択欄が見つかりません'
      );
    }

    /*
     * 5000cmの選択肢が本当に存在するか確認
     *
     * HTML:
     * <option value="500">5000cm</option>
     */
    const option5000 =
      quantitySelect.locator(
        'option[value="500"]'
      );

    if (
      await option5000.count() === 0
    ) {
      throw new Error(
        '5000cmの選択肢が見つかりません'
      );
    }

    /*
     * 5000cm を選択
     */
    await quantitySelect.selectOption(
      TEST_QUANTITY_VALUE
    );

    console.log(
      `テスト数量 ${TEST_QUANTITY_CM}cm を選択しました`
    );

    await page.waitForTimeout(500);

    /*
     * add.json のレスポンス待機を先に開始
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
     * かごへ入れるボタン
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

    /*
     * 在庫不足になれば
     * カート追加は失敗し、
     * add.jsonのnoticeに在庫数が返る
     */
    await addButton.click();

    const response =
      await responsePromise;

    const result =
      await response.json();

    console.log(
      '------------------------------'
    );

    console.log(
      'add.json 応答'
    );

    console.log(
      JSON.stringify(
        result,
        null,
        2
      )
    );

    console.log(
      '------------------------------'
    );

    /*
     * 想定外にカート追加成功した場合
     */
    if (
      result.status === 'success'
    ) {
      console.log(
        '⚠️ カート追加が成功しました'
      );

      console.log(
        '残量取得テストを中止します'
      );

      process.exitCode = 1;

      return;
    }

    /*
     * notice例:
     *
     * choucho ＋ noppara ファブリック の
     * 在庫数は1100cmです。
     * かごへ追加することができませんでした。
     */
    const notice =
      result.notice || '';

    console.log(
      `notice: ${notice}`
    );

    /*
     * 在庫数を抽出
     */
    const match =
      notice.match(
        /在庫数は\s*([0-9,]+)\s*cm/i
      );

    if (!match) {
      console.log(
        '在庫残量を取得できませんでした'
      );

      console.log(
        'add.jsonのnoticeを確認してください'
      );

      process.exitCode = 1;

      return;
    }

    const stockCm =
      Number(
        match[1]
          .replace(/,/g, '')
      );

    const stockMeter =
      stockCm / 100;

    console.log(
      '=============================='
    );

    console.log(
      '✅ 在庫残量取得成功'
    );

    console.log(
      `商品ID: ${PRODUCT_ID}`
    );

    console.log(
      `カラー: ${TARGET_COLOR}`
    );

    console.log(
      `生地巾: ${TARGET_WIDTH}cm`
    );

    console.log(
      `残量: ${stockCm}cm`
    );

    console.log(
      `残量: ${stockMeter.toFixed(1)}m`
    );

    console.log(
      '=============================='
    );

    /*
     * 今回はここで終了。
     *
     * ・定期監視なし
     * ・通知なし
     * ・履歴保存なし
     *
     * まず残量が取得できるかだけ確認する。
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
