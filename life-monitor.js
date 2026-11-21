const { chromium } = require('playwright');
const fs = require('fs');

const LIST_URL = process.env.LIFE_URL;
const STATE_FILE = 'life-state.json';

const GITHUB_USERNAME =
  process.env.GITHUB_ACTOR;

// 1回の実行で確認する商品詳細ページ数
const DETAIL_BATCH_SIZE = 10;

const WAIT_AFTER_LIST_LOAD_MS = 15000;
const WAIT_AFTER_DETAIL_LOAD_MS = 8000;
const WAIT_BETWEEN_DETAIL_PAGES_MS = 1000;

if (!LIST_URL) {
  throw new Error(
    'LIFE_URLが設定されていません。GitHub Actions Secretを確認してください。'
  );
}

function sleep(ms) {
  return new Promise(resolve =>
    setTimeout(resolve, ms)
  );
}

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

function createEmptyState() {
  return {
    initialized: false,
    detailCursor: 0,
    products: {}
  };
}

function sanitizeProduct(product = {}) {
  return {
    productId:
      product.productId || '',

    productName:
      product.productName || '',

    isSoldOut:
      Boolean(product.isSoldOut),

    advanceAnnouncement:
      product.advanceAnnouncement || ''
  };
}

function loadState() {
  if (!fs.existsSync(STATE_FILE)) {
    return createEmptyState();
  }

  try {
    const loaded = JSON.parse(
      fs.readFileSync(
        STATE_FILE,
        'utf8'
      )
    );

    const products = {};

    for (
      const [
        productId,
        product
      ]
      of Object.entries(
        loaded.products || {}
      )
    ) {
      products[productId] =
        sanitizeProduct({
          ...product,
          productId
        });
    }

    return {
      initialized:
        Boolean(loaded.initialized),

      detailCursor:
        Number(
          loaded.detailCursor || 0
        ),

      products
    };

  } catch (error) {
    console.log(
      `life-state.jsonを読み込めませんでした: ${error.message}`
    );

    return createEmptyState();
  }
}

function saveState(state) {
  const products = {};

  for (
    const [
      productId,
      product
    ]
    of Object.entries(
      state.products || {}
    )
  ) {
    products[productId] =
      sanitizeProduct({
        ...product,
        productId
      });
  }

  const safeState = {
    initialized:
      Boolean(state.initialized),

    detailCursor:
      Number(
        state.detailCursor || 0
      ),

    products
  };

  fs.writeFileSync(
    STATE_FILE,
    JSON.stringify(
      safeState,
      null,
      2
    ),
    'utf8'
  );

  console.log(
    'life-state.jsonを保存しました'
  );
}

function buildProductUrl(productId) {
  const listUrl =
    new URL(LIST_URL);

  return new URL(
    `/online_store/${productId}`,
    listUrl.origin
  ).href;
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
          'life-monitor'
      },

      body: JSON.stringify({
        title,
        body
      })
    }
  );

  if (!response.ok) {
    console.log(
      `GitHub通知作成エラー: ` +
      `${response.status} ` +
      `${await response.text()}`
    );

    return false;
  }

  console.log(
    `GitHub通知を作成しました: ${title}`
  );

  return true;
}

async function getListProducts(page) {
  console.log(
    'Life一覧ページを開きます'
  );

  await page.goto(
    LIST_URL,
    {
      waitUntil:
        'domcontentloaded',

      timeout: 60000
    }
  );

  await page.waitForTimeout(
    WAIT_AFTER_LIST_LOAD_MS
  );

  const products =
    await page.evaluate(() => {
      const productMap =
        new Map();

      /*
       * 一覧の商品カードを取得
       */
      const cards =
        Array.from(
          document.querySelectorAll(
            'div[id^="item-"]'
          )
        );

      for (const card of cards) {
        const productId =
          card.id
            .replace(
              'item-',
              ''
            )
            .trim();

        if (!productId) {
          continue;
        }

        const link =
          card.querySelector(
            `a[href*="/online_store/${productId}"]`
          ) ||
          card.querySelector(
            'a[href*="/online_store/"]'
          );

        if (!link) {
          continue;
        }

        const href =
          link.href || '';

        /*
         * カテゴリページへのリンクを除外
         */
        const match =
          href.match(
            /\/online_store\/([^/?#]+)\/?$/
          );

        if (!match) {
          continue;
        }

        const detectedId =
          match[1];

        const excludedCategories = [
          'life',
          'fashion',
          'fabric',
          'gifts',
          'mens',
          'kids_baby',
          'vintage',
          'events'
        ];

        if (
          excludedCategories.includes(
            detectedId
          )
        ) {
          continue;
        }

        const image =
          card.querySelector('img');

        const imageAlt =
          image
            ?.getAttribute('alt')
            ?.trim();

        const cardText =
          card.innerText
            .split('\n')
            .map(text =>
              text.trim()
            )
            .filter(Boolean);

        const productName =
          imageAlt ||
          cardText
            .filter(text =>
              text.toLowerCase() !==
              'sold out'
            )
            .join(' ') ||
          productId;

        const soldOutElement =
          card.querySelector(
            '[class*="soldout"]'
          );

        let isSoldOut = false;

        if (soldOutElement) {
          const style =
            window.getComputedStyle(
              soldOutElement
            );

          const rect =
            soldOutElement
              .getBoundingClientRect();

          isSoldOut =
            style.display !== 'none' &&
            style.visibility !==
              'hidden' &&
            Number(
              style.opacity
            ) !== 0 &&
            rect.width > 0 &&
            rect.height > 0;
        }

        /*
         * soldoutクラスがない場合に備え、
         * 表示文字も確認
         */
        if (!isSoldOut) {
          isSoldOut =
            cardText.some(
              text =>
                text
                  .toLowerCase()
                  .replace(/\s+/g, '') ===
                'soldout'
            );
        }

        productMap.set(
          productId,
          {
            productId,
            productName,
            url: href,
            isSoldOut
          }
        );
      }

      return Array.from(
        productMap.values()
      );
    });

  console.log(
    `Life一覧から${products.length}商品を取得しました`
  );

  return products;
}

function normalizeAnnouncement(text) {
  return String(text || '')
    .replace(/\s+/g, ' ')
    .replace(
      /^[・\-–—\s]+/,
      ''
    )
    .trim();
}

function isAdvanceRestockAnnouncement(
  text
) {
  const normalized =
    normalizeAnnouncement(text);

  if (!normalized) {
    return false;
  }

  /*
   * 過去形・完了形は通知対象外
   */
  const completedExpressions = [
    '再入荷いたしました',
    '再入荷しました',
    '再入荷済み',
    '再販売いたしました',
    '再販売しました',
    '完売いたしました',
    '完売しました'
  ];

  if (
    completedExpressions.some(
      expression =>
        normalized.includes(
          expression
        )
    )
  ) {
    return false;
  }

  /*
   * 未来の再入荷・再販売予定
   */
  const advanceExpressions = [
    '再入荷いたします',
    '再入荷を予定',
    '再入荷予定',
    '再販売いたします',
    '再販売を予定',
    '再販売予定',
    '販売を予定',
    '販売予定',
    '入荷を予定',
    '入荷予定'
  ];

  return advanceExpressions.some(
    expression =>
      normalized.includes(
        expression
      )
  );
}

async function getProductDetail(
  page,
  product
) {
  console.log(
    `Life詳細確認: ${product.productId}`
  );

  await page.goto(
    product.url,
    {
      waitUntil:
        'domcontentloaded',

      timeout: 60000
    }
  );

  await page.waitForTimeout(
    WAIT_AFTER_DETAIL_LOAD_MS
  );

  return await page.evaluate(() => {
    const heading =
      document.querySelector('h1') ||
      document.querySelector('h2');

    const productName =
      heading
        ?.innerText
        ?.trim() ||
      document.title
        .replace(
          ' - minä perhonen',
          ''
        )
        .trim();

    const lines =
      document.body.innerText
        .split('\n')
        .map(text =>
          text.trim()
        )
        .filter(Boolean);

    const announcements = [
      ...new Set(
        lines
          .filter(text =>
            text.includes(
              '再入荷'
            ) ||
            text.includes(
              '再販売'
            ) ||
            text.includes(
              '販売予定'
            ) ||
            text.includes(
              '入荷予定'
            )
          )
          .map(text =>
            text
              .replace(
                /\s+/g,
                ' '
              )
              .replace(
                /^[・\-–—\s]+/,
                ''
              )
              .trim()
          )
      )
    ];

    return {
      productName,
      announcements
    };
  });
}

function getAdvanceAnnouncement(
  announcements
) {
  const candidates =
    (announcements || [])
      .map(
        normalizeAnnouncement
      )
      .filter(
        isAdvanceRestockAnnouncement
      );

  return candidates.length > 0
    ? candidates.join('\n')
    : '';
}

async function notifyRestock(
  product,
  detail
) {
  const displayName =
    detail?.productName ||
    product.productName;

  const productUrl =
    buildProductUrl(
      product.productId
    );

  const title =
    `🛒 Life 在庫復活！ ${displayName}`;

  const body =
`@${GITHUB_USERNAME}

## 🛒 Life商品の在庫が復活しました

**商品：${displayName}**

**変化：SOLD OUT → 購入可能**

### 商品ページ

${productUrl}

確認時刻：${getJapanTime()}（日本時間）`;

  await createGitHubIssue(
    title,
    body
  );
}

async function notifyAnnouncement(
  product,
  detail,
  announcement
) {
  const displayName =
    detail?.productName ||
    product.productName;

  const productUrl =
    buildProductUrl(
      product.productId
    );

  const title =
    `📅 Life 再入荷予定！ ${displayName}`;

  const body =
`@${GITHUB_USERNAME}

## 📅 Life商品の再入荷予定

**商品：${displayName}**

### 掲載された案内

${announcement}

### 商品ページ

${productUrl}

確認時刻：${getJapanTime()}（日本時間）`;

  await createGitHubIssue(
    title,
    body
  );
}

(async () => {
  const browser =
    await chromium.launch({
      headless: true
    });

  const listPage =
    await browser.newPage({
      viewport: {
        width: 1440,
        height: 1200
      }
    });

  const detailPage =
    await browser.newPage({
      viewport: {
        width: 1440,
        height: 1200
      }
    });

  const state =
    loadState();

  const previousProducts =
    state.products || {};

  try {
    console.log(
      '=============================='
    );

    console.log(
      'Life Monitor開始'
    );

    console.log(
      `確認時刻: ${getJapanTime()}`
    );

    console.log(
      '=============================='
    );

    const products =
      await getListProducts(
        listPage
      );

    if (
      products.length === 0
    ) {
      throw new Error(
        'Life一覧の商品を取得できませんでした。life-state.jsonは更新しません。'
      );
    }

    /*
     * 初回実行
     */
    if (!state.initialized) {
      console.log(
        '初回実行です。現在状態を基準として保存します。'
      );

      for (
        const product
        of products
      ) {
        previousProducts[
          product.productId
        ] = {
          productId:
            product.productId,

          productName:
            product.productName,

          isSoldOut:
            product.isSoldOut,

          advanceAnnouncement: ''
        };
      }

      state.initialized = true;
      state.detailCursor = 0;
      state.products =
        previousProducts;

      saveState(state);

      console.log(
        '初回実行のため通知は送りません'
      );

      return;
    }

    /*
     * SOLD OUT → 購入可能を検出
     */
    const restockedProducts =
      products.filter(
        product => {
          const previous =
            previousProducts[
              product.productId
            ];

          return (
            previous &&
            previous.isSoldOut ===
              true &&
            product.isSoldOut ===
              false
          );
        }
      );

    console.log(
      `Life在庫復活: ${restockedProducts.length}件`
    );

    for (
      const product
      of restockedProducts
    ) {
      let detail = null;

      try {
        detail =
          await getProductDetail(
            detailPage,
            product
          );
      } catch (error) {
        console.log(
          `復活商品の詳細取得エラー: ` +
          `${product.productId} ` +
          `${error.message}`
        );
      }

      await notifyRestock(
        product,
        detail
      );

      await sleep(
        WAIT_BETWEEN_DETAIL_PAGES_MS
      );
    }

    /*
     * 再入荷予定を10商品ずつ確認
     */
    const sortedProducts =
      [...products].sort(
        (a, b) =>
          a.productId.localeCompare(
            b.productId
          )
      );

    let cursor =
      Number(
        state.detailCursor || 0
      );

    if (
      cursor >=
      sortedProducts.length
    ) {
      cursor = 0;
    }

    const detailBatch = [];

    for (
      let index = 0;
      index <
      Math.min(
        DETAIL_BATCH_SIZE,
        sortedProducts.length
      );
      index++
    ) {
      const productIndex =
        (
          cursor +
          index
        ) %
        sortedProducts.length;

      detailBatch.push(
        sortedProducts[
          productIndex
        ]
      );
    }

    console.log(
      `Life再入荷案内確認: ${detailBatch.length}商品`
    );

    for (
      const product
      of detailBatch
    ) {
      try {
        const detail =
          await getProductDetail(
            detailPage,
            product
          );

        const announcement =
          getAdvanceAnnouncement(
            detail.announcements
          );

        const previous =
          previousProducts[
            product.productId
          ] || {};

        const previousAnnouncement =
          previous
            .advanceAnnouncement ||
          '';

        if (
          announcement &&
          announcement !==
            previousAnnouncement
        ) {
          await notifyAnnouncement(
            product,
            detail,
            announcement
          );
        }

        previousProducts[
          product.productId
        ] = {
          productId:
            product.productId,

          productName:
            detail.productName ||
            product.productName,

          isSoldOut:
            product.isSoldOut,

          advanceAnnouncement:
            announcement
        };

      } catch (error) {
        console.log(
          `Life詳細確認エラー: ` +
          `${product.productId} ` +
          `${error.message}`
        );
      }

      await sleep(
        WAIT_BETWEEN_DETAIL_PAGES_MS
      );
    }

    /*
     * 一覧の最新状態を保存
     */
    for (
      const product
      of products
    ) {
      const previous =
        previousProducts[
          product.productId
        ] || {};

      previousProducts[
        product.productId
      ] = {
        productId:
          product.productId,

        productName:
          product.productName,

        isSoldOut:
          product.isSoldOut,

        advanceAnnouncement:
          previous
            .advanceAnnouncement ||
          ''
      };
    }

    state.detailCursor =
      sortedProducts.length === 0
        ? 0
        : (
            cursor +
            detailBatch.length
          ) %
          sortedProducts.length;

    state.products =
      previousProducts;

    saveState(state);

    console.log(
      `次回の詳細確認開始位置: ${state.detailCursor}`
    );

    console.log(
      'Life Monitor終了'
    );

  } catch (error) {
    console.error(
      `Life監視エラー: ${error.stack}`
    );

    process.exitCode = 1;

  } finally {
    await browser.close();
  }
})();
