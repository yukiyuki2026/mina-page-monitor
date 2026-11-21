const { chromium } = require('playwright');
const fs = require('fs');

const LIST_URL =
  'https://www.mina-perhonen.jp/online_store/fabric/';

const STATE_FILE = 'state.json';

// GitHubアプリへ通知するユーザー名
const GITHUB_USERNAME = 'yukiyuki2026';

// 1回の実行で確認する商品詳細ページ数
// 約100商品なら、15分間隔で約2時間30分に1巡します
const DETAIL_BATCH_SIZE = 10;

const WAIT_AFTER_LIST_LOAD_MS = 15000;
const WAIT_AFTER_DETAIL_LOAD_MS = 8000;
const WAIT_BETWEEN_DETAIL_PAGES_MS = 1000;

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function loadState() {
  if (!fs.existsSync(STATE_FILE)) {
    return {
      initialized: false,
      detailCursor: 0,
      products: {}
    };
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

    return {
      initialized: false,
      detailCursor: 0,
      products: {}
    };
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
      'GitHub通知を送信できませんでした。' +
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
  return text
    .replace(/\s+/g, ' ')
    .replace(/^[・\-–—\s]+/, '')
    .trim();
}

function isAdvanceRestockAnnouncement(text) {
  const normalized =
    normalizeAnnouncement(text);

  if (!normalized.includes('再入荷')) {
    return false;
  }

  // 終了後の文章は通知対象外
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

  // 事前予告として扱う表現
  const advanceExpressions = [
    '再入荷いたします',
    '再入荷を予定',
    '再入荷予定',
    '再販売いたします',
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
  
