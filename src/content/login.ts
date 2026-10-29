/**
 * NNDD の「Chrome を開く」ボタンから開かれたときに、user_session を NNDD に送る。
 *
 * NNDD は https://www.nicovideo.jp/?nndd_login_code=123456 のように、ログイン画面に表示しているコードを付けてブラウザを開く。
 * このコードを知っているのは NNDD が開いたブラウザだけなので、他のウェブサイトは送り込めない。
 * 実際の Cookie の読み取り・送信・タブを閉じる処理は background.ts が行う。
 */

const PARAM = 'nndd_login_code';

interface Result {
  ok: boolean;
  message: string;
  pending?: boolean;
}

function showToast(message: string, ok: boolean): void {
  const el = document.createElement('div');
  el.textContent = message;
  el.setAttribute('role', 'status');
  el.style.cssText = [
    'position:fixed',
    'top:16px',
    'right:16px',
    'z-index:2147483647',
    'max-width:360px',
    'padding:12px 16px',
    'border-radius:6px',
    'font:14px/1.5 system-ui,sans-serif',
    'color:#fff',
    `background:${ok ? '#1a7f37' : '#cf222e'}`,
    'box-shadow:0 2px 8px rgba(0,0,0,.3)'
  ].join(';');
  document.body.appendChild(el);
  setTimeout(() => el.remove(), 10000);
}

async function main(): Promise<void> {
  const url = new URL(location.href);
  const code = url.searchParams.get(PARAM);

  if (code === null) {
    // ログイン待ちが失敗してこのタブに戻された場合の結果表示
    try {
      const result = (await chrome.runtime.sendMessage({ type: 'nndd-result' })) as Result | null | undefined;
      if (result) showToast(result.message, result.ok);
    } catch {
      // 拡張が使えない場合は何もしない
    }
    return;
  }

  // コードをアドレスバーに残さない(履歴や共有に残さないため)
  url.searchParams.delete(PARAM);
  history.replaceState(null, '', url.toString());

  if (!/^\d{6}$/.test(code)) return;

  try {
    const result = (await chrome.runtime.sendMessage({ type: 'nndd-login', code })) as Result | undefined;
    // 未ログインの場合は、この直後にタブがログインページに移るので、表示は不要
    if (result && !result.pending) showToast(result.message, result.ok);
  } catch {
    showToast('拡張から NNDD への送信に失敗しました。', false);
  }
}

void main();

export {};
