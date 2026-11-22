const { chromium } = require('playwright');
const fs = require('fs');

const LIST_URL = process.env.MINA_URL;
const GITHUB_USERNAME = process.env.GITHUB_ACTOR;

const PRODUCT_ID = 'FC0600YKPD';

const STATE_FILE =
  'restock-watch-state.json';

const BEFORE_FILE =
  'restock-watch-before.json';

const AFTER_FILE =
  'restock-watch-after.json';

const DIFF_FILE =
  'restock-watch-diff.json';

const PAGE_WAIT_MS = 12000;

if (!LIST_URL) {
  throw new Error(
    'MINA_URLが設定されていません。GitHub Actions Secretを確認してください。'
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

function loadState() {
  if (!fs.existsSync(STATE_FILE)) {
    return {
      initialized: false,
      previousStatus: '',
      beforeSnapshotSaved: false,
      afterSnapshotSaved: false,
      firstCheckedAt: '',
      lastCheckedAt: '',
      restockedAt: ''
    };
  }

  try {
    const loaded = JSON.parse(
      fs.readFileSync(
        STATE_FILE,
        'utf8'
      )
    );

    return {
      initialized:
        Boolean(loaded.initialized),

      previousStatus:
        loaded.previousStatus || '',

      beforeSnapshotSaved:
        Boolean(
          loaded.beforeSnapshotSaved
        ),

      afterSnapshotSaved:
        Boolean(
          loaded.afterSnapshotSaved
        ),

      firstCheckedAt:
        loaded.firstCheckedAt || '',

      lastCheckedAt:
        loaded.lastCheckedAt || '',

      restockedAt:
        loaded.restockedAt || ''
    };
  } catch (error) {
    console.log(
      `状態ファイルを読み込めませんでした: ${error.message}`
    );

    return {
      initialized: false,
      previousStatus: '',
      beforeSnapshotSaved: false,
      afterSnapshotSaved: false,
      firstCheckedAt: '',
      lastCheckedAt: '',
      restockedAt: ''
    };
  }
}

function saveState(state) {
  fs.writeFileSync(
    STATE_FILE,
    JSON.stringify(
      state,
      null,
      2
    ),
    'utf8'
  );

  console.log(
    `${STATE_FILE}を保存しました`
  );
}

function getProductUrl() {
  const listUrl =
    new URL(LIST_URL);

  return new URL(
    `/online_store/${PRODUCT_ID}`,
    listUrl.origin
  ).href;
}

function getSafePath(urlText) {
  try {
    const url =
      new URL(urlText);

    return (
      url.pathname +
      url.search
    );
  } catch {
    return urlText;
  }
}

function safeJsonParse(text) {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

function detectStatus(variants) {
  if (
    !Array.isArray(variants) ||
    variants.length === 0
  ) {
    return 'unknown';
  }

  const availableVariants =
    variants.filter(
      variant =>
        variant.disabled === false
    );

  if (
    availableVariants.length > 0
  ) {
    return 'available';
  }

  return 'soldout';
}

function sanitizeForComparison(value) {
  if (value === null) {
    return null;
  }

  if (Array.isArray(value)) {
    return value.map(
      sanitizeForComparison
    );
  }

  if (
    typeof value === 'object'
  ) {
    const result = {};

    const ignoredKeys = new Set([
      'checkedAt',
      'createdAt',
      'updatedAt',
      'publishedAt',
      'lastCheckedAt'
    ]);

    for (
      const [
        key,
        child
      ]
      of Object.entries(value)
    ) {
      if (
        ignoredKeys.has(key)
      ) {
        continue;
      }

      result[key] =
        sanitizeForComparison(child);
    }

    return result;
  }

  return value;
}

function createDifferences(
  before,
  after,
  path = '',
  differences = []
) {
  if (
    differences.length >= 5000
  ) {
    return differences;
  }

  if (
    before === after
  ) {
    return differences;
  }

  const beforeIsObject =
    before !== null &&
    typeof before === 'object';

  const afterIsObject =
    after !== null &&
    typeof after === 'object';

  if (
    !beforeIsObject ||
    !afterIsObject
  ) {
    differences.push({
      path:
        path || '(root)',

      before:
        before === undefined
          ? '__MISSING__'
          : before,

      after:
        after === undefined
          ? '__MISSING__'
          : after
    });

    return differences;
  }

  if (
    Array.isArray(before) ||
    Array.isArray(after)
  ) {
    if (
      !Array.isArray(before) ||
      !Array.isArray(after)
    ) {
      differences.push({
        path:
          path || '(root)',
        before,
        after
      });

      return differences;
    }

    const maxLength =
      Math.max(
        before.length,
        after.length
      );

    for (
      let index = 0;
      index < maxLength;
      index++
    ) {
      createDifferences(
        before[index],
        after[index],
        `${path}[${index}]`,
        differences
      );
    }

    return differences;
  }

  const keys =
    new Set([
      ...Object.keys(before),
      ...Object.keys(after)
    ]);

  for (const key of keys) {
    const childPath =
      path
        ? `${path}.${key}`
        : key;

    createDifferences(
      before[key],
      after[key],
      childPath,
      differences
    );

    if (
      differences.length >= 5000
    ) {
      break;
    }
  }

  return differences;
}

function findInterestingDifferences(
  differences
) {
  const pattern =
    /stock|inventory|quantity|available|availability|soldout|disabled|sku|variant|current|color|size|width/i;

  return differences.filter(
    difference =>
      pattern.test(
        difference.path
      )
  );
}

function findNumericDifferences(
  differences
) {
  return differences.filter(
    difference =>
      typeof difference.before ===
        'number' &&
      typeof difference.after ===
        'number' &&
      difference.before !==
        difference.after
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
          'restock-watch'
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
    'GitHub通知を作成しました'
  );

  return true;
}

async function captureSnapshot(
  browser
) {
  const page =
    await browser.newPage({
      viewport: {
        width: 1440,
        height: 1200
      }
    });

  const networkTasks = [];

  /*
   * 商品ページを通常表示したときの
   * Fetch/XHRを保存します。
   *
   * かごへ入れる操作は行いません。
   * add.jsonも除外します。
   */
  page.on(
    'response',
    response => {
      const task =
        (async () => {
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

          const path =
            getSafePath(
              response.url()
            );

          if (
            path.includes(
              'add.json'
            )
          ) {
            return null;
          }

          let bodyText = '';

          try {
            bodyText =
              await response.text();
          } catch (error) {
            return {
              resourceType,
              method:
                request.method(),
              path,
              status:
                response.status(),
              readError:
                error.message
            };
          }

          const parsedJson =
            safeJsonParse(bodyText);

          return {
            resourceType,

            method:
              request.method(),

            path,

            status:
              response.status(),

            contentType:
              response.headers()[
                'content-type'
              ] || '',

            requestPostData:
              request.postData() ||
              null,

            body:
              parsedJson !== null
                ? parsedJson
                : bodyText
          };
        })();

      networkTasks.push(task);
    }
  );

  try {
    const checkedAt =
      getJapanTime();

    console.log(
      `商品ページを開きます: ${PRODUCT_ID}`
    );

    await page.goto(
      getProductUrl(),
      {
        waitUntil:
          'domcontentloaded',
        timeout: 60000
      }
    );

    await page.waitForTimeout(
      PAGE_WAIT_MS
    );

    const pageData =
      await page.evaluate(
        productId => {
          const heading =
            document.querySelector(
              'h1'
            ) ||
            document.querySelector(
              'h2'
            );

          const productName =
            heading
              ?.innerText
              ?.trim() ||
            document.title;

          const buttons =
            Array.from(
              document.querySelectorAll(
                'button.btn_line'
              )
            );

          const variants = [];

          for (
            const button
            of buttons
          ) {
            const container =
              button.closest('li') ||
              button
                .parentElement
                ?.parentElement ||
              button.parentElement;

            if (!container) {
              continue;
            }

            const lines =
              container.innerText
                .split('\n')
                .map(text =>
                  text.trim()
                )
                .filter(Boolean);

            const width =
              button.innerText
                .trim();

            const color =
              lines.find(text =>
                text !== width &&
                text !== 'カラー' &&
                text !==
                  '生地巾(cm)' &&
                text !==
                  'かごへ入れる' &&
                !/^\d+(\.\d+)?$/i
                  .test(text) &&
                !/^\d+(\.\d+)?CM$/i
                  .test(text)
              ) || '';

            variants.push({
              color,
              width,
              disabled:
                button.disabled,

              buttonText:
                button.innerText
                  .trim(),

              containerText:
                container.innerText
                  .replace(
                    /\s+/g,
                    ' '
                  )
                  .trim(),

              buttonAttributes:
                Object.fromEntries(
                  Array.from(
                    button.attributes
                  ).map(
                    attribute => [
                      attribute.name,
                      attribute.value
                    ]
                  )
                ),

              containerAttributes:
                Object.fromEntries(
                  Array.from(
                    container.attributes
                  ).map(
                    attribute => [
                      attribute.name,
                      attribute.value
                    ]
                  )
                )
            });
          }

          const scripts =
            Array.from(
              document.scripts
            ).map(
              (
                script,
                index
              ) => ({
                index,

                src:
                  script.src ||
                  '',

                type:
                  script.type ||
                  '',

                text:
                  script.src
                    ? ''
                    : (
                        script.textContent ||
                        ''
                      )
              })
            );

          const localStorageData =
            {};

          for (
            let index = 0;
            index <
            localStorage.length;
            index++
          ) {
            const key =
              localStorage.key(
                index
              );

            localStorageData[key] =
              localStorage.getItem(
                key
              );
          }

          const sessionStorageData =
            {};

          for (
            let index = 0;
            index <
            sessionStorage.length;
            index++
          ) {
            const key =
              sessionStorage.key(
                index
              );

            sessionStorageData[key] =
              sessionStorage.getItem(
                key
              );
          }

          const dataAttributes = [];

          for (
            const element
            of Array.from(
              document.querySelectorAll(
                '*'
              )
            )
          ) {
            const attributes =
              Array.from(
                element.attributes ||
                []
              );

            const dataValues =
              attributes.filter(
                attribute =>
                  attribute.name
                    .startsWith(
                      'data-'
                    )
              );

            if (
              dataValues.length === 0
            ) {
              continue;
            }

            dataAttributes.push({
              tag:
                element.tagName,

              text:
                (
                  element.innerText ||
                  ''
                )
                  .replace(
                    /\s+/g,
                    ' '
                  )
                  .trim()
                  .slice(
                    0,
                    500
                  ),

              attributes:
                Object.fromEntries(
                  dataValues.map(
                    attribute => [
                      attribute.name,
                      attribute.value
                    ]
                  )
                )
            });
          }

          return {
            productId,

            productName,

            variants,

            scripts,

            productRelatedScripts:
              scripts.filter(
                script =>
                  script.text.includes(
                    productId
                  )
              ),

            localStorage:
              localStorageData,

            sessionStorage:
              sessionStorageData,

            dataAttributes,

            windowKeys:
              Object.keys(
                window
              ).sort()
          };
        },
        PRODUCT_ID
      );

    const html =
      await page.content();

    await page.waitForTimeout(
      1000
    );

    const networkResponses =
      (
        await Promise.all(
          networkTasks
        )
      ).filter(Boolean);

    const status =
      detectStatus(
        pageData.variants
      );

    return {
      checkedAt,

      productId:
        PRODUCT_ID,

      productName:
        pageData.productName,

      detectedStatus:
        status,

      cartActionPerformed:
        false,

      variants:
        pageData.variants,

      localStorage:
        pageData.localStorage,

      sessionStorage:
        pageData.sessionStorage,

      dataAttributes:
        pageData.dataAttributes,

      windowKeys:
        pageData.windowKeys,

      scripts:
        pageData.scripts,

      productRelatedScripts:
        pageData
          .productRelatedScripts,

      html,

      networkResponses
    };

  } finally {
    await page.close();
  }
}

(async () => {
  const state =
    loadState();

  const browser =
    await chromium.launch({
      headless: true
    });

  try {
    console.log(
      '=============================='
    );

    console.log(
      '再販自動観測'
    );

    console.log(
      `商品ID: ${PRODUCT_ID}`
    );

    console.log(
      'カート操作: なし'
    );

    console.log(
      '=============================='
    );

    const snapshot =
      await captureSnapshot(
        browser
      );

    const currentStatus =
      snapshot.detectedStatus;

    const previousStatus =
      state.previousStatus;

    console.log(
      `前回状態: ${
        previousStatus ||
        '未登録'
      }`
    );

    console.log(
      `今回状態: ${currentStatus}`
    );

    console.log(
      `カラー数: ${
        snapshot.variants.length
      }`
    );

    console.log(
      `Fetch/XHR: ${
        snapshot
          .networkResponses
          .length
      }件`
    );

    /*
     * 初回実行
     */
    if (!state.initialized) {
      state.initialized = true;
      state.previousStatus =
        currentStatus;
      state.firstCheckedAt =
        snapshot.checkedAt;
      state.lastCheckedAt =
        snapshot.checkedAt;

      /*
       * 現在SOLD OUTなら、
       * 再販前の完全データとして保存
       */
      if (
        currentStatus ===
        'soldout'
      ) {
        fs.writeFileSync(
          BEFORE_FILE,
          JSON.stringify(
            snapshot,
            null,
            2
          ),
          'utf8'
        );

        state.beforeSnapshotSaved =
          true;

        console.log(
          'SOLD OUT時の完全スナップショットを保存しました'
        );
      }

      saveState(state);

      console.log(
        '初回基準値として保存しました'
      );

      return;
    }

    /*
     * BEFOREがまだ無い状態で
     * SOLD OUTを確認した場合
     */
    if (
      currentStatus ===
        'soldout' &&
      !state.beforeSnapshotSaved
    ) {
      fs.writeFileSync(
        BEFORE_FILE,
        JSON.stringify(
          snapshot,
          null,
          2
        ),
        'utf8'
      );

      state.beforeSnapshotSaved =
        true;

      console.log(
        'SOLD OUT時の完全スナップショットを保存しました'
      );
    }

    /*
     * SOLD OUTから購入可能へ変化
     */
    const restocked =
      previousStatus ===
        'soldout' &&
      currentStatus ===
        'available';

    if (restocked) {
      const restockedAt =
        snapshot.checkedAt;

      console.log(
        '★ 再販を検知しました'
      );

      /*
       * 再販後スナップショット
       */
      fs.writeFileSync(
        AFTER_FILE,
        JSON.stringify(
          snapshot,
          null,
          2
        ),
        'utf8'
      );

      state.afterSnapshotSaved =
        true;
      state.restockedAt =
        restockedAt;

      /*
       * SOLD OUT時データと
       * 再販後データを比較
       */
      let beforeSnapshot = null;

      if (
        fs.existsSync(
          BEFORE_FILE
        )
      ) {
        try {
          beforeSnapshot =
            JSON.parse(
              fs.readFileSync(
                BEFORE_FILE,
                'utf8'
              )
            );
        } catch (error) {
          console.log(
            `再販前データを読み込めませんでした: ${error.message}`
          );
        }
      }

      if (beforeSnapshot) {
        const safeBefore =
          sanitizeForComparison(
            beforeSnapshot
          );

        const safeAfter =
          sanitizeForComparison(
            snapshot
          );

        const differences =
          createDifferences(
            safeBefore,
            safeAfter
          );

        const interestingDifferences =
          findInterestingDifferences(
            differences
          );

        const numericDifferences =
          findNumericDifferences(
            differences
          );

        const diffResult = {
          productId:
            PRODUCT_ID,

          beforeStatus:
            beforeSnapshot
              .detectedStatus,

          afterStatus:
            snapshot
              .detectedStatus,

          beforeCheckedAt:
            beforeSnapshot
              .checkedAt,

          afterCheckedAt:
            snapshot
              .checkedAt,

          totalDifferenceCount:
            differences.length,

          interestingDifferenceCount:
            interestingDifferences
              .length,

          numericDifferenceCount:
            numericDifferences.length,

          interestingDifferences,

          numericDifferences,

          allDifferences:
            differences
        };

        fs.writeFileSync(
          DIFF_FILE,
          JSON.stringify(
            diffResult,
            null,
            2
          ),
          'utf8'
        );

        console.log(
          `全差分: ${differences.length}件`
        );

        console.log(
          `在庫関連候補: ${interestingDifferences.length}件`
        );

        console.log(
          `数値変化: ${numericDifferences.length}件`
        );
      }

      const availableVariants =
        snapshot.variants.filter(
          variant =>
            variant.disabled ===
            false
        );

      const variantText =
        availableVariants.length > 0
          ? availableVariants
              .map(
                variant =>
                  `- ${variant.color}` +
                  ` / 生地巾 ` +
                  `${variant.width}cm`
              )
              .join('\n')
          : '- 取得できませんでした';

      await createGitHubIssue(
        '🧪 再販検知・完全データ取得',
`@${GITHUB_USERNAME}

## FC0595BPGLの再販を検知しました

### 購入可能カラー

${variantText}

### 検知時刻

${restockedAt}（日本時間）

### 調査データ

- 再販前：${BEFORE_FILE}
- 再販後：${AFTER_FILE}
- 全差分：${DIFF_FILE}
- カート操作：なし

SOLD OUT時と再販後の完全スナップショットを保存しました。`
      );
    }

    state.previousStatus =
      currentStatus;

    state.lastCheckedAt =
      snapshot.checkedAt;

    saveState(state);

    console.log(
      '=============================='
    );

    console.log(
      '今回の確認終了'
    );

    console.log(
      `現在状態: ${currentStatus}`
    );

    console.log(
      '=============================='
    );

  } catch (error) {
    console.error(
      `再販観測エラー: ${error.stack}`
    );

    process.exitCode = 1;

  } finally {
    await browser.close();
  }
})();
