const { chromium } = require('playwright');
const fs = require('fs');
const LIST_URL =
  process.env.MINA_URL;

const STATE_FILE = 'state.json';

const GITHUB_USERNAME =
  process.env.GITHUB_ACTOR;

if (!LIST_URL) {
  throw new Error(
    'MINA_URLが設定されていません。GitHub Actions Secretを確認してください。'
  );
}
const LIST_URL =
  'https://www.mina-perhonen.jp/online_store/fabric/';

const STATE_FILE = 'state.json';

const GITHUB_USERNAME = 'yukiyuki2026';

// 1回の実行で確認する商品詳細ページ数
const DETAIL_BATCH_SIZE = 10;

const WAIT_AFTER_LIST_LOAD_MS = 15000;
const WAIT_AFTER_DETAIL_LOAD_MS = 8000;
const WAIT_BETWEEN_DETAIL_PAGES_MS = 1000;

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function createEmptyState() {
  return {
    initialized: false,
    detailCursor: 0,
    products: {},
    pendingNotifications: []
  };
}

function loadState() {
  if (!fs.existsSync(STATE_FILE)) {
    return createEmptyState();
  }

  try {
    const state = JSON.parse(
      fs.readFileSync(STATE_FILE, 'utf8')
    );

    return {
      initialized: Boolean(state.initialized),
      detailCursor: Number(state.detailCursor || 0),
      products: state.products || {},
      pendingNotifications:
        Array.isArray(state.pendingNotifications)
          ? state.pendingNotifications
          : []
    };
  } catch (error) {
    console.log(
      `state.jsonを読み込めませんでした: ${error.message}`
    );

    return createEmptyState();
  }
}

function saveState(state) {
  fs.writeFileSync(
    STATE_FILE,
    JSON.stringify(state, null, 2),
    'utf8'
  );

  console.log('state.jsonを保存しました');
}

function getJapanTimeParts() {
  const formatter = new Intl.DateTimeFormat(
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
  );

  const parts = formatter.formatToParts(new Date());

  const values = {};

  for (const part of parts) {
    if (part.type !== 'literal') {
      values[part.type] = part.value;
    }
  }

  return {
    year: Number(values.year),
    month: Number(values.month),
    day: Number(values.day),
    hour: Number(values.hour),
    minute: Number(values.minute),
    second: Number(values.second)
  };
}

function isQuietTime() {
  const japanTime = getJapanTimeParts();

  const totalMinutes =
    japanTime.hour * 60 +
    japanTime.minute;

  const quietStart =
    11 * 60 + 55;

  const quietEnd =
    12 * 60 + 10;

  return (
    totalMinutes >= quietStart &&
    totalMinutes <= quietEnd
  );
}

function getJapanTimeText() {
  const japanTime = getJapanTimeParts();

  const pad = value =>
    String(value).padStart(2, '0');

  return (
    `${japanTime.year}-` +
    `${pad(japanTime.month)}-` +
    `${pad(japanTime.day)} ` +
    `${pad(japanTime.hour)}:` +
    `${pad(japanTime.minute)}:` +
    `${pad(japanTime.second)}`
  );
}

async function createGitHubIssue(title, body) {
  const token =
    process.env.GITHUB_TOKEN ||
    process.env.GH_TOKEN;

  const repository =
    process.env.GITHUB_REPOSITORY;

  if (!token || !repository) {
    console.log(
      'GitHub通知を作成できませんでした。' +
      'GITHUB_TOKENまたはGITHUB_REPOSITORYがありません。'
    );

    return false;
  }

  const response = await fetch(
    `https://api.github.com/repos/${repository}/issues`,
    {
      method: 'POST',
      headers: {
        Accept: 'application/vnd.github+json',
        Authorization: `Bearer ${token}`,
        'X-GitHub-Api-Version': '2022-11-28',
        'Content-Type': 'application/json',
        'User-Agent': 'mina-stock-monitor'
      },
      body: JSON.stringify({
        title,
        body
      })
    }
  );

  if (!response.ok) {
    const responseText = await response.text();

    console.log(
      `GitHub通知作成エラー: ` +
      `${response.status} ${responseText}`
    );

    return false;
  }

  const issue = await response.json();

  console.log(
    `GitHub通知を作成しました: ${issue.html_url}`
  );

  return true;
}

function addPendingNotification(
  state,
  key,
  title,
  body
) {
  const alreadyExists =
    state.pendingNotifications.some(
      notification =>
        notification.key === key
    );

  if (alreadyExists) {
    console.log(
      `保留通知は登録済みです: ${key}`
    );

    return;
  }

  state.pendingNotifications.push({
    key,
    title,
    body,
    detectedAt: getJapanTimeText()
  });

  console.log(
    `通知を12:10以降まで保留しました: ${title}`
  );
}

async function sendOrQueueNotification(
  state,
  key,
  title,
  body
) {
  if (isQuietTime()) {
    addPendingNotification(
      state,
      key,
      title,
      body
    );

    return false;
  }

  return await createGitHubIssue(
    title,
    body
  );
}

async function sendPendingNotifications(state) {
  if (isQuietTime()) {
    console.log(
      '11:55～12:10のため、保留通知は送信しません'
    );

    return;
  }

  if (
    state.pendingNotifications.length === 0
  ) {
    return;
  }

  console.log(
    `保留通知を${state.pendingNotifications.length}件送信します`
  );

  const unsentNotifications = [];

  for (
    const notification
    of state.pendingNotifications
  ) {
    const body =
`${notification.body}

---

検知時刻：${notification.detectedAt}（日本時間）
11:55～12:10の通知抑制時間中に検知したため、現在通知しています。`;

    const result =
      await createGitHubIssue(
        notification.title,
        body
      );

    if (!result) {
      unsentNotifications.push(
        notification
      );
    }

    await sleep(500);
  }

  state.pendingNotifications =
    unsentNotifications;
}

async function getListProducts(page) {
  console.log(
    'minä perhonen Fabric一覧を開きます'
  );

  await page.goto(LIST_URL, {
    waitUntil: 'domcontentloaded',
    timeout: 60000
  });

  console.log(
    `${WAIT_AFTER_LIST_LOAD_MS / 1000}秒待ちます`
  );

  await page.waitForTimeout(
    WAIT_AFTER_LIST_LOAD_MS
  );

  const products =
    await page.evaluate(() => {
      const cards = Array.from(
        document.querySelectorAll(
          'div[id^="item-FC"]'
        )
      );

      const productMap = new Map();

      for (const card of cards) {
        const productId =
          card.id
            .replace('item-', '')
            .trim();

        if (
          !productId.startsWith('FC')
        ) {
          continue;
        }

        const link =
          card.querySelector(
            `a[href*="/online_store/${productId}"]`
          );

        if (!link) {
          continue;
        }

        const image =
          card.querySelector('img');

        const productName =
          image
            ?.getAttribute('alt')
            ?.trim() ||
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
            style.visibility !== 'hidden' &&
            Number(style.opacity) !== 0 &&
            rect.width > 0 &&
            rect.height > 0;
        }

        productMap.set(
          productId,
          {
            productId,
            productName,
            url: link.href,
            isSoldOut
          }
        );
      }

      return Array.from(
        productMap.values()
      );
    });

  console.log(
    `一覧から${products.length}商品を取得しました`
  );

  return products;
}

function normalizeAnnouncement(text) {
  return text
    .replace(/\s+/g, ' ')
    .replace(/^[・\-–—\s]+/, '')
    .trim();
}

function isAdvanceRestockAnnouncement(text) {
  const normalized =
    normalizeAnnouncement(text);

  if (
    !normalized.includes('再入荷') &&
    !normalized.includes('再販売') &&
    !normalized.includes('販売予定')
  ) {
    return false;
  }

  const pastExpressions = [
    '再入荷いたしました',
    '再入荷しました',
    '再入荷済み',
    '完売いたしました',
    '完売しました'
  ];

  if (
    pastExpressions.some(expression =>
      normalized.includes(expression)
    )
  ) {
    return false;
  }

  const advanceExpressions = [
    '再入荷いたします',
    '再入荷を予定',
    '再入荷予定',
    '再販売いたします',
    '再販売を予定',
    '再販売予定',
    '販売を予定',
    '販売予定'
  ];

  return advanceExpressions.some(
    expression =>
      normalized.includes(expression)
  );
}

async function getProductDetail(
  detailPage,
  product
) {
  console.log(
    `詳細確認: ` +
    `${product.productName} ` +
    `(${product.productId})`
  );

  await detailPage.goto(
    product.url,
    {
      waitUntil: 'domcontentloaded',
      timeout: 60000
    }
  );

  await detailPage.waitForTimeout(
    WAIT_AFTER_DETAIL_LOAD_MS
  );

  return await detailPage.evaluate(() => {
    const heading =
      document.querySelector('h1') ||
      document.querySelector('h2');

    const productName =
      heading?.innerText?.trim() ||
      document.title
        .replace(
          ' - minä perhonen',
          ''
        )
        .trim();

    const lines =
      document.body.innerText
        .split('\n')
        .map(text => text.trim())
        .filter(Boolean);

    const announcements = [
      ...new Set(
        lines
          .filter(text =>
            text.includes('再入荷') ||
            text.includes('再販売') ||
            text.includes('販売予定')
          )
          .map(text =>
            text
              .replace(/\s+/g, ' ')
              .replace(
                /^[・\-–—\s]+/,
                ''
              )
              .trim()
          )
      )
    ];

    const buttons = Array.from(
      document.querySelectorAll(
        'button.btn_line'
      )
    );

    const colorMap =
      new Map();

    for (const button of buttons) {
      const container =
        button.closest('li') ||
        button
          .parentElement
          ?.parentElement ||
        button.parentElement;

      if (!container) {
        continue;
      }

      const width =
        button.innerText.trim();

      const texts =
        container.innerText
          .split('\n')
          .map(text => text.trim())
          .filter(Boolean);

      const colorName =
        texts.find(text =>
          text !== width &&
          text !== 'カラー' &&
          text !== '生地巾(cm)' &&
          text !== 'かごへ入れる' &&
          !/^\d+$/.test(text) &&
          !/^\d+CM$/i.test(text)
        );

      if (!colorName) {
        continue;
      }

      const key =
        `${colorName}|${width}`;

      if (!colorMap.has(key)) {
        colorMap.set(
          key,
          {
            color: colorName,
            width,
            available:
              !button.disabled
          }
        );
      }
    }

    return {
      productName,
      announcements,
      colors:
        Array.from(
          colorMap.values()
        )
    };
  });
}

function getLatestAdvanceAnnouncement(
  announcements
) {
  const advanceAnnouncements =
    announcements
      .map(normalizeAnnouncement)
      .filter(
        isAdvanceRestockAnnouncement
      );

  if (
    advanceAnnouncements.length === 0
  ) {
    return '';
  }

  return advanceAnnouncements.join('\n');
}

function createAvailableColorsText(colors) {
  const availableColors =
    colors.filter(
      item => item.available
    );

  if (
    availableColors.length === 0
  ) {
    return (
      '購入可能カラーを' +
      '取得できませんでした'
    );
  }

  return availableColors
    .map(item => {
      const widthText =
        item.width
          ? ` / 生地巾 ${item.width}cm`
          : '';

      return (
        `- **${item.color}**` +
        `${widthText}`
      );
    })
    .join('\n');
}

async function notifyNewProduct(
  state,
  product,
  detail
) {
  const displayName =
    detail?.productName ||
    product.productName;

  const statusText =
    product.isSoldOut
      ? 'SOLD OUT'
      : '購入可能';

  let colorsText = '';

  if (
    detail &&
    detail.colors &&
    detail.colors.length > 0
  ) {
    colorsText =
`

### カラー・生地巾

${detail.colors
  .map(item => {
    const status =
      item.available
        ? '購入可能'
        : '購入不可';

    return (
      `- **${item.color}**` +
      ` / 生地巾 ${item.width}cm` +
      ` / ${status}`
    );
  })
  .join('\n')}`;
  }

  const title =
    `🆕 新しいファブリック！ ${displayName}`;

  const body =
`@${GITHUB_USERNAME}

## 🆕 新しいファブリックが追加されました

**商品：${displayName}**

**現在の状態：${statusText}**
${colorsText}

### 商品ページ

${product.url}`;

  const key =
    `new-product:${product.productId}`;

  await sendOrQueueNotification(
    state,
    key,
    title,
    body
  );
}

async function notifyRestock(
  state,
  product,
  detail
) {
  const displayName =
    detail.productName ||
    product.productName;

  const colorsText =
    createAvailableColorsText(
      detail.colors
    );

  const title =
    `🛒 在庫復活！ ${displayName}`;

  const body =
`@${GITHUB_USERNAME}

## 🛒 minä perhonen 在庫復活

**商品：${displayName}**

### 購入可能カラー

${colorsText}

### 商品ページ

${product.url}

一覧ページで **SOLD OUTから購入可能への変化** を検知しました。`;

  const key =
    `restock:${product.productId}:` +
    `${Date.now()}`;

  await sendOrQueueNotification(
    state,
    key,
    title,
    body
  );
}

async function notifyAdvanceAnnouncement(
  state,
  product,
  detail,
  announcement
) {
  const displayName =
    detail.productName ||
    product.productName;

  const title =
    `📅 再入荷予定！ ${displayName}`;

  const body =
`@${GITHUB_USERNAME}

## 📅 minä perhonen 再入荷予定

**商品：${displayName}**

### 掲載されたお知らせ

${announcement}

### 商品ページ

${product.url}

まだSOLD OUTの場合でも、再入荷の事前予告として通知しています。`;

  const key =
    `announcement:${product.productId}:` +
    Buffer.from(announcement)
      .toString('base64')
      .slice(0, 40);

  await sendOrQueueNotification(
    state,
    key,
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

  const state = loadState();

  const previousProducts =
    state.products || {};

  try {
    console.log(
      `実行時刻（日本時間）: ` +
      `${getJapanTimeText()}`
    );

    console.log(
      `通知抑制時間: ` +
      `${isQuietTime() ? 'はい' : 'いいえ'}`
    );

    // 12:10以降なら保留通知を送る
    await sendPendingNotifications(
      state
    );

    const products =
      await getListProducts(
        listPage
      );

    if (products.length === 0) {
      throw new Error(
        '商品一覧を取得できませんでした。' +
        'state.jsonは更新しません。'
      );
    }

    console.log(
      '------------------------------'
    );

    for (const product of products) {
      console.log(
        `${product.productName} | ` +
        `${product.productId} | ` +
        `${product.isSoldOut
          ? 'SOLD OUT'
          : '購入可能'} | ` +
        `${product.url}`
      );
    }

    console.log(
      '------------------------------'
    );

    /*
     * 初回実行
     */
    if (!state.initialized) {
      console.log(
        '初回実行です。現在の状態を保存します。'
      );

      for (const product of products) {
        previousProducts[
          product.productId
        ] = {
          productId:
            product.productId,
          productName:
            product.productName,
          url:
            product.url,
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
     * 新商品を検出
     */
    const newProducts =
      products.filter(product =>
        !previousProducts[
          product.productId
        ]
      );

    console.log(
      `新商品を検知した件数: ` +
      `${newProducts.length}`
    );

    for (const product of newProducts) {
      let detail = null;

      try {
        detail =
          await getProductDetail(
            detailPage,
            product
          );
      } catch (error) {
        console.log(
          `新商品の詳細取得エラー: ` +
          `${product.productId} ` +
          `${error.message}`
        );
      }

      await notifyNewProduct(
        state,
        product,
        detail
      );

      await sleep(
        WAIT_BETWEEN_DETAIL_PAGES_MS
      );
    }

    /*
     * SOLD OUT → 購入可能を検出
     */
    const restockedProducts =
      products.filter(product => {
        const previous =
          previousProducts[
            product.productId
          ];

        return (
          previous &&
          previous.isSoldOut === true &&
          product.isSoldOut === false
        );
      });

    console.log(
      `在庫復活を検知した件数: ` +
      `${restockedProducts.length}`
    );

    for (
      const product
      of restockedProducts
    ) {
      let detail;

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

        detail = {
          productName:
            product.productName,
          announcements: [],
          colors: []
        };
      }

      await notifyRestock(
        state,
        product,
        detail
      );

      await sleep(
        WAIT_BETWEEN_DETAIL_PAGES_MS
      );
    }

    /*
     * 再入荷予告を10商品ずつ確認
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
      cursor >= sortedProducts.length
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
        (cursor + index) %
        sortedProducts.length;

      detailBatch.push(
        sortedProducts[productIndex]
      );
    }

    console.log(
      `再入荷予告確認: ` +
      `${detailBatch.length}商品`
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

        const displayName =
          detail.productName ||
          product.productName;

        const advanceAnnouncement =
          getLatestAdvanceAnnouncement(
            detail.announcements
          );

        const previous =
          previousProducts[
            product.productId
          ] || {};

        const previousAnnouncement =
          previous.advanceAnnouncement ||
          '';

        if (
          advanceAnnouncement &&
          advanceAnnouncement !==
          previousAnnouncement
        ) {
          await notifyAdvanceAnnouncement(
            state,
            product,
            detail,
            advanceAnnouncement
          );
        }

        previousProducts[
          product.productId
        ] = {
          ...previous,
          productId:
            product.productId,
          productName:
            displayName,
          url:
            product.url,
          isSoldOut:
            product.isSoldOut,
          advanceAnnouncement
        };
      } catch (error) {
        console.log(
          `予告確認エラー: ` +
          `${product.productId} ` +
          `${error.message}`
        );
      }

      await sleep(
        WAIT_BETWEEN_DETAIL_PAGES_MS
      );
    }

    /*
     * 最新の一覧状態を保存
     */
    for (const product of products) {
      const previous =
        previousProducts[
          product.productId
        ] || {};

      previousProducts[
        product.productId
      ] = {
        ...previous,
        productId:
          product.productId,
        productName:
          product.productName,
        url:
          product.url,
        isSoldOut:
          product.isSoldOut,
        advanceAnnouncement:
          previous.advanceAnnouncement ||
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
      `次回の詳細確認開始位置: ` +
      `${state.detailCursor}`
    );
  } catch (error) {
    console.error(
      `監視処理エラー: ` +
      `${error.stack}`
    );

    process.exitCode = 1;
  } finally {
    await browser.close();
  }
})();
