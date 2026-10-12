'use strict';
// Administration page of the Foundry release proxy. Plain DOM code, no libraries; every value from the server is
// put into the page with textContent, never as HTML.

(() => {
  const $ = (sel) => document.querySelector(sel);
  let csrf = '';
  let state = null;
  let recipients = [];
  let editing = null; // module id being edited, null when adding

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
    renderNotify();
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
