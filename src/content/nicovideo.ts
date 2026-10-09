const CMD_SCHEME = 'nndd-re-cmd';
const BUTTON_ROOT_ID = 'nndd-re-ext-root';
const MENU_ID = 'nndd-re-ext-menu';

console.log('[NNDD-RE Ext] content script loaded on', location.href);

type PageInfo =
  | { kind: 'watch'; videoId: string }
  | { kind: 'mylist'; mylistId: string }
  | { kind: 'live'; liveId: string }
  | null;

function parsePage(url: string): PageInfo {
  const watchMatch = url.match(/\/watch\/((?:sm|nm|so)\d+)/);
  if (watchMatch) return { kind: 'watch', videoId: watchMatch[1] };

  const mylistMatch = url.match(/\/(?:my\/)?mylist\/(\d+)/) ?? url.match(/\/user\/\d+\/mylist\/(\d+)/);
  if (mylistMatch) return { kind: 'mylist', mylistId: mylistMatch[1] };

  const liveMatch = url.match(/^https:\/\/live\.nicovideo\.jp\/watch\/(lv\d+)/);
  if (liveMatch) return { kind: 'live', liveId: liveMatch[1] };

  return null;
}

function buildCmdUrl(action: 'play' | 'download' | 'mylist' | 'live' | 'liveRecord', id: string): string {
  return `${CMD_SCHEME}://${action}/${id}`;
}

function makeButton(label: string, href: string): HTMLAnchorElement {
  const a = document.createElement('a');
  a.href = href;
  a.textContent = label;
  a.className = 'nndd-re-ext-button';
  return a;
}

function makeMenuItem(label: string, href: string): HTMLAnchorElement {
  const a = document.createElement('a');
  a.href = href;
  a.textContent = label;
  a.className = 'nndd-re-ext-menu-item';
  a.setAttribute('role', 'menuitem');
  a.addEventListener('click', () => closeMenu());
  return a;
}

function makeTrigger(): HTMLButtonElement {
  const b = document.createElement('button');
  b.type = 'button';
  b.textContent = 'RE';
  b.className = 'nndd-re-ext-trigger';
  b.title = 'NNDD-RE';
  b.setAttribute('aria-haspopup', 'menu');
  b.setAttribute('aria-expanded', 'false');
  return b;
}

// ------------------------------------------------------------------
// ドロップダウンメニュー
// アクションバーの祖先が overflow:hidden なため、メニューはその中に置くと
// 切り取られる。body直下に position:fixed で出し、座標をトリガーから算出する。
// ------------------------------------------------------------------
let openMenuEl: HTMLElement | null = null;
let activeTrigger: HTMLElement | null = null;

function closeMenu(): void {
  if (!openMenuEl) return;
  openMenuEl.remove();
  openMenuEl = null;
  activeTrigger?.setAttribute('aria-expanded', 'false');
  activeTrigger = null;
  document.removeEventListener('pointerdown', onDocPointerDown, true);
  document.removeEventListener('keydown', onDocKeyDown, true);
  window.removeEventListener('scroll', closeMenu, true);
  window.removeEventListener('resize', closeMenu);
}

function onDocPointerDown(e: Event): void {
  const target = e.target as Node;
  if (openMenuEl?.contains(target) || activeTrigger?.contains(target)) return;
  closeMenu();
}

function onDocKeyDown(e: KeyboardEvent): void {
  if (e.key === 'Escape') closeMenu();
}

function positionMenu(menu: HTMLElement, trigger: HTMLElement): void {
  const t = trigger.getBoundingClientRect();
  const m = menu.getBoundingClientRect();
  // アクションバーは画面下寄りにあることが多いため既定は上方向。入らなければ下。
  let top = t.top - m.height - 8;
  if (top < 8) top = t.bottom + 8;
  // 右端をトリガーに揃える（メニューが画面右外へ出ないように）
  let left = t.right - m.width;
  left = Math.min(Math.max(left, 8), window.innerWidth - m.width - 8);
  menu.style.top = `${top}px`;
  menu.style.left = `${left}px`;
}

function openMenuFor(trigger: HTMLElement, items: HTMLAnchorElement[]): void {
  closeMenu();

  const menu = document.createElement('div');
  menu.id = MENU_ID;
  menu.className = 'nndd-re-ext-menu';
  menu.setAttribute('role', 'menu');
  menu.append(...items);
  document.body.appendChild(menu);

  openMenuEl = menu;
  activeTrigger = trigger;
  trigger.setAttribute('aria-expanded', 'true');
  positionMenu(menu, trigger);

  document.addEventListener('pointerdown', onDocPointerDown, true);
  document.addEventListener('keydown', onDocKeyDown, true);
  window.addEventListener('scroll', closeMenu, true);
  window.addEventListener('resize', closeMenu);
}

interface Anchor {
  el: Element;
  position: InsertPosition;
}

// 視聴ページはPanda CSS系atomicクラスに全面刷新済みでクラス名でのアンカーは不可能なため、
// data-element-name="share" (共有ボタン、安定した計測用属性) から親のボタン群を辿り、
// 三点メニュー ([data-scope="menu"][data-part="trigger"]) の直前 = 共有と三点の間に置く。
// 共有と三点の間には nicoad/gift が data-video-action-hidden で挟まっていることがあるが、
// それらは非表示なので視覚上は共有の直後になる。
function findWatchAnchor(): Anchor | null {
  const shareBtn = document.querySelector('[data-element-name="share"]');
  if (shareBtn) {
    const group = shareBtn.parentElement;
    const menuBtn = group?.querySelector(':scope > [data-scope="menu"][data-part="trigger"]');
    if (menuBtn) return { el: menuBtn, position: 'beforebegin' };
    return { el: shareBtn, position: 'afterend' };
  }

  const actionBtn = document.querySelector('[data-element-area="video_action"]');
  if (actionBtn?.parentElement) return { el: actionBtn.parentElement, position: 'beforeend' };

  return null;
}

// マイリストページはヘッダーのフォロー/共有ボタンが並ぶ .MylistHeaderAction に相乗りする。
function findMylistAnchor(): Anchor | null {
  const el = document.querySelector('.MylistHeaderAction');
  return el ? { el, position: 'beforeend' } : null;
}

// 生放送ページは番組タイトル下の <ul> (タイムシフト予約/X共有/共有/その他の操作 の
// 4つの <li>) に相乗りする。クラス名はPanda CSS系atomicクラスで不安定なため、
// aria-label (安定した日本語ラベル) から「その他の操作」ボタンの祖先 <li> を辿り、
// その直前 = 共有とその他の間に置く。
function findLiveAnchor(): Anchor | null {
  const extraBtn = document.querySelector('button[aria-label="その他の操作"]');
  const extraLi = extraBtn?.closest('li');
  if (extraLi) return { el: extraLi, position: 'beforebegin' };

  const shareBtn = document.querySelector('button[aria-label="共有"]');
  const shareLi = shareBtn?.closest('li');
  if (shareLi) return { el: shareLi, position: 'afterend' };

  return null;
}

function renderButtons(container: HTMLElement, buttons: HTMLElement[]): void {
  container.replaceChildren(...buttons);
}

// 幅確保用のクラスを祖先に付ける。CSSの :has() で祖先を辿る手もあるが、
// ニコニコの巨大なDOMが常時書き換わる中では :has() の再計算が重すぎるため、
// mount時にJS側でクラスを付け直す。
function markActionBarAncestors(root: HTMLElement): void {
  const group = root.parentElement;
  const wrap = group?.parentElement;
  const bar = wrap?.parentElement;
  wrap?.classList.add('nndd-re-ext-actions-wrap');
  bar?.classList.add('nndd-re-ext-actions-bar');
}

function mount(): void {
  // mount自身のDOM操作でMutationObserverが再発火し、無限ループになるのを防ぐ。
  anchorObserver.disconnect();
  guardObserver.disconnect();
  try {
    doMount();
  } catch (e) {
    console.error('[NNDD-RE Ext] mount failed:', e);
  }
}

function doMount(): void {
  {
    const info = parsePage(location.href);
    if (!info) {
      document.getElementById(BUTTON_ROOT_ID)?.remove();
      closeMenu();
      return;
    }

    closeMenu();
    document.getElementById(BUTTON_ROOT_ID)?.remove();

    // 生放送ページの挿入先は <ul><li>...</li></ul> 構造のため、root自体を <li> にする。
    const root = document.createElement(info.kind === 'live' ? 'li' : 'div');
    root.id = BUTTON_ROOT_ID;

    let anchor: Anchor | null = null;
    if (info.kind === 'watch') {
      // 動画アクションバーは幅の余裕が無く、横長ボタンを足すと三点メニューが
      // overflow:hidden で切り落とされる。40px幅のアイコン1個に集約し、
      // 実際の操作はドロップダウンで出す。
      root.classList.add('nndd-re-ext-watch');
      const trigger = makeTrigger();
      trigger.addEventListener('click', (e) => {
        e.preventDefault();
        e.stopPropagation();
        if (openMenuEl) {
          closeMenu();
          return;
        }
        openMenuFor(trigger, [
          makeMenuItem('NNDD-REで再生', buildCmdUrl('play', info.videoId)),
          makeMenuItem('NNDD-REにDL登録', buildCmdUrl('download', info.videoId))
        ]);
      });
      renderButtons(root, [trigger]);
      anchor = findWatchAnchor();
    } else if (info.kind === 'mylist') {
      renderButtons(root, [makeButton('NNDD-REで開く', buildCmdUrl('mylist', info.mylistId))]);
      anchor = findMylistAnchor();
    } else if (info.kind === 'live') {
      root.classList.add('nndd-re-ext-live');
      const trigger = makeTrigger();
      trigger.classList.add('nndd-re-ext-trigger--live');
      trigger.addEventListener('click', (e) => {
        e.preventDefault();
        e.stopPropagation();
        if (openMenuEl) {
          closeMenu();
          return;
        }
        openMenuFor(trigger, [
          makeMenuItem('NNDD-REで視聴', buildCmdUrl('live', info.liveId)),
          makeMenuItem('NNDD-REで録画', buildCmdUrl('liveRecord', info.liveId))
        ]);
      });
      renderButtons(root, [trigger]);
      anchor = findLiveAnchor();
    }

    if (anchor) {
      root.classList.add('nndd-re-ext-inline');
      anchor.el.insertAdjacentElement(anchor.position, root);
      if (info.kind === 'watch') markActionBarAncestors(root);
      // 設置できたらDOM全体の監視は止め、ボタンが載っている親だけを見張る。
      // ニコニコはコメント描画でDOMが絶え間なく変化するため、subtree付きの
      // 監視を張りっぱなしにするとページが目に見えて重くなる。
      watchForRemoval(root);
    } else {
      root.classList.add('nndd-re-ext-floating');
      document.body.appendChild(root);
      waitForAnchor();
    }
  }
}

// ------------------------------------------------------------------
// 再マウント制御
// 常時DOMを監視せずに済むよう、状態ごとに監視対象を切り替える:
//   - 設置済み  … ボタンの親のみを childList 監視 (Reactの再描画で消えた時の復活用)
//   - 未設置    … body を subtree 監視。ただしアンカー出現までの一時的なものとし、
//                 RETRY_WINDOW_MS で打ち切る
//   - URL変化   … MutationObserverではなく軽量なポーリングで検知
// ------------------------------------------------------------------
const RETRY_WINDOW_MS = 30_000;
const DEBOUNCE_MS = 250;
const URL_POLL_MS = 500;

let retryUntil = Date.now() + RETRY_WINDOW_MS;
let timer: number | undefined;

function scheduleMount(): void {
  if (timer !== undefined) return;
  timer = window.setTimeout(() => {
    timer = undefined;
    mount();
  }, DEBOUNCE_MS);
}

// ボタンがDOMから外されたら貼り直す。subtreeを付けないので、コメント描画のような
// 無関係な変化は一切拾わない。
const guardObserver = new MutationObserver(() => {
  if (openMenuEl) return;
  if (!document.getElementById(BUTTON_ROOT_ID)?.isConnected) scheduleMount();
});

function watchForRemoval(root: HTMLElement): void {
  const parent = root.parentElement;
  if (parent) guardObserver.observe(parent, { childList: true });
}

// アンカーがまだ描画されていない間だけ張る一時的な監視。
const anchorObserver = new MutationObserver(() => {
  if (Date.now() >= retryUntil) {
    anchorObserver.disconnect();
    return;
  }
  scheduleMount();
});

function waitForAnchor(): void {
  if (Date.now() >= retryUntil) return;
  anchorObserver.observe(document.body, { childList: true, subtree: true });
}

// ニコニコ動画はSPAのためpushState/replaceStateでURLが変わりリロードが起きない。
// content scriptはisolated worldでページ側のhistory呼び出しをフックできないため、
// 文字列比較だけの軽いポーリングで検知する。
let lastUrl = location.href;
setInterval(() => {
  if (location.href === lastUrl) return;
  lastUrl = location.href;
  retryUntil = Date.now() + RETRY_WINDOW_MS;
  mount();
}, URL_POLL_MS);

mount();
