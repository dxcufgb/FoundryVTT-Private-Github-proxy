'use strict';
// Administration page of the Foundry release proxy. Plain DOM code, no libraries; every value from the server is
// put into the page with textContent, never as HTML. One HTML page with several views, chosen by the address's
// fragment: #/ (modules), #/token, #/notifications, #/password (the settings menu links to them).

(() => {
  const $ = (sel) => document.querySelector(sel);
  let csrf = '';
  let state = null;
  let recipients = [];
  let editing = null; // module id being edited, null when adding
  let update = null; // the last GET update answer
  let watching = null; // timer while waiting for an update to restart the proxy
  const PAGES = {
    modules: 'Modules',
    token: 'GitHub token',
    notifications: 'Notifications',
    password: 'Admin password',
  };

  function toast(message, bad = false) {
    const el = $('#toast');
    el.textContent = message;
    el.className = bad ? 'bad' : '';
    el.hidden = false;
    clearTimeout(toast.timer);
    toast.timer = setTimeout(() => { el.hidden = true; }, bad ? 7000 : 3500);
  }

  async function call(method, path, body) {
    const headers = {};
    if (method !== 'GET') {
      headers['Content-Type'] = 'application/json';
      headers['X-CSRF-Token'] = csrf;
    }
    const res = await fetch(`/_admin/api/${path}`, {
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
      credentials: 'same-origin',
      cache: 'no-store',
    });
    let data = {};
    try {
      data = await res.json();
    } catch {
      // keep the empty object
    }
    if (res.status === 401 && path !== 'login') {
      showLogin();
      throw new Error('Your session has ended; please log in again.');
    }
    if (!res.ok) throw new Error(data.error || `request failed (${res.status})`);
    if (data.csrf) csrf = data.csrf;
    return data;
  }

  function showLogin() {
    closeMenu();
    $('#app-view').hidden = true;
    $('#top-actions').hidden = true;
    $('#brand-logo').hidden = true;
    $('#app-footer').hidden = false;
    $('#footer-version').hidden = true;
    $('#footer-actions').hidden = true;
    $('#login-view').hidden = false;
    document.body.classList.add('logged-out');
    document.title = 'Foundry Release Proxy';
    $('#login-form').password.focus();
  }

  function showApp(data) {
    document.body.classList.remove('logged-out');
    $('#login-view').hidden = true;
    $('#app-view').hidden = false;
    $('#top-actions').hidden = false;
    $('#brand-logo').hidden = false;
    $('#app-footer').hidden = false;
    $('#footer-version').hidden = false;
    $('#footer-actions').hidden = false;
    render(data);
    showPage();
    checkUpdate();
  }

  // The view named by the address's fragment (#/token ...); anything unknown is the modules page.
  function currentPage() {
    const name = location.hash.replace(/^#\/?/, '');
    return Object.hasOwn(PAGES, name) ? name : 'modules';
  }

  function showPage() {
    const page = currentPage();
    for (const section of document.querySelectorAll('.page')) section.hidden = section.dataset.page !== page;
    const here = page === 'modules' ? '#/' : `#/${page}`;
    for (const item of document.querySelectorAll('#settings-menu a')) {
      if (item.getAttribute('href') === here) item.setAttribute('aria-current', 'page');
      else item.removeAttribute('aria-current');
    }
    document.title = page === 'modules' ? 'Foundry Release Proxy' : `${PAGES[page]} – Foundry Release Proxy`;
    closeMenu();
  }

  // Drop-down menus: the cogwheel's settings menu and each module's "⋯" actions menu. A menu is a button and a
  // [role=menu] in a .menu-wrap; one is open at a time and Escape, a click outside or a choice closes it. Module
  // menus are .floating: fixed to the button's position, so the scrolling table cannot cut them off.
  let current = null; // { button, menu } of the open menu

  const menuItems = (menu) => [...menu.querySelectorAll('[role="menuitem"]')];

  function placeFloating(button, menu) {
    const r = button.getBoundingClientRect();
    const height = menu.offsetHeight;
    const below = r.bottom + 6 + height <= window.innerHeight - 8;
    menu.style.top = `${Math.max(8, below ? r.bottom + 6 : r.top - 6 - height)}px`;
    menu.style.left = `${Math.max(8, Math.min(r.right - menu.offsetWidth, window.innerWidth - menu.offsetWidth - 8))}px`;
  }

  function openMenu(button, menu, focusIndex = 0) {
    closeMenu();
    menu.hidden = false;
    if (menu.classList.contains('floating')) placeFloating(button, menu);
    button.setAttribute('aria-expanded', 'true');
    current = { button, menu };
    const items = menuItems(menu);
    if (items[focusIndex]) items[focusIndex].focus({ preventScroll: true });
  }

  function closeMenu(returnFocus = false) {
    if (!current) return;
    const { button, menu } = current;
    current = null;
    menu.hidden = true;
    button.setAttribute('aria-expanded', 'false');
    if (returnFocus) button.focus();
  }

  // Click and arrow keys on the button open its menu; a choice in the menu closes it and puts focus back on the
  // button. That happens before the choice's own action runs (capture phase), so a dialog the action opens hands
  // focus back to the button when it closes, and keyboard users carry on from the same row.
  function wireMenu(button, menu) {
    button.addEventListener('click', () => {
      if (current && current.menu === menu) closeMenu();
      else openMenu(button, menu);
    });
    button.addEventListener('keydown', (e) => {
      if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
        e.preventDefault();
        openMenu(button, menu, e.key === 'ArrowDown' ? 0 : menuItems(menu).length - 1);
      }
    });
    menu.addEventListener('keydown', menuKeys);
    menu.addEventListener('click', (e) => {
      if (e.target.closest('[role="menuitem"]')) closeMenu(true);
    }, true);
  }

  function menuKeys(e) {
    if (!current) return;
    const items = menuItems(current.menu);
    const i = items.indexOf(document.activeElement);
    if (e.key === 'Escape') {
      e.preventDefault();
      closeMenu(true);
    } else if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      const step = e.key === 'ArrowDown' ? 1 : -1;
      items[(i + step + items.length) % items.length].focus();
    } else if (e.key === 'Home' || e.key === 'End') {
      e.preventDefault();
      items[e.key === 'Home' ? 0 : items.length - 1].focus();
    } else if (e.key === 'Tab') {
      closeMenu();
    }
  }

  function el(tag, props = {}, children = []) {
    const node = document.createElement(tag);
    for (const [k, v] of Object.entries(props)) {
      if (k === 'text') node.textContent = v;
      else if (k === 'class') node.className = v;
      else if (k.startsWith('on')) node.addEventListener(k.slice(2), v);
      else node.setAttribute(k, v);
    }
    for (const child of children) node.append(child);
    return node;
  }

  async function copyText(text) {
    if (navigator.clipboard && window.isSecureContext) {
      await navigator.clipboard.writeText(text);
      return;
    }
    // http:// on anything but localhost has no Clipboard API; fall back to a selected text field.
    const area = el('textarea', { readonly: '' });
    Object.assign(area.style, { position: 'fixed', top: '-1000px', opacity: '0' });
    area.value = text;
    document.body.append(area);
    area.select();
    const ok = document.execCommand('copy');
    area.remove();
    if (!ok) throw new Error('copy failed');
  }

  function render(data) {
    state = data;
    renderModules();
    renderToken();
    renderVersion();
    renderNotify();
  }

  // The footer: installed version, the latest release, and why "Update proxy now" is unavailable (if it is).
  function renderVersion(note) {
    let text = `Foundry Release Proxy ${state.version || '(version unknown)'}`;
    const notes = [];
    let bad = false;
    if (update) {
      if (update.latest) {
        text += update.newer === true ? ` · version ${update.latest} is available`
          : update.newer === false ? ' · up to date' : ` · latest release ${update.latest}`;
      } else if (update.latestProblem) {
        notes.push(`Latest release unknown: ${update.latestProblem}.`);
      }
      if (update.problem) {
        notes.push(`Updating from this page is not available: ${update.problem}`);
        bad = true;
      }
    }
    if (note) notes.push(note);
    $('#version-status').textContent = text;
    $('#version-status').className = update && update.newer ? 'newer' : '';
    const noteEl = $('#version-note');
    noteEl.textContent = notes.join(' ');
    noteEl.hidden = notes.length === 0;
    noteEl.className = bad ? 'small error' : 'small';
    $('#update-check').disabled = Boolean(watching);
  }

  // "Check for update": asks GitHub for the latest release. Pressed by hand (e) and a newer one exists, it asks
  // whether to install it now; the check after login only updates the footer.
  async function checkUpdate(e) {
    const button = $('#update-check');
    button.disabled = true;
    try {
      update = await call('GET', 'update');
      renderVersion();
      if (!e) return;
      if (update.newer && update.canUpdate) {
        $('#update-dialog-text').textContent =
          `Version ${update.latest} is available; this proxy runs ${state.version || 'an unknown version'}. Update the proxy now?`;
        $('#update-dialog').showModal();
      } else if (update.newer) {
        toast(`Version ${update.latest} is available, but updating from this page is not set up: ${update.problem}`, true);
      } else if (update.newer === false) {
        toast(`The proxy is up to date (${state.version}).`);
      } else {
        toast(update.latestProblem ? `Latest release unknown: ${update.latestProblem}` : 'Checked for updates.', Boolean(update.latestProblem));
      }
    } catch (err) {
      if (e) toast(err.message, true);
    } finally {
      button.disabled = Boolean(watching);
    }
  }

  // After "Update proxy now": the proxy restarts when a newer release was installed (and then needs a new login).
  function watchUpdate(before) {
    const started = Date.now();
    clearInterval(watching);
    watching = setInterval(async () => {
      if (Date.now() - started > 5 * 60 * 1000) {
        clearInterval(watching);
        watching = null;
        renderVersion('No restart within 5 minutes: there was no newer release, or the update failed (see the ' +
          'notification e-mail or the update log).');
        return;
      }
      try {
        const data = await call('GET', 'state');
        if (data.version !== before) {
          clearInterval(watching);
          watching = null;
          render(data);
          toast(`Updated to ${data.version}.`);
        }
      } catch (err) {
        if (!$('#login-view').hidden) {
          // the session ended: the proxy restarted, most likely with the new version
          clearInterval(watching);
          watching = null;
          $('#login-error').textContent = 'The proxy restarted (after the update); please log in again.';
          $('#login-error').hidden = false;
        }
        // otherwise the proxy is restarting: keep waiting
      }
    }, 5000);
  }

  // The update dialog's "Update now": asks the installer's updater to run, then waits for the restart.
  async function updateNow() {
    $('#update-check').disabled = true;
    try {
      await call('POST', 'update', {});
      watchUpdate(state.version);
      renderVersion('Update requested; waiting for the proxy to restart…');
      toast('Update started.');
    } catch (err) {
      toast(err.message, true);
      renderVersion();
    }
  }

  // With a token in use: a checkmark, its kind and "Add new token" (a dialog); without one: the field on the page.
  function renderToken() {
    const t = state.token;
    const hasToken = Boolean(t.kind);
    const status = $('#token-status');
    status.replaceChildren();
    if (hasToken) {
      status.append(el('span', { class: 'check-ok', 'aria-hidden': 'true', text: '✓' }),
        el('strong', { text: 'A token is set' }), ` (${t.kind}).`);
    } else {
      status.textContent = 'No token is set.';
    }
    const note = $('#token-note');
    note.className = t.canChange ? 'hint' : 'hint error';
    note.textContent = t.canChange
      ? `A new token is saved to ${t.file}.`
      : `It cannot be changed here: ${t.file ? `${t.file}: ` : ''}${t.problem}`;
    $('#token-form').hidden = hasToken;
    $('#token-save').hidden = hasToken;
    $('#token-add').hidden = !hasToken;
    $('#token-save').disabled = !t.canChange;
    $('#token-add').disabled = !t.canChange;
    const daily = $('#daily-check');
    const c = t.lastCheck;
    daily.className = c && c.problems.length ? 'hint error' : 'hint';
    daily.textContent = !c
      ? 'Daily check: not run yet (the first runs an hour after the proxy starts).'
      : `Daily check ${new Date(c.at).toLocaleString()}: ` +
        (c.problems.length ? `${c.problems.length} problem(s), e-mailed to the recipients below: ${c.problems.join('; ')}` : 'all OK.');
  }

  const MARK = { ok: '✓', warn: '!', bad: '✗' };

  function showResults(r) {
    const list = $('#setup-results');
    list.replaceChildren();
    const line = (status, title, message) => el('li', { class: status }, [
      el('span', { class: 'mark', 'aria-hidden': 'true', text: MARK[status] || '?' }),
      el('strong', { text: title }),
      el('span', { text: ` ${message}` }),
    ]);
    list.append(line(r.token.status, r.tested === 'typed' ? 'Typed token:' : 'Token in use:', r.token.message));
    if (r.token.status === 'bad') {
      list.append(line('bad', 'Repositories:', 'not checked, GitHub did not accept the token.'));
    }
    for (const c of r.checks) {
      list.append(line(c.status, `${c.name} (${c.repo}):`, c.message));
    }
    list.hidden = false;
  }

  async function testSetup(e) {
    const button = e.currentTarget;
    button.disabled = true;
    const list = $('#setup-results');
    list.replaceChildren(el('li', { text: 'Testing…' }));
    list.hidden = false;
    try {
      // without a saved token, a token typed in the page's field is tested (not saved)
      const typed = $('#token-form').hidden ? '' : $('#token-form').token.value.trim();
      const r = await call('POST', 'setup-test', { token: typed });
      showResults(r);
      const bad = r.token.status === 'bad' || r.checks.some((c) => c.status === 'bad');
      toast(bad ? 'Test setup found problems (see the list).' : 'Test setup finished.', bad);
    } catch (err) {
      list.hidden = true;
      toast(err.message, true);
    } finally {
      button.disabled = false;
    }
  }

  // Saves a token (GitHub must accept it first); true when it is in use. onError gets the reason otherwise.
  async function saveToken(token, onError) {
    try {
      render(await call('PUT', 'token', { token }));
      toast('Token saved and in use. Delete the old one on GitHub when you no longer need it.');
      return true;
    } catch (err) {
      onError(err.message);
      return false;
    }
  }

  async function saveTypedToken(e) {
    e.preventDefault();
    const form = e.currentTarget;
    $('#token-save').disabled = true;
    if (await saveToken(form.token.value.trim(), (msg) => toast(msg, true))) form.reset();
    $('#token-save').disabled = !state.token.canChange;
  }

  function openTokenDialog() {
    $('#token-dialog-form').reset();
    $('#token-dialog-error').hidden = true;
    $('#token-dialog').showModal();
    $('#token-dialog-form').token.focus();
  }

  async function addToken(e) {
    e.preventDefault();
    const form = e.currentTarget;
    const button = $('#token-dialog-add');
    const error = $('#token-dialog-error');
    error.hidden = true;
    button.disabled = true;
    const ok = await saveToken(form.token.value.trim(), (msg) => {
      error.textContent = msg;
      error.hidden = false;
    });
    button.disabled = false;
    if (ok) $('#token-dialog').close();
  }

  function renderModules() {
    closeMenu();
    const body = $('#modules tbody');
    body.replaceChildren();
    state.modules.forEach((m, index) => {
      const status = el('span', { class: 'status' });
      const assets = [m.manifestAsset, m.zipAsset].join(', ');
      const menuId = `module-menu-${index}`;
      const item = (text, onclick, cls = '') => el('button', { type: 'button', role: 'menuitem', class: cls, text, onclick });
      const menu = el('div', { id: menuId, class: 'menu floating', role: 'menu', 'aria-label': `Actions for ${m.id}`, hidden: '' }, [
        item('Copy link', () => copyLink(m)),
        item('Check release', () => checkRelease(m, status)),
        item('Edit', () => openModule(m)),
        item('Delete', () => deleteModule(m), 'danger'),
      ]);
      const button = el('button', {
        type: 'button', class: 'icon-button secondary small', 'aria-haspopup': 'menu', 'aria-expanded': 'false',
        'aria-controls': menuId, 'aria-label': `Actions for ${m.id}`, title: 'Actions', text: '⋯',
      });
      wireMenu(button, menu);
      body.append(el('tr', {}, [
        el('td', {}, [el('strong', { text: m.id })]),
        el('td', {}, [el('code', { text: m.repo }), status]),
        el('td', {}, [el('code', { text: assets })]),
        el('td', {}, [el('code', { text: m.link })]),
        el('td', { class: 'actions-col' }, [el('div', { class: 'menu-wrap' }, [button, menu])]),
      ]));
    });
    $('#modules').hidden = state.modules.length === 0;
    $('#no-modules').hidden = state.modules.length !== 0;
  }

  async function copyLink(m) {
    try {
      await copyText(m.link);
      toast(`Copied the link for ${m.id}. Paste it as the Manifest URL in Foundry.`);
    } catch {
      toast(`Could not copy automatically; the link is ${m.link}`, true);
    }
  }

  async function checkRelease(m, status) {
    status.className = 'status';
    status.textContent = 'Checking…';
    try {
      const r = await call('GET', `modules/${encodeURIComponent(m.id)}/release`);
      if (r.error) {
        status.className = 'status bad';
        status.textContent = r.error;
      } else if (r.missing && r.missing.length) {
        status.className = 'status bad';
        status.textContent = `Latest ${r.tag} lacks ${r.missing.join(', ')}`;
      } else {
        status.className = 'status good';
        const when = r.published ? ` (${new Date(r.published).toLocaleDateString()})` : '';
        status.textContent = `Latest release: ${r.tag}${when}`;
      }
    } catch (err) {
      status.className = 'status bad';
      status.textContent = err.message;
    }
  }

  function openModule(m) {
    editing = m ? m.id : null;
    const form = $('#module-form');
    form.reset();
    $('#module-dialog-title').textContent = m ? `Edit ${m.id}` : 'Add module';
    $('#module-error').hidden = true;
    if (m) {
      form.moduleId.value = m.id;
      form.repo.value = m.repo;
      form.manifestAsset.value = m.manifestAsset === 'module.json' ? '' : m.manifestAsset;
      form.zipAsset.value = m.zipAsset === 'module.zip' ? '' : m.zipAsset;
      form.querySelector('details').open = m.manifestAsset !== 'module.json' || m.zipAsset !== 'module.zip';
    }
    $('#module-dialog').showModal();
  }

  async function saveModule(e) {
    e.preventDefault();
    const form = e.currentTarget;
    const body = {
      id: form.moduleId.value.trim(),
      repo: form.repo.value.trim(),
      manifestAsset: form.manifestAsset.value.trim(),
      zipAsset: form.zipAsset.value.trim(),
    };
    try {
      const data = editing === null
        ? await call('POST', 'modules', body)
        : await call('PUT', `modules/${encodeURIComponent(editing)}`, body);
      $('#module-dialog').close();
      render(data);
      toast(editing === null ? `Added ${body.id}.` : `Saved ${body.id}.`);
    } catch (err) {
      $('#module-error').textContent = err.message;
      $('#module-error').hidden = false;
    }
  }

  async function deleteModule(m) {
    if (!confirm(`Delete module "${m.id}" (${m.repo})?\nFoundry can no longer install or update it through this proxy.`)) return;
    try {
      render(await call('DELETE', `modules/${encodeURIComponent(m.id)}`));
      toast(`Deleted ${m.id}.`);
    } catch (err) {
      toast(err.message, true);
    }
  }

  function renderRecipients() {
    const list = $('#recipients');
    list.replaceChildren();
    if (!recipients.length) list.append(el('li', { class: 'empty', text: 'No recipients: no e-mails are sent.' }));
    recipients.forEach((address, i) => {
      list.append(el('li', {}, [
        el('span', { text: address }),
        el('button', { type: 'button', title: `Remove ${address}`, 'aria-label': `Remove ${address}`, text: '×',
          onclick: () => { recipients.splice(i, 1); renderRecipients(); } }),
      ]));
    });
  }

  function renderNotify() {
    const { smtp } = state.notify;
    recipients = [...state.notify.recipients];
    renderRecipients();
    const form = $('#notify-form');
    for (const key of ['host', 'port', 'security', 'from', 'user']) form[key].value = smtp[key] ?? '';
    form.password.value = '';
    form.password.placeholder = smtp.passwordSet ? '(stored; type to replace)' : '(none)';
    form.clearPassword.checked = false;
    $('#clear-password-row').hidden = !smtp.passwordSet;
  }

  function addRecipient() {
    const input = $('#recipient-input');
    const address = input.value.trim();
    if (!address) return;
    if (!input.checkValidity() || !address.includes('.')) {
      toast(`"${address}" is not an e-mail address.`, true);
      return;
    }
    if (!recipients.some((r) => r.toLowerCase() === address.toLowerCase())) recipients.push(address);
    input.value = '';
    renderRecipients();
  }

  async function saveNotify(e) {
    e.preventDefault();
    if ($('#recipient-input').value.trim()) addRecipient();
    const form = e.currentTarget;
    const body = {
      recipients,
      smtp: {
        host: form.host.value.trim(),
        port: Number(form.port.value),
        security: form.security.value,
        from: form.from.value.trim(),
        user: form.user.value.trim(),
        password: form.password.value,
        clearPassword: form.clearPassword.checked,
      },
    };
    try {
      render(await call('PUT', 'notify', body));
      toast('Notification settings saved.');
    } catch (err) {
      toast(err.message, true);
    }
  }

  async function testNotify(e) {
    const button = e.currentTarget;
    button.disabled = true;
    try {
      await call('POST', 'notify/test', {});
      toast('Test e-mail sent (to the saved addresses).');
    } catch (err) {
      toast(err.message, true);
    } finally {
      button.disabled = false;
    }
  }

  // Offers the password to the browser's password manager once the proxy accepted it. The form (with its hidden user
  // name) lets Chrome and others notice the login by themselves; this asks explicitly where the browser can (Chrome,
  // Edge: secure contexts, which includes localhost). Saving is up to the user; a refusal changes nothing.
  function rememberPassword(password) {
    if (typeof window.PasswordCredential !== 'function' || !navigator.credentials) return;
    try {
      const credential = new window.PasswordCredential({ id: 'admin', password, name: 'Foundry Release Proxy' });
      navigator.credentials.store(credential).catch(() => {});
    } catch {
      // not offered: nothing to do
    }
  }

  async function changePassword(e) {
    e.preventDefault();
    const form = e.currentTarget;
    if (form.password.value !== form.repeat.value) {
      toast('The new passwords do not match.', true);
      return;
    }
    try {
      const password = form.password.value;
      render(await call('PUT', 'password', { current: form.current.value, password }));
      form.reset();
      rememberPassword(password);
      toast('Password changed. Other sessions were logged out.');
    } catch (err) {
      toast(err.message, true);
    }
  }

  async function login(e) {
    e.preventDefault();
    const form = e.currentTarget;
    const error = $('#login-error');
    error.hidden = true;
    try {
      const password = form.password.value;
      const data = await call('POST', 'login', { password });
      // the form disappears first (how password managers tell a login went through), then the field is emptied
      showApp(data);
      form.reset();
      rememberPassword(password);
    } catch (err) {
      error.textContent = err.message;
      error.hidden = false;
    }
  }

  async function logout() {
    try {
      await call('POST', 'logout', {});
    } catch {
      // logged out either way
    }
    csrf = '';
    showLogin();
  }

  document.addEventListener('DOMContentLoaded', async () => {
    $('#login-form').addEventListener('submit', login);
    $('#logout').addEventListener('click', logout);
    wireMenu($('#settings-button'), $('#settings-menu'));
    document.addEventListener('click', (e) => {
      if (!e.target.closest('.menu-wrap')) closeMenu();
    });
    // A module's menu is fixed to its button's place on screen: scrolling or resizing closes it.
    const closeFloating = () => {
      if (current && current.menu.classList.contains('floating')) closeMenu();
    };
    window.addEventListener('resize', closeFloating);
    document.addEventListener('scroll', closeFloating, true);
    window.addEventListener('hashchange', () => {
      if (!$('#app-view').hidden) {
        showPage();
        window.scrollTo(0, 0);
      }
    });
    $('#add-module').addEventListener('click', () => openModule(null));
    $('#module-form').addEventListener('submit', saveModule);
    $('#module-cancel').addEventListener('click', () => $('#module-dialog').close());
    $('#token-form').addEventListener('submit', saveTypedToken);
    $('#token-add').addEventListener('click', openTokenDialog);
    $('#token-dialog-form').addEventListener('submit', addToken);
    $('#token-dialog-cancel').addEventListener('click', () => $('#token-dialog').close());
    // the typed token never stays in the page once the dialog is closed
    $('#token-dialog').addEventListener('close', () => $('#token-dialog-form').reset());
    $('#update-check').addEventListener('click', checkUpdate);
    $('#update-dialog').addEventListener('close', () => {
      if ($('#update-dialog').returnValue === 'update') updateNow();
      $('#update-dialog').returnValue = '';
    });
    $('#setup-test').addEventListener('click', testSetup);
    $('#notify-form').addEventListener('submit', saveNotify);
    $('#notify-test').addEventListener('click', testNotify);
    $('#recipient-add').addEventListener('click', addRecipient);
    $('#recipient-input').addEventListener('keydown', (e) => {
      if (e.key === 'Enter') {
        e.preventDefault();
        addRecipient();
      }
    });
    $('#password-form').addEventListener('submit', changePassword);
    try {
      showApp(await call('GET', 'state'));
    } catch {
      showLogin();
    }
  });
})();
