'use strict';
const $ = id => document.getElementById(id);
const button = $('run');
function status(label, state = '') {
  $('status').textContent = label;
  $('status').dataset.state = state;
  $('announcement').textContent = label;
}
async function initialize() {
  try {
    const response = await fetch('/api/health');
    if (!response.ok) throw new Error('Application unavailable');
    const data = await response.json();
    $('sql').textContent = data.query;
    await refreshLogin();
  } catch {
    $('sql').textContent = 'Cannot reach the NestJS application. Reload to retry.';
    status('Application unavailable', 'error');
  }
}
button.addEventListener('click', async () => {
  button.disabled = true;
  button.textContent = 'Connecting…';
  $('results').hidden = true;
  $('empty').hidden = true;
  $('error').hidden = true;
  status('Running query…');
  try {
    const response = await fetch('/api/query');
    if (response.status === 401) {
      await refreshLogin();
      throw new Error('Sign in with Azure to run the query.');
    }
    const data = await response.json();
    if (!response.ok) throw new Error(`${data.code || 'Request failed'}: ${data.message || 'Please retry.'}`);
    $('duration').textContent = `${data.durationMs} ms`;
    $('count').textContent = String(data.rows.length);
    const header = document.createElement('tr');
    for (const column of data.columns) {
      const th = document.createElement('th');
      th.scope = 'col';
      th.textContent = column;
      header.append(th);
    }
    $('columns').replaceChildren(header);
    $('rows').replaceChildren(...data.rows.map(row => {
      const tr = document.createElement('tr');
      for (const column of data.columns) {
        const td = document.createElement('td');
        td.textContent = String(row[column] ?? '—');
        tr.append(td);
      }
      return tr;
    }));
    $('results').hidden = false;
    status('Connected', 'success');
  } catch (error) {
    $('error').textContent = error.message;
    $('error').hidden = false;
    status('Connection failed', 'error');
  } finally {
    button.disabled = !signedIn;
    button.textContent = 'Run query';
  }
});
let signedIn = false;
let pollTimer;
async function refreshLogin() {
  const response = await fetch('/deepsec/auth/status');
  if (!response.ok) throw new Error('Sign-in service unavailable');
  const data = await response.json();
  signedIn = data.state === 'authenticated';
  $('login').disabled = data.state === 'pending';
  $('login').hidden = signedIn;
  $('logout').hidden = !signedIn;
  button.disabled = !signedIn;
  $('account').textContent = signedIn ? (data.username || 'Signed in') : 'Not signed in';
  if (signedIn) {
    clearTimeout(pollTimer);
    $('device').hidden = true;
    status('Ready');
  } else if (data.state === 'pending') {
    if (data.deviceCode) {
      $('verification').href = data.deviceCode.verificationUri;
      $('user-code').textContent = data.deviceCode.userCode;
      $('device').hidden = false;
    }
    $('logout').hidden = false;
    status('Waiting for sign-in…');
    pollTimer = setTimeout(pollLogin, 2000);
  } else {
    $('device').hidden = true;
    if (data.state === 'failed') throw new Error('Azure sign-in failed. Try again.');
    status('Sign in required');
  }
}
async function pollLogin() {
  try { await refreshLogin(); }
  catch (error) {
    $('error').textContent = error.message;
    $('error').hidden = false;
    $('login').disabled = false;
    status('Sign-in failed', 'error');
  }
}
$('login').addEventListener('click', async () => {
  clearTimeout(pollTimer);
  $('login').disabled = true;
  $('error').hidden = true;
  status('Starting sign-in…');
  try {
    const response = await fetch('/deepsec/auth/start', { method: 'POST' });
    const data = await response.json();
    if (!response.ok) throw new Error(data.message || 'Could not start sign-in');
    $('verification').href = data.verificationUri;
    $('user-code').textContent = data.userCode;
    $('device').hidden = false;
    status('Waiting for sign-in…');
    pollTimer = setTimeout(pollLogin, 2000);
  } catch (error) {
    $('error').textContent = error.message;
    $('error').hidden = false;
    $('login').disabled = false;
    status('Sign-in failed', 'error');
  }
});
$('logout').addEventListener('click', async () => {
  clearTimeout(pollTimer);
  try {
    const response = await fetch('/deepsec/auth/logout', { method: 'POST' });
    if (!response.ok) throw new Error('Sign-out failed');
    $('results').hidden = true;
    $('error').hidden = true;
    $('empty').hidden = false;
    await refreshLogin();
  } catch (error) {
    $('error').textContent = error.message;
    $('error').hidden = false;
  }
});
initialize();
