'use strict';
// Administration page of the Foundry release proxy. Plain DOM code, no libraries; every value from the server is
// put into the page with textContent, never as HTML.

(() => {
  const $ = (sel) => document.querySelector(sel);
  let csrf = '';
  let state = null;
  let recipients = [];
  let editing = null; // module id being edited, null when adding
  let update = null; // the last GET update answer
  let watching = null; // timer while waiting for an update to restart the proxy

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
    $('#app-view').hidden = true;
    $('#logout').hidden = true;
    $('#login-view').hidden = false;
    $('#login-form').password.focus();
  }

  function showApp(data) {
    $('#login-view').hidden = true;
    $('#app-view').hidden = false;
    $('#logout').hidden = false;
    render(data);
    checkUpdate();
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

  function renderVersion(note) {
    const status = $('#version-status');
    let text = `Installed: ${state.version || 'unknown'}.`;
    let bad = false;
    if (update) {
      if (update.latest) {
        text += ` Latest release: ${update.latest}` +
          (update.newer === true ? ' (newer).' : update.newer === false ? ' (this is up to date).' : '.');
      } else if (update.latestProblem) {
        text += ` Latest release unknown: ${update.latestProblem}.`;
      }
      if (update.problem) {
        text += ` "Update proxy now" is not available: ${update.problem}`;
        bad = true;
      }
    }
    if (note) text += ` ${note}`;
    status.textContent = text;
    status.className = bad ? 'error' : '';
    $('#update-now').disabled = Boolean(watching) || !update || !update.canUpdate;
  }

  async function checkUpdate(e) {
    const button = $('#update-check');
    button.disabled = true;
    try {
      update = await call('GET', 'update');
      renderVersion();
      if (e) toast(update.newer ? `Version ${update.latest} is available.` : 'Checked for updates.');
    } catch (err) {
      if (e) toast(err.message, true);
    } finally {
      button.disabled = false;
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

  async function updateNow(e) {
    const what = update && update.newer ? `version ${update.latest}` : 'the latest release (if it is newer)';
    if (!confirm(`Install ${what} now?\nThe proxy restarts; Foundry cannot reach it for a few seconds and you log in again.`)) return;
    const button = e.currentTarget;
    button.disabled = true;
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

  function renderToken() {
    const t = state.token;
    const status = $('#token-status');
    status.className = t.canChange ? '' : 'error';
    status.textContent = t.canChange
      ? `In use: a ${t.kind}. A new one is saved to ${t.file}.`
      : `In use: a ${t.kind || 'GitHub token'}. It cannot be changed here: ${t.file ? `${t.file}: ` : ''}${t.problem}`;
    $('#token-save').disabled = !t.canChange;
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
      const r = await call('POST', 'setup-test', { token: $('#token-form').token.value.trim() });
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

  async function saveToken(e) {
    e.preventDefault();
    const form = e.currentTarget;
    const button = $('#token-save');
    button.disabled = true;
    try {
      render(await call('PUT', 'token', { token: form.token.value.trim() }));
      form.reset();
      toast('Token saved and in use. Delete the old one on GitHub when you no longer need it.');
    } catch (err) {
      toast(err.message, true);
    } finally {
      button.disabled = !state.token.canChange;
    }
  }

  function renderModules() {
    const body = $('#modules tbody');
    body.replaceChildren();
    for (const m of state.modules) {
      const status = el('span', { class: 'status' });
      const assets = [m.manifestAsset, m.zipAsset].join(', ');
      const row = el('tr', {}, [
        el('td', {}, [el('strong', { text: m.id })]),
        el('td', {}, [el('code', { text: m.repo }), status]),
        el('td', {}, [el('code', { text: assets })]),
        el('td', {}, [el('code', { text: m.link })]),
        el('td', {}, [el('div', { class: 'actions' }, [
          el('button', { type: 'button', class: 'small', text: 'Copy link', onclick: () => copyLink(m) }),
          el('button', { type: 'button', class: 'small secondary', text: 'Check release',
            onclick: (e) => checkRelease(m, status, e.currentTarget) }),
          el('button', { type: 'button', class: 'small secondary', text: 'Edit', onclick: () => openModule(m) }),
          el('button', { type: 'button', class: 'small danger', text: 'Delete', onclick: () => deleteModule(m) }),
        ])]),
      ]);
      body.append(row);
    }
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

  async function checkRelease(m, status, button) {
    button.disabled = true;
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
    } finally {
      button.disabled = false;
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

  async function changePassword(e) {
    e.preventDefault();
    const form = e.currentTarget;
    if (form.password.value !== form.repeat.value) {
      toast('The new passwords do not match.', true);
      return;
    }
    try {
      render(await call('PUT', 'password', { current: form.current.value, password: form.password.value }));
      form.reset();
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
      const data = await call('POST', 'login', { password: form.password.value });
      form.reset();
      showApp(data);
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
    $('#add-module').addEventListener('click', () => openModule(null));
    $('#module-form').addEventListener('submit', saveModule);
    $('#module-cancel').addEventListener('click', () => $('#module-dialog').close());
    $('#token-form').addEventListener('submit', saveToken);
    $('#update-check').addEventListener('click', checkUpdate);
    $('#update-now').addEventListener('click', updateNow);
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
