const { chromium } = require('playwright');
const fs = require('fs');

const HISTORY_FILE = 'stock-test-history.json';

const PRODUCT_ID = 'FC0463';
const TARGET_COLOR = 'brown';
const TARGET_WIDTH = '149';

// value="500" = 5000cm
const TEST_QUANTITY_VALUE = '500';

const GITHUB_USERNAME =
  process.env.GITHUB_ACTOR;

// カート操作前の通信で探す語句
const INVESTIGATION_WORDS = [
  '1100',
  'stock',
  'inventory',
  'quantity',
  'available',
  'availability',
  'sku'
];

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

function getUrlPath(urlText) {
  try {
    const url = new URL(urlText);

    return (
      url.pathname +
      url.search
    );
  } catch {
    return urlText;
  }
}

function createSnippet(
  text,
  index,
  length = 100
) {
  const start =
    Math.max(0, index - length);

  const end =
    Math.min(
      text.length,
      index + length
    );

  return text
    .slice(start, end)
    .replace(/\s+/g, ' ')
    .trim();
}

async function inspectResponse(
  response,
  stage
) {
  const request =
    response.request();

  const resourceType =
    request.resourceType();

  if (
    resourceType !== 'xhr' &&
    resourceType !== 'fetch'
  ) {
    return null;
  }

  const urlPath =
    getUrlPath(response.url());

  const contentType =
    response.headers()[
      'content-type'
    ] || '';

  let text = '';

  try {
    text = await response.text();
  } catch {
    return {
      stage,
      urlPath,
      status: response.status(),
      contentType,
      matchedWords: [],
      snippets: [],
      readError: true
    };
  }

  /*
   * 巨大なResponseをそのまま保存しない
   */
  const searchableText =
    text.slice(0, 1000000);

  const lowerText =
    searchableText.toLowerCase();

  const matchedWords = [];
  const snippets = [];

  for (
    const word
    of INVESTIGATION_WORDS
  ) {
    const index =
      lowerText.indexOf(
        word.toLowerCase()
      );

    if (index >= 0) {
      matchedWords.push(word);

      snippets.push({
        word,
        text: createSnippet(
          searchableText,
          index
        )
      });
    }
  }

  /*
   * 検索語句が見つからず、
   * URLにも在庫関連らしい語句がない通信は
   * 履歴に含めない
   */
  const interestingUrl =
    /product|sku|stock|inventory|quantity|available|variant|entry|cart|add/i
      .test(urlPath);

  if (
    matchedWords.length === 0 &&
    !interestingUrl
  ) {
    return null;
  }

  return {
    stage,
    urlPath,
    status: response.status(),
    contentType,
    matchedWords,
    snippets,
    readError: false
  };
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

  /*
   * pre-cart:
   * 「かごへ入れる」を押す前
   *
   * cart:
   * 「かごへ入れる」を押した後
   */
  let investigationStage =
    'pre-cart';

  const investigationPromises = [];

  page.on(
    'response',
    response => {
      const promise =
        inspectResponse(
          response,
          investigationStage
        )
          .then(result => result)
          .catch(error => ({
            stage:
              investigationStage,

            urlPath:
              getUrlPath(
                response.url()
              ),

            status:
              response.status(),

            matchedWords: [],

            snippets: [],

            investigationError:
              error.message
          }));

      investigationPromises.push(
        promise
      );
    }
  );

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
     * brownの行
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
     * 149cmボタン
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
      await page.waitForTimeout(1000);

      const investigationResults =
        (
          await Promise.all(
            investigationPromises
          )
        ).filter(Boolean);

      return {
        status: 'soldout',
        stockCm: 0,
        stockMeter: 0,
        notice:
          'カラー選択ボタンがdisabledです',

        preCartCandidates:
          investigationResults.filter(
            item =>
              item.stage ===
              'pre-cart'
          )
      };
    }

    await widthButton.click();

    /*
     * カラー・生地巾選択後に発生する
     * 通信を待つ
     */
    await page.waitForTimeout(3000);

    /*
     * ここまでがカート操作前
     */
    const preCartPromiseCount =
      investigationPromises.length;

    /*
     * 数量欄
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
     * ここからはカート操作後
     */
    investigationStage = 'cart';

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

    await page.waitForTimeout(1000);

    /*
     * 通信調査処理が終わるのを待つ
     */
    const investigationResults =
      (
        await Promise.all(
          investigationPromises
        )
      ).filter(Boolean);

    /*
     * 「かごへ入れる」前までに登録された通信
     */
    const preCartCandidates =
      investigationResults
        .slice(
          0,
          preCartPromiseCount
        )
        .filter(
          item =>
            item.stage ===
            'pre-cart'
        );

    console.log(
      '=============================='
    );

    console.log(
      'カート操作前の通信調査結果'
    );

    console.log(
      JSON.stringify(
        preCartCandidates,
        null,
        2
      )
    );

    console.log(
      '=============================='
    );

    const direct1100Candidates =
      preCartCandidates.filter(
        item =>
          item.matchedWords
            ?.includes('1100')
      );

    if (
      direct1100Candidates.length > 0
    ) {
      console.log(
        '★ カート操作前の通信に1100が見つかりました'
      );

      console.log(
        '直接取得ルートの候補があります'
      );
    } else {
      console.log(
        'カート操作前の通信には1100が見つかりませんでした'
      );
    }

    const keywordCandidates =
      preCartCandidates.filter(
        item =>
          item.matchedWords
            ?.some(word =>
              word !== '1100'
            )
      );

    if (
      keywordCandidates.length > 0
    ) {
      console.log(
        '在庫関連キーワードを含む通信候補があります'
      );
    }

    /*
     * 想定外にカート追加成功
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
          result.notice || '',

        preCartCandidates
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

        notice,

        preCartCandidates
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

      notice,

      preCartCandidates
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
      '15分間隔の在庫観測・通信調査'
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

    const directCandidates =
      result.preCartCandidates
        ?.filter(
          candidate =>
            candidate.matchedWords
              ?.includes('1100')
        ) || [];

    const keywordCandidates =
      result.preCartCandidates
        ?.filter(
          candidate =>
            candidate.matchedWords
              ?.length > 0
        ) || [];

    history.observations.push({
      checkedAt,

      status:
        result.status,

      stockCm:
        result.stockCm,

      stockMeter:
        result.stockMeter,

      notice:
        result.notice,

      investigation: {
        direct1100Found:
          directCandidates.length > 0,

        directCandidates,

        keywordCandidates
      }
    });

    /*
     * カート追加成功時
     */
    if (
      result.status ===
      'unexpected-success'
    ) {
      await createGitHubIssue(
        '⚠️ 在庫テストを停止してください',
`@${GITHUB_USERNAME}

## カート追加が成功した可能性があります

安全のため、Stock Testのスケジュールを停止してください。

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
     * 初回基準
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

      return;
    }

    /*
     * SOLD OUTへの変化
     */
    if (
      result.status === 'soldout' &&
      previousStatus !== 'soldout'
    ) {
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
     * 残量変化
     */
    if (
      result.status ===
        'available' &&
      previousStockCm !== null &&
      result.stockCm !==
        previousStockCm
    ) {
      const differenceCm =
        result.stockCm -
        previousStockCm;

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
- 確認時刻：${checkedAt}

### カート操作前の直接取得候補

- 1100を含む通信：${directCandidates.length}件
- 在庫関連キーワードを含む通信：${keywordCandidates.length}件`
      );
    }

    history.previousStatus =
      result.status;

    history.previousStockCm =
      result.stockCm;

    saveHistory(history);

    console.log(
      `現在状態: ${result.status}`
    );

    if (
      result.stockCm !== null
    ) {
      console.log(
        `現在残量: ${result.stockCm}cm`
      );

      console.log(
        `現在残量: ` +
        `${result.stockMeter.toFixed(1)}m`
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
