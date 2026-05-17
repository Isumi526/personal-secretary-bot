// ============================================================
//  LINE勤怠管理Bot(Notion保存版・ポモドーロ通知・猫口調) 一人運用
//  ※トークン類はスクリプトプロパティで管理(コードに直書きしない)
// ============================================================

// ===== 設定(スクリプトプロパティから読み込み) =====
function getProp(key) {
  const v = PropertiesService.getScriptProperties().getProperty(key);
  if (!v) throw new Error('スクリプトプロパティ「' + key + '」が未設定だニャ😺 プロジェクトの設定で登録するニャ😺');
  return v;
}

const CHANNEL_ACCESS_TOKEN = getProp('CHANNEL_ACCESS_TOKEN');
const MY_USER_ID           = getProp('MY_USER_ID');
const NOTION_TOKEN         = getProp('NOTION_TOKEN');
const NOTION_DB_ID         = getProp('NOTION_DB_ID');

const TZ = 'Asia/Tokyo';

// ポモドーロ設定(テスト時は 1 と 2 に。本番は 50 と 60)
const NOTIFY_FIRST_MIN  = 50;
const NOTIFY_SECOND_MIN = 60;

// ============================================================
//  Webhook受信
// ============================================================
function doPost(e) {
  const data = JSON.parse(e.postData.contents);
  const event = data.events && data.events[0];
  if (!event || event.type !== 'message' || event.message.type !== 'text') {
    return ContentService.createTextOutput('OK');
  }

  const text = event.message.text.trim();
  const replyToken = event.replyToken;

  let msg = '';
  switch (text) {
    case '出勤': msg = handleClockIn();    break;
    case '休憩': msg = handleBreakStart(); break;
    case '再開': msg = handleBreakEnd();   break;
    case '退勤': msg = handleClockOut();   break;
    default:
      msg = 'コマンドは 出勤 / 休憩 / 再開 / 退勤 のどれかだニャ😺';
  }

  reply(replyToken, msg);
  return ContentService.createTextOutput('OK');
}

// ============================================================
//  状態管理(PropertiesServiceに保持)
// ============================================================
function getState() {
  const raw = PropertiesService.getScriptProperties().getProperty('STATE');
  if (!raw) {
    return {
      working: false, clockIn: '', onBreak: false, breakStart: '', breakTotalMin: 0,
      cycleStart: '', notified50: false, notified60: false,
    };
  }
  return JSON.parse(raw);
}

function setState(s) {
  PropertiesService.getScriptProperties().setProperty('STATE', JSON.stringify(s));
}

// ============================================================
//  各コマンド処理
// ============================================================
function handleClockIn() {
  const s = getState();
  if (s.working) return 'もう出勤してるニャ😺';
  const now = new Date();
  setState({
    working: true,
    clockIn: now.toISOString(),
    onBreak: false,
    breakStart: '',
    breakTotalMin: 0,
    cycleStart: now.toISOString(),
    notified50: false,
    notified60: false,
  });
  return '出勤したニャ(' + fmt(now) + ')😺\n' + NOTIFY_FIRST_MIN + '分後に教えるニャ😺';
}

function handleBreakStart() {
  const s = getState();
  if (!s.working)  return 'まだ出勤してないニャ😺';
  if (s.onBreak)   return 'もう休憩中だニャ😺';
  const now = new Date();
  s.onBreak = true;
  s.breakStart = now.toISOString();
  setState(s);
  return '休憩スタートだニャ(' + fmt(now) + ')😺\nゆっくり休むニャ😺';
}

function handleBreakEnd() {
  const s = getState();
  if (!s.working) return 'まだ出勤してないニャ😺';
  if (!s.onBreak) return '休憩してないニャ😺';
  const now = new Date();
  const mins = (now - new Date(s.breakStart)) / 60000;
  s.breakTotalMin += mins;
  s.onBreak = false;
  s.breakStart = '';
  s.cycleStart = now.toISOString();
  s.notified50 = false;
  s.notified60 = false;
  setState(s);
  return '再開だニャ(' + fmt(now) + ')😺\n今日の休憩は合計' + Math.round(s.breakTotalMin) + '分だニャ😺\n' + NOTIFY_FIRST_MIN + '分後に教えるニャ😺';
}

function handleClockOut() {
  const s = getState();
  if (!s.working) return 'まだ出勤してないニャ😺';

  const now = new Date();
  if (s.onBreak) {
    s.breakTotalMin += (now - new Date(s.breakStart)) / 60000;
  }

  const clockIn  = new Date(s.clockIn);
  const grossMin = (now - clockIn) / 60000;
  const netMin   = grossMin - s.breakTotalMin;
  const netHours = Math.round((netMin / 60) * 100) / 100;
  const breakMin = Math.round(s.breakTotalMin);

  saveToNotion(clockIn, now, breakMin, netHours);

  setState({
    working: false, clockIn: '', onBreak: false, breakStart: '', breakTotalMin: 0,
    cycleStart: '', notified50: false, notified60: false,
  });

  return [
    '退勤だニャ、おつかれさまニャ(' + fmt(now) + ')😺',
    '出勤:' + fmt(clockIn) + 'だニャ😺',
    '休憩合計:' + breakMin + '分だニャ😺',
    '実質稼働:' + netHours + '時間だニャ😺',
  ].join('\n');
}

// ============================================================
//  ポモドーロ通知(1分おきトリガーで実行)
// ============================================================
function notifyElapsed() {
  const s = getState();
  if (!s.working) return;
  if (s.onBreak)  return;
  if (!s.cycleStart) return;

  const elapsedMin = (new Date() - new Date(s.cycleStart)) / 60000;

  if (elapsedMin >= NOTIFY_FIRST_MIN && !s.notified50) {
    if (push('⏰ 作業はじめてから' + NOTIFY_FIRST_MIN + '分たったニャ😺\nそろそろ区切る準備をするニャ😺')) {
      s.notified50 = true;
      setState(s);
    }
    return;
  }

  if (elapsedMin >= NOTIFY_SECOND_MIN && !s.notified60) {
    if (push('🔔 さらに' + (NOTIFY_SECOND_MIN - NOTIFY_FIRST_MIN) + '分たって計' + NOTIFY_SECOND_MIN + '分だニャ😺\n「休憩」って送って休むニャ😺')) {
      s.notified60 = true;
      setState(s);
    }
    return;
  }
}

// ============================================================
//  Notionに1行追加
// ============================================================
function saveToNotion(clockIn, clockOut, breakMin, netHours) {
  const payload = {
    parent: { database_id: NOTION_DB_ID },
    properties: {
      '日付': {
        title: [{ text: { content: Utilities.formatDate(clockIn, TZ, 'yyyy/MM/dd') } }],
      },
      '出勤': {
        date: { start: Utilities.formatDate(clockIn, TZ, "yyyy-MM-dd'T'HH:mm:ssXXX") },
      },
      '退勤': {
        date: { start: Utilities.formatDate(clockOut, TZ, "yyyy-MM-dd'T'HH:mm:ssXXX") },
      },
      '休憩合計(分)': { number: breakMin },
      '実質稼働(時間)': { number: netHours },
    },
  };

  const res = UrlFetchApp.fetch('https://api.notion.com/v1/pages', {
    method: 'post',
    contentType: 'application/json',
    headers: {
      Authorization: 'Bearer ' + NOTION_TOKEN,
      'Notion-Version': '2022-06-28',
    },
    payload: JSON.stringify(payload),
    muteHttpExceptions: true,
  });

  if (res.getResponseCode() >= 300) {
    push('⚠️ Notionへの保存に失敗したニャ😺\n' + res.getContentText().slice(0, 300));
  }
}

// ============================================================
//  LINE送信
// ============================================================
function reply(replyToken, text) {
  UrlFetchApp.fetch('https://api.line.me/v2/bot/message/reply', {
    method: 'post',
    contentType: 'application/json',
    headers: { Authorization: 'Bearer ' + CHANNEL_ACCESS_TOKEN },
    payload: JSON.stringify({
      replyToken: replyToken,
      messages: [{ type: 'text', text: text }],
    }),
    muteHttpExceptions: true,
  });
}

// push成功(HTTP 200)ならtrueを返す。失敗時は詳細をログ出力
function push(text) {
  const res = UrlFetchApp.fetch('https://api.line.me/v2/bot/message/push', {
    method: 'post',
    contentType: 'application/json',
    headers: { Authorization: 'Bearer ' + CHANNEL_ACCESS_TOKEN },
    payload: JSON.stringify({
      to: MY_USER_ID,
      messages: [{ type: 'text', text: text }],
    }),
    muteHttpExceptions: true,
  });
  const code = res.getResponseCode();
  if (code !== 200) {
    Logger.log('push失敗 HTTP=' + code + ' body=' + res.getContentText());
  }
  return code === 200;
}

// ============================================================
//  動作テスト用
// ============================================================
function testPush() {
  const ok = push('テスト通知だニャ😺');
  Logger.log('push結果: ' + ok);
}

// プロパティが4つとも入っているか形だけ確認(値そのものは出さない)
function checkConfig() {
  ['CHANNEL_ACCESS_TOKEN', 'MY_USER_ID', 'NOTION_TOKEN', 'NOTION_DB_ID'].forEach(function (k) {
    const v = PropertiesService.getScriptProperties().getProperty(k);
    Logger.log(k + ': ' + (v ? ('OK length=' + v.length) : '未設定！'));
  });
}

// ============================================================
//  ユーティリティ
// ============================================================
function fmt(d) {
  return Utilities.formatDate(new Date(d), TZ, 'HH:mm');
}

function doGet() {
  return ContentService.createTextOutput('稼働中だニャ😺');
}