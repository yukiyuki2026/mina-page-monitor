const { chromium } = require('playwright');
const fs = require('fs');

const LIST_URL = process.env.MINA_URL;

const PRODUCT_ID = 'FC0608YWST';

const OUTPUT_FILE =
  'network-full-snapshot.json';

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

(async () => {
  const browser =
    await chromium.launch({
      headless: true
    });

  const page =
    await browser.newPage({
      viewport: {
        width: 1440,
        height: 1200
      }
    });

  const capturedResponses = [];

  /*
   * Fetch / XHR のResponseをできるだけ広く保存
   *
   * カート操作は一切行わない。
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
            return;
          }

          const path =
            getSafePath(
              response.url()
            );

          /*
           * 念のためカート追加APIは除外
           */
          if (
            path.includes(
              'add.json'
            )
          ) {
            return;
          }

          let bodyText = '';

          try {
            bodyText =
              await response.text();
          } catch (error) {
            capturedResponses.push({
              resourceType,
              method:
                request.method(),
              path,
              status:
                response.status(),
              readError:
                error.message
            });

            return;
          }

          /*
           * JSONならJSONとして保存。
           * JSONでなければ文字列として保存。
           */
          const parsedJson =
            safeJsonParse(
              bodyText
            );

          capturedResponses.push({
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
          });
        })();

      task.catch(
        error => {
          console.log(
            `通信取得エラー: ${error.message}`
          );
        }
      );
    }
  );

  try {
    console.log(
      '=============================='
    );

    console.log(
      '完全スナップショット取得開始'
    );

    console.log(
      `商品ID: ${PRODUCT_ID}`
    );

    console.log(
      'カート操作は行いません'
    );

    console.log(
      '=============================='
    );

    const baseUrl =
      new URL(
        LIST_URL
      ).origin;

    const productUrl =
      `${baseUrl}/online_store/${PRODUCT_ID}`;

    /*
     * 商品ページを普通に開くだけ
     */
    await page.goto(
      productUrl,
      {
        waitUntil:
          'domcontentloaded',

        timeout:
          60000
      }
    );

    /*
     * 動的データが読み込まれるのを待つ
     */
    await page.waitForTimeout(
      12000
    );

    /*
     * レンダリング後HTML全文
     */
    const html =
      await page.content();

    /*
     * DOM上のscript全文
     */
    const scripts =
      await page.evaluate(
        () =>
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
          )
      );

    /*
     * Local Storage
     */
    const localStorageData =
      await page.evaluate(
        () => {
          const result = {};

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

            result[key] =
              localStorage.getItem(
                key
              );
          }

          return result;
        }
      );

    /*
     * Session Storage
     */
    const sessionStorageData =
      await page.evaluate(
        () => {
          const result = {};

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

            result[key] =
              sessionStorage.getItem(
                key
              );
          }

          return result;
        }
      );

    /*
     * カラー・生地巾・disabled状態
     */
    const variantData =
      await page.evaluate(
        () => {
          const result = [];

          const buttons =
            Array.from(
              document.querySelectorAll(
                'button.btn_line'
              )
            );

          for (
            const button
            of buttons
          ) {
            const container =
              button.closest(
                'li'
              ) ||
              button
                .parentElement
                ?.parentElement ||
              button.parentElement;

            if (!container) {
              continue;
            }

            result.push({
              containerText:
                container.innerText
                  .replace(
                    /\s+/g,
                    ' '
                  )
                  .trim(),

              buttonText:
                button.innerText
                  .trim(),

              disabled:
                button.disabled,

              className:
                button.className,

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

          return result;
        }
      );

    /*
     * data-*属性のある要素
     */
    const dataAttributes =
      await page.evaluate(
        () => {
          const items = [];

          const elements =
            Array.from(
              document.querySelectorAll(
                '*'
              )
            );

          for (
            const element
            of elements
          ) {
            const attributes =
              Array.from(
                element.attributes ||
                []
              );

            const dataAttrs =
              attributes.filter(
                attr =>
                  attr.name.startsWith(
                    'data-'
                  )
              );

            if (
              dataAttrs.length === 0
            ) {
              continue;
            }

            items.push({
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
                  dataAttrs.map(
                    attr => [
                      attr.name,
                      attr.value
                    ]
                  )
                )
            });
          }

          return items;
        }
      );

    /*
     * Windowに存在するキーの一覧。
     *
     * Windowオブジェクトそのものを
     * JSON化すると循環参照で失敗するため、
     * キー一覧を取得する。
     */
    const windowKeys =
      await page.evaluate(
        () =>
          Object.keys(
            window
          ).sort()
      );

    /*
     * 商品IDを含むscriptを別途抽出
     */
    const productRelatedScripts =
      scripts.filter(
        script =>
          script.text.includes(
            PRODUCT_ID
          )
      );

    /*
     * Fetch/XHRの完了待ち
     */
    await page.waitForTimeout(
      2000
    );

    /*
     * 一つの完全スナップショットとして保存
     */
    const snapshot = {
      checkedAt:
        getJapanTime(),

      productId:
        PRODUCT_ID,

      expectedState:
        'SOLD OUT',

      cartActionPerformed:
        false,

      variantData,

      localStorage:
        localStorageData,

      sessionStorage:
        sessionStorageData,

      dataAttributes,

      windowKeys,

      scripts,

      productRelatedScripts,

      html,

      networkResponses:
        capturedResponses
    };

    fs.writeFileSync(
      OUTPUT_FILE,

      JSON.stringify(
        snapshot,
        null,
        2
      ),

      'utf8'
    );

    console.log(
      '=============================='
    );

    console.log(
      '完全スナップショット取得成功'
    );

    console.log(
      `商品ID: ${PRODUCT_ID}`
    );

    console.log(
      `variantData: ${variantData.length}件`
    );

    console.log(
      `Fetch/XHR: ${capturedResponses.length}件`
    );

    console.log(
      `script: ${scripts.length}件`
    );

    console.log(
      `商品ID関連script: ${productRelatedScripts.length}件`
    );

    console.log(
      `data-*要素: ${dataAttributes.length}件`
    );

    console.log(
      `Local Storage: ${Object.keys(localStorageData).length}件`
    );

    console.log(
      `Session Storage: ${Object.keys(sessionStorageData).length}件`
    );

    console.log(
      `HTML文字数: ${html.length}`
    );

    console.log(
      'カート操作: なし'
    );

    console.log(
      `保存先: ${OUTPUT_FILE}`
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
