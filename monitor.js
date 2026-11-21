const { chromium } = require('playwright');
const fs = require('fs');

const LIST_URL =
  'https://www.mina-perhonen.jp/online_store/fabric/';

const STATE_FILE = 'state.json';

// GitHub Mobileへ通知するユーザー名
const GITHUB_USERNAME = 'yukiyuki2026';

// 1回の実行で確認する商品詳細ページ数
// 100商品なら、15分間隔で約2時間30分に1巡
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
    products: {}
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
      products: state.products || {}
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

async function getListProducts(page) {
  console.log('minä perhonen Fabric一覧を開きます');

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

  const products = await page.evaluate(() => {
    const cards = Array.from(
      document.querySelectorAll(
        'div[id^="item-FC"]'
      )
    );

    const productMap = new Map();

    for (const card of cards) {
      const productId =
        card.id.replace('item-', '').trim();

      if (!productId.startsWith('FC')) {
        continue;
      }

      const link = card.querySelector(
        `a[href*="/online_store/${productId}"]`
      );

      if (!link) {
        continue;
      }

      const image = card.querySelector('img');

      const productName =
        image?.getAttribute('alt')?.trim() ||
        productId;

      const soldOutElement =
        card.querySelector('[class*="soldout"]');

      let isSoldOut = false;

      if (soldOutElement) {
        const style =
          window.getComputedStyle(soldOutElement);

        const rect =
          soldOutElement.getBoundingClientRect();

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

    return Array.from(productMap.values());
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

  // 再入荷済み・販売終了後の文章は通知しない
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

  // 未来の再入荷・再販売を示す表現
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

  return advanceExpressions.some(expression =>
    normalized.includes(expression)
  );
}

async function getProductDetail(
  detailPage,
  product
) {
  console.log(
    `詳細確認: ${product.productName} ` +
    `(${product.productId})`
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
              .replace(/^[・\-–—\s]+/, '')
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
        button.parentElement?.parentElement ||
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

      const colorName = texts.find(text =>
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
      colors: Array.from(colorMap.values())
    };
  });
}

function getLatestAdvanceAnnouncement(
  announcements
) {
  const advanceAnnouncements =
    announcements
      .map(normalizeAnnouncement)
      .filter(isAdvanceRestockAnnouncement);

  if (advanceAnnouncements.length === 0) {
    return '';
  }

  return advanceAnnouncements.join('\n');
}

function createAvailableColorsText(colors) {
  const availableColors =
    colors.filter(item => item.available);

  if (availableColors.length === 0) {
    return '購入可能カラーを取得できませんでした';
  }

  return availableColors
    .map(item => {
      const widthText =
        item.width
          ? ` / 生地巾 ${item.width}cm`
          : '';

      return `- **${item.color}**${widthText}`;
    })
    .join('\n');
}

async function sendRestockNotification(
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

  const issueTitle =
    `🛒 在庫復活！ ${displayName}`;

  const issueBody =
`@${GITHUB_USERNAME}

## 🛒 minä perhonen 在庫復活

**商品：${displayName}**

### 購入可能カラー

${colorsText}

### 商品ページ

${product.url}

一覧ページで **SOLD OUTから購入可能への変化** を検知しました。`;

  await createGitHubIssue(
    issueTitle,
    issueBody
  );
}

async function sendAdvanceAnnouncementNotification(
  product,
  detail,
  announcement
) {
  const displayName =
    detail.productName ||
    product.productName;

  const issueTitle =
    `📅 再入荷予定！ ${displayName}`;

  const issueBody =
`@${GITHUB_USERNAME}

## 📅 minä perhonen 再入荷予定

**商品：${displayName}**

### 掲載されたお知らせ

${announcement}

### 商品ページ

${product.url}

まだSOLD OUTの場合でも、再入荷の事前予告として通知しています。`;

  await createGitHubIssue(
    issueTitle,
    issueBody
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
    const products =
      await getListProducts(listPage);

    if (products.length === 0) {
      throw new Error(
        '商品一覧を取得できませんでした。' +
        'state.jsonは更新しません。'
      );
    }

    console.log('------------------------------');

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

    console.log('------------------------------');

    /*
     * 初回実行
     *
     * 現在の状態を基準値として保存します。
     * 初回は在庫復活通知を送りません。
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
      state.products = previousProducts;

      saveState(state);

      console.log(
        '初回実行のため通知は送りません'
      );

      return;
    }

    /*
     * 前回SOLD OUT、今回購入可能の商品を抽出
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
      `在庫復活を検知した商品数: ` +
      `${restockedProducts.length}`
    );

    /*
     * 在庫復活した商品だけ詳細ページを確認
     */
    for (const product of restockedProducts) {
      try {
        const detail =
          await getProductDetail(
            detailPage,
            product
          );

        await sendRestockNotification(
          product,
          detail
        );
      } catch (error) {
        console.log(
          `在庫復活商品の詳細取得エラー: ` +
          `${product.productId} ` +
          `${error.message}`
        );

        const fallbackDetail = {
          productName:
            product.productName,
          announcements: [],
          colors: []
        };

        await sendRestockNotification(
          product,
          fallbackDetail
        );
      }

      await sleep(
        WAIT_BETWEEN_DETAIL_PAGES_MS
      );
    }

    /*
     * 再入荷の事前予告を分割して確認
     *
     * 1回につき10商品だけ確認し、
     * 次回は続きから確認します。
     */
    const sortedProducts =
      [...products].sort((a, b) =>
        a.productId.localeCompare(
          b.productId
        )
      );

    let cursor =
      Number(state.detailCursor || 0);

    if (cursor >= sortedProducts.length) {
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

    for (const product of detailBatch) {
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
          previous.advanceAnnouncement || '';

        /*
         * 新しい再入荷予告が出た場合、
         * または予告内容が変更された場合だけ通知
         */
        if (
          advanceAnnouncement &&
          advanceAnnouncement !==
          previousAnnouncement
        ) {
          await sendAdvanceAnnouncementNotification(
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
          `再入荷予告確認エラー: ` +
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
     *
     * 購入可能からSOLD OUTへ変化した場合も
     * 状態は更新しますが、通知は送りません。
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
          previous.advanceAnnouncement || ''
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
