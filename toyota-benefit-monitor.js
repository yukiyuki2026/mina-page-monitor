const fs = require('fs');
const crypto = require('crypto');

const NEWS_RSS_URL =
  process.env.TOYOTA_NEWS_RSS_URL;

const PRESS_RSS_URL =
  process.env.TOYOTA_PRESS_RSS_URL;

const SUPPORT_URL =
  process.env.TOYOTA_SUPPORT_URL;

const GITHUB_TOKEN =
  process.env.GITHUB_TOKEN;

const GITHUB_REPOSITORY =
  process.env.GITHUB_REPOSITORY;

const GITHUB_USERNAME =
  process.env.GITHUB_ACTOR;

const STATE_FILE =
  'toyota-benefit-state.json';

const REQUEST_TIMEOUT_MS = 30000;
const WAIT_BETWEEN_REQUESTS_MS = 500;

const BENEFIT_KEYWORDS = [
  '商品券',
  'プレミアム',
  'paypay',
  'ポイント還元',
  'ポイント付与',
  'キャッシュレス',
  '還元キャンペーン',
  '給付金',
  '給付',
  '支援金',
  '支援事業',
  '生活支援',
  '補助金',
  '補助',
  '助成金',
  '助成',
  '購入費',
  '免除',
  '減免',
  '無料',
  '無償',
  '割引',
  '二次販売',
  '追加販売',
  '追加募集',
  '再募集',
  '先着順',
  '物価高騰',
  '家計支援',
  '家計サポート',
  '省エネ',
  '住宅支援',
  '申請受付',
  '申込受付',
  '受付開始'
];

const HIGH_PRIORITY_KEYWORDS = [
  '商品券',
  'プレミアム',
  'paypay',
  '給付金',
  '支援金',
  'ポイント還元',
  '二次販売',
  '追加販売',
  '追加募集',
  '再募集',
  '先着順',
  '申請受付',
  '申込受付',
  '受付開始'
];

const BUSINESS_KEYWORDS = [
  '事業者',
  '事業所',
  '法人',
  '企業',
  '中小企業',
  '農業者',
  '商工会',
  '自治会',
  '団体',
  '施設運営者',
  '事業主',
  '店舗向け'
];

const RESIDENT_KEYWORDS = [
  '市民',
  '市内在住',
  '豊田市在住',
  '住民',
  '世帯',
  '家庭',
  '個人',
  '本人',
  '保護者',
  '子育て',
  '高齢者',
  '障がい',
  '学生',
  '児童',
  '乳幼児',
  '住宅',
  '購入者',
  '利用者',
  'お一人様',
  '1人'
];

const SUMMARY_KEYWORDS = [
  '対象',
  '申請',
  '申込',
  '受付',
  '締切',
  '期限',
  '期間',
  '販売',
  '先着',
  '抽選',
  '円',
  '万円',
  'ポイント',
  '還元',
  '無料',
  '免除',
  '減免',
  '市内在住',
  '豊田市在住',
  '市民',
  '世帯',
  '1人',
  '一人'
];

if (
  !NEWS_RSS_URL ||
  !PRESS_RSS_URL ||
  !SUPPORT_URL
) {
  throw new Error(
    '豊田市監視用のSecretが不足しています。' +
    'TOYOTA_NEWS_RSS_URL、' +
    'TOYOTA_PRESS_RSS_URL、' +
    'TOYOTA_SUPPORT_URLを確認してください。'
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

function createHash(value) {
  return crypto
    .createHash('sha256')
    .update(String(value || ''))
    .digest('hex');
}

function decodeHtmlEntities(value) {
  return String(value || '')
    .replace(
      /<!\[CDATA\[([\s\S]*?)\]\]>/g,
      '$1'
    )
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/gi, "'")
    .replace(/&#x27;/gi, "'")
    .replace(/&#x2F;/gi, '/')
    .replace(
      /&#(\d+);/g,
      (_, number) =>
        String.fromCharCode(
          Number(number)
        )
    )
    .replace(
      /&#x([0-9a-f]+);/gi,
      (_, number) =>
        String.fromCharCode(
          parseInt(number, 16)
        )
    );
}

function stripHtml(value) {
  return decodeHtmlEntities(
    String(value || '')
      .replace(
        /<script[\s\S]*?<\/script>/gi,
        ' '
      )
      .replace(
        /<style[\s\S]*?<\/style>/gi,
        ' '
      )
      .replace(/<br\s*\/?>/gi, '\n')
      .replace(/<\/p>/gi, '\n')
      .replace(/<\/li>/gi, '\n')
      .replace(/<[^>]+>/g, ' ')
  )
    .replace(/\r/g, '')
    .replace(/[ \t]+/g, ' ')
    .replace(/\n[ \t]+/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

function normalizeText(value) {
  return stripHtml(value)
    .replace(/\s+/g, ' ')
    .trim();
}

function normalizeUrl(urlText) {
  try {
    const url =
      new URL(urlText);

    url.hash = '';

    [
      'utm_source',
      'utm_medium',
      'utm_campaign',
      'utm_term',
      'utm_content'
    ].forEach(parameter =>
      url.searchParams.delete(parameter)
    );

    return url.href;
  } catch {
    return String(urlText || '')
      .trim();
  }
}

function createEmptyState() {
  return {
    initialized: false,
    checkedAt: '',
    entries: {}
  };
}

function loadState() {
  if (!fs.existsSync(STATE_FILE)) {
    return createEmptyState();
  }

  try {
    const loaded =
      JSON.parse(
        fs.readFileSync(
          STATE_FILE,
          'utf8'
        )
      );

    return {
      initialized:
        Boolean(loaded.initialized),

      checkedAt:
        loaded.checkedAt || '',

      entries:
        loaded.entries || {}
    };
  } catch (error) {
    console.log(
      `状態ファイルを読み込めませんでした: ${error.message}`
    );

    return createEmptyState();
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

async function fetchText(url) {
  const controller =
    new AbortController();

  const timeout =
    setTimeout(
      () => controller.abort(),
      REQUEST_TIMEOUT_MS
    );

  try {
    const response =
      await fetch(
        url,
        {
          headers: {
            Accept:
              'text/html,application/xhtml+xml,application/xml,text/xml;q=0.9,*/*;q=0.8',

            'User-Agent':
              'Toyota-Benefit-Monitor/1.0'
          },

          signal:
            controller.signal
        }
      );

    if (!response.ok) {
      throw new Error(
        `HTTP ${response.status}`
      );
    }

    return await response.text();
  } finally {
    clearTimeout(timeout);
  }
}

function getXmlTag(
  value,
  tagName
) {
  const escapedTagName =
    tagName.replace(
      /[.*+?^${}()|[\]\\]/g,
      '\\$&'
    );

  const match =
    String(value || '').match(
      new RegExp(
        `<${escapedTagName}(?:\\s[^>]*)?>` +
        `([\\s\\S]*?)` +
        `<\\/${escapedTagName}>`,
        'i'
      )
    );

  return match
    ? decodeHtmlEntities(
        match[1]
      ).trim()
    : '';
}

function parseRss(
  xml,
  sourceName
) {
  const items = [];

  const itemMatches =
    String(xml || '').match(
      /<item(?:\s[^>]*)?>[\s\S]*?<\/item>/gi
    ) || [];

  for (
    const itemXml
    of itemMatches
  ) {
    const title =
      normalizeText(
        getXmlTag(
          itemXml,
          'title'
        )
      );

    const link =
      normalizeUrl(
        getXmlTag(
          itemXml,
          'link'
        )
      );

    const guid =
      normalizeText(
        getXmlTag(
          itemXml,
          'guid'
        )
      );

    const description =
      normalizeText(
        getXmlTag(
          itemXml,
          'description'
        )
      );

    const content =
      normalizeText(
        getXmlTag(
          itemXml,
          'content:encoded'
        )
      );

    const publishedAt =
      normalizeText(
        getXmlTag(
          itemXml,
          'pubDate'
        )
      );

    if (!title || !link) {
      continue;
    }

    items.push({
      id:
        normalizeUrl(
          guid || link
        ),

      source:
        sourceName,

      title,

      url:
        link,

      description:
        content || description,

      publishedAt,

      sourceType:
        'rss'
    });
  }

  /*
   * Atom形式にも対応
   */
  if (items.length === 0) {
    const entryMatches =
      String(xml || '').match(
        /<entry(?:\s[^>]*)?>[\s\S]*?<\/entry>/gi
      ) || [];

    for (
      const entryXml
      of entryMatches
    ) {
      const title =
        normalizeText(
          getXmlTag(
            entryXml,
            'title'
          )
        );

      const linkMatch =
        entryXml.match(
          /<link[^"']+["'][^>]*>/i
        );

      const link =
        normalizeUrl(
          linkMatch
            ? decodeHtmlEntities(
                linkMatch[1]
              )
            : ''
        );

      const id =
        normalizeText(
          getXmlTag(
            entryXml,
            'id'
          )
        );

      const summary =
        normalizeText(
          getXmlTag(
            entryXml,
            'summary'
          )
        );

      const content =
        normalizeText(
          getXmlTag(
            entryXml,
            'content'
          )
        );

      const publishedAt =
        normalizeText(
          getXmlTag(
            entryXml,
            'updated'
          )
        );

      if (!title || !link) {
        continue;
      }

      items.push({
        id:
          normalizeUrl(
            id || link
          ),

        source:
          sourceName,

        title,

        url:
          link,

        description:
          content || summary,

        publishedAt,

        sourceType:
          'rss'
      });
    }
  }

  return items;
}

function extractLinks(
  html,
  baseUrl,
  sourceName
) {
  const links = [];

  const anchorPattern =
    /<a\b[^"']+["'][^>]*>([\s\S]*?)<\/a>/gi;

  let match;

  while (
    (
      match =
        anchorPattern.exec(html)
    ) !== null
  ) {
    const href =
      decodeHtmlEntities(
        match[1]
      ).trim();

    const title =
      normalizeText(
        match[2]
      );

    if (
      !href ||
      !title ||
      href.startsWith('#') ||
      href.startsWith(
        'javascript:'
      )
    ) {
      continue;
    }

    let absoluteUrl = '';

    try {
      absoluteUrl =
        normalizeUrl(
          new URL(
            href,
            baseUrl
          ).href
        );
    } catch {
      continue;
    }

    try {
      const parsedUrl =
        new URL(absoluteUrl);

      if (
        parsedUrl.hostname !==
        'www.city.toyota.aichi.jp'
      ) {
        continue;
      }
    } catch {
      continue;
    }

    links.push({
      id:
        absoluteUrl,

      source:
        sourceName,

      title,

      url:
        absoluteUrl,

      description: '',

      publishedAt: '',

      sourceType:
        'support-page'
    });
  }

  return links;
}

function getMatchedKeywords(text) {
  const lowerText =
    String(text || '')
      .toLowerCase();

  return BENEFIT_KEYWORDS.filter(
    keyword =>
      lowerText.includes(
        keyword.toLowerCase()
      )
  );
}

function getPriorityKeywords(text) {
  const lowerText =
    String(text || '')
      .toLowerCase();

  return HIGH_PRIORITY_KEYWORDS.filter(
    keyword =>
      lowerText.includes(
        keyword.toLowerCase()
      )
  );
}

function isLikelyResidentBenefit(
  text,
  matchedKeywords
) {
  const lowerText =
    String(text || '')
      .toLowerCase();

  const hasBusinessKeyword =
    BUSINESS_KEYWORDS.some(
      keyword =>
        lowerText.includes(
          keyword.toLowerCase()
        )
    );

  const hasResidentKeyword =
    RESIDENT_KEYWORDS.some(
      keyword =>
        lowerText.includes(
          keyword.toLowerCase()
        )
    );

  const hasHighPriority =
    HIGH_PRIORITY_KEYWORDS.some(
      keyword =>
        lowerText.includes(
          keyword.toLowerCase()
        )
    );

  if (hasHighPriority) {
    return true;
  }

  if (
    hasBusinessKeyword &&
    !hasResidentKeyword
  ) {
    return false;
  }

  return matchedKeywords.length > 0;
}

function splitSentences(text) {
  return String(text || '')
    .replace(/\r/g, '\n')
    .split(
      /(?<=[。！？!?])|\n+/
    )
    .map(sentence =>
      sentence
        .replace(/\s+/g, ' ')
        .trim()
    )
    .filter(
      sentence =>
        sentence.length >= 8
    );
}

function extractSummaryLines(text) {
  const sentences =
    splitSentences(text);

  const important = [];

  for (
    const sentence
    of sentences
  ) {
    const matched =
      SUMMARY_KEYWORDS.some(
        keyword =>
          sentence.includes(
            keyword
          )
      );

    const hasAmount =
      /(?:\d{1,3}(?:,\d{3})*|\d+)(?:円|万円|ポイント|％|%)/.test(
        sentence
      );

    const hasDate =
      /(?:令和\d+年|\d{4}年)?\s*\d{1,2}月\d{1,2}日/.test(
        sentence
      );

    if (
      matched ||
      hasAmount ||
      hasDate
    ) {
      important.push(sentence);
    }

    if (
      important.length >= 6
    ) {
      break;
    }
  }

  if (important.length > 0) {
    return important;
  }

  return sentences.slice(0, 3);
}

function determinePriority(text) {
  const lowerText =
    String(text || '')
      .toLowerCase();

  const hasApplication =
    [
      '申請',
      '申込',
      '申し込み',
      '受付'
    ].some(
      keyword =>
        lowerText.includes(
          keyword.toLowerCase()
        )
    );

  const hasDeadline =
    [
      '締切',
      '期限',
      'まで',
      '受付期間',
      '申込期間'
    ].some(
      keyword =>
        lowerText.includes(
          keyword.toLowerCase()
        )
    );

  const highPriority =
    getPriorityKeywords(
      lowerText
    );

  if (
    (
      hasApplication &&
      hasDeadline
    ) ||
    highPriority.length >= 2
  ) {
    return {
      level:
        'high',

      icon:
        '🔴',

      label:
        '最優先・見逃し注意'
    };
  }

  if (
    highPriority.length > 0 ||
    hasApplication
  ) {
    return {
      level:
        'medium',

      icon:
        '🟠',

      label:
        '要確認'
    };
  }

  return {
    level:
      'normal',

    icon:
      '🟡',

    label:
      'お得情報候補'
  };
}

async function getDetailText(url) {
  try {
    const html =
      await fetchText(url);

    return normalizeText(html);
  } catch (error) {
    console.log(
      `詳細取得エラー: ${url} ${error.message}`
    );

    return '';
  }
}

async function createGitHubIssue(
  title,
  body
) {
  if (
    !GITHUB_TOKEN ||
    !GITHUB_REPOSITORY
  ) {
    console.log(
      'GitHub通知用の環境変数がありません'
    );

    return false;
  }

  const response =
    await fetch(
      `https://api.github.com/repos/${GITHUB_REPOSITORY}/issues`,
      {
        method: 'POST',

        headers: {
          Accept:
            'application/vnd.github+json',

          Authorization:
            `Bearer ${GITHUB_TOKEN}`,

          'X-GitHub-Api-Version':
            '2022-11-28',

          'Content-Type':
            'application/json',

          'User-Agent':
            'toyota-benefit-monitor'
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

function createIssueBody(
  entry,
  matchedKeywords,
  detailText
) {
  const combinedText =
    [
      entry.title,
      entry.description,
      detailText
    ]
      .filter(Boolean)
      .join(' ');

  const priority =
    determinePriority(
      combinedText
    );

  const summaryLines =
    extractSummaryLines(
      detailText ||
      entry.description ||
      entry.title
    );

  const summaryText =
    summaryLines.length > 0
      ? summaryLines
          .map(line =>
            `- ${line}`
          )
          .join('\n')
      : '- 詳細ページで内容を確認してください';

  const publishedText =
    entry.publishedAt
      ? `\n- 公開・更新：${entry.publishedAt}`
      : '';

  const keywordText =
    matchedKeywords.length > 0
      ? matchedKeywords.join(' / ')
      : 'お得情報候補';

  return (
`@${GITHUB_USERNAME}

## ${priority.icon} 豊田市・知らないと損かも

**${entry.title}**

### 判定

- 重要度：**${priority.label}**
- 情報源：${entry.source}${publishedText}
- 検知キーワード：${keywordText}

### 要点候補

${summaryText}

### 詳細・申請ページ

${entry.url}

---

確認時刻：${getJapanTime()}（日本時間）

※対象条件、申請要否、受付期間、予算上限、先着・抽選の別は、必ず公式ページで最終確認してください。`
  );
}

function mergeEntries(entries) {
  const merged =
    new Map();

  for (
    const entry
    of entries
  ) {
    const normalizedUrl =
      normalizeUrl(entry.url);

    if (!normalizedUrl) {
      continue;
    }

    const existing =
      merged.get(
        normalizedUrl
      );

    if (!existing) {
      merged.set(
        normalizedUrl,
        {
          ...entry,

          id:
            normalizedUrl,

          url:
            normalizedUrl,

          sources:
            [entry.source]
        }
      );

      continue;
    }

    const sources =
      new Set([
        ...(existing.sources || []),
        entry.source
      ]);

    existing.sources =
      Array.from(sources);

    existing.source =
      existing.sources.join(' / ');

    if (
      entry.description.length >
      existing.description.length
    ) {
      existing.description =
        entry.description;
    }

    if (
      !existing.publishedAt &&
      entry.publishedAt
    ) {
      existing.publishedAt =
        entry.publishedAt;
    }
  }

  return Array.from(
    merged.values()
  );
}

(async () => {
  const state =
    loadState();

  try {
    console.log(
      '=============================='
    );

    console.log(
      'Toyota Benefit Monitor開始'
    );

    console.log(
      `確認時刻: ${getJapanTime()}`
    );

    console.log(
      '=============================='
    );

    const [
      newsRss,
      pressRss,
      supportHtml
    ] = await Promise.all([
      fetchText(
        NEWS_RSS_URL
      ),

      fetchText(
        PRESS_RSS_URL
      ),

      fetchText(
        SUPPORT_URL
      )
    ]);

    const newsEntries =
      parseRss(
        newsRss,
        '豊田市・新着情報'
      );

    const pressEntries =
      parseRss(
        pressRss,
        '豊田市・報道発表'
      );

    const supportEntries =
      extractLinks(
        supportHtml,
        SUPPORT_URL,
        '豊田市・生活支援まとめ'
      );

    console.log(
      `新着情報RSS: ${newsEntries.length}件`
    );

    console.log(
      `報道発表RSS: ${pressEntries.length}件`
    );

    console.log(
      `生活支援ページ: ${supportEntries.length}リンク`
    );

    const allEntries =
      mergeEntries([
        ...newsEntries,
        ...pressEntries,
        ...supportEntries
      ]);

    console.log(
      `重複統合後: ${allEntries.length}件`
    );

    const currentEntries = {};
    const notificationCandidates = [];

    for (
      const entry
      of allEntries
    ) {
      const initialText =
        [
          entry.title,
          entry.description
        ]
          .filter(Boolean)
          .join(' ');

      let matchedKeywords =
        getMatchedKeywords(
          initialText
        );

      let detailText = '';

      const shouldFetchDetail =
        entry.sourceType ===
          'support-page' ||
        matchedKeywords.length > 0;

      if (shouldFetchDetail) {
        detailText =
          await getDetailText(
            entry.url
          );

        await sleep(
          WAIT_BETWEEN_REQUESTS_MS
        );

        matchedKeywords =
          getMatchedKeywords(
            [
              initialText,
              detailText
            ].join(' ')
          );
      }

      const combinedText =
        [
          initialText,
          detailText
        ]
          .filter(Boolean)
          .join(' ');

      const isBenefit =
        isLikelyResidentBenefit(
          combinedText,
          matchedKeywords
        );

      const contentHash =
        createHash(
          [
            entry.title,
            entry.description,
            detailText
          ].join('\n')
        );

      currentEntries[
        entry.id
      ] = {
        title:
          entry.title,

        url:
          entry.url,

        source:
          entry.source,

        publishedAt:
          entry.publishedAt,

        isBenefit,

        matchedKeywords,

        contentHash,

        lastSeenAt:
          getJapanTime()
      };

      const previous =
        state.entries[
          entry.id
        ];

      if (!state.initialized) {
        continue;
      }

      const isNew =
        !previous;

      const isUpdated =
        previous &&
        previous.contentHash !==
          contentHash;

      const becameBenefit =
        previous &&
        previous.isBenefit ===
          false &&
        isBenefit === true;

      if (
        isBenefit &&
        (
          isNew ||
          isUpdated ||
          becameBenefit
        )
      ) {
        notificationCandidates.push({
          entry,
          matchedKeywords,
          detailText,
          reason:
            isNew
              ? '新規掲載'
              : '内容更新'
        });
      }
    }

    if (!state.initialized) {
      state.initialized = true;

      state.checkedAt =
        getJapanTime();

      state.entries =
        currentEntries;

      saveState(state);

      console.log(
        '初回実行のため、現在情報を基準として保存しました'
      );

      console.log(
        '初回は通知を送りません'
      );

      return;
    }

    console.log(
      `通知候補: ${notificationCandidates.length}件`
    );

    for (
      const candidate
      of notificationCandidates
    ) {
      const priority =
        determinePriority(
          [
            candidate.entry.title,
            candidate.entry.description,
            candidate.detailText
          ].join(' ')
        );

      const title =
        (
          `${priority.icon} ` +
          `豊田市お得情報：` +
          `${candidate.entry.title}`
        ).slice(0, 240);

      const body =
        createIssueBody(
          candidate.entry,
          candidate.matchedKeywords,
          candidate.detailText
        );

      await createGitHubIssue(
        title,
        body
      );

      await sleep(500);
    }

    state.entries = {
      ...state.entries,
      ...currentEntries
    };

    state.checkedAt =
      getJapanTime();

    saveState(state);

    console.log(
      '=============================='
    );

    console.log(
      'Toyota Benefit Monitor終了'
    );

    console.log(
      `通知作成: ${notificationCandidates.length}件`
    );

    console.log(
      '=============================='
    );

  } catch (error) {
    console.error(
      `豊田市お得情報監視エラー: ${error.stack}`
    );

    process.exitCode = 1;
  }
})();
