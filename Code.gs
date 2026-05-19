// ============================================================
//  Personal Secretary Bot - 個人秘書システム
//  Module 1: 勤怠管理(Attendance)
//
//  設計思想:
//    LINEを単一のインターフェースとした個人秘書システム。
//    現在は勤怠管理モジュールのみだが、コマンドはハンドラマップで
//    管理しており、新しい秘書機能はハンドラを1つ追加するだけで
//    拡張できる構造になっている。
//
//  ⚠️ 認証情報は一切ハードコードしない。
//     すべてスクリプトプロパティから読み込む。
//     設定方法は README.md を参照。
// ============================================================

// ===== スクリプトプロパティから設定を読み込む =====
const PROPS = PropertiesService.getScriptProperties();

const CHANNEL_ACCESS_TOKEN = PROPS.getProperty('CHANNEL_ACCESS_TOKEN');
const MY_USER_ID           = PROPS.getProperty('MY_USER_ID');
const NOTION_TOKEN         = PROPS.getProperty('NOTION_TOKEN');
const NOTION_DB_ID         = PROPS.getProperty('NOTION_DB_ID');

const TZ = 'Asia/Tokyo';

// ポモドーロ設定(テスト時は 1 と 2 に。本番は 50 と 60)
const NOTIFY_FIRST_MIN  = 100;
const NOTIFY_SECOND_MIN = 120;

// ============================================================
//  コマンドルーター
//
//  秘書システムの中核。LINEから届いたテキストを対応する
//  ハンドラに振り分ける。新しい秘書機能を追加する場合は
//  COMMAND_HANDLERS にエントリを1つ足すだけでよい。
//
//  例: タスク管理モジュールを足すなら
//      'タスク追加': handleTaskAdd,
//      'タスク一覧': handleTaskList,
//  のようにハンドラ関数を実装して登録するだけ。
//  ルーティングのコア(doPost)には一切手を入れる必要がない。
// ============================================================
const COMMAND_HANDLERS = {
  // --- Module 1: 勤怠管理 ---
  '出勤': handleClockIn,
  '休憩': handleBreakStart,
  '再開': handleBreakEnd,
  '退勤': handleClockOut,

  // --- ヘルプ(全モジュール共通) ---
  'ヘルプ': handleHelp,

  // --- 今後追加予定のモジュール例(設計上の拡張ポイント) ---
  // Module 2: タスク管理   → 'タスク追加' / 'タスク一覧' / 'タスク完了'
  // Module 3: メモ          → 'メモ' (Notion別DBに保存)
  // Module 4: リマインド    → 'リマインド' (時刻指定でpush通知)
  // Module 5: 日次サマリー  → 'サマリー' (稼働+タスクをまとめて通知)
};

const FALLBACK_MESSAGE =
  '知らないコマンドだニャ😺\n「ヘルプ」と送ると使えるコマンドを教えるニャ😺';

// ============================================================
//  設定チェック(初回セットアップ時に実行して確認する)
// ============================================================
function validateConfig_() {
  const missing = [];
  if (!CHANNEL_ACCESS_TOKEN) missing.push('CHANNEL_ACCESS_TOKEN');
  if (!MY_USER_ID)           missing.push('MY_USER_ID');
  if (!NOTION_TOKEN)         missing.push('NOTION_TOKEN');
  if (!NOTION_DB_ID)         missing.push('NOTION_DB_ID');
  if (missing.length > 0) {
    throw new Error(
      'スクリプトプロパティが未設定です: ' + missing.join(', ') +
      '\nGASエディタの「プロジェクトの設定 > スクリプト プロパティ」から登録してください。'
    );
  }
}

// ============================================================
//  Webhook受信(ルーティングのコア。機能追加時も変更不要)
// ============================================================
function doPost(e) {
  validateConfig_();

  const data = JSON.parse(e.postData.contents);
  const event = data.events && data.events[0];
  if (!event || event.type !== 'message' || event.message.type !== 'text') {
    return ContentService.createTextOutput('OK');
  }

  // 自分以外からのメッセージは無視(一人運用の安全策)
  if (event.source && event.source.userId && event.source.userId !== MY_USER_ID) {
    return ContentService.createTextOutput('OK');
  }

  const text = event.message.text.trim();
  const replyToken = event.replyToken;

  // ハンドラマップから対応する処理を取得して実行
  const handler = COMMAND_HANDLERS[text];
  const msg = handler ? handler() : FALLBACK_MESSAGE;

  reply(replyToken, msg);
  return ContentService.createTextOutput('OK');
}

// ============================================================
//  ヘルプ(登録済みコマンドを動的に列挙)
// ============================================================
function handleHelp() {
  const commands = Object.keys(COMMAND_HANDLERS).join(' / ');
  return [
    '使えるコマンドだニャ😺',
    commands,
    '',
    '今は勤怠管理モジュールだけだけど、',
    'これから少しずつ秘書機能を増やしていくニャ😺',
  ].join('\n');
}

// ============================================================
//  状態管理(PropertiesServiceに保持)
// ============================================================
function getState() {
  const raw = PROPS.getProperty('STATE');
  if (!raw) {
    return {
      working: false, clockIn: '', onBreak: false, breakStart: '', breakTotalMin: 0,
      cycleStart: '', notified50: false, notified60: false, lastBreakNotify: '',
    };
  }
  return JSON.parse(raw);
}

function setState(s) {
  PROPS.setProperty('STATE', JSON.stringify(s));
}

// ============================================================
//  Module 1: 勤怠管理 - 各コマンド処理
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
    lastBreakNotify: '',
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
  s.lastBreakNotify = now.toISOString();
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
//  Module 1: ポモドーロ通知(1分おきトリガーで実行)
// ============================================================
function notifyElapsed() {
  const s = getState();
  if (!s.working) return;

  // 休憩中: 1時間ごとに通知
  if (s.onBreak) {
    if (!s.lastBreakNotify) return;
    const breakElapsed = (new Date() - new Date(s.lastBreakNotify)) / 60000;
    if (breakElapsed >= 30) {
      const totalBreak = Math.round(s.breakTotalMin + (new Date() - new Date(s.breakStart)) / 60000);
      if (push('😴 休憩中だニャ😺\n合計' + totalBreak + '分休んでるニャ😺\nそろそろ再開するニャ？😺')) {
        s.lastBreakNotify = new Date().toISOString();
        setState(s);
      }
    }
    return;
  }

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
      // サイクルをリセット → 次の50分/60分通知が繰り返される
      s.cycleStart = new Date().toISOString();
      s.notified50 = false;
      s.notified60 = false;
      setState(s);
    }
    return;
  }
}

// ============================================================
//  Notion保存(勤怠ログ)
//  ※ 他モジュールでNotionを使う場合も、この関数を参考に
//    モジュールごとに保存関数を分離する設計とする
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
//  LINE送信(全モジュール共通インフラ)
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
  validateConfig_();
  const ok = push('テスト通知だニャ😺');
  Logger.log('push結果: ' + ok);
}

function checkConfig() {
  // トークンの中身は出力しない。設定済みかどうかだけ確認する。
  Logger.log('CHANNEL_ACCESS_TOKEN: ' + (CHANNEL_ACCESS_TOKEN ? '設定済み' : '未設定'));
  Logger.log('MY_USER_ID: '           + (MY_USER_ID ? '設定済み' : '未設定'));
  Logger.log('NOTION_TOKEN: '          + (NOTION_TOKEN ? '設定済み' : '未設定'));
  Logger.log('NOTION_DB_ID: '          + (NOTION_DB_ID ? '設定済み' : '未設定'));
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
