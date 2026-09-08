/* teleport.js — continuing a claude.ai conversation here.

   Clicking a row in History → Web pulls that conversation down and carries on
   with it in a local tab. The agent runs on this machine, in this workspace.

   The flow has two places the user can still say no, so it is a sequence of
   steps rather than one action:

     row click → repo check ─┬─ proceed ──────────────┐
                             └─ "Different repository" ┤→ Teleporting… → fetch
                                                       │                   │
                                        cancel ────────┘        branch? ───┤
                                                                 │         │
                                                       branch prompt → checkout
                                                                           │
                                                            load as a local session

   Only the last checkout step can change the working tree, and it runs solely
   once the branch prompt has been answered. A session that names no repository
   — which is every Remote Control session — skips both prompts entirely. */

/* The teleport currently in flight, or null. Holds the answers gathered so far
   so a later step knows what the user already agreed to; cleared on every exit
   path, including the ones where the user backs out. */
let teleportState = null;

/* ===================== entry ===================== */

/* Called from a Web-tab row. Starts with the repo question, because the answer
   decides whether anything else should happen at all. */
function startTeleport(session) {
  if (!session || !session.id) return;
  if (teleportState) return;            // one at a time; a second click is a slip
  teleportState = { session: session, id: session.id };
  showTeleportProgress(session, 'Checking repository…');
  if (window._teleportRepoCheck) {
    _teleportRepoCheck(session.id);
  } else {
    // No bridge (an old host, or the page opened outside Eclipse). Say so
    // rather than leaving the progress overlay up forever.
    endTeleport();
    teleportFailed('Teleport is not available in this build.');
  }
}

window.onTeleportRepoCheck = function (json, token) {
  if (!teleportState || teleportState.id !== token) return;   // superseded
  let d = null;
  try { d = JSON.parse(json || '{}'); } catch (e) { d = null; }
  if (!d || d.status === 'error') { endTeleport(); teleportFailed('Couldn’t check this workspace.'); return; }
  if (d.proceed) { runTeleport(); return; }
  showRepoDialog(d);
};

/* ===================== "Different repository" ===================== */

/* Three options, keyed 1/2/3, arrows wrapping, Enter on the selection, Esc and
   a click outside both meaning cancel — the same affordances the VS Code panel
   offers, so the muscle memory carries over. "Open folder…" leads rather than
   "Continue here": opening the right folder is the answer that keeps the
   session's own history meaningful, and continuing here is the deliberate
   exception. */
function showRepoDialog(d) {
  const overlay = document.getElementById('teleport-overlay');
  const win = document.getElementById('teleport-win');
  overlay.classList.add('open');
  win.innerHTML = '';

  const title = document.createElement('h3');
  title.className = 'tp-title';
  title.textContent = 'Different repository';

  const desc = document.createElement('p');
  desc.className = 'tp-desc';
  desc.appendChild(document.createTextNode('This session was created in '));
  const pill = document.createElement('code');
  pill.className = 'tp-repo';
  pill.textContent = d.sessionDisplay || ((d.sessionOwner || '') + '/' + (d.sessionName || ''));
  desc.appendChild(pill);
  desc.appendChild(document.createTextNode('. Open that folder first, or continue in the current workspace.'));

  const opts = document.createElement('div');
  opts.className = 'tp-options';

  const choices = [
    { key: '1', label: 'Open folder…', primary: true, run: teleportOpenFolder },
    { key: '2', label: 'Continue here', run: runTeleport },
    { key: '3', label: 'Cancel', run: cancelTeleport },
  ];
  let selected = 0;

  const rows = choices.map((c, i) => {
    const row = document.createElement('div');
    row.className = 'tp-option' + (c.primary ? ' primary' : '');
    const k = document.createElement('span'); k.className = 'tp-key'; k.textContent = c.key;
    const l = document.createElement('span'); l.className = 'tp-label'; l.textContent = c.label;
    row.appendChild(k); row.appendChild(l);
    row.onclick = (e) => { e.stopPropagation(); closeTeleportDialog(); c.run(); };
    opts.appendChild(row);
    return row;
  });
  const paint = () => rows.forEach((r, i) => r.classList.toggle('sel', i === selected));
  paint();

  win.appendChild(title); win.appendChild(desc); win.appendChild(opts);
  // Clicking the panel itself must not read as clicking away from it.
  win.onclick = (e) => e.stopPropagation();
  overlay.onclick = () => { closeTeleportDialog(); cancelTeleport(); };

  teleportState.keyHandler = (e) => {
    const pick = (i) => { e.preventDefault(); closeTeleportDialog(); choices[i].run(); };
    if (e.key === 'Escape' || e.key === '3') return pick(2);
    if (e.key === '1') return pick(0);
    if (e.key === '2') return pick(1);
    if (e.key === 'ArrowDown') { e.preventDefault(); selected = (selected + 1) % 3; paint(); return; }
    if (e.key === 'ArrowUp')   { e.preventDefault(); selected = (selected + 2) % 3; paint(); return; }
    if (e.key === 'Enter')     return pick(selected);
  };
  window.addEventListener('keydown', teleportState.keyHandler);
}

function closeTeleportDialog() {
  const overlay = document.getElementById('teleport-overlay');
  if (overlay) { overlay.classList.remove('open'); overlay.onclick = null; }
  if (teleportState && teleportState.keyHandler) {
    window.removeEventListener('keydown', teleportState.keyHandler);
    teleportState.keyHandler = null;
  }
}

/* Opening a different folder abandons this teleport: the session belongs to the
   repo being opened, so it should be started again from there — where the repo
   question no longer arises. */
function teleportOpenFolder() {
  endTeleport();
  if (window._pickDirectory) _pickDirectory();
}

function cancelTeleport() { endTeleport(); }

/* ===================== fetch ===================== */

function runTeleport() {
  if (!teleportState) return;
  closeTeleportDialog();
  showTeleportProgress(teleportState.session, null);
  if (window._teleportRun) _teleportRun(teleportState.id);
  else { endTeleport(); teleportFailed('Teleport is not available in this build.'); }
}

window.onTeleportDone = function (json, token) {
  if (!teleportState || teleportState.id !== token) return;
  let r = null;
  try { r = JSON.parse(json || '{}'); } catch (e) { r = null; }
  if (!r || !r.ok) {
    const msg = (r && r.message) || 'Couldn’t load this conversation.';
    endTeleport();
    teleportFailed(msg);
    return;
  }
  teleportState.local = r;
  // A branch only reaches here when it genuinely exists, so the prompt can
  // never offer a checkout that could not work.
  if (r.branch) showBranchDialog(r.branch);
  else finishTeleport();
};

/* ===================== branch ===================== */

/* Switching branches is the one step that changes files on disk, so it asks —
   and shows what is uncommitted, since that is what the user stands to have
   moved out from under them. */
function showBranchDialog(branch) {
  let status = { clean: true, changedFiles: [], currentBranch: '' };
  try { status = JSON.parse(window._teleportGitStatus ? _teleportGitStatus() : '{}') || status; } catch (e) {}

  const overlay = document.getElementById('teleport-overlay');
  const win = document.getElementById('teleport-win');
  overlay.classList.add('open');
  win.innerHTML = '';

  const title = document.createElement('h3');
  title.className = 'tp-title';
  title.textContent = 'Switch branch';

  const desc = document.createElement('p');
  desc.className = 'tp-desc';
  desc.appendChild(document.createTextNode('This session was working on '));
  const pill = document.createElement('code'); pill.className = 'tp-repo'; pill.textContent = branch;
  desc.appendChild(pill);
  desc.appendChild(document.createTextNode(
    status.currentBranch ? '. You are on ' : '. Switch to it, or stay where you are.'));
  if (status.currentBranch) {
    const cur = document.createElement('code'); cur.className = 'tp-repo'; cur.textContent = status.currentBranch;
    desc.appendChild(cur);
    desc.appendChild(document.createTextNode('.'));
  }

  win.appendChild(title); win.appendChild(desc);

  if (!status.clean && status.changedFiles && status.changedFiles.length) {
    const warn = document.createElement('div');
    warn.className = 'tp-warn';
    const n = status.changedFiles.length;
    warn.textContent = n + (n === 1 ? ' file has' : ' files have') + ' uncommitted changes.';
    win.appendChild(warn);
    const list = document.createElement('div');
    list.className = 'tp-files';
    status.changedFiles.slice(0, 8).forEach(f => {
      const row = document.createElement('div'); row.className = 'tp-file'; row.textContent = f;
      list.appendChild(row);
    });
    if (n > 8) {
      const more = document.createElement('div'); more.className = 'tp-file tp-more';
      more.textContent = 'and ' + (n - 8) + ' more';
      list.appendChild(more);
    }
    win.appendChild(list);
  }

  const opts = document.createElement('div');
  opts.className = 'tp-options';
  const choices = [
    { key: '1', label: 'Switch to ' + branch, primary: true, run: () => doCheckout(branch) },
    { key: '2', label: 'Stay on this branch', run: finishTeleport },
  ];
  let selected = 0;
  const rows = choices.map((c, i) => {
    const row = document.createElement('div');
    row.className = 'tp-option' + (c.primary ? ' primary' : '');
    const k = document.createElement('span'); k.className = 'tp-key'; k.textContent = c.key;
    const l = document.createElement('span'); l.className = 'tp-label'; l.textContent = c.label;
    row.appendChild(k); row.appendChild(l);
    row.onclick = (e) => { e.stopPropagation(); closeTeleportDialog(); c.run(); };
    opts.appendChild(row);
    return row;
  });
  const paint = () => rows.forEach((r, i) => r.classList.toggle('sel', i === selected));
  paint();
  win.appendChild(opts);

  win.onclick = (e) => e.stopPropagation();
  // Backing out of THIS prompt keeps the conversation — it is already saved
  // locally — and simply leaves the branch alone.
  overlay.onclick = () => { closeTeleportDialog(); finishTeleport(); };

  teleportState.keyHandler = (e) => {
    const pick = (i) => { e.preventDefault(); closeTeleportDialog(); choices[i].run(); };
    if (e.key === 'Escape' || e.key === '2') return pick(1);
    if (e.key === '1') return pick(0);
    if (e.key === 'ArrowDown') { e.preventDefault(); selected = (selected + 1) % 2; paint(); return; }
    if (e.key === 'ArrowUp')   { e.preventDefault(); selected = (selected + 1) % 2; paint(); return; }
    if (e.key === 'Enter')     return pick(selected);
  };
  window.addEventListener('keydown', teleportState.keyHandler);
}

function doCheckout(branch) {
  showTeleportProgress(teleportState && teleportState.session, 'Switching to ' + branch + '…');
  if (window._teleportCheckout) _teleportCheckout(branch);
  else finishTeleport();
}

window.onTeleportCheckout = function (json) {
  if (!teleportState) return;
  let r = null;
  try { r = JSON.parse(json || '{}'); } catch (e) { r = null; }
  // A failed checkout is not a failed teleport — the conversation is saved and
  // usable either way, so open it and let the message explain the branch.
  if (!r || !r.ok) teleportState.branchError = (r && r.message) || 'Couldn’t switch branch.';
  finishTeleport();
};

/* ===================== finish ===================== */

/* The teleported conversation is now an ordinary local session, so it opens the
   same way any past conversation does. */
function finishTeleport() {
  const st = teleportState;
  endTeleport();
  if (!st || !st.local || !st.local.localSessionId) return;
  const title = st.local.title || (st.session && st.session.title) || '';
  if (st.branchError) teleportFailed(st.branchError);
  loadHistory(st.local.localSessionId, title);
}

function endTeleport() {
  closeTeleportDialog();
  hideTeleportProgress();
  teleportState = null;
}

/* ===================== progress + failure ===================== */

/* "Teleporting session…" over a dimmed panel, naming the conversation and the
   repo it came from so a slow fetch still says what it is doing. */
function showTeleportProgress(session, label) {
  const el = document.getElementById('teleport-progress');
  if (!el) return;
  el.innerHTML = '';
  const line = document.createElement('div');
  line.className = 'tp-prog-line';
  // CSS ring rather than an icon — icons.js has no spinner, and the existing
  // `spin` keyframe (used by the search-scope button) is already in the sheet.
  const spin = document.createElement('span'); spin.className = 'tp-spin';
  const text = document.createElement('span'); text.textContent = label || 'Teleporting session…';
  line.appendChild(spin); line.appendChild(text);
  el.appendChild(line);
  if (session) {
    const name = document.createElement('div');
    name.className = 'tp-prog-name';
    name.textContent = session.title || '';
    el.appendChild(name);
    if (session.repo) {
      const sub = document.createElement('div');
      sub.className = 'tp-prog-sub';
      sub.textContent = session.repo;
      el.appendChild(sub);
    }
  }
  el.classList.add('open');
  // Hides the transcript panes and the composer for as long as this is up, so
  // the message body reads as empty rather than as this floating over it.
  document.body.classList.add('teleporting');
}

function hideTeleportProgress() {
  const el = document.getElementById('teleport-progress');
  if (el) { el.classList.remove('open'); el.innerHTML = ''; }
  document.body.classList.remove('teleporting');
}

/* Failures surface on the Web tab itself rather than in a dialog: the user is
   still standing in the list they clicked from, and that is where an
   explanation belongs. */
function teleportFailed(message) {
  const el = document.getElementById('history-web');
  if (!el) return;
  const note = document.createElement('div');
  note.className = 'h-empty tp-error';
  note.textContent = message;
  el.insertBefore(note, el.firstChild);
  setTimeout(() => { if (note.parentNode) note.parentNode.removeChild(note); }, 8000);
}

/* The "Teleported from web" boundary, drawn like the model-switch divider —
   rules either side of a centred label — but with the label set as a pill,
   since it marks a change of origin rather than a change of setting. */
function makeTeleportDivider() {
  const turn = document.createElement('div');
  turn.className = 'turn';
  const d = document.createElement('div');
  d.className = 'teleport-divider';
  const l1 = document.createElement('span'); l1.className = 'tpd-line';
  const txt = document.createElement('span'); txt.className = 'tpd-text';
  txt.textContent = 'Teleported from web';
  const l2 = document.createElement('span'); l2.className = 'tpd-line';
  d.appendChild(l1); d.appendChild(txt); d.appendChild(l2);
  turn.appendChild(d);
  return turn;
}
