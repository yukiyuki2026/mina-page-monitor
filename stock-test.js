const { chromium } = require('playwright');
const fs = require('fs');

const HISTORY_FILE = 'stock-test-history.json';

const PRODUCT_ID = 'FC0463';
const TARGET_COLOR = 'brown';
const TARGET_WIDTH = '149';

// value="500" = 5000cm
const TEST_QUANTITY_VALUE = '500';
const TEST_QUANTITY_CM = 5000;

const GITHUB_USERNAME =
  process.env.GITHUB_ACTOR;

function getJapanTime() {
  return new Intl.DateTimeFormat(
    'ja-JP',
    {
      timeZone: 'Asia/Tokyo',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
      hourCycle: 'h23'
    }
  ).format(new Date());
}

function createEmptyHistory() {
  return {
    initialized: false,
    previousStatus: '',
    previousStockCm: null,
    observations: []
  };
}

function loadHistory() {
  if (!fs.existsSync(HISTORY_FILE)) {
    return createEmptyHistory();
  }

  try {
    const history = JSON.parse(
      fs.readFileSync(
        HISTORY_FILE,
        'utf8'
      )
    );

    return {
      initialized:
        Boolean(history.initialized),
      previousStatus:
        history.previousStatus || '',
      previousStockCm:
        history.previousStockCm ?? null,
      observations:
        Array.isArray(history.observations)
          ? history.observations
          : []
    };
  } catch (error) {
    console.log(
      `履歴を読み込めませんでした: ${error.message}`
    );

    return createEmptyHistory();
  }
}

function saveHistory(history) {
  fs.writeFileSync(
    HISTORY_FILE,
    JSON.stringify(
      history,
      null,
      2
    ),
    'utf8'
  );

  console.log(
    `${HISTORY_FILE}を保存しました`
  );
}

async function createGitHubIssue(
  title,
  body
) {
  const token =
    process.env.GITHUB_TOKEN;

  const repository =
    process.env.GITHUB_REPOSITORY;

  if (!token || !repository) {
    console.log(
      'GitHub通知用の環境変数がありません'
    );

    return false;
  }

  const response = await fetch(
    `https://api.github.com/repos/${repository}/issues`,
    {
      method: 'POST',
      headers: {
        Accept:
          'application/vnd.github+json',
        Authorization:
          `Bearer ${token}`,
        'X-GitHub-Api-Version':
          '2022-11-28',
        'Content-Type':
          'application/json',
        'User-Agent':
          'page-test'
      },
      body: JSON.stringify({
        title,
        body
      })
    }
  );

  if (!response.ok) {
    console.log(
      `通知作成エラー: ` +
      `${response.status} ` +
      `${await response.text()}`
    );

    return false;
  }

  console.log(
    'GitHub通知を作成しました'
  );

  return true;
}

async function measureStock(
  browser,
  productUrl
) {
  const page =
    await browser.newPage({
      viewport: {
        width: 1440,
        height: 1200
      }
    });

  try {
    await page.goto(
      productUrl,
      {
        waitUntil:
          'domcontentloaded',
        timeout: 60000
      }
    );

    await page.waitForTimeout(8000);

    /*
     * brownの行を取得
     */
    const colorRow = page
      .locator('li')
      .filter({
        hasText: TARGET_COLOR
      })
      .first();

    if (
      await colorRow.count() === 0
    ) {
      throw new Error(
        `${TARGET_COLOR}の行が見つかりません`
      );
    }

    /*
     * 149cmボタンを取得
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
        `${TARGET_WIDTH}cmボタンが見つかりません`
      );
    }

    /*
     * disabledならSOLD OUT
     */
    if (
      await widthButton.isDisabled()
    ) {
      return {
        status: 'soldout',
        stockCm: 0,
        stockMeter: 0,
        notice:
          'カラー選択ボタンがdisabledです'
      };
    }

    await widthButton.click();

    await page.waitForTimeout(1000);

    /*
     * 5000cmの選択肢を持つ数量欄を探す
     */
    const selects =
      page.locator('select.select');

    let quantitySelect = null;

    for (
      let index = 0;
      index < await selects.count();
      index++
    ) {
      const candidate =
        selects.nth(index);

      const option =
        candidate.locator(
          `option[value="${TEST_QUANTITY_VALUE}"]`
        );

      if (
        await option.count() > 0
      ) {
        quantitySelect =
          candidate;

        break;
      }
    }

    if (!quantitySelect) {
      throw new Error(
        '5000cmを持つ数量欄が見つかりません'
      );
    }

    await quantitySelect.selectOption(
      TEST_QUANTITY_VALUE
    );

    await page.waitForTimeout(500);

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

    /*
     * add.jsonの応答待機
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

    await addButton.click();

    const response =
      await responsePromise;

    const result =
      await response.json();

    console.log(
      JSON.stringify(
        result,
        null,
        2
      )
    );

    /*
     * 成功した場合は実際にカートへ
     * 入った可能性があるため停止
     */
    if (
      result.status === 'success'
    ) {
      return {
        status:
          'unexpected-success',
        stockCm: null,
        stockMeter: null,
        notice:
          result.notice || ''
      };
    }

    const notice =
      result.notice || '';

    const match =
      notice.match(
        /在庫数は\s*([0-9,]+)\s*cm/i
      );

    if (!match) {
      return {
        status: 'unknown',
        stockCm: null,
        stockMeter: null,
        notice
      };
    }

    const stockCm =
      Number(
        match[1].replace(
          /,/g,
          ''
        )
      );

    return {
      status: 'available',
      stockCm,
      stockMeter:
        stockCm / 100,
      notice
    };

  } finally {
    await page.close();
  }
}

(async () => {
  const listUrl =
    process.env.MINA_URL;

  if (!listUrl) {
    throw new Error(
      'MINA_URLが設定されていません'
    );
  }

  const baseUrl =
    new URL(listUrl).origin;

  const productUrl =
    `${baseUrl}/online_store/${PRODUCT_ID}`;

  const browser =
    await chromium.launch({
      headless: true
    });

  const history =
    loadHistory();

  try {
    const checkedAt =
      getJapanTime();

    console.log(
      '=============================='
    );

    console.log(
      '15分間隔の在庫観測'
    );

    console.log(
      `確認時刻: ${checkedAt}`
    );

    console.log(
      '=============================='
    );

    const result =
      await measureStock(
        browser,
        productUrl
      );

    const previousStatus =
      history.previousStatus;

    const previousStockCm =
      history.previousStockCm;

    history.observations.push({
      checkedAt,
      status: result.status,
      stockCm: result.stockCm,
      stockMeter:
        result.stockMeter,
      notice: result.notice
    });

    /*
     * 想定外にカートへ追加できた場合
     */
    if (
      result.status ===
      'unexpected-success'
    ) {
      console.error(
        'カート追加が成功した可能性があります'
      );

      console.error(
        '安全のため観測を停止してください'
      );

      await createGitHubIssue(
        '⚠️ 在庫テストを停止してください',
`@${GITHUB_USERNAME}

## カート追加が成功した可能性があります

安全のため、このテストWorkflowを停止してください。

- 商品ID：${PRODUCT_ID}
- カラー：${TARGET_COLOR}
- 生地巾：${TARGET_WIDTH}cm
- 確認時刻：${checkedAt}`
      );

      history.previousStatus =
        result.status;

      saveHistory(history);

      process.exitCode = 1;

      return;
    }

    /*
     * 残量を取得できなかった場合
     */
    if (
      result.status === 'unknown'
    ) {
      console.log(
        '残量を取得できませんでした'
      );

      console.log(
        result.notice
      );

      saveHistory(history);

      return;
    }

    /*
     * 初回は基準値として保存
     * 通知は行わない
     */
    if (!history.initialized) {
      history.initialized = true;
      history.previousStatus =
        result.status;
      history.previousStockCm =
        result.stockCm;

      saveHistory(history);

      console.log(
        '初回値として保存しました'
      );

      console.log(
        `残量: ${result.stockCm}cm`
      );

      console.log(
        `残量: ${result.stockMeter.toFixed(1)}m`
      );

      return;
    }

    /*
     * SOLD OUTへの変化
     */
    if (
      result.status === 'soldout' &&
      previousStatus !== 'soldout'
    ) {
      console.log(
        'SOLD OUTへの変化を検知しました'
      );

      await createGitHubIssue(
        '🔴 在庫観測：SOLD OUT',
`@${GITHUB_USERNAME}

## 対象カラーがSOLD OUTになりました

- 商品ID：${PRODUCT_ID}
- カラー：${TARGET_COLOR}
- 生地巾：${TARGET_WIDTH}cm
- 前回残量：${
  previousStockCm === null
    ? '不明'
    : `${(
        previousStockCm / 100
      ).toFixed(1)}m`
}
- 確認時刻：${checkedAt}`
      );
    }

    /*
     * 残量が変化した場合
     */
    if (
      result.status === 'available' &&
      previousStockCm !== null &&
      result.stockCm !==
        previousStockCm
    ) {
      const differenceCm =
        result.stockCm -
        previousStockCm;

      console.log(
        `残量変化: ` +
        `${previousStockCm}cm` +
        ` → ` +
        `${result.stockCm}cm`
      );

      await createGitHubIssue(
        '📉 在庫残量が変化しました',
`@${GITHUB_USERNAME}

## 在庫残量が変化しました

- 商品ID：${PRODUCT_ID}
- カラー：${TARGET_COLOR}
- 生地巾：${TARGET_WIDTH}cm
- 前回：${(
  previousStockCm / 100
).toFixed(1)}m
- 現在：${(
  result.stockCm / 100
).toFixed(1)}m
- 変化：${(
  differenceCm / 100
).toFixed(1)}m
- 確認時刻：${checkedAt}`
      );
    }

    /*
     * 最新値を保存
     */
    history.previousStatus =
      result.status;

    history.previousStockCm =
      result.stockCm;

    saveHistory(history);

    console.log(
      `現在の状態: ${result.status}`
    );

    if (
      result.stockCm !== null
    ) {
      console.log(
        `現在残量: ${result.stockCm}cm`
      );

      console.log(
        `現在残量: ${result.stockMeter.toFixed(1)}m`
      );
    }

  } catch (error) {
    console.error(
      `観測エラー: ${error.stack}`
    );

    process.exitCode = 1;

  } finally {
    await browser.close();
  }
})();
