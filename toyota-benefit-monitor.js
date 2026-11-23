const fs = require('fs');
const crypto = require('crypto');

const NEWS_RSS_URL = process.env.TOYOTA_NEWS_RSS_URL;
const PRESS_RSS_URL = process.env.TOYOTA_PRESS_RSS_URL;
const SUPPORT_URL = process.env.TOYOTA_SUPPORT_URL;
const GITHUB_TOKEN = process.env.GITHUB_TOKEN;
const GITHUB_REPOSITORY = process.env.GITHUB_REPOSITORY;
const GITHUB_USERNAME = process.env.GITHUB_ACTOR;

const STATE_FILE = 'toyota-benefit-state.json';
const REQUEST_TIMEOUT_MS = 30000;
const WAIT_BETWEEN_REQUESTS_MS = 500;

/*
 * この値を変更した最初の1回だけ、
 * 現在の情報を通知せずに基準として保存します。
 */
const BASELINE_VERSION =
  '2026-11-23-personal-support-v1';

const BENEFIT_KEYWORDS = [
  '商品券','プレミアム','paypay','ポイント還元','ポイント付与','キャッシュレス','還元キャンペーン',
  '二次販売','追加販売','給付金','給付','支援金','支援事業','生活支援','補助金','補助','助成金','助成',
  '奨励金','交付金','購入費','負担軽減','支給','融資','融資制度','貸付','貸付金','資金貸付','無利子貸付',
  '低利融資','教育ローン','修学資金','就学資金','入学資金','母子父子寡婦福祉資金','生活福祉資金',
  '教育支援資金','免除','減免','無料','無償','割引','追加募集','再募集','先着順','申請受付','申込受付',
  '受付開始','物価高騰','家計支援','家計サポート','生活困窮','低所得世帯','非課税世帯','省エネ','住宅支援',
  '家賃補助','住宅手当','ひとり親','ひとり親家庭','ひとり親世帯','母子家庭','母子世帯','母子父子家庭',
  '児童扶養手当','子育て世帯','子育て家庭','子育て支援','保護者','児童','生徒','小学生','小学校','中学生',
  '中学校','義務教育','就学援助','就学支援','学用品','学用品費','新入学学用品費','教育費','通学費','給食費',
  '修学旅行費','校外活動費','入学準備金','高校生','高校','高等学校','高等学校等就学支援金','高校生等奨学給付金',
  '授業料支援','授業料無償化','高校授業料','高校入学','高等学校入学','大学生','大学','短期大学','短大',
  '専門学校','専門学生','高等専門学校','高専','進学','大学進学','入学金','授業料','受験料','受験費用','奨学金',
  '給付型奨学金','貸与型奨学金','修学支援','高等教育の修学支援新制度','学費','学生生活','医療費','医療費助成',
  '子ども医療費','母子家庭等医療費','受給者証'
];

const HIGH_PRIORITY_KEYWORDS = [
  '商品券','プレミアム','paypay','給付金','支援金','ポイント還元','二次販売','追加販売','追加募集','再募集',
  '先着順','申請受付','申込受付','受付開始','申請期限','募集期限'
];

const PERSONAL_PRIORITY_KEYWORDS = [
  'ひとり親','ひとり親家庭','ひとり親世帯','母子家庭','母子世帯','母子父子家庭','母子父子寡婦福祉資金',
  '児童扶養手当','児童扶養手当受給者','母子家庭等医療費','子育て世帯','子育て家庭','子育て支援','児童','生徒',
  '保護者','小学生','小学校','中学生','中学校','義務教育','就学援助','就学支援','学用品','学用品費',
  '新入学学用品費','教育費','通学費','給食費','修学旅行費','校外活動費','入学準備金','高校生','高校',
  '高等学校','高等学校等就学支援金','高校生等奨学給付金','高校授業料','授業料支援','授業料無償化','高校入学',
  '高等学校入学','大学生','大学','短期大学','短大','専門学校','専門学生','高等専門学校','高専','進学','大学進学',
  '入学金','授業料','受験料','受験費用','学費','奨学金','給付型奨学金','貸与型奨学金','修学支援',
  '高等教育の修学支援新制度','教育ローン','教育支援資金','修学資金','就学資金','入学資金','無利子貸付',
  '資金貸付','医療費','子ども医療費','医療費助成','医療費受給者証','受給者証','生活支援','家計支援',
  '物価高騰','低所得世帯','非課税世帯','生活困窮','家賃補助','住宅手当'
];

const VERY_HIGH_PERSONAL_KEYWORDS = [
  'ひとり親','ひとり親家庭','ひとり親世帯','母子家庭','母子世帯','母子父子家庭','児童扶養手当',
  '母子家庭等医療費','母子父子寡婦福祉資金','就学援助','新入学学用品費','中学生','中学校','高校生',
  '高等学校等就学支援金','高校生等奨学給付金','大学生','給付型奨学金','高等教育の修学支援新制度',
  '教育ローン','教育支援資金','修学資金'
];

const BUSINESS_KEYWORDS = [
  '事業者','事業所','法人','企業','中小企業','農業者','商工会','施設運営者','事業主','店舗向け','立地','工場',
  '設備投資','産業用地','創業者','雇用主','運転資金','設備資金','創業融資','事業資金','経営安定','売上減少'
];

const RESIDENT_KEYWORDS = [
  '市民','市内在住','豊田市在住','住民','世帯','家庭','個人','本人','保護者','子育て','高齢者','障がい','学生',
  '児童','生徒','乳幼児','住宅','購入者','利用者','お一人様','1人','ひとり親','母子家庭','小学生','中学生',
  '高校生','大学生','専門学生'
];

if (!NEWS_RSS_URL || !PRESS_RSS_URL || !SUPPORT_URL) {
  throw new Error(
    '豊田市監視用のSecretが不足しています。TOYOTA_NEWS_RSS_URL、TOYOTA_PRESS_RSS_URL、TOYOTA_SUPPORT_URLを確認してください。'
  );
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function getJapanTime() {
  return new Intl.DateTimeFormat('ja-JP', {
    timeZone: 'Asia/Tokyo',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hourCycle: 'h23'
  }).format(new Date());
}

function createHash(value) {
  return crypto
    .createHash('sha256')
    .update(String(value || ''))
    .digest('hex');
}

function decodeHtmlEntities(value) {
  return String(value || '')
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1')
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"')
    .replace(/&apos;/gi, "'")
    .replace(/&#x27;/gi, "'")
    .replace(/&#x2F;/gi, '/')
    .replace(/&#(\d+);/g, (_, n) =>
      String.fromCharCode(Number(n))
    )
    .replace(/&#x([0-9a-f]+);/gi, (_, n) =>
      String.fromCharCode(parseInt(n, 16))
    );
}

function stripHtml(value) {
  return decodeHtmlEntities(
    String(value || '')
      .replace(/<script[\s\S]*?<\/script>/gi, ' ')
      .replace(/<style[\s\S]*?<\/style>/gi, ' ')
      .replace(/<(br|hr)\s*\/?>/gi, '\n')
      .replace(
        /<\/(p|li|div|section|article|h1|h2|h3|h4|tr)>/gi,
        '\n'
      )
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
    const url = new URL(urlText);

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
    return String(urlText || '').trim();
  }
}

function createEmptyState() {
  return {
    initialized: false,
    baselineVersion: '',
    checkedAt: '',
    entries: {}
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

    return {
      initialized:
        Boolean(
          loaded.initialized
        ),

      baselineVersion:
        loaded.baselineVersion || '',

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
    JSON.stringify(state, null, 2),
    'utf8'
  );

  console.log(
    `${STATE_FILE}を保存しました`
  );
}

async function fetchText(url) {
  const controller = new AbortController();

  const timeout = setTimeout(
    () => controller.abort(),
    REQUEST_TIMEOUT_MS
  );

  try {
    const response = await fetch(
      url,
      {
        headers: {
          Accept:
            'text/html,application/xhtml+xml,application/xml,text/xml;q=0.9,*/*;q=0.8',

          'User-Agent':
            'Toyota-Benefit-Monitor/4.1'
        },

        signal: controller.signal
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
  const escaped =
    tagName.replace(
      /[.*+?^${}()|[\]\\]/g,
      '\\$&'
    );

  const match =
    String(value || '').match(
      new RegExp(
        `<${escaped}(?:\\s[^>]*)?>([\\s\\S]*?)<\\/${escaped}>`,
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

  for (const itemXml of itemMatches) {
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
        content ||
        description,

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

    for (const entryXml of entryMatches) {
      const title =
        normalizeText(
          getXmlTag(
            entryXml,
            'title'
          )
        );

      const hrefMatch =
        entryXml.match(
          /<link\b[^>]*href=["']([^"']+)["'][^>]*\/?>/i
        );

      const link =
        normalizeUrl(
          hrefMatch
            ? decodeHtmlEntities(
                hrefMatch[1]
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
          content ||
          summary,

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
    /<a\b[^>]*href=["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi;

  let match;

  while (
    (
      match =
        anchorPattern.exec(
          html
        )
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
      if (
        new URL(
          absoluteUrl
        ).hostname !==
        'www.city.toyota.aichi.jp'
      ) {
        continue;
      }
    } catch {
      continue;
    }

    links.push({
      id: absoluteUrl,
      source: sourceName,
      title,
      url: absoluteUrl,
      description: '',
      publishedAt: '',
      sourceType: 'support-page'
    });
  }

  return links;
}

function matchingKeywords(
  text,
  keywords
) {
  const lower =
    String(text || '')
      .toLowerCase();

  return keywords.filter(
    keyword =>
      lower.includes(
        keyword.toLowerCase()
      )
  );
}

function getMatchedKeywords(text) {
  return matchingKeywords(
    text,
    BENEFIT_KEYWORDS
  );
}

function getPriorityKeywords(text) {
  return matchingKeywords(
    text,
    HIGH_PRIORITY_KEYWORDS
  );
}

function getPersonalKeywords(text) {
  return matchingKeywords(
    text,
    PERSONAL_PRIORITY_KEYWORDS
  );
}

function getVeryHighPersonalKeywords(text) {
  return matchingKeywords(
    text,
    VERY_HIGH_PERSONAL_KEYWORDS
  );
}

function determinePersonalRelevance(
  text
) {
  const personalMatches =
    getPersonalKeywords(
      text
    );

  const veryHighMatches =
    getVeryHighPersonalKeywords(
      text
    );

  const lower =
    String(text || '')
      .toLowerCase();

  const hasBusiness =
    BUSINESS_KEYWORDS.some(
      keyword =>
        lower.includes(
          keyword.toLowerCase()
        )
    );

  const hasResident =
    RESIDENT_KEYWORDS.some(
      keyword =>
        lower.includes(
          keyword.toLowerCase()
        )
    );

  if (
    veryHighMatches.length > 0
  ) {
    return {
      level: 'very-high',
      icon: '⭐',
      label:
        'あなたへの関連度：かなり高い'
    };
  }

  if (
    personalMatches.length >= 2
  ) {
    return {
      level: 'high',
      icon: '⭐',
      label:
        'あなたへの関連度：高い'
    };
  }

  if (
    personalMatches.length === 1
  ) {
    return {
      level: 'medium',
      icon: '👀',
      label:
        'あなたにも関係する可能性あり'
    };
  }

  if (
    hasBusiness &&
    !hasResident
  ) {
    return {
      level: 'low',
      icon: '🏢',
      label:
        '主に事業者向け'
    };
  }

  return {
    level: 'normal',
    icon: '🔎',
    label:
      '対象条件を確認'
  };
}

function isLikelyResidentBenefit(
  text,
  matchedKeywords
) {
  const lower =
    String(text || '')
      .toLowerCase();

  const hasBusiness =
    BUSINESS_KEYWORDS.some(
      keyword =>
        lower.includes(
          keyword.toLowerCase()
        )
    );

  const hasResident =
    RESIDENT_KEYWORDS.some(
      keyword =>
        lower.includes(
          keyword.toLowerCase()
        )
    );

  const hasHigh =
    HIGH_PRIORITY_KEYWORDS.some(
      keyword =>
        lower.includes(
          keyword.toLowerCase()
        )
    );

  const hasPersonal =
    PERSONAL_PRIORITY_KEYWORDS.some(
      keyword =>
        lower.includes(
          keyword.toLowerCase()
        )
    );

  if (
    hasPersonal ||
    hasHigh
  ) {
    return true;
  }

  if (
    hasBusiness &&
    !hasResident
  ) {
    return false;
  }

  return (
    matchedKeywords.length > 0
  );
}

function splitSentences(text) {
  return String(text || '')
    .replace(/\r/g, '\n')
    .split(
      /(?<=[。！？!?])|\n+/
    )
    .map(
      sentence =>
        sentence
          .replace(/\s+/g, ' ')
          .trim()
    )
    .filter(
      sentence =>
        sentence.length >= 8
    );
}

function shortenText(
  text,
  maxLength = 90
) {
  const normalized =
    String(text || '')
      .replace(/\s+/g, ' ')
      .trim();

  return normalized.length <=
    maxLength
    ? normalized
    : `${normalized.slice(
        0,
        maxLength
      )}…`;
}

function getAudienceInfo(text) {
  const lower =
    String(text || '')
      .toLowerCase();

  const hasBusiness =
    BUSINESS_KEYWORDS.some(
      keyword =>
        lower.includes(
          keyword.toLowerCase()
        )
    );

  const hasResident =
    RESIDENT_KEYWORDS.some(
      keyword =>
        lower.includes(
          keyword.toLowerCase()
        )
    );

  if (
    hasBusiness &&
    !hasResident
  ) {
    return {
      icon: '🏢',
      label:
        '主に事業者向け'
    };
  }

  if (hasResident) {
    return {
      icon: '👤',
      label:
        '市民・家庭向けの可能性あり'
    };
  }

  return {
    icon: '🔎',
    label:
      '対象者を要確認'
  };
}

function findUsefulSentence(
  sentences,
  patterns,
  used
) {
  for (
    const sentence
    of sentences
  ) {
    if (
      used.has(
        sentence
      )
    ) {
      continue;
    }

    if (
      patterns.some(
        pattern =>
          pattern.test(
            sentence
          )
      )
    ) {
      used.add(
        sentence
      );

      return sentence;
    }
  }

  return '';
}

function extractShortSummary(text) {
  const sentences =
    splitSentences(text)
      .filter(
        sentence =>
          sentence.length <= 300
      );

  const used =
    new Set();

const target =
    findUsefulSentence(
      sentences,
      [
        /ひとり親/,
        /母子家庭/,
        /児童扶養手当/,
        /小学生/,
        /中学生/,
        /高校生/,
        /大学生/,
        /専門学生/,
        /学生/,
        /就学援助/,
        /子育て世帯/,
        /保護者/,
        /対象者/,
        /対象となる/,
        /対象は/,
        /市内在住/,
        /豊田市在住/,
        /市民/,
        /世帯/,
        /申請できる/,
        /利用できる/
      ],
      used
    );

  const amount =
    findUsefulSentence(
      sentences,
      [
        /\d{1,3}(?:,\d{3})*円/,
        /\d+(?:\.\d+)?万円/,
        /\d+(?:\.\d+)?%/,
        /\d+(?:\.\d+)?％/,
        /\d{1,3}(?:,\d{3})*ポイント/,
        /補助率/,
        /補助額/,
        /給付額/,
        /助成額/,
        /支給額/,
        /貸付額/,
        /融資額/,
        /限度額/,
        /上限額/,
        /利率/,
        /無利子/,
        /返済/,
        /償還/,
        /授業料/,
        /入学金/,
        /受験料/,
        /給食費/,
        /学用品費/,
        /医療費/,
        /無料/,
        /割引/,
        /免除/,
        /減免/
      ],
      used
    );

  const deadline =
    findUsefulSentence(
      sentences,
      [
        /締切/,
        /期限/,
        /受付期間/,
        /申請期間/,
        /申込期間/,
        /募集期間/,
        /受付開始/,
        /申請開始/,
        /申込開始/,
        /\d{1,2}月\d{1,2}日まで/,
        /令和\d+年\d{1,2}月\d{1,2}日/
      ],
      used
    );

  return {
    target:
      target
        ? shortenText(target)
        : '',

    amount:
      amount
        ? shortenText(amount)
        : '',

    deadline:
      deadline
        ? shortenText(deadline)
        : ''
  };
}

function determineSupportType(text) {
  const lower =
    String(text || '')
      .toLowerCase();

  if (
    [
      '融資',
      '貸付',
      '教育ローン',
      '修学資金',
      '就学資金',
      '入学資金'
    ].some(
      keyword =>
        lower.includes(keyword)
    )
  ) {
    return {
      icon: '💳',
      label:
        '貸付・融資の可能性あり',

      note:
        '返済の有無、利率、保証人、返済開始時期を確認してください。'
    };
  }

  if (
    [
      '奨学金',
      '奨学給付金',
      '就学支援金',
      '修学支援'
    ].some(
      keyword =>
        lower.includes(keyword)
    )
  ) {
    return {
      icon: '🎓',
      label:
        '教育・進学支援',

      note:
        '給付型か貸与型か、返済が必要かを確認してください。'
    };
  }

  if (
    [
      '補助金',
      '助成金',
      '給付金',
      '支援金',
      '支給'
    ].some(
      keyword =>
        lower.includes(keyword)
    )
  ) {
    return {
      icon: '💰',
      label:
        '給付・補助・助成',

      note:
        '申請期限、対象条件、予算上限を確認してください。'
    };
  }

  if (
    [
      '免除',
      '減免',
      '無料',
      '無償',
      '割引'
    ].some(
      keyword =>
        lower.includes(keyword)
    )
  ) {
    return {
      icon: '🧾',
      label:
        '無料・減免・割引',

      note:
        '自動適用か申請が必要かを確認してください。'
    };
  }

  return {
    icon: '📌',
    label:
      '支援情報',

    note:
      '利用条件は公式ページで確認してください。'
  };
}

function determinePriority(text) {
  const lower =
    String(text || '')
      .toLowerCase();

  const relevance =
    determinePersonalRelevance(
      text
    );

  const hasApplication =
    [
      '申請',
      '申込',
      '申し込み',
      '受付',
      '募集'
    ].some(
      keyword =>
        lower.includes(keyword)
    );

  const hasDeadline =
    [
      '締切',
      '期限',
      'まで',
      '受付期間',
      '申込期間',
      '募集期間'
    ].some(
      keyword =>
        lower.includes(keyword)
    );

  const highPriority =
    getPriorityKeywords(
      text
    );

  if (
    relevance.level ===
      'very-high'
  ) {
    return {
      icon: '⭐',
      label:
        'あなた向け・優先確認'
    };
  }

  if (
    relevance.level === 'high' &&
    (
      hasApplication ||
      hasDeadline
    )
  ) {
    return {
      icon: '⭐',
      label:
        'あなた向け・優先確認'
    };
  }

  if (
    (
      hasApplication &&
      hasDeadline
    ) ||
    highPriority.length >= 2
  ) {
    return {
      icon: '🔴',
      label:
        '見逃し注意'
    };
  }

  if (
    relevance.level === 'high'
  ) {
    return {
      icon: '🟣',
      label:
        '関連度が高い情報'
    };
  }

  if (
    highPriority.length > 0 ||
    hasApplication ||
    relevance.level === 'medium'
  ) {
    return {
      icon: '🟠',
      label:
        '要確認'
    };
  }

  return {
    icon: '🟡',
    label:
      'お得・支援情報候補'
  };
}

async function getDetailText(url) {
  try {
    return normalizeText(
      await fetchText(url)
    );
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

  const relevance =
    determinePersonalRelevance(
      combinedText
    );

  const audience =
    getAudienceInfo(
      combinedText
    );

  const supportType =
    determineSupportType(
      combinedText
    );

  const summary =
    extractShortSummary(
      detailText ||
      entry.description ||
      entry.title
    );

  const lines = [];

  if (summary.target) {
    lines.push(
      `👤 **対象：** ${summary.target}`
    );
  }

  if (summary.amount) {
    lines.push(
      `💰 **金額・内容：** ${summary.amount}`
    );
  }

  if (summary.deadline) {
    lines.push(
      `📅 **期限：** ${summary.deadline}`
    );
  }

  const usefulText =
    lines.length
      ? lines
          .slice(0, 3)
          .join('\n\n')
      : '詳しい対象条件、金額、期限は公式ページで確認してください。';

  const publishedText =
    entry.publishedAt
      ? `\n\n公開・更新：${entry.publishedAt}`
      : '';

  return (
`@${GITHUB_USERNAME}

## ${priority.icon} 豊田市のお得・支援情報

**${entry.title}**

${relevance.icon} **${relevance.label}**

${audience.icon} **${audience.label}**

${supportType.icon} **${supportType.label}**

### 🔗 詳細・申請ページ

${entry.url}

### かんたん確認

${usefulText}

### 確認ポイント

${supportType.note}

情報源：${entry.source}${publishedText}

確認時刻：${getJapanTime()}（日本時間）

※対象条件、申請期限、返済の有無、受付状況は公式ページで最終確認してください。`
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
      normalizeUrl(
        entry.url
      );

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
      Array.from(
        sources
      );

    existing.source =
      existing.sources.join(
        ' / '
      );

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

      const initialPersonalKeywords =
        getPersonalKeywords(
          initialText
        );

      let detailText = '';

      const shouldFetchDetail =
        entry.sourceType ===
          'support-page' ||
        matchedKeywords.length > 0 ||
        initialPersonalKeywords.length > 0;

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

      const personalRelevance =
        determinePersonalRelevance(
          combinedText
        );

      const supportType =
        determineSupportType(
          combinedText
        );

      const stableSummary =
  extractShortSummary(
    detailText ||
    entry.description ||
    entry.title
  );

　　　const contentHash =
  createHash(
    [
      entry.title,
      entry.description,
      matchedKeywords
        .slice()
        .sort()
        .join('|'),
      stableSummary.target,
      stableSummary.amount,
      stableSummary.deadline
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

        personalRelevance:
          personalRelevance.level,

        supportType:
          supportType.label,

        matchedKeywords,

        contentHash,

        lastSeenAt:
          getJapanTime()
      };

      const previous =
        state.entries[
          entry.id
        ];

      if (
        !state.initialized
      ) {
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
        isBenefit ===
          true;

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
          detailText,
          personalRelevance,

          reason:
            isNew
              ? '新規掲載'
              : '内容更新'
        });
      }
    }

   const needsRebaseline =
  !state.initialized ||
  state.baselineVersion !==
    BASELINE_VERSION;

if (needsRebaseline) {
  state.initialized = true;

  state.baselineVersion =
    BASELINE_VERSION;

  state.checkedAt =
    getJapanTime();

  state.entries =
    currentEntries;

  saveState(state);

  console.log(
    '現在の情報を新しい基準として保存しました'
  );

  console.log(
    `基準バージョン: ${BASELINE_VERSION}`
  );

  console.log(
    '再基準化のため、今回は通知を送りません'
  );

  console.log(
    '次回実行から新規・重要な更新だけ通知します'
  );

  return;
}

    const relevanceOrder = {
      'very-high': 0,
      high: 1,
      medium: 2,
      normal: 3,
      low: 4
    };

    notificationCandidates.sort(
      (a, b) =>
        (
          relevanceOrder[
            a.personalRelevance.level
          ] ?? 99
        ) -
        (
          relevanceOrder[
            b.personalRelevance.level
          ] ?? 99
        )
    );

    console.log(
      `通知候補: ${notificationCandidates.length}件`
    );

    for (
      const candidate
      of notificationCandidates
    ) {
      const combinedText =
        [
          candidate.entry.title,
          candidate.entry.description,
          candidate.detailText
        ]
          .filter(Boolean)
          .join(' ');

      const priority =
        determinePriority(
          combinedText
        );

      const relevance =
        determinePersonalRelevance(
          combinedText
        );

      const supportType =
        determineSupportType(
          combinedText
        );

      const title =
        (
          `${priority.icon}` +
          `${relevance.icon}` +
          `${supportType.icon} ` +
          `${candidate.entry.title}`
        ).slice(
          0,
          240
        );

      const body =
        createIssueBody(
          candidate.entry,
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
