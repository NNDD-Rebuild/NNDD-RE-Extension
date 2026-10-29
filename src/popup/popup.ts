/**
 * ブラウザでログイン済みのニコニコ動画の user_session を、同じPCで動いている NNDD に渡す。
 *
 * NNDD のログイン画面を開いている間だけ、画面に表示されるコードが一致したときに受け付けられる。
 * 送信先は 127.0.0.1(同じPC)に固定。user_session は NNDD 以外には送らない。
 */

const NICO_URL = 'https://www.nicovideo.jp/';
const COOKIE_NAME = 'user_session';
const DEFAULT_PORT = 12301;
const PORT_KEY = 'nndd-port';

const codeInput = document.getElementById('code') as HTMLInputElement;
const portInput = document.getElementById('port') as HTMLInputElement;
const sendButton = document.getElementById('send') as HTMLButtonElement;
const statusEl = document.getElementById('nndd-status') as HTMLParagraphElement;
const resultEl = document.getElementById('result') as HTMLParagraphElement;

function loadPort(): number {
  try {
    const saved = Number(localStorage.getItem(PORT_KEY));
    if (Number.isInteger(saved) && saved >= 1 && saved <= 65535) return saved;
  } catch {
    // localStorage が使えなくても動く
  }
  return DEFAULT_PORT;
}

function currentPort(): number {
  const port = Number(portInput.value);
  return Number.isInteger(port) && port >= 1 && port <= 65535 ? port : DEFAULT_PORT;
}

function endpoint(): string {
  return `http://127.0.0.1:${currentPort()}/NNDDLogin`;
}

function setResult(message: string, ok: boolean): void {
  resultEl.textContent = message;
  resultEl.className = ok ? 'result ok' : 'result ng';
}

/** NNDD のログイン画面が待ち受けているかを表示する */
async function refreshStatus(): Promise<void> {
  statusEl.textContent = 'NNDD に接続中...';
  try {
    const res = await fetch(endpoint(), { method: 'GET' });
    const body = (await res.json()) as { waiting?: boolean };
    statusEl.textContent = body.waiting
      ? 'NNDD: ログイン画面が開いています。コードを入力して送れます。'
      : 'NNDD: ログイン画面が開いていません(またはコードの誤りが多すぎます)。NNDD のログイン画面を開き直してください。';
  } catch {
    statusEl.textContent = 'NNDD に接続できません。NNDD が起動しているか、ポートが合っているか確認してください。';
  }
}

async function getSession(): Promise<string | null> {
  const cookie = await chrome.cookies.get({ url: NICO_URL, name: COOKIE_NAME });
  return cookie?.value ? cookie.value : null;
}

async function send(): Promise<void> {
  const code = codeInput.value.trim();
  if (!/^\d{6}$/.test(code)) {
    setResult('NNDD のログイン画面に表示されている6桁のコードを入力してください。', false);
    return;
  }

  sendButton.disabled = true;
  setResult('', true);
  try {
    let session: string | null;
    try {
      session = await getSession();
    } catch {
      setResult('Cookie を読み取れませんでした。拡張の権限を確認してください。', false);
      return;
    }
    if (!session) {
      setResult('このブラウザでニコニコ動画にログインしていません。ログインしてからもう一度試してください。', false);
      return;
    }

    let res: Response;
    try {
      res = await fetch(endpoint(), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ code, userSession: session })
      });
    } catch {
      setResult('NNDD に接続できません。NNDD が起動しているか、ポートが合っているか確認してください。', false);
      return;
    }

    switch (res.status) {
      case 202:
        try {
          localStorage.setItem(PORT_KEY, String(currentPort()));
        } catch {
          // 保存できなくても問題ない
        }
        setResult('NNDD に送りました。NNDD の画面でログインの結果を確認してください。', true);
        codeInput.value = '';
        break;
      case 403:
        setResult('コードが違います。NNDD のログイン画面に表示されているコードを確認してください。', false);
        break;
      case 409:
        setResult('NNDD のログイン画面が開いていません。ログイン画面を開いてからもう一度試してください。', false);
        break;
      case 429:
        setResult('コードの誤りが続いたため受付を止めました。NNDD のログイン画面を開き直してください。', false);
        break;
      case 400:
        setResult('NNDD が受け取れない値でした。ブラウザでニコニコ動画に再ログインしてください。', false);
        break;
      default:
        setResult(`NNDD から想定外の応答がありました(${res.status})。`, false);
    }
  } finally {
    sendButton.disabled = false;
    void refreshStatus();
  }
}

portInput.value = String(loadPort());
sendButton.addEventListener('click', () => void send());
codeInput.addEventListener('keydown', (e) => {
  if (e.key === 'Enter') void send();
});
portInput.addEventListener('change', () => void refreshStatus());
void refreshStatus();
codeInput.focus();

export {};
