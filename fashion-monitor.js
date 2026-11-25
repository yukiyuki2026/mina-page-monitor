const { chromium } = require('playwright');
const fs = require('fs');

const LIST_URL = process.env.FASHION_URL;
const STATE_FILE = 'fashion-state.json';
const GITHUB_USERNAME = process.env.GITHUB_ACTOR;

// 1回に詳細確認する商品数
const DETAIL_BATCH_SIZE = 10;

const WAIT_AFTER_LIST_LOAD_MS = 15000;
const WAIT_AFTER_DETAIL_LOAD_MS = 8000;
const WAIT_BETWEEN_DETAIL_PAGES_MS = 1000;

if (!LIST_URL) {
  throw new Error(
    'FASHION_URLが設定されていません。GitHub Actions Secretを確認してください。'
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

function normalizeText(text) {
  return String(text || '')
    .replace(/\s+/g, ' ')
    .trim();
}

function createVariationKey(label) {
  return normalizeText(label)
    .toLowerCase();
}

function sanitizeVariations(variations) {
  if (!variations) {
    return {};
  }

  const sanitized = {};

  if (Array.isArray(variations)) {
    for (const variation of variations) {
      if (!variation) {
        continue;
      }

      const label = normalizeText(
        variation.label ||
        variation.name
      );

      if (!label) {
        continue;
      }

      const key =
        createVariationKey(label);

      sanitized[key] = {
        label,
        available:
          Boolean(variation.available)
      };
    }

    return sanitized;
  }

  if (typeof variations === 'object') {
    for (
      const [storedKey, variation]
      of Object.entries(variations)
    ) {
      if (
        !variation ||
        typeof variation !== 'object'
      ) {
        continue;
      }

      const label = normalizeText(
        variation.label ||
        variation.name ||
        storedKey
      );

      if (!label) {
        continue;
      }

      const key =
        createVariationKey(label);

      sanitized[key] = {
        label,
        available:
          Boolean(variation.available)
      };
    }
  }

  return sanitized;
}

function sanitizeProduct(product = {}) {
  const variations =
    sanitizeVariations(
      product.variations
    );

  return {
    productId:
      product.productId || '',

    productName:
      product.productName || '',

    isSoldOut:
      Boolean(product.isSoldOut),

    advanceAnnouncement:
      product.advanceAnnouncement || '',

    variations,

    variationsInitialized:
      Boolean(
        product.variationsInitialized
      ) ||
      Object.keys(variations).length > 0
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
      const [productId, product]
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
      `fashion-state.jsonを読み込めませんでした: ${error.message}`
    );

    return createEmptyState();
  }
}

function saveState(state) {
  const products = {};

  for (
    const [productId, product]
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
    'fashion-state.jsonを保存しました'
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
    process.env.GITHUB_TOKEN ||
    process.env.GH_TOKEN;

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
          'fashion-monitor'
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
      `${response.status} ` +
      `${responseText}`
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
    'Fashion一覧ページを開きます'
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

      const cards = Array.from(
        document.querySelectorAll(
          'div[id^="item-"]'
        )
      );

      for (const card of cards) {
        const productId =
          card.id
            .replace('item-', '')
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

        const match = href.match(
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
              text
                .toLowerCase()
                .replace(/\s+/g, '') !==
              'soldout'
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
            style.visibility !== 'hidden' &&
            Number(style.opacity) !== 0 &&
            rect.width > 0 &&
            rect.height > 0;
        }

        if (!isSoldOut) {
          isSoldOut =
            cardText.some(text =>
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
    `Fashion一覧から${products.length}商品を取得しました`
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
    `Fashion詳細確認: ${product.productId}`
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
    function cleanText(text) {
      return String(text || '')
        .replace(/\s+/g, ' ')
        .trim();
    }

    function isVisible(element) {
      if (!element) {
        return false;
      }

      const style =
        window.getComputedStyle(
          element
        );

      const rect =
        element
          .getBoundingClientRect();

      return (
        style.display !== 'none' &&
        style.visibility !== 'hidden' &&
        Number(style.opacity) !== 0 &&
        rect.width > 0 &&
        rect.height > 0
      );
    }

    function isUnavailableControl(
      control
    ) {
      if (!control) {
        return true;
      }

      const classText =
        String(
          control.className || ''
        ).toLowerCase();

      const ariaDisabled =
        control.getAttribute(
          'aria-disabled'
        );

      const dataDisabled =
        control.getAttribute(
          'data-disabled'
        );

      const text =
        cleanText(
          control.innerText ||
          control.textContent
        ).toLowerCase();

      return (
        control.disabled === true ||
        control.hasAttribute(
          'disabled'
        ) ||
        ariaDisabled === 'true' ||
        dataDisabled === 'true' ||
        classText.includes(
          'disabled'
        ) ||
        classText.includes(
          'soldout'
        ) ||
        classText.includes(
          'sold-out'
        ) ||
        classText.includes(
          'unavailable'
        ) ||
        text.includes(
          'sold out'
        ) ||
        text.includes(
          '在庫切れ'
        ) ||
        text.includes(
          '売り切れ'
        )
      );
    }

    function getVariationContainer(
      control
    ) {
      const selectors = [
        'li',
        '[class*="variation"]',
        '[class*="variant"]',
        '[class*="option"]',
        '[class*="sku"]',
        '[class*="stock"]',
        '[class*="product"]',
        'tr'
      ];

      for (const selector of selectors) {
        const container =
          control.closest(selector);

        if (
          container &&
          container !== document.body
        ) {
          const text =
            cleanText(
              container.innerText
            );

          if (
            text &&
            text.length <= 400
          ) {
            return container;
          }
        }
      }

      return (
        control.parentElement ||
        control
      );
    }

    function getLabelForControl(
      control
    ) {
      const inputId =
        control.getAttribute('id');

      if (!inputId) {
        return '';
      }

      try {
        const label =
          document.querySelector(
            `label[for="${CSS.escape(inputId)}"]`
          );

        return cleanText(
          label?.innerText ||
          label?.textContent
        );
      } catch {
        return '';
      }
    }

    function getVariationLabel(
      control,
      container,
      index
    ) {
      const ignoredExactTexts = [
        'かごへ入れる',
        'カートに入れる',
        '購入する',
        'sold out',
        '在庫切れ',
        '売り切れ',
        '選択してください',
        '選択',
        '数量',
        'カラー',
        '色',
        'サイズ',
        'size',
        'color',
        '在庫あり',
        '購入可能'
      ];

      const candidates = [
        getLabelForControl(control),

        cleanText(
          control.getAttribute(
            'data-color'
          )
        ),

        cleanText(
          control.getAttribute(
            'data-size'
          )
        ),

        cleanText(
          control.getAttribute(
            'data-name'
          )
        ),

        cleanText(
          control.getAttribute(
            'data-label'
          )
        ),

        cleanText(
          control.getAttribute(
            'aria-label'
          )
        ),

        cleanText(
          control.getAttribute(
            'title'
          )
        )
      ];

      const containerLines =
        String(
          container.innerText || ''
        )
          .split('\n')
          .map(cleanText)
          .filter(Boolean);

      for (const line of containerLines) {
        candidates.push(line);
      }

      candidates.push(
        cleanText(control.value)
      );

      candidates.push(
        cleanText(
          control.innerText ||
          control.textContent
        )
      );

      const usableParts = [];

      for (const candidate of candidates) {
        const cleaned =
          cleanText(candidate);

        if (!cleaned) {
          continue;
        }

        const lower =
          cleaned.toLowerCase();

        if (
          ignoredExactTexts.some(
            ignored =>
              lower ===
              ignored.toLowerCase()
          )
        ) {
          continue;
        }

        if (
          lower === 'on' ||
          lower === 'off'
        ) {
          continue;
        }

        if (
          !usableParts.includes(
            cleaned
          )
        ) {
          usableParts.push(
            cleaned
          );
        }
      }

      if (usableParts.length > 0) {
        return usableParts
          .slice(0, 3)
          .join(' / ');
      }

      return `選択肢${index + 1}`;
    }

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
            text.includes('再入荷') ||
            text.includes('再販売') ||
            text.includes('販売予定') ||
            text.includes('入荷予定')
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

    /*
     * Fashion商品の
     * カラー・サイズ選択肢を取得
     */
    const controls = Array.from(
      document.querySelectorAll(
        [
          'button.btn_line',
          'button[class*="cart"]',
          'button[class*="stock"]',
          'button[class*="variant"]',
          'button[class*="variation"]',
          'input[type="radio"]',
          'input[type="button"]',
          'select option'
        ].join(',')
      )
    ).filter(control => {
      if (
        control.tagName === 'OPTION'
      ) {
        return Boolean(
          cleanText(
            control.textContent
          )
        );
      }

      return isVisible(control);
    });

    const variationMap =
      new Map();

    controls.forEach(
      (control, index) => {
        if (
          control.tagName === 'OPTION'
        ) {
          const label =
            cleanText(
              control.textContent
            );

          if (
            !label ||
            control.value === ''
          ) {
            return;
          }

          const lower =
            label.toLowerCase();

          if (
            lower.includes(
              '選択してください'
            )
          ) {
            return;
          }

          const available =
            !control.disabled &&
            !lower.includes(
              'sold out'
            ) &&
            !lower.includes(
              '在庫切れ'
            ) &&
            !lower.includes(
              '売り切れ'
            );

          const existing =
            variationMap.get(lower);

          if (existing) {
            existing.available =
              existing.available ||
              available;

            variationMap.set(
              lower,
              existing
            );
          } else {
            variationMap.set(
              lower,
              {
                label,
                available
              }
            );
          }

          return;
        }

        const container =
          getVariationContainer(
            control
          );

        const label =
          getVariationLabel(
            control,
            container,
            index
          );

        if (!label) {
          return;
        }

        const key =
          label.toLowerCase();

        const available =
          !isUnavailableControl(
            control
          );

        const existing =
          variationMap.get(key);

        if (existing) {
          existing.available =
            existing.available ||
            available;

          variationMap.set(
            key,
            existing
          );
        } else {
          variationMap.set(
            key,
            {
              label,
              available
            }
          );
        }
      }
    );

    return {
      productName,
      announcements,

      variations:
        Array.from(
          variationMap.values()
        )
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

function convertVariationsToState(
  variations
) {
  const result = {};

  for (const variation of variations || []) {
    const label =
      normalizeText(
        variation.label
      );

    if (!label) {
      continue;
    }

    const key =
      createVariationKey(label);

    result[key] = {
      label,

      available:
        Boolean(
          variation.available
        )
    };
  }

  return result;
}

function findRestockedVariations(
  previousProduct,
  currentVariations
) {
  if (
    !previousProduct
      ?.variationsInitialized
  ) {
    return [];
  }

  const previousVariations =
    sanitizeVariations(
      previousProduct.variations
    );

  const restocked = [];

  for (
    const current
    of currentVariations || []
  ) {
    const key =
      createVariationKey(
        current.label
      );

    const previous =
      previousVariations[key];

    if (
      previous &&
      previous.available === false &&
      current.available === true
    ) {
      restocked.push(current);
    }
  }

  return restocked;
}

function createVariationText(
  variations
) {
  if (
    !variations ||
    variations.length === 0
  ) {
    return '';
  }

  return variations
    .map(
      variation =>
        `- **${variation.label}**`
    )
    .join('\n');
}

function updateProductFromDetail(
  previousProduct,
  product,
  detail,
  announcement
) {
  return {
    ...previousProduct,

    productId:
      product.productId,

    productName:
      detail?.productName ||
      product.productName,

    isSoldOut:
      product.isSoldOut,

    advanceAnnouncement:
      announcement !== undefined
        ? announcement
        : (
            previousProduct
              ?.advanceAnnouncement ||
            ''
          ),

    variations:
      convertVariationsToState(
        detail?.variations || []
      ),

    variationsInitialized:
      true
  };
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

  const availableVariations =
    (detail?.variations || [])
      .filter(
        variation =>
          variation.available
      );

  const variationSection =
    availableVariations.length > 0
      ? (
`\n### 現在購入可能なカラー・サイズ\n\n` +
        `${createVariationText(
          availableVariations
        )}\n`
      )
      : '';

  const title =
    `🛒 Fashion 在庫復活！ ${displayName}`;

  const body =
`@${GITHUB_USERNAME}

## 🛒 Fashion商品の在庫が復活しました

**商品：${displayName}**

**変化：SOLD OUT → 購入可能**
${variationSection}
### 商品ページ

${productUrl}

確認時刻：${getJapanTime()}（日本時間）`;

  await createGitHubIssue(
    title,
    body
  );
}

async function notifyVariationRestock(
  product,
  detail,
  restockedVariations
) {
  const displayName =
    detail?.productName ||
    product.productName;

  const productUrl =
    buildProductUrl(
      product.productId
    );

  const title =
    `🎨 Fashion カラー・サイズ在庫復活！ ${displayName}`;

  const body =
`@${GITHUB_USERNAME}

## 🎨 Fashion商品のカラー・サイズ在庫が復活しました

**商品：${displayName}**

### 復活したカラー・サイズ

${createVariationText(
  restockedVariations
)}

### 商品ページ

${productUrl}

購入画面で、上記のカラー・サイズが **購入不可から購入可能に変わったこと** を検知しました。

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
    `📅 Fashion 再入荷予定！ ${displayName}`;

  const body =
`@${GITHUB_USERNAME}

## 📅 Fashion商品の再入荷予定

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

  /*
   * 同じ実行中に同じ商品詳細を
   * 複数回開かないためのキャッシュ
   */
  const detailCache =
    new Map();

  async function getCachedDetail(
    product
  ) {
    if (
      detailCache.has(
        product.productId
      )
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
      '=============================='
    );

    console.log(
      'Fashion Monitor開始'
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

    if (products.length === 0) {
      throw new Error(
        'Fashion一覧の商品を取得できませんでした。fashion-state.jsonは更新しません。'
      );
    }

    /*
     * 初回実行
     */
    if (!state.initialized) {
      console.log(
        '初回実行です。現在状態を基準として保存します。'
      );

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

          variations: {},

          variationsInitialized:
            false
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
     * 商品全体の
     * SOLD OUT → 購入可能
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

    const overallRestockedIds =
      new Set(
        restockedProducts.map(
          product =>
            product.productId
        )
      );

    console.log(
      `Fashion商品全体の在庫復活: ${restockedProducts.length}件`
    );

    for (
      const product
      of restockedProducts
    ) {
      let detail = null;

      try {
        detail =
          await getCachedDetail(
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

      if (detail) {
        const previous =
          previousProducts[
            product.productId
          ] || {};

        const announcement =
          getAdvanceAnnouncement(
            detail.announcements
          );

        previousProducts[
          product.productId
        ] = updateProductFromDetail(
          previous,
          product,
          detail,
          announcement
        );
      }

      await sleep(
        WAIT_BETWEEN_DETAIL_PAGES_MS
      );
    }

    /*
     * 再入荷案内とカラー・サイズ在庫を
     * 10商品ずつ確認
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
      index < Math.min(
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
      `Fashion詳細確認: ${detailBatch.length}商品`
    );

    for (
      const product
      of detailBatch
    ) {
      try {
        const detail =
          await getCachedDetail(
            product
          );

        const announcement =
          getAdvanceAnnouncement(
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

            variations: {},

            variationsInitialized:
              false
          };

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

        /*
         * カラー・サイズ単位の
         * 購入不可 → 購入可能を検出
         */
        const restockedVariations =
          findRestockedVariations(
            previous,
            detail.variations
          );

        /*
         * 商品全体の在庫復活通知を
         * 送った場合は重複通知しない
         */
        if (
          restockedVariations.length >
            0 &&
          !overallRestockedIds.has(
            product.productId
          )
        ) {
          console.log(
            `Fashionカラー・サイズ在庫復活: ` +
            `${product.productId} ` +
            `${restockedVariations
              .map(
                variation =>
                  variation.label
              )
              .join(', ')}`
          );

          await notifyVariationRestock(
            product,
            detail,
            restockedVariations
          );
        } else if (
          !previous
            .variationsInitialized
        ) {
          console.log(
            `Fashionカラー・サイズ初期状態を登録: ` +
            `${product.productId} ` +
            `${detail.productName || product.productName} ` +
            `(${detail.variations.length}件)`
          );
        }

        previousProducts[
          product.productId
        ] = updateProductFromDetail(
          previous,
          product,
          detail,
          announcement
        );
      } catch (error) {
        console.log(
          `Fashion詳細確認エラー: ` +
          `${product.productId} ` +
          `${error.message}`
        );
      }

      await sleep(
        WAIT_BETWEEN_DETAIL_PAGES_MS
      );
    }

    /*
     * 一覧ページの最新状態を保存
     *
     * 今回詳細確認しなかった商品の
     * variationsは消さずに維持する
     */
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
            .advanceAnnouncement ||
          '',

        variations:
          sanitizeVariations(
            previous.variations
          ),

        variationsInitialized:
          Boolean(
            previous
              .variationsInitialized
          )
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
      'Fashion Monitor終了'
    );
  } catch (error) {
    console.error(
      `Fashion監視エラー: ${error.stack}`
    );

    process.exitCode = 1;
  } finally {
    await browser.close();
  }
})();
