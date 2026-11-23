const fs = require('fs');
const crypto = require('crypto');

const EVENT_RSS_URL = 'https://www.city.toyota.aichi.jp/eventrss.rss';
const WAKABAYASHI_URL = 'https://www.ph-toyota.jp/guide/wakabayashi/course.php';

const GITHUB_TOKEN = process.env.GITHUB_TOKEN;
const GITHUB_REPOSITORY = process.env.GITHUB_REPOSITORY;
const GITHUB_USERNAME = process.env.GITHUB_ACTOR;

const STATE_FILE = 'toyota-event-state.json';
const REQUEST_TIMEOUT_MS = 30000;
const WAIT_BETWEEN_REQUESTS_MS = 350;
const BASELINE_VERSION = '2026-11-23-event-v3';
const LOOKAHEAD_DAYS = 120;

const EVENT_KEYWORDS = [
  'イベント', '祭り', 'まつり', '夏祭り', '夏まつり', '納涼祭', '盆踊り', '花火', '縁日', '夜店',
  'マルシェ', 'マーケット', 'フリーマーケット', 'キッチンカー', 'フェス', 'フェスタ', '文化祭',
  'コンサート', '演奏会', '上映会', '展示', '体験', 'ワークショップ', 'イルミネーション', '紅葉', '桜',
  '茶会', '講座', '教室', '観察会', 'ウォーキング', 'ウオーキング',
  '親子', '家族', 'アスレチック', 'キャンプ', '工作', '料理', 'プラネタリウム', '点灯式',
  'クリスマス', 'クラフト', '手作り', '自然素材', '森あそび', '森あるき', '読み聞かせ'
];

const PRIORITY_KEYWORDS = [
  '永覚新町', '永覚町', '永覚', '鴛鴨町', '鴛鴨', '渡刈町', '渡刈', '豊栄町', '大林町', '大林',
  '寿町', '竜神町', '竹町', '竹村', '住吉町', '中町',
  '若林', '若林東町', '若林西町', '若林八幡宮', '若林交流館', '高岡', '高岡町', '前林', '前林町', '若園',
  'マルシェ', 'マーケット', '夏祭り', '夏まつり', '納涼祭', '盆踊り', '花火', '縁日', '夜店',
  'キッチンカー', 'フリーマーケット', 'ふれあい祭り',
  '無料', '申込み不要', '申込不要', '予約不要', '中学生', '親子', '家族'
];

const EXCLUDED_KEYWORDS = [
  '市長記者会見', '会議', '議事録', '入札', '職員採用', '表彰式',
  '市長を訪問', '表敬訪問', '大会結果', '事業者向け説明会', 'オンライン開催のみ'
];

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function getJapanDate() {
  return new Date(new Date().toLocaleString('en-US', { timeZone: 'Asia/Tokyo' }));
}

function getJapanTime() {
  return new Intl.DateTimeFormat('ja-JP', {
    timeZone: 'Asia/Tokyo',
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23'
  }).format(new Date());
}

function createHash(value) {
  return crypto.createHash('sha256').update(String(value || '')).digest('hex');
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
    .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(Number(n)))
    .replace(/&#x([0-9a-f]+);/gi, (_, n) => String.fromCharCode(parseInt(n, 16)));
}

function stripHtml(value) {
  return decodeHtmlEntities(String(value || '')
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<(br|hr)\s*\/?>/gi, '\n')
    .replace(/<\/(p|li|div|section|article|h1|h2|h3|h4|tr)>/gi, '\n')
    .replace(/<[^>]+>/g, ' '))
    .replace(/\r/g, '')
    .replace(/[ \t]+/g, ' ')
    .replace(/\n[ \t]+/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

function normalizeText(value) {
  return stripHtml(value).replace(/\s+/g, ' ').trim();
}

function containsAny(text, keywords) {
  const lower = String(text || '').toLowerCase();
  return keywords.some(keyword => lower.includes(keyword.toLowerCase()));
}

async function fetchText(url, maxRetries = 3) {
  let lastError = null;

  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);

    try {
      console.log(`取得開始 ${attempt}/${maxRetries}: ${url}`);

      const response = await fetch(url, {
        headers: {
          'User-Agent': 'Mozilla/5.0 Toyota-Event-Monitor/2.0',
          Accept: 'text/html,application/xhtml+xml,application/xml,text/xml;q=0.9,*/*;q=0.8'
        },
        signal: controller.signal
      });

      if (!response.ok) {
        throw new Error(`HTTP ${response.status} ${response.statusText}`);
      }

      const text = await response.text();
      console.log(`取得成功: ${url}`);
      return text;
    } catch (error) {
      lastError = error;
      console.log(`取得失敗 ${attempt}/${maxRetries}: ${url}`);
      console.log(`理由: ${error.message}`);

      if (attempt < maxRetries) {
        console.log('2秒後に再試行します');
        await sleep(2000);
      }
    } finally {
      clearTimeout(timer);
    }
  }

  throw new Error(`URL取得に${maxRetries}回失敗しました: ${url} / ${lastError?.message || 'unknown error'}`);
}

function getXmlTag(xml, tagName) {
  const escaped = tagName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const match = String(xml || '').match(
    new RegExp(`<${escaped}(?:\\s[^>]*)?>([\\s\\S]*?)<\\/${escaped}>`, 'i')
  );
  return match ? decodeHtmlEntities(match[1]).trim() : '';
}

function parseRss(xml) {
  const items = [];
  const blocks = String(xml || '').match(/<item(?:\s[^>]*)?>[\s\S]*?<\/item>/gi) || [];

  for (const block of blocks) {
    const title = normalizeText(getXmlTag(block, 'title'));
    const url = getXmlTag(block, 'link').trim();
    const description = normalizeText(getXmlTag(block, 'description'));
    const publishedAt = normalizeText(getXmlTag(block, 'pubDate'));

    if (!title || !url) continue;

    items.push({
      id: url,
      title,
      url,
      description,
      publishedAt,
      source: '豊田市イベントRSS'
    });
  }

  return items;
}

function parseWakabayashi(html, baseUrl) {
  const lines = stripHtml(html).split('\n').map(line => line.trim()).filter(Boolean);
  const items = [];

  for (let index = 0; index < lines.length; index++) {
    const match = lines[index].match(
      /^(\d{4})\s+(\d{1,2})\/(\d{1,2})\s*[（(].*?[）)]\s*(.+)$/
    );

    if (!match) continue;

    const date = `${match[1]}-${String(match[2]).padStart(2, '0')}-${String(match[3]).padStart(2, '0')}`;
    const title = match[4].trim();
    const description = lines[index + 1] || '';

    items.push({
      id: `${baseUrl}#${date}-${title}`,
      title,
      url: baseUrl,
      description,
      publishedAt: '',
      source: '若林交流館',
      explicitDate: date
    });
  }

  return items;
}

function findDates(text) {
  const currentYear = getJapanDate().getFullYear();
  const results = [];
  const patterns = [
    /((?:20\d{2}|令和\d+)年)?\s*(\d{1,2})月\s*(\d{1,2})日/g,
    /(20\d{2})[-/.](\d{1,2})[-/.](\d{1,2})/g
  ];

  for (const pattern of patterns) {
    let match;

    while ((match = pattern.exec(text)) !== null) {
      let year = currentYear;

      if (match[1]) {
        if (String(match[1]).startsWith('令和')) {
          const reiwaYear = Number(String(match[1]).match(/\d+/)?.[0] || 0);
          year = 2018 + reiwaYear;
        } else {
          year = Number(match[1]);
        }
      }

      const date = new Date(
        year,
        Number(match[2]) - 1,
        Number(match[3]),
        23, 59, 59
      );

      if (!Number.isNaN(date.getTime())) {
        results.push(date);
      }
    }
  }

  return results;
}

function getEventDateInfo(item, detailText) {
  if (item.explicitDate) {
    const date = new Date(`${item.explicitDate}T23:59:59+09:00`);
    return {
      dates: [date],
      display: item.explicitDate.replace(/-/g, '/')
    };
  }

  const dates = findDates([
    item.title,
    item.description,
    detailText
  ].join(' '));

  if (dates.length === 0) {
    return {
      dates: [],
      display: '日付は詳細ページで確認'
    };
  }

  dates.sort((a, b) => a - b);

  return {
    dates,
    display: dates
      .slice(0, 2)
      .map(date => `${date.getFullYear()}/${date.getMonth() + 1}/${date.getDate()}`)
      .join('～')
  };
}

function isFutureEvent(dateInfo) {
  if (dateInfo.dates.length === 0) return false;

  const today = getJapanDate();
  today.setHours(0, 0, 0, 0);

  const limit = new Date(today);
  limit.setDate(limit.getDate() + LOOKAHEAD_DAYS);

  return dateInfo.dates.some(date => date >= today && date <= limit);
}

function extractFact(text, patterns) {
  const lines = stripHtml(text).split('\n').map(line => line.trim()).filter(Boolean);
  return lines.find(line => patterns.some(pattern => pattern.test(line))) || '';
}

function loadState() {
  if (!fs.existsSync(STATE_FILE)) {
    return {
      initialized: false,
      baselineVersion: '',
      entries: {}
    };
  }

  try {
    const loaded = JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'));

    return {
      initialized: Boolean(loaded.initialized),
      baselineVersion: loaded.baselineVersion || '',
      entries: loaded.entries || {}
    };
  } catch (error) {
    console.log(`状態ファイルを読み込めませんでした: ${error.message}`);

    return {
      initialized: false,
      baselineVersion: '',
      entries: {}
    };
  }
}

function saveState(state) {
  fs.writeFileSync(
    STATE_FILE,
    JSON.stringify(state, null, 2),
    'utf8'
  );

  console.log(`${STATE_FILE}を保存しました`);
}

async function createGitHubIssue(title, body) {
  if (!GITHUB_TOKEN || !GITHUB_REPOSITORY) {
    console.log('GitHub通知用の環境変数がありません');
    return false;
  }

  const response = await fetch(
    `https://api.github.com/repos/${GITHUB_REPOSITORY}/issues`,
    {
      method: 'POST',
      headers: {
        Accept: 'application/vnd.github+json',
        Authorization: `Bearer ${GITHUB_TOKEN}`,
        'X-GitHub-Api-Version': '2022-11-28',
        'Content-Type': 'application/json',
        'User-Agent': 'toyota-event-monitor'
      },
      body: JSON.stringify({ title, body })
    }
  );

  if (!response.ok) {
    console.log(`GitHub通知作成エラー: ${response.status} ${await response.text()}`);
    return false;
  }

  console.log(`GitHub通知を作成しました: ${title}`);
  return true;
}

(async () => {
  const state = loadState();

  try {
    console.log('==============================');
    console.log('Toyota Event Monitor開始');
    console.log(`確認時刻: ${getJapanTime()}`);
    console.log('==============================');

    /*
     * 豊田市イベントRSSはメイン情報源。
     * 取得失敗時はstateを更新せず終了する。
     */
    const eventRss = await fetchText(EVENT_RSS_URL);
    const rssItems = parseRss(eventRss);

    /*
     * 若林交流館はサブ情報源。
     * 取得失敗時も豊田市RSSの処理は続ける。
     */
    let wakabayashiItems = [];

    try {
      const wakabayashiHtml = await fetchText(WAKABAYASHI_URL);
      wakabayashiItems = parseWakabayashi(
        wakabayashiHtml,
        WAKABAYASHI_URL
      );
    } catch (error) {
      console.log(`若林交流館の取得をスキップします: ${error.message}`);
      wakabayashiItems = [];
    }

    const sourceItems = [
      ...rssItems,
      ...wakabayashiItems
    ];

    const uniqueItems = new Map();

    for (const item of sourceItems) {
      uniqueItems.set(item.id, item);
    }

    console.log(`豊田市イベントRSS: ${rssItems.length}件`);
    console.log(`若林交流館: ${wakabayashiItems.length}件`);
    console.log(`重複統合後: ${uniqueItems.size}件`);

    const currentEntries = {};
    const notificationCandidates = [];

    for (const item of uniqueItems.values()) {
      const initialText = [
        item.title,
        item.description
      ].filter(Boolean).join(' ');

      if (containsAny(initialText, EXCLUDED_KEYWORDS)) {
        console.log(`一般ニュースのため除外: ${item.title}`);
        continue;
      }

      if (
        !containsAny(initialText, EVENT_KEYWORDS) &&
        item.source !== '若林交流館'
      ) {
        console.log(`イベント判定外: ${item.title}`);
        continue;
      }

      let detailText = item.description;

      if (item.source === '豊田市イベントRSS') {
        try {
          detailText = normalizeText(await fetchText(item.url));
          await sleep(WAIT_BETWEEN_REQUESTS_MS);
        } catch (error) {
          console.log(`詳細ページ取得失敗のため除外: ${item.title} / ${error.message}`);
          continue;
        }
      }

      const dateInfo = getEventDateInfo(item, detailText);

      if (!isFutureEvent(dateInfo)) {
        console.log(`開催済み・日付不明のため除外: ${item.title}`);
        continue;
      }

      const location = extractFact(
        detailText,
        [/開催場所/, /会場/, /場所/]
      );

      const eventTime = extractFact(
        detailText,
        [/開催時間/, /午前\d/, /午後\d/, /\d{1,2}:\d{2}/]
      );

      const fee = extractFact(
        detailText,
        [/参加費/, /料金/, /入場無料/, /無料/]
      );

      const application = extractFact(
        detailText,
        [/申込み/, /申込/, /予約/, /先着/]
      );

      const priority = containsAny(
        initialText,
        PRIORITY_KEYWORDS
      );

      const contentHash = createHash([
        item.title,
        dateInfo.display,
        location,
        eventTime,
        fee,
        application
      ].join('\n'));

      currentEntries[item.id] = {
        title: item.title,
        url: item.url,
        eventDate: dateInfo.display,
        contentHash,
        priority,
        lastSeenAt: getJapanTime()
      };

      const previous = state.entries[item.id];

      if (
        state.initialized &&
        (
          !previous ||
          previous.contentHash !== contentHash
        )
      ) {
        notificationCandidates.push({
          item,
          dateInfo,
          location,
          eventTime,
          fee,
          application,
          priority
        });
      }
    }

    /*
     * 初回・判定変更後は通知せず基準化する。
     */
    if (
      !state.initialized ||
      state.baselineVersion !== BASELINE_VERSION
    ) {
      state.initialized = true;
      state.baselineVersion = BASELINE_VERSION;
      state.entries = currentEntries;

      saveState(state);

      console.log('現在のイベントを基準として保存しました');
      console.log(`基準バージョン: ${BASELINE_VERSION}`);
      console.log('初回・再基準化のため今回は通知しません');

      return;
    }

    notificationCandidates.sort(
      (a, b) => Number(b.priority) - Number(a.priority)
    );

    console.log(`通知候補: ${notificationCandidates.length}件`);

    for (const candidate of notificationCandidates) {
      const icon = candidate.priority ? '🎪⭐' : '🎪';

      const timeText = candidate.eventTime
        ? `🕒 **時間：** ${candidate.eventTime}\n\n`
        : '';

      const locationText = candidate.location
        ? `📍 **場所：** ${candidate.location}\n\n`
        : '';

      const feeText = candidate.fee
        ? `💰 **料金：** ${candidate.fee}\n\n`
        : '';

      const applicationText = candidate.application
        ? `📝 **申込：** ${candidate.application}\n\n`
        : '';

      const body =
`@${GITHUB_USERNAME}

## ${icon} これから行ける豊田市イベント

**${candidate.item.title}**

📅 **開催日：** ${candidate.dateInfo.display}

${timeText}${locationText}${feeText}${applicationText}### 🔗 詳細ページ

${candidate.item.url}

情報源：${candidate.item.source}

確認時刻：${getJapanTime()}（日本時間）`;

      const title = (
        `${icon} ${candidate.item.title}`
      ).slice(0, 240);

      await createGitHubIssue(title, body);
      await sleep(500);
    }

    state.entries = {
      ...state.entries,
      ...currentEntries
    };

    saveState(state);

    console.log('==============================');
    console.log('Toyota Event Monitor終了');
    console.log(`通知作成: ${notificationCandidates.length}件`);
    console.log('==============================');

  } catch (error) {
    console.error(`Toyota Event Monitorエラー: ${error.stack}`);
    process.exitCode = 1;
  }
})();
