const fs = require('fs');
const crypto = require('crypto');

const EVENT_RSS_URL = process.env.TOYOTA_EVENT_RSS_URL;
const WAKABAYASHI_URL = process.env.WAKABAYASHI_EVENT_URL || '';
const GITHUB_TOKEN = process.env.GITHUB_TOKEN;
const GITHUB_REPOSITORY = process.env.GITHUB_REPOSITORY;
const GITHUB_USERNAME = process.env.GITHUB_ACTOR;

const STATE_FILE = 'toyota-event-state.json';
const REQUEST_TIMEOUT_MS = 30000;
const WAIT_BETWEEN_REQUESTS_MS = 350;
const BASELINE_VERSION = '2026-11-23-event-v1';
const LOOKAHEAD_DAYS = 120;

const EVENT_KEYWORDS = [
  'イベント','祭り','まつり','夏祭り','盆踊り','花火','縁日','マルシェ','マーケット','フリーマーケット',
  'キッチンカー','フェス','フェスタ','文化祭','コンサート','演奏会','上映会','展示','体験','ワークショップ',
  'イルミネーション','紅葉','桜','茶会','講座','教室','観察会','ウォーキング','ウオーキング'
];

const PRIORITY_KEYWORDS = [
  '若林','若林八幡宮','若林交流館','高岡','竹村','前林','若園','マルシェ','夏祭り','盆踊り','花火',
  '縁日','キッチンカー','無料','申込み不要','申込不要','中学生','親子','家族'
];

const EXCLUDED_KEYWORDS = [
  '市長記者会見','会議','議事録','入札','職員採用','表彰式','市長を訪問','表敬訪問','大会結果',
  '事業者向け説明会','オンライン開催のみ'
];

if (!EVENT_RSS_URL) {
  throw new Error('TOYOTA_EVENT_RSS_URLが設定されていません。');
}

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const nowJapan = () => new Date(new Date().toLocaleString('en-US', { timeZone: 'Asia/Tokyo' }));
const japanText = () => new Intl.DateTimeFormat('ja-JP', {
  timeZone: 'Asia/Tokyo', year: 'numeric', month: '2-digit', day: '2-digit',
  hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23'
}).format(new Date());
const hash = value => crypto.createHash('sha256').update(String(value || '')).digest('hex');

function decode(value) {
  return String(value || '')
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1')
    .replace(/&amp;/gi, '&').replace(/&lt;/gi, '<').replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"').replace(/&apos;/gi, "'")
    .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(Number(n)))
    .replace(/&#x([0-9a-f]+);/gi, (_, n) => String.fromCharCode(parseInt(n, 16)));
}

function stripHtml(value) {
  return decode(String(value || '')
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<(br|hr)\s*\/?>/gi, '\n')
    .replace(/<\/(p|li|div|section|article|h1|h2|h3|h4|tr)>/gi, '\n')
    .replace(/<[^>]+>/g, ' '))
    .replace(/\r/g, '').replace(/[ \t]+/g, ' ').replace(/\n[ \t]+/g, '\n')
    .replace(/\n{3,}/g, '\n\n').trim();
}

const normalize = value => stripHtml(value).replace(/\s+/g, ' ').trim();

async function fetchText(url) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  try {
    const response = await fetch(url, {
      headers: { 'User-Agent': 'Toyota-Event-Monitor/1.0', Accept: 'text/html,application/xml,text/xml,*/*' },
      signal: controller.signal
    });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    return await response.text();
  } finally {
    clearTimeout(timer);
  }
}

function getTag(xml, tag) {
  const escaped = tag.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const match = String(xml || '').match(new RegExp(`<${escaped}(?:\\s[^>]*)?>([\\s\\S]*?)<\\/${escaped}>`, 'i'));
  return match ? decode(match[1]).trim() : '';
}

function parseRss(xml) {
  const items = [];
  const blocks = String(xml || '').match(/<item(?:\s[^>]*)?>[\s\S]*?<\/item>/gi) || [];
  for (const block of blocks) {
    const title = normalize(getTag(block, 'title'));
    const url = getTag(block, 'link').trim();
    const description = normalize(getTag(block, 'description'));
    const publishedAt = normalize(getTag(block, 'pubDate'));
    if (!title || !url) continue;
    items.push({ id: url, title, url, description, publishedAt, source: '豊田市イベントRSS' });
  }
  return items;
}

function parseWakabayashi(html, baseUrl) {
  const text = stripHtml(html);
  const lines = text.split('\n').map(v => v.trim()).filter(Boolean);
  const items = [];
  for (let i = 0; i < lines.length; i++) {
    const m = lines[i].match(/^(\d{4})\s+(\d{1,2})\/(\d{1,2})\s*[（(].*?[）)]\s*(.+)$/);
    if (!m) continue;
    const date = `${m[1]}-${String(m[2]).padStart(2, '0')}-${String(m[3]).padStart(2, '0')}`;
    const title = m[4].trim();
    const description = lines[i + 1] || '';
    items.push({
      id: `${baseUrl}#${date}-${title}`, title, url: baseUrl,
      description, publishedAt: '', source: '若林交流館', explicitDate: date
    });
  }
  return items;
}

function findDates(text) {
  const currentYear = nowJapan().getFullYear();
  const results = [];
  const patterns = [
    /((?:20\d{2}|令和\d+)年)?\s*(\d{1,2})月\s*(\d{1,2})日/g,
    /(20\d{2})[-/.](\d{1,2})[-/.](\d{1,2})/g
  ];
  for (const pattern of patterns) {
    let m;
    while ((m = pattern.exec(text)) !== null) {
      let year = currentYear;
      if (m[1]) {
        if (String(m[1]).startsWith('令和')) year = 2018 + Number(String(m[1]).match(/\d+/)?.[0] || 0);
        else year = Number(m[1]);
      }
      const date = new Date(year, Number(m[2]) - 1, Number(m[3]), 23, 59, 59);
      if (!Number.isNaN(date.getTime())) results.push(date);
    }
  }
  return results;
}

function classifyDate(item, detailText) {
  if (item.explicitDate) {
    const d = new Date(`${item.explicitDate}T23:59:59+09:00`);
    return { dates: [d], display: item.explicitDate };
  }
  const dates = findDates(`${item.title} ${item.description} ${detailText}`);
  if (!dates.length) return { dates: [], display: '日付は詳細ページで確認' };
  dates.sort((a, b) => a - b);
  return {
    dates,
    display: dates.map(d => `${d.getFullYear()}/${d.getMonth() + 1}/${d.getDate()}`).slice(0, 2).join('～')
  };
}

function isFutureEvent(dateInfo) {
  if (!dateInfo.dates.length) return false;
  const today = nowJapan();
  today.setHours(0, 0, 0, 0);
  const limit = new Date(today);
  limit.setDate(limit.getDate() + LOOKAHEAD_DAYS);
  return dateInfo.dates.some(d => d >= today && d <= limit);
}

function extractFact(text, patterns) {
  const lines = stripHtml(text).split('\n').map(v => v.trim()).filter(Boolean);
  return lines.find(line => patterns.some(pattern => pattern.test(line))) || '';
}

function loadState() {
  if (!fs.existsSync(STATE_FILE)) return { initialized: false, baselineVersion: '', entries: {} };
  try {
    const loaded = JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'));
    return {
      initialized: Boolean(loaded.initialized),
      baselineVersion: loaded.baselineVersion || '',
      entries: loaded.entries || {}
    };
  } catch {
    return { initialized: false, baselineVersion: '', entries: {} };
  }
}

function saveState(state) {
  fs.writeFileSync(STATE_FILE, JSON.stringify(state, null, 2), 'utf8');
  console.log(`${STATE_FILE}を保存しました`);
}

async function createIssue(title, body) {
  if (!GITHUB_TOKEN || !GITHUB_REPOSITORY) return false;
  const response = await fetch(`https://api.github.com/repos/${GITHUB_REPOSITORY}/issues`, {
    method: 'POST',
    headers: {
      Accept: 'application/vnd.github+json', Authorization: `Bearer ${GITHUB_TOKEN}`,
      'X-GitHub-Api-Version': '2022-11-28', 'Content-Type': 'application/json',
      'User-Agent': 'toyota-event-monitor'
    },
    body: JSON.stringify({ title, body })
  });
  if (!response.ok) {
    console.log(`GitHub通知作成エラー: ${response.status} ${await response.text()}`);
    return false;
  }
  return true;
}

(async () => {
  const state = loadState();
  try {
    const rssItems = parseRss(await fetchText(EVENT_RSS_URL));
    let wakabayashiItems = [];
    if (WAKABAYASHI_URL) {
      wakabayashiItems = parseWakabayashi(await fetchText(WAKABAYASHI_URL), WAKABAYASHI_URL);
    }

    const sourceItems = [...rssItems, ...wakabayashiItems];
    const unique = new Map(sourceItems.map(item => [item.id, item]));
    const currentEntries = {};
    const candidates = [];

    console.log(`イベント候補: ${unique.size}件`);

    for (const item of unique.values()) {
      const initialText = `${item.title} ${item.description}`;
      if (containsAny(initialText, EXCLUDED_KEYWORDS)) continue;
      if (!containsAny(initialText, EVENT_KEYWORDS) && item.source !== '若林交流館') continue;

      let detailText = item.description;
      if (item.source === '豊田市イベントRSS') {
        detailText = normalize(await fetchText(item.url));
        await sleep(WAIT_BETWEEN_REQUESTS_MS);
      }

      const dateInfo = classifyDate(item, detailText);
      if (!isFutureEvent(dateInfo)) {
        console.log(`開催済み・日付不明のため除外: ${item.title}`);
        continue;
      }

      const location = extractFact(detailText, [/開催場所/,/会場/,/場所/]);
      const time = extractFact(detailText, [/開催時間/,/午前\d/,/午後\d/,/\d{1,2}:\d{2}/]);
      const fee = extractFact(detailText, [/参加費/,/料金/,/入場無料/,/無料/]);
      const application = extractFact(detailText, [/申込み/,/申込/,/予約/,/先着/]);
      const priority = containsAny(initialText, PRIORITY_KEYWORDS);
      const contentHash = hash([item.title, dateInfo.display, location, time, fee, application].join('\n'));

      currentEntries[item.id] = {
        title: item.title, url: item.url, eventDate: dateInfo.display,
        contentHash, priority, lastSeenAt: japanText()
      };

      const previous = state.entries[item.id];
      if (state.initialized && (!previous || previous.contentHash !== contentHash)) {
        candidates.push({ item, dateInfo, location, time, fee, application, priority });
      }
    }

    if (!state.initialized || state.baselineVersion !== BASELINE_VERSION) {
      state.initialized = true;
      state.baselineVersion = BASELINE_VERSION;
      state.entries = currentEntries;
      saveState(state);
      console.log('初回・再基準化のため今回は通知しません');
      return;
    }

    candidates.sort((a, b) => Number(b.priority) - Number(a.priority));
    console.log(`通知候補: ${candidates.length}件`);

    for (const c of candidates) {
      const icon = c.priority ? '🎪⭐' : '🎪';
      const body = `@${GITHUB_USERNAME}\n\n## ${icon} これから行ける豊田市イベント\n\n**${c.item.title}**\n\n📅 **開催日：** ${c.dateInfo.display}\n\n${c.time ? `🕒 **時間：** ${c.time}\n\n` : ''}${c.location ? `📍 **場所：** ${c.location}\n\n` : ''}${c.fee ? `💰 **料金：** ${c.fee}\n\n` : ''}${c.application ? `📝 **申込：** ${c.application}\n\n` : ''}### 🔗 詳細ページ\n\n${c.item.url}\n\n情報源：${c.item.source}\n\n確認時刻：${japanText()}（日本時間）`;
      await createIssue(`${icon} ${c.item.title}`.slice(0, 240), body);
      await sleep(500);
    }

    state.entries = { ...state.entries, ...currentEntries };
    saveState(state);
    console.log(`Toyota Event Monitor終了 通知作成: ${candidates.length}件`);
  } catch (error) {
    console.error(`Toyota Event Monitorエラー: ${error.stack}`);
    process.exitCode = 1;
  }
})();
