const { chromium } = require('playwright');
const fs = require('fs');

const LIST_URL = process.env.MINA_URL;
const OUTPUT_FILE = 'network-test-result.json';

// 今回はSOLD OUT商品を最大3件だけ調べる
const MAX_PRODUCTS = 3;

const SEARCH_WORDS = [
  'stock',
  'inventory',
  'quantity',
  'available',
  'availability',
  'sku',
  'variant'
];

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

function safePath(urlText) {
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

function createSnippet(
  text,
  index
) {
  const normalized =
    text.replace(/\s+/g, ' ');

  return normalized.slice(
    Math.max(0, index - 150),
    Math.min(
      normalized.length,
      index + 300
    )
  );
}

function findInterestingValues(text) {
  const lower =
    text.toLowerCase();

  const findings = [];

  /*
   * stock / inventory / quantityなどを探す
   */
  for (const word of SEARCH_WORDS) {
    let startIndex = 0;

    while (true) {
      const index =
        lower.indexOf(
          word.toLowerCase(),
          startIndex
        );

      if (index < 0) {
        break;
      }

      findings.push({
        type: 'keyword',
        keyword: word,
        snippet:
          createSnippet(
            text,
            index
          )
      });

      startIndex =
        index + word.length;

      /*
       * 同じ単語が大量にある場合の
       * ログ肥大化防止
       */
      if (
        findings.filter(
          item =>
            item.keyword === word
        ).length >= 5
      ) {
        break;
      }
    }
  }

  /*
   * よくある在庫JSON表現を重点的に探す
   *
   * 例:
   * "stock": 0
   * "quantity": 0
   * "inventory": 0
   */
  const patterns = [
    /["']?stock["']?\s*[:=]\s*(-?\d+)/gi,
    /["']?inventory["']?\s*[:=]\s*(-?\d+)/gi,
    /["']?quantity["']?\s*[:=]\s*(-?\d+)/gi,
    /["']?availableQuantity["']?\s*[:=]\s*(-?\d+)/gi,
    /["']?availability["']?\s*[:=]\s*["']?([^"',}\s]+)/gi,
    /["']?available["']?\s*[:=]\s*(true|false|\d+)/gi
  ];

  for (const pattern of patterns) {
    let match;

    while (
      (
        match =
          pattern.exec(text)
      ) !== null
    ) {
      findings.push({
        type: 'value',
        expression:
          match[0],
        value:
          match[1],
        snippet:
          createSnippet(
            text,
            match.index
          )
      });

      if (
        findings.filter(
          item =>
            item.type === 'value'
        ).length >= 30
      ) {
        break;
      }
    }
  }

  return findings;
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

  const responsePromises = [];

  /*
   * カート操作は一切していません。
   * ページを普通に開いた時の
   * Fetch/XHRだけ観察します。
   */
  page.on(
    'response',
    response => {
      const promise =
        (async () => {
          const type =
            response
              .request()
              .resourceType();

          if (
            type !== 'xhr' &&
            type !== 'fetch'
          ) {
            return null;
          }

          const path =
            safePath(
              response.url()
            );

          /*
           * カート系通信は除外
           */
          if (
            path.includes(
              'add.json'
            )
          ) {
            return null;
          }

          let text = '';

          try {
            text =
              await response.text();
          } catch {
            return null;
          }

          /*
           * 最大1MBだけ調査
           */
          const safeText =
            text.slice(
              0,
              1000000
            );

          const findings =
            findInterestingValues(
              safeText
            );

          const interestingPath =
            /product|sku|stock|inventory|quantity|available|variant/i
              .test(path);

          if (
            findings.length === 0 &&
            !interestingPath
          ) {
            return null;
          }

          return {
            method:
              response
                .request()
                .method(),

            path,

            status:
              response.status(),

            contentType:
              response.headers()[
                'content-type'
              ] || '',

            findings
          };
        })();

      responsePromises.push(
        promise
      );
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

    await page.waitForTimeout(
      8000
    );

    /*
     * 詳細ページ上のカラー状態も取得
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

          colors.push({
            text:
              container.innerText
                .replace(
                  /\s+/g,
                  ' '
                )
                .trim(),

            disabled:
              button.disabled,

            buttonText:
              button.innerText
                .trim()
          });
        }

        /*
         * HTML内にstock等が
         * 埋め込まれていないかも調査
         */
        const html =
          document.documentElement
            .innerHTML;

        return {
          colors,

          htmlFindings:
            []
        };
      });

    /*
     * ページHTMLもNode側で調査
     */
    const html =
      await page.content();

    pageData.htmlFindings =
      findInterestingValues(
        html.slice(
          0,
          2000000
        )
      );

    await page.waitForTimeout(
      1000
    );

    const responses =
      (
        await Promise.all(
          responsePromises
        )
      ).filter(Boolean);

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

      htmlFindings:
        pageData.htmlFindings,

      networkResponses:
        responses
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
      'SOLD OUT商品の在庫0候補調査'
    );

    console.log(
      'カート操作は行いません'
    );

    console.log(
      '=============================='
    );

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
     * 一覧からSOLD OUT商品だけ抽出
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

          if (!soldOutElement) {
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
            style.display !== 'none' &&
            style.visibility !== 'hidden' &&
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

    /*
     * 今回は最大3件だけ調査
     */
    const targets =
      products.slice(
        0,
        MAX_PRODUCTS
      );

    console.log(
      `今回調査する商品: ${targets.length}件`
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

      /*
       * ログにも候補を表示
       */
      console.log(
        '------------------------------'
      );

      console.log(
        `商品: ${result.productId}`
      );

      console.log(
        `HTML候補: ${result.htmlFindings.length}件`
      );

      console.log(
        `通信候補: ${result.networkResponses.length}件`
      );

      const zeroCandidates = [];

      for (
        const finding
        of result.htmlFindings
      ) {
        if (
          finding.type ===
            'value' &&
          String(
            finding.value
          ) === '0'
        ) {
          zeroCandidates.push({
            source: 'HTML',
            ...finding
          });
        }
      }

      for (
        const response
        of result.networkResponses
      ) {
        for (
          const finding
          of response.findings || []
        ) {
          if (
            finding.type ===
              'value' &&
            String(
              finding.value
            ) === '0'
          ) {
            zeroCandidates.push({
              source:
                response.path,
              ...finding
            });
          }
        }
      }

      console.log(
        `★ 在庫0候補: ${zeroCandidates.length}件`
      );

      if (
        zeroCandidates.length > 0
      ) {
        console.log(
          JSON.stringify(
            zeroCandidates,
            null,
            2
          )
        );
      }

      await new Promise(
        resolve =>
          setTimeout(
            resolve,
            1000
          )
      );
    }

    /*
     * URL全体は保存せず、
     * 商品ID・候補情報だけ保存
     */
    const output = {
      checkedAt:
        getJapanTime(),

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
      `${OUTPUT_FILE}を作成しました`
    );

    console.log(
      '調査終了'
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
