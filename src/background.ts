/**
 * NNDD への user_session の受け渡し(バックグラウンド)。
 *
 * NNDD の「Chrome を開く」ボタンが開いたタブ(https://www.nicovideo.jp/?nndd_login_code=コード)のコンテンツスクリプト
 * (src/content/login.ts)から、ペアリングコードを受け取る。
 *  - このブラウザでニコニコ動画にログイン済みなら、user_session を同じPCの NNDD(127.0.0.1)に送り、タブを閉じる。
 *  - 未ログインなら、そのタブでログインページを開いて待ち、ログインを検知したら NNDD に送ってタブを閉じる。
 * Cookie の読み取りと NNDD への送信は、ページの制約(CORS など)を受けないここで行う。
 *
 * バックグラウンドは一定時間で停止されるため、待機中の情報は chrome.storage.session に保存する。
 */

const NICO_URL = 'https://www.nicovideo.jp/';
const LOGIN_PAGE_URL = 'https://account.nicovideo.jp/login?site=niconico&next_url=%2F';
const COOKIE_NAME = 'user_session';
const NNDD_PORT = 12301;
const NNDD_LOGIN_URL = `http://127.0.0.1:${NNDD_PORT}/NNDDLogin`;

const PENDING_KEY = 'nndd-pending';
const RESULT_KEY = 'nndd-result';
/** ログイン待ちの有効時間(2段階認証などで時間がかかる場合を見込む) */
const PENDING_TTL_MS = 10 * 60 * 1000;
/** 成功メッセージを見せてからタブを閉じるまでの時間 */
const CLOSE_DELAY_MS = 2000;

interface LoginResult {
  ok: boolean;
  message: string;
  /** ログインを待っている(タブをログインページに移した) */
  pending?: boolean;
}

interface Pending {
  code: string;
  tabId: number;
  at: number;
}

interface StoredResult {
  tabId: number;
  ok: boolean;
  message: string;
}

async function readSession(): Promise<string | null> {
  try {
    const cookie = await chrome.cookies.get({ url: NICO_URL, name: COOKIE_NAME });
    return cookie?.value && cookie.value !== 'deleted' ? cookie.value : null;
  } catch {
    return null;
  }
}

async function postToNndd(code: string, session: string): Promise<LoginResult> {
  let res: Response;
  try {
    res = await fetch(NNDD_LOGIN_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ code, userSession: session })
    });
  } catch {
    return { ok: false, message: 'NNDD に接続できません。NNDD のログイン画面を開いたままにしてください。' };
  }

  switch (res.status) {
    case 202:
      return { ok: true, message: 'NNDD にログイン情報を送りました。このタブは自動で閉じます。' };
    case 403:
      return { ok: false, message: 'コードが違います。NNDD の「Chrome を開く」をもう一度押してください。' };
    case 409:
      return { ok: false, message: 'NNDD のログイン画面が開いていません。' };
    case 429:
      return { ok: false, message: 'コードの誤りが続いたため受付を止めました。NNDD のログイン画面を開き直してください。' };
    default:
      return { ok: false, message: `NNDD から想定外の応答がありました(${res.status})。` };
  }
}

function closeTabLater(tabId: number, delayMs: number): void {
  setTimeout(() => {
    chrome.tabs.remove(tabId).catch(() => {
      // すでに閉じられている
    });
  }, delayMs);
}

/** コンテンツスクリプトからの依頼: ログイン済みなら送信、未ログインならログインを待つ */
async function handleLoginRequest(code: string, tabId: number | undefined): Promise<LoginResult> {
  if (!/^\d{6}$/.test(code)) {
    return { ok: false, message: 'コードの形式が正しくありません。' };
  }

  const session = await readSession();
  if (session) {
    const result = await postToNndd(code, session);
    if (result.ok && tabId !== undefined) closeTabLater(tabId, CLOSE_DELAY_MS);
    return result;
  }

  // 未ログイン: このタブでログインページを開き、ログインされるのを待つ
  if (tabId === undefined) {
    return { ok: false, message: 'このブラウザでニコニコ動画にログインしていません。' };
  }
  const pending: Pending = { code, tabId, at: Date.now() };
  await chrome.storage.session.set({ [PENDING_KEY]: pending });
  await chrome.tabs.update(tabId, { url: LOGIN_PAGE_URL });
  return {
    ok: false,
    pending: true,
    message: 'ニコニコ動画にログインしてください。ログインすると自動で NNDD に送り、このタブを閉じます。'
  };
}

// ログインを待っている間に user_session が設定されたら(=ログインされたら)、NNDD に送ってタブを閉じる
chrome.cookies.onChanged.addListener((info) => {
  const cookie = info.cookie;
  if (info.removed || cookie.name !== COOKIE_NAME || !cookie.domain.endsWith('nicovideo.jp')) return;
  if (!cookie.value || cookie.value === 'deleted') return;

  void (async () => {
    const stored = await chrome.storage.session.get(PENDING_KEY);
    const pending = stored[PENDING_KEY] as Pending | undefined;
    if (!pending) return;
    // 1回だけ処理する(続けて Cookie が更新されても、二重に送らない)
    await chrome.storage.session.remove(PENDING_KEY);
    if (Date.now() - pending.at > PENDING_TTL_MS) return;

    const result = await postToNndd(pending.code, cookie.value);
    if (result.ok) {
      closeTabLater(pending.tabId, 0);
      return;
    }
    // 失敗: ログインページのままでは伝えられないので、ニコニコ動画のトップに戻して結果を表示する
    const failed: StoredResult = { tabId: pending.tabId, ok: false, message: result.message };
    await chrome.storage.session.set({ [RESULT_KEY]: failed });
    try {
      await chrome.tabs.update(pending.tabId, { url: NICO_URL });
    } catch {
      // タブが閉じられている
    }
  })();
});

chrome.runtime.onMessage.addListener((message: unknown, sender, sendResponse) => {
  // この拡張自身のコンテンツスクリプト(ニコニコ動画のページ)からだけ受け付ける
  if (sender.id !== chrome.runtime.id) return false;
  if (!sender.url || !sender.url.startsWith(NICO_URL)) return false;
  const msg = message as { type?: string; code?: unknown } | null;
  if (!msg) return false;

  if (msg.type === 'nndd-login' && typeof msg.code === 'string') {
    void handleLoginRequest(msg.code, sender.tab?.id).then(sendResponse);
    return true; // 非同期で応答する
  }

  if (msg.type === 'nndd-result') {
    // ログイン待ちの結果が失敗だった場合に、戻したタブで表示するため
    void (async () => {
      const stored = await chrome.storage.session.get(RESULT_KEY);
      const result = stored[RESULT_KEY] as StoredResult | undefined;
      if (result && result.tabId === sender.tab?.id) {
        await chrome.storage.session.remove(RESULT_KEY);
        sendResponse({ ok: result.ok, message: result.message });
      } else {
        sendResponse(null);
      }
    })();
    return true;
  }

  return false;
});

export {};
