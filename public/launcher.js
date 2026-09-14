// Floating launcher on the wait-surface — surfaces the Vault + account/sign-in
// without editing the minified SPA. Injected server-side into GET /.
(() => {
  const css = [
    '#waitsi_launcher{position:fixed;right:14px;bottom:14px;z-index:9999;display:flex;gap:8px;align-items:center;font-family:system-ui,sans-serif}',
    '#waitsi_launcher a{background:#111612;color:#e9f3e3;border:1px solid #212b23;padding:8px 12px;border-radius:999px;font-size:13px;font-weight:600;text-decoration:none;box-shadow:0 4px 14px rgba(0,0,0,.5)}',
    '#waitsi_launcher a.cta{background:#b8ff4f;color:#08130a;border-color:#b8ff4f}',
  ].join('\n');
  const style = document.createElement('style'); style.textContent = css; document.head.appendChild(style);
  const pill = document.createElement('div');
  pill.id = 'waitsi_launcher';
  pill.innerHTML = '<a href="/vaults">Vault</a><a class="cta" id="wl_acct" href="/account">Log in</a>';
  document.body.appendChild(pill);

  fetch('/account/me', { credentials: 'same-origin' })
    .then((r) => (r.ok ? r.json() : null))
    .then((me) => {
      if (me && me.user) {
        const a = document.getElementById('wl_acct');
        a.textContent = '@' + me.user.handle.slice(0, 12);
        a.setAttribute('title', 'Your account — save results/history');
      }
    })
    .catch(() => { /* keep default */ });
})();