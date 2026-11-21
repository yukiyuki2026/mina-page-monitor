const { chromium } = require('playwright');
const fs = require('fs');

const LIST_URL = process.env.MINA_URL;
const OUTPUT_FILE = 'network-test-result.json';

// SOLD OUT商品を最大3件確認
const MAX_PRODUCTS = 3;

if (!LIST_URL) {
  throw new Error(
    'MINA_URLが設定されていません'
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

function getSafePath(urlText) {
  try {
    const url = new URL(urlText);

    return (
      url.pathname +
      url.search
    );
  } catch {
    return '';
  }
}

async function inspectProduct(
  browser,
  product
) {
  const page =
    await browser.newPage({
      viewport: {
        width: 1440,
        height: 1200
      }
    });

  const apiResponses = [];

  /*
   * /api/products のJSON全文を取得
   *
   * かごへ入れる操作はしない
   * add.jsonも呼ばない
   */
  page.on(
    'response',
    response => {
      const requestPath =
        getSafePath(
          response.url()
        );

      if (
        !requestPath.startsWith(
          '/api/products?'
        )
      ) {
        return;
      }

      const task =
        (async () => {
          try {
            const contentType =
              response.headers()[
                'content-type'
              ] || '';

            if (
              !contentType.includes(
                'application/json'
              )
            ) {
              return;
            }

            const json =
              await response.json();

            apiResponses.push({
              method:
                response
                  .request()
                  .method(),

              path:
                requestPath,

              status:
                response.status(),

              json
            });

          } catch (error) {
            apiResponses.push({
              method:
                response
                  .request()
                  .method(),

              path:
                requestPath,

              status:
                response.status(),

              error:
                error.message
            });
          }
        })();

      /*
       * Promise rejectionを防止
       */
      task.catch(() => {});
    }
  );

  try {
    console.log(
      `調査開始: ${product.productId}`
    );

    await page.goto(
      product.url,
      {
        waitUntil:
          'domcontentloaded',

        timeout: 60000
      }
    );

    /*
     * API通信完了待ち
     */
    await page.waitForTimeout(
      10000
    );

    /*
     * 画面上のカラー状態も保存
     */
    const pageData =
      await page.evaluate(() => {
        const buttons =
          Array.from(
            document.querySelectorAll(
              'button.btn_line'
            )
          );

        const colors = [];

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

          const texts =
            container.innerText
              .split('\n')
              .map(text =>
                text.trim()
              )
              .filter(Boolean);

          const width =
            button.innerText.trim();

          const color =
            texts.find(text =>
              text !== width &&
              text !== 'カラー' &&
              text !== '生地巾(cm)' &&
              text !==
                'かごへ入れる' &&
              !/^\d+$/.test(text) &&
              !/^\d+(\.\d+)?CM$/i.test(
                text
              )
            ) || '';

          colors.push({
            color,
            width,
            disabled:
              button.disabled
          });
        }

        return {
          colors
        };
      });

    console.log(
      `商品: ${product.productId}`
    );

    console.log(
      `カラー数: ${pageData.colors.length}`
    );

    console.log(
      `/api/products取得数: ${apiResponses.length}`
    );

    /*
     * JSON内の0を簡易集計
     */
    const zeroValues = [];

    function searchZeros(
      value,
      path = ''
    ) {
      if (
        value === null ||
        value === undefined
      ) {
        return;
      }

      if (
        typeof value === 'number'
      ) {
        if (value === 0) {
          zeroValues.push({
            path,
            value
          });
        }

        return;
      }

      if (
        Array.isArray(value)
      ) {
        value.forEach(
          (item, index) =>
            searchZeros(
              item,
              `${path}[${index}]`
            )
        );

        return;
      }

      if (
        typeof value === 'object'
      ) {
        for (
          const [
            key,
            child
          ]
          of Object.entries(value)
        ) {
          const childPath =
            path
              ? `${path}.${key}`
              : key;

          searchZeros(
            child,
            childPath
          );
        }
      }
    }

    for (
      const apiResponse
      of apiResponses
    ) {
      if (apiResponse.json) {
        searchZeros(
          apiResponse.json
        );
      }
    }

    console.log(
      `JSON内の数値0: ${zeroValues.length}件`
    );

    if (
      zeroValues.length > 0
    ) {
      console.log(
        '0になっているJSONパス:'
      );

      console.log(
        JSON.stringify(
          zeroValues.slice(
            0,
            100
          ),
          null,
          2
        )
      );
    }

    return {
      productId:
        product.productId,

      productName:
        product.productName,

      listState:
        'SOLD OUT',

      checkedAt:
        getJapanTime(),

      colors:
        pageData.colors,

      zeroValues,

      /*
       * ★ここに/api/productsの
       * JSON全文が入る
       */
      apiProductsResponses:
        apiResponses
    };

  } finally {
    await page.close();
  }
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

  try {
    console.log(
      '=============================='
    );

    console.log(
      '/api/products JSON全文調査'
    );

    console.log(
      'カート操作は行いません'
    );

    console.log(
      '=============================='
    );

    /*
     * Fabric一覧
     */
    await listPage.goto(
      LIST_URL,
      {
        waitUntil:
          'domcontentloaded',

        timeout: 60000
      }
    );

    await listPage.waitForTimeout(
      15000
    );

    /*
     * SOLD OUT商品を抽出
     */
    const products =
      await listPage.evaluate(() => {
        const cards =
          Array.from(
            document.querySelectorAll(
              'div[id^="item-FC"]'
            )
          );

        const result = [];

        for (
          const card
          of cards
        ) {
          const productId =
            card.id
              .replace(
                'item-',
                ''
              )
              .trim();

          if (
            !productId.startsWith(
              'FC'
            )
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

          const soldOutElement =
            card.querySelector(
              '[class*="soldout"]'
            );

          if (
            !soldOutElement
          ) {
            continue;
          }

          const style =
            window.getComputedStyle(
              soldOutElement
            );

          const rect =
            soldOutElement
              .getBoundingClientRect();

          const isSoldOut =
            style.display !==
              'none' &&
            style.visibility !==
              'hidden' &&
            Number(
              style.opacity
            ) !== 0 &&
            rect.width > 0 &&
            rect.height > 0;

          if (!isSoldOut) {
            continue;
          }

          const image =
            card.querySelector(
              'img'
            );

          result.push({
            productId,

            productName:
              image
                ?.getAttribute(
                  'alt'
                )
                ?.trim() ||
              productId,

            url:
              link.href
          });
        }

        return result;
      });

    console.log(
      `現在のSOLD OUT: ${products.length}商品`
    );

    const targets =
      products.slice(
        0,
        MAX_PRODUCTS
      );

    console.log(
      `今回調査: ${targets.length}商品`
    );

    const results = [];

    for (
      const product
      of targets
    ) {
      const result =
        await inspectProduct(
          browser,
          product
        );

      results.push(
        result
      );

      console.log(
        '------------------------------'
      );

      console.log(
        `${result.productId}`
      );

      console.log(
        `API: ${result.apiProductsResponses.length}件`
      );

      console.log(
        `数値0: ${result.zeroValues.length}件`
      );

      console.log(
        '------------------------------'
      );

      await new Promise(
        resolve =>
          setTimeout(
            resolve,
            1000
          )
      );
    }

    const output = {
      checkedAt:
        getJapanTime(),

      purpose:
        'SOLD OUT時の/api/products JSON全文取得',

      targetCount:
        results.length,

      products:
        results
    };

    fs.writeFileSync(
      OUTPUT_FILE,
      JSON.stringify(
        output,
        null,
        2
      ),
      'utf8'
    );

    console.log(
      '=============================='
    );

    console.log(
      `${OUTPUT_FILE}を保存しました`
    );

    console.log(
      '/api/products JSON全文取得完了'
    );

    console.log(
      '=============================='
    );

  } catch (error) {
    console.error(
      `調査エラー: ${error.stack}`
    );

    process.exitCode = 1;

  } finally {
    await browser.close();
  }
})();
