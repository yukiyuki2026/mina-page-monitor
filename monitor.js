const { chromium } = require('playwright');
const fs = require('fs');

const LIST_URL = process.env.MINA_URL;
const STATE_FILE = 'state.json';
const GITHUB_USERNAME = process.env.GITHUB_ACTOR;

const DETAIL_BATCH_SIZE = 10;
const WAIT_AFTER_LIST_LOAD_MS = 15000;
const WAIT_AFTER_DETAIL_LOAD_MS = 8000;
const WAIT_BETWEEN_DETAIL_PAGES_MS = 1000;

if (!LIST_URL) {
  throw new Error(
    'MINA_URLが設定されていません。GitHub Actions Secretを確認してください。'
  );
}

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

function createColorKey(color, width) {
  return `${color || ''}|${width || ''}`;
}

function sanitizeStoredColors(colors) {
  if (!colors) {
    return {};
  }

  const sanitizedColors = {};

  if (Array.isArray(colors)) {
    for (const item of colors) {
      if (!item || !item.color) {
        continue;
      }

      const color = String(item.color).trim();
      const width = String(item.width || '').trim();
      const key = createColorKey(color, width);

      sanitizedColors[key] = {
        color,
        width,
        available: Boolean(item.available)
      };
    }

    return sanitizedColors;
  }

  if (typeof colors === 'object') {
    for (const [storedKey, item] of Object.entries(colors)) {
      if (!item || typeof item !== 'object') {
        continue;
      }

      const color = String(item.color || '').trim();
      const width = String(item.width || '').trim();

      if (!color) {
        continue;
      }

      const key =
        storedKey || createColorKey(color, width);

      sanitizedColors[key] = {
        color,
        width,
        available: Boolean(item.available)
      };
    }
  }

  return sanitizedColors;
}

function sanitizeStoredProduct(product = {}) {
  const colors =
    sanitizeStoredColors(product.colors);

  return {
    productId: product.productId || '',
    productName: product.productName || '',
    isSoldOut: Boolean(product.isSoldOut),
    advanceAnnouncement:
      product.advanceAnnouncement || '',
    colors,
    colorsInitialized:
      Boolean(product.colorsInitialized) ||
      Object.keys(colors).length > 0
  };
}

function loadState() {
  if (!fs.existsSync(STATE_FILE)) {
    return createEmptyState();
  }

  try {
    const loaded = JSON.parse(
      fs.readFileSync(STATE_FILE, 'utf8')
    );

    const products = {};

    for (const [productId, product] of Object.entries(
      loaded.products || {}
    )) {
      products[productId] = sanitizeStoredProduct({
        ...product,
        productId
      });
    }

    const pendingNotifications = Array.isArray(
      loaded.pendingNotifications
    )
      ? loaded.pendingNotifications.map(notification => ({
          key: notification.key || '',
          type: notification.type || '',
          productId: notification.productId || '',
          productName: notification.productName || '',
          statusText: notification.statusText || '',
          colorsText: notification.colorsText || '',
          announcement: notification.announcement || '',
          detectedAt: notification.detectedAt || '',
          title: notification.title || ''
        }))
      : [];

    return {
      initialized: Boolean(loaded.initialized),
      detailCursor: Number(loaded.detailCursor || 0),
      products,
      pendingNotifications
    };
  } catch (error) {
    console.log(
      `state.jsonを読み込めませんでした: ${error.message}`
    );

    return createEmptyState();
  }
}

function saveState(state) {
  const products = {};

  for (const [productId, product] of Object.entries(
    state.products || {}
  )) {
    products[productId] = sanitizeStoredProduct({
      ...product,
      productId
    });
  }

  const safeState = {
    initialized: Boolean(state.initialized),
    detailCursor: Number(state.detailCursor || 0),
    products,
    pendingNotifications: Array.isArray(
      state.pendingNotifications
    )
      ? state.pendingNotifications
      : []
  };

  fs.writeFileSync(
    STATE_FILE,
    JSON.stringify(safeState, null, 2),
    'utf8'
  );

  console.log(
    'state.jsonを保存しました。商品URLは保存していません。'
  );
}

function getJapanTimeParts() {
  const formatter = new Intl.DateTimeFormat('ja-JP', {
    timeZone: 'Asia/Tokyo',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hourCycle: 'h23'
  });

  const parts =
    formatter.formatToParts(new Date());

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

function isQuietTime() {
  const japanTime = getJapanTimeParts();

  const totalMinutes =
    japanTime.hour * 60 + japanTime.minute;

  const quietStart = 11 * 60 + 55;
  const quietEnd = 12 * 60 + 5;

  return (
    totalMinutes >= quietStart &&
    totalMinutes <= quietEnd
  );
}

function buildProductUrl(productId) {
  const listUrl = new URL(LIST_URL);

  return new URL(
    `/online_store/${productId}`,
    listUrl.origin
  ).href;
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
        'User-Agent': 'page-monitor'
      },
      body: JSON.stringify({
        title,
        body
      })
    }
  );

  if (!response.ok) {
    const responseText =
      await response.text();

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

function createNotificationBody(notification) {
  const productUrl = buildProductUrl(
    notification.productId
  );

  if (notification.type === 'new-product') {
    const colorsSection =
      notification.colorsText
        ? `\n### カラー・生地巾\n\n${notification.colorsText}\n`
        : '';

    return (
`@${GITHUB_USERNAME}

## 🆕 新しいファブリックが追加されました

**商品：${notification.productName}**

**現在の状態：${notification.statusText}**
${colorsSection}
### 商品ページ

${productUrl}`
    );
  }

  if (notification.type === 'restock') {
    return (
`@${GITHUB_USERNAME}

## 🛒 在庫復活

**商品：${notification.productName}**

### 購入可能カラー

${notification.colorsText}

### 商品ページ

${productUrl}

一覧ページで **SOLD OUTから購入可能への変化** を検知しました。`
    );
  }

  if (notification.type === 'color-restock') {
    return (
`@${GITHUB_USERNAME}

## 🎨 カラー在庫復活

**商品：${notification.productName}**

### 復活したカラー

${notification.colorsText}

### 商品ページ

${productUrl}

購入画面で、上記カラーの購入ボタンが **無効から有効に変わったこと** を検知しました。`
    );
  }

  if (notification.type === 'announcement') {
    return (
`@${GITHUB_USERNAME}

## 📅 再入荷予定

**商品：${notification.productName}**

### 掲載されたお知らせ

${notification.announcement}

### 商品ページ

${productUrl}

まだSOLD OUTの場合でも、再入荷の事前予告として通知しています。`
    );
  }

  return (
`@${GITHUB_USERNAME}

**商品：${notification.productName}**

${productUrl}`
  );
}

function addPendingNotification(
  state,
  notification
) {
  const alreadyExists =
    state.pendingNotifications.some(
      item => item.key === notification.key
    );

  if (alreadyExists) {
    console.log(
      `保留通知は登録済みです: ${notification.key}`
    );

    return;
  }

  state.pendingNotifications.push({
    ...notification,
    detectedAt: getJapanTimeText()
  });

  console.log(
    `通知を12:05終了後まで保留しました: ${notification.title}`
  );
}

async function sendOrQueueNotification(
  state,
  notification
) {
  if (isQuietTime()) {
    addPendingNotification(
      state,
      notification
    );

    return false;
  }

  const body =
    createNotificationBody(notification);

  return await createGitHubIssue(
    notification.title,
    body
  );
}

async function sendPendingNotifications(state) {
  if (isQuietTime()) {
    console.log(
      '11:55～12:05のため、保留通知は送信しません'
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
`${createNotificationBody(notification)}

---

検知時刻：${notification.detectedAt}（日本時間）

通知抑制時間中に検知したため、現在通知しています。`;

    const sent = await createGitHubIssue(
      notification.title,
      body
    );

    if (!sent) {
      unsentNotifications.push(notification);
    }

    await sleep(500);
  }

  state.pendingNotifications =
    unsentNotifications;
}

async function getListProducts(page) {
  console.log(
    '監視対象の一覧ページを開きます'
  );

  await page.goto(LIST_URL, {
    waitUntil: 'domcontentloaded',
    timeout: 60000
  });

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
        const productId = card.id
          .replace('item-', '')
          .trim();

        if (!productId.startsWith('FC')) {
          continue;
        }

        const link = card.querySelector(
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

        productMap.set(productId, {
          productId,
          productName,
          url: link.href,
          isSoldOut
        });
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
  return String(text || '')
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
    `詳細確認: ${product.productId}`
  );

  await detailPage.goto(product.url, {
    waitUntil: 'domcontentloaded',
    timeout: 60000
  });

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
        .replace(' - minä perhonen', '')
        .trim();

    const lines = document.body.innerText
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

    const colorMap = new Map();

    for (const button of buttons) {
      const container =
        button.closest('li') ||
        button.parentElement
          ?.parentElement ||
        button.parentElement;

      if (!container) {
        continue;
      }

      const width =
        button.innerText.trim();

      const texts = container.innerText
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
        colorMap.set(key, {
          color: colorName,
          width,
          available: !button.disabled
        });
      }
    }

    return {
      productName,
      announcements,
      colors: Array.from(
        colorMap.values()
      )
    };
  });
}

function getLatestAdvanceAnnouncement(
  announcements
) {
  const candidates = announcements
    .map(normalizeAnnouncement)
    .filter(
      isAdvanceRestockAnnouncement
    );

  return candidates.length > 0
    ? candidates.join('\n')
    : '';
}

function createColorsText(colors) {
  if (!colors || colors.length === 0) {
    return '';
  }

  return colors
    .map(item => {
      const widthText = item.width
        ? ` / 生地巾 ${item.width}cm`
        : '';

      return (
        `- **${item.color}**` +
        `${widthText}`
      );
    })
    .join('\n');
}

function createAvailableColorsText(colors) {
  const availableColors =
    (colors || []).filter(
      item => item.available
    );

  if (availableColors.length === 0) {
    return '購入可能カラーを取得できませんでした';
  }

  return createColorsText(
    availableColors
  );
}

function createAllColorsText(colors) {
  if (!colors || colors.length === 0) {
    return '';
  }

  return colors
    .map(item => {
      const status = item.available
        ? '購入可能'
        : '購入不可';

      const widthText = item.width
        ? ` / 生地巾 ${item.width}cm`
        : '';

      return (
        `- **${item.color}**` +
        `${widthText}` +
        ` / ${status}`
      );
    })
    .join('\n');
}

function convertColorsToState(colors) {
  const colorState = {};

  for (const item of colors || []) {
    if (!item || !item.color) {
      continue;
    }

    const color =
      String(item.color).trim();

    const width =
      String(item.width || '').trim();

    const key =
      createColorKey(color, width);

    colorState[key] = {
      color,
      width,
      available: Boolean(item.available)
    };
  }

  return colorState;
}

function findRestockedColors(
  previousProduct,
  currentColors
) {
  if (!previousProduct?.colorsInitialized) {
    return [];
  }

  const previousColors =
    sanitizeStoredColors(
      previousProduct.colors
    );

  const restockedColors = [];

  for (
    const currentColor
    of currentColors || []
  ) {
    const key = createColorKey(
      currentColor.color,
      currentColor.width
    );

    const previousColor =
      previousColors[key];

    if (
      previousColor &&
      previousColor.available === false &&
      currentColor.available === true
    ) {
      restockedColors.push(
        currentColor
      );
    }
  }

  return restockedColors;
}

function updateStoredProductFromDetail(
  previousProduct,
  product,
  detail,
  announcement
) {
  return {
    ...previousProduct,
    productId: product.productId,
    productName:
      detail?.productName ||
      product.productName,
    isSoldOut: product.isSoldOut,
    advanceAnnouncement:
      announcement !== undefined
        ? announcement
        : (
            previousProduct
              ?.advanceAnnouncement || ''
          ),
    colors: convertColorsToState(
      detail?.colors || []
    ),
    colorsInitialized: true
  };
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

  const notification = {
    key:
      `new-product:${product.productId}`,
    type: 'new-product',
    productId: product.productId,
    productName: displayName,
    statusText,
    colorsText: createAllColorsText(
      detail?.colors || []
    ),
    announcement: '',
    title:
      `🆕 新しいファブリック！ ${displayName}`
  };

  await sendOrQueueNotification(
    state,
    notification
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

  const notification = {
    key:
      `restock:${product.productId}:` +
      `${Date.now()}`,
    type: 'restock',
    productId: product.productId,
    productName: displayName,
    statusText: '購入可能',
    colorsText:
      createAvailableColorsText(
        detail.colors
      ),
    announcement: '',
    title:
      `🛒 在庫復活！ ${displayName}`
  };

  await sendOrQueueNotification(
    state,
    notification
  );
}

async function notifyColorRestock(
  state,
  product,
  detail,
  restockedColors
) {
  if (
    !restockedColors ||
    restockedColors.length === 0
  ) {
    return;
  }

  const displayName =
    detail.productName ||
    product.productName;

  const colorKeys = restockedColors
    .map(item =>
      createColorKey(
        item.color,
        item.width
      )
    )
    .sort()
    .join(',');

  const notification = {
    key:
      `color-restock:` +
      `${product.productId}:` +
      Buffer.from(colorKeys)
        .toString('base64')
        .slice(0, 80),
    type: 'color-restock',
    productId: product.productId,
    productName: displayName,
    statusText: '購入可能',
    colorsText:
      createColorsText(
        restockedColors
      ),
    announcement: '',
    title:
      `🎨 カラー在庫復活！ ${displayName}`
  };

  await sendOrQueueNotification(
    state,
    notification
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

  const notification = {
    key:
      `announcement:` +
      `${product.productId}:` +
      Buffer.from(announcement)
        .toString('base64')
        .slice(0, 40),
    type: 'announcement',
    productId: product.productId,
    productName: displayName,
    statusText: '',
    colorsText: '',
    announcement,
    title:
      `📅 再入荷予定！ ${displayName}`
  };

  await sendOrQueueNotification(
    state,
    notification
  );
}

(async () => {
  const browser = await chromium.launch({
    headless: true
  });

  const listPage = await browser.newPage({
    viewport: {
      width: 1440,
      height: 1200
    }
  });

  const detailPage = await browser.newPage({
    viewport: {
      width: 1440,
      height: 1200
    }
  });

  const state = loadState();

  const previousProducts =
    state.products || {};

  const detailCache = new Map();

  async function getCachedProductDetail(
    product
  ) {
    if (
      detailCache.has(product.productId)
    ) {
      return detailCache.get(
        product.productId
      );
    }

    const detail =
      await getProductDetail(
        detailPage,
        product
      );

    detailCache.set(
      product.productId,
      detail
    );

    return detail;
  }

  try {
    console.log(
      `実行時刻（日本時間）: ${getJapanTimeText()}`
    );

    console.log(
      `通知抑制時間: ${
        isQuietTime() ? 'はい' : 'いいえ'
      }`
    );

    await sendPendingNotifications(
      state
    );

    const products =
      await getListProducts(listPage);

    if (products.length === 0) {
      throw new Error(
        '商品一覧を取得できませんでした。state.jsonは更新しません。'
      );
    }

    if (!state.initialized) {
      for (const product of products) {
        previousProducts[
          product.productId
        ] = {
          productId:
            product.productId,
          productName:
            product.productName,
          isSoldOut:
            product.isSoldOut,
          advanceAnnouncement: '',
          colors: {},
          colorsInitialized: false
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

    const newProducts =
      products.filter(
        product =>
          !previousProducts[
            product.productId
          ]
      );

    const newProductIds = new Set(
      newProducts.map(
        product => product.productId
      )
    );

    console.log(
      `新商品を検知した件数: ${newProducts.length}`
    );

    for (const product of newProducts) {
      let detail = null;

      try {
        detail =
          await getCachedProductDetail(
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

      const announcement = detail
        ? getLatestAdvanceAnnouncement(
            detail.announcements
          )
        : '';

      previousProducts[
        product.productId
      ] = {
        productId:
          product.productId,
        productName:
          detail?.productName ||
          product.productName,
        isSoldOut:
          product.isSoldOut,
        advanceAnnouncement:
          announcement,
        colors: convertColorsToState(
          detail?.colors || []
        ),
        colorsInitialized:
          Boolean(detail)
      };

      await sleep(
        WAIT_BETWEEN_DETAIL_PAGES_MS
      );
    }

    const restockedProducts =
      products.filter(product => {
        const previous =
          previousProducts[
            product.productId
          ];

        return (
          !newProductIds.has(
            product.productId
          ) &&
          previous &&
          previous.isSoldOut === true &&
          product.isSoldOut === false
        );
      });

    const overallRestockedProductIds =
      new Set(
        restockedProducts.map(
          product => product.productId
        )
      );

    console.log(
      `商品全体の在庫復活を検知した件数: ` +
      `${restockedProducts.length}`
    );

    for (
      const product
      of restockedProducts
    ) {
      let detail;

      try {
        detail =
          await getCachedProductDetail(
            product
          );
      } catch (error) {
        detail = {
          productName:
            product.productName,
          announcements: [],
          colors: []
        };

        console.log(
          `復活商品の詳細取得エラー: ` +
          `${product.productId} ` +
          `${error.message}`
        );
      }

      await notifyRestock(
        state,
        product,
        detail
      );

      const previous =
        previousProducts[
          product.productId
        ] || {};

      const announcement =
        getLatestAdvanceAnnouncement(
          detail.announcements || []
        );

      previousProducts[
        product.productId
      ] = updateStoredProductFromDetail(
        previous,
        product,
        detail,
        announcement
      );

      await sleep(
        WAIT_BETWEEN_DETAIL_PAGES_MS
      );
    }

    const sortedProducts =
      [...products].sort((a, b) =>
        a.productId.localeCompare(
          b.productId
        )
      );

    let cursor =
      Number(state.detailCursor || 0);

    if (
      cursor >= sortedProducts.length
    ) {
      cursor = 0;
    }

    const detailBatch = [];

    for (
      let index = 0;
      index < Math.min(
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
      `詳細確認対象: ${detailBatch.length}商品`
    );

    for (
      const product
      of detailBatch
    ) {
      try {
        const detail =
          await getCachedProductDetail(
            product
          );

        const displayName =
          detail.productName ||
          product.productName;

        const announcement =
          getLatestAdvanceAnnouncement(
            detail.announcements
          );

        const previous =
          previousProducts[
            product.productId
          ] || {
            productId:
              product.productId,
            productName:
              product.productName,
            isSoldOut:
              product.isSoldOut,
            advanceAnnouncement: '',
            colors: {},
            colorsInitialized: false
          };

        const previousAnnouncement =
          previous
            .advanceAnnouncement || '';

        if (
          announcement &&
          announcement !==
            previousAnnouncement &&
          !newProductIds.has(
            product.productId
          )
        ) {
          await notifyAdvanceAnnouncement(
            state,
            product,
            detail,
            announcement
          );
        }

        const restockedColors =
          findRestockedColors(
            previous,
            detail.colors
          );

        if (
          restockedColors.length > 0 &&
          !newProductIds.has(
            product.productId
          ) &&
          !overallRestockedProductIds.has(
            product.productId
          )
        ) {
          console.log(
            `カラー在庫復活: ` +
            `${product.productId} ` +
            `${restockedColors
              .map(item =>
                `${item.color}/` +
                `${item.width}cm`
              )
              .join(', ')}`
          );

          await notifyColorRestock(
            state,
            product,
            detail,
            restockedColors
          );
        } else if (
          !previous.colorsInitialized
        ) {
          console.log(
            `カラー初期状態を登録: ` +
            `${product.productId} ` +
            `${displayName}`
          );
        }

        previousProducts[
          product.productId
        ] = updateStoredProductFromDetail(
          previous,
          product,
          detail,
          announcement
        );
      } catch (error) {
        console.log(
          `詳細確認エラー: ` +
          `${product.productId} ` +
          `${error.message}`
        );
      }

      await sleep(
        WAIT_BETWEEN_DETAIL_PAGES_MS
      );
    }

    for (const product of products) {
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
          previous.productName ||
          product.productName,
        isSoldOut:
          product.isSoldOut,
        advanceAnnouncement:
          previous
            .advanceAnnouncement || '',
        colors: sanitizeStoredColors(
          previous.colors
        ),
        colorsInitialized:
          Boolean(
            previous.colorsInitialized
          )
      };
    }

    state.detailCursor =
      sortedProducts.length === 0
        ? 0
        : (
            cursor +
            detailBatch.length
          ) % sortedProducts.length;

    state.products =
      previousProducts;

    saveState(state);

    console.log(
      `次回の詳細確認開始位置: ` +
      `${state.detailCursor}`
    );
  } catch (error) {
    console.error(
      `監視処理エラー: ${error.stack}`
    );

    process.exitCode = 1;
  } finally {
    await browser.close();
  }
})();
