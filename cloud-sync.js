/* spys 게임 클라우드 저장 연동 — 모든 게임 <head> 맨 위에서 불러옴 */
(function () {
  'use strict';
  if (window.__CS) return;
  // ▼▼ Cloudflare Worker 주소 (만든 뒤 여기만 바꾸면 됨) ▼▼
  var API = 'https://spys-save.spys7777.workers.dev';
  // ▲▲▲▲▲▲▲▲▲▲▲▲▲▲▲▲▲▲▲▲▲▲▲▲▲▲▲▲▲▲▲▲▲▲▲▲▲▲▲▲▲▲▲▲▲▲▲▲
  var P = '__cs_';
  var LS;
  try { LS = window.localStorage; LS.setItem(P + 't', '1'); LS.removeItem(P + 't'); } catch (e) { return; }

  var SP = Storage.prototype, oSet = SP.setItem, oGet = SP.getItem, oRem = SP.removeItem, oKey = SP.key;
  function g(k) { return oGet.call(LS, k); }
  function s(k, v) { try { oSet.call(LS, k, v); } catch (e) {} }
  function r(k) { oRem.call(LS, k); }
  function keys() { var a = [], i, k; for (i = 0; i < LS.length; i++) { k = oKey.call(LS, i); if (k != null && k.indexOf(P) !== 0) a.push(k); } return a; }

  var configured = API.indexOf('REPLACE_ME') < 0;
  var blocked = false, timer = null, pushing = false, again = false, lastPush = 0;
  var fresh = false;          // 이번 페이지에서 클라우드 최신 상태를 확인했는지
  var lastErr = '', lastOk = 0;
  var dirty = {}, meta = {};  // meta: 키별로 마지막으로 맞춘 클라우드 버전(시간)
  try { (JSON.parse(g(P + 'dirty') || '[]')).forEach(function (k) { dirty[k] = 1; }); } catch (e) {}
  try { meta = JSON.parse(g(P + 'meta') || '{}') || {}; } catch (e) { meta = {}; }
  function saveDirty() { s(P + 'dirty', JSON.stringify(Object.keys(dirty))); }
  function saveMeta() { s(P + 'meta', JSON.stringify(meta)); }
  function acct() { return { id: g(P + 'id'), auth: g(P + 'auth') }; }
  function on() { var a = acct(); return configured && !!(a.id && a.auth); }
  function mark(k) { if (k.indexOf(P) === 0) return; dirty[k] = 1; saveDirty(); sched(); }

  // 게임들이 저장할 때 자동으로 감지
  SP.setItem = function (k, v) {
    if (this !== LS) return oSet.apply(this, arguments);
    if (blocked) return;
    k = String(k); v = String(v);
    var old = oGet.call(this, k);
    oSet.call(this, k, v);
    if (old !== v) mark(k);
  };
  SP.removeItem = function (k) {
    if (this !== LS) return oRem.apply(this, arguments);
    if (blocked) return;
    k = String(k);
    var had = oGet.call(this, k) !== null;
    oRem.call(this, k);
    if (had) mark(k);
  };
  var oClr = SP.clear;
  SP.clear = function () {
    if (this !== LS) return oClr.apply(this, arguments);
    if (blocked) return;
    keys().forEach(function (k) { oRem.call(LS, k); mark(k); });
  };

  function api(path, body, keep) {
    var a = acct();
    body.id = body.id || a.id; body.auth = body.auth || a.auth;
    var str = JSON.stringify(body);
    return fetch(API + '/' + path, {
      method: 'POST', headers: { 'content-type': 'text/plain' }, body: str,
      keepalive: !!keep && str.length < 60000
    }).then(function (res) {
      return res.json().catch(function () { return {}; }).then(function (j) {
        if (!res.ok || !j.ok) throw new Error(j.err || ('서버 오류 ' + res.status));
        return j;
      });
    });
  }

  function sched() {
    if (!on() || timer) return;
    var wait = Math.max(3000, 20000 - (Date.now() - lastPush));
    timer = setTimeout(function () { timer = null; syncNow(); }, wait);
  }

  // 바뀐 저장 올리기 (항상 클라우드 최신 확인 뒤에만)
  function push(keep) {
    if (!on() || !fresh) return Promise.resolve();
    if (pushing) { again = true; return Promise.resolve(); }
    var ks = Object.keys(dirty);
    if (!ks.length) return Promise.resolve();
    var sent = {}, chunks = [[]], size = 0;
    ks.forEach(function (k) {
      var v = g(k); sent[k] = v;
      var it = v === null ? { k: k, del: 1 } : { k: k, v: v };
      var n = (v ? v.length : 0) + k.length + 20;
      if (size + n > 300000 && chunks[chunks.length - 1].length) { chunks.push([]); size = 0; }
      chunks[chunks.length - 1].push(it); size += n;
    });
    pushing = true; lastPush = Date.now();
    var p = Promise.resolve();
    chunks.forEach(function (ch) {
      p = p.then(function () {
        return api('push', { items: ch }, keep).then(function (res) {
          ch.forEach(function (it) {
            meta[it.k] = res.ts;
            if (g(it.k) === sent[it.k]) delete dirty[it.k];
          });
          saveMeta(); saveDirty();
        });
      });
    });
    return p.then(function () { lastErr = ''; lastOk = Date.now(); setStat('ok'); },
      function (e) { lastErr = e.message; setStat('err'); }).then(function () {
      pushing = false;
      if (again) { again = false; push(); } else if (Object.keys(dirty).length && !lastErr) sched();
    });
  }

  // 클라우드에서 바뀐 것 받기. 다른 기기가 바꾼 건 클라우드 우선. 실제로 바뀐 게 있으면 true
  function pull(since) {
    if (since == null) since = +(g(P + 'since') || 0);
    return api('pull', { since: since }).then(function (res) {
      var changed = false;
      (res.items || []).forEach(function (it) {
        if (it.k.indexOf(P) === 0) return;
        if (it.ts <= (meta[it.k] || 0)) return;     // 이미 맞춘 버전
        meta[it.k] = it.ts; delete dirty[it.k];      // 다른 기기에서 바뀜 → 이 기기 옛날 값 버림
        var cur = g(it.k);
        if (it.del) { if (cur !== null) { blocked = true; r(it.k); changed = true; } }
        else if (cur !== it.v) { blocked = true; s(it.k, it.v); changed = true; }
      });
      saveMeta(); saveDirty();
      s(P + 'since', String(res.max || since));
      fresh = true; lastErr = ''; lastOk = Date.now();
      return changed;
    });
  }

  function reload(msg) {
    blocked = true;
    toast(msg || '☁ 다른 기기 저장 불러오는 중…');
    setTimeout(function () { location.reload(); }, 700);
  }

  var syncing = null;
  function syncNow() {
    if (!on()) return Promise.resolve();
    if (syncing) return syncing;
    fresh = false; setStat('busy');
    syncing = pull().then(function (changed) {
      if (changed) { reload(); return; }
      return push();
    }).then(function () { if (!blocked) setStat(lastErr ? 'err' : 'ok'); }).catch(function (e) {
      blocked = false; lastErr = e.message; setStat('err');
      if (/틀렸/.test(e.message)) toast('☁ ' + e.message + ' — 다시 로그인해줘');
    }).then(function () { syncing = null; });
    return syncing;
  }

  // 클라우드 저장으로 강제로 다시 받기
  function forceDown() {
    if (!on()) return Promise.resolve();
    meta = {}; dirty = {}; saveMeta(); saveDirty(); s(P + 'since', '0');
    return syncNow();
  }

  function sha(t) {
    return crypto.subtle.digest('SHA-256', new TextEncoder().encode(t)).then(function (b) {
      return Array.prototype.map.call(new Uint8Array(b), function (x) { return ('0' + x.toString(16)).slice(-2); }).join('');
    });
  }

  function login(id, pw) {
    return login0(id, pw).then(function (how) {
      if (how === 'down') reload('☁ 클라우드 저장 불러왔어!'); else blocked = false;
      return how;
    });
  }
  function login0(id, pw) {
    id = String(id || '').trim().toLowerCase();
    if (!configured) return Promise.reject(new Error('아직 서버 주소가 설정 안 됐어'));
    if (!id || !pw) return Promise.reject(new Error('아이디랑 비밀번호 써줘'));
    if (pw.length < 4) return Promise.reject(new Error('비밀번호는 4자 이상'));
    var auth;
    return sha(id + '|' + pw + '|spys-cloud').then(function (h) {
      auth = h;
      return api('login', { id: id, auth: auth });
    }).then(function (res) {
      s(P + 'id', id); s(P + 'auth', auth); s(P + 'since', '0');
      meta = {}; dirty = {}; saveMeta(); saveDirty();
      var local = keys();
      if (res.created || !res.count) {
        // 새 계정 / 클라우드 비어 있음 → 이 기기 저장 올리기
        local.forEach(function (k) { dirty[k] = 1; }); saveDirty();
        fresh = true;
        return push().then(function () { if (lastErr) throw new Error(lastErr); return 'up'; });
      }
      if (!local.length) return pull(0).then(function (c) { return c ? 'down' : 'same'; });
      return ask('이 아이디에 클라우드 저장이 있어.\n이 브라우저에도 저장이 있어. 어떤 걸 쓸까?\n\n(다른 기기에서 하던 걸 이어하려면 위에 거)',
        ['☁ 클라우드 저장 받기', '📱 이 브라우저 저장으로 덮어쓰기']).then(function (c) {
        return api('pull', { since: 0 }).then(function (all) {
          var items = all.items || [], have = {};
          items.forEach(function (it) { if (!it.del) have[it.k] = 1; });
          if (c === 0) {
            // 클라우드 받기 + 이 브라우저에만 있는 저장은 올려두기
            return pull(0).then(function (ch) {
              keys().forEach(function (k) { if (!have[k]) dirty[k] = 1; }); saveDirty();
              return push().then(function () { return ch ? 'down' : 'same'; });
            });
          }
          // 이 브라우저 저장으로 덮어쓰기 (클라우드에만 있는 건 삭제)
          items.forEach(function (it) { meta[it.k] = it.ts; dirty[it.k] = 1; });
          local.forEach(function (k) { dirty[k] = 1; });
          saveMeta(); saveDirty(); s(P + 'since', String(all.max || 0));
          fresh = true;
          return push().then(function () { if (lastErr) throw new Error(lastErr); return 'up'; });
        });
      });
    });
  }

  function logout() { r(P + 'id'); r(P + 'auth'); r(P + 'since'); r(P + 'meta'); meta = {}; dirty = {}; saveDirty(); fresh = false; setStat(); }

  // ───── 화면(작은 ☁ 버튼 + 패널) ─────
  var ui = {}, statNow = '';
  function css() {
    var st = document.createElement('style');
    st.textContent =
      '#__csb{position:fixed;z-index:2147483646;width:30px;height:30px;border-radius:15px;background:rgba(20,22,30,.55);color:#fff;font:15px/30px system-ui,sans-serif;text-align:center;cursor:pointer;-webkit-user-select:none;user-select:none;touch-action:none;box-shadow:0 1px 4px rgba(0,0,0,.4);opacity:.6;transition:opacity .3s}' +
      '#__csb:hover{opacity:1}#__csb i{position:absolute;right:1px;bottom:1px;width:8px;height:8px;border-radius:4px;background:#888}' +
      '#__csb.ok i{background:#3ddc84}#__csb.err i{background:#ff4d4d}#__csb.busy i{background:#ffcc00}' +
      '#__csp{position:fixed;inset:0;z-index:2147483647;background:rgba(0,0,0,.55);display:flex;align-items:center;justify-content:center;font:15px/1.5 system-ui,"맑은 고딕",sans-serif}' +
      '#__csp .bx{background:#1d1f27;color:#eee;width:min(320px,90vw);border-radius:14px;padding:16px;box-shadow:0 6px 30px rgba(0,0,0,.6)}' +
      '#__csp h3{margin:0 0 6px;font-size:17px}#__csp p{margin:6px 0;color:#aab;font-size:13px;white-space:pre-line}' +
      '#__csp input{box-sizing:border-box;width:100%;margin:5px 0;padding:10px;border-radius:8px;border:1px solid #444;background:#111;color:#eee;font:inherit}' +
      '#__csp button{box-sizing:border-box;width:100%;margin-top:7px;padding:10px;border:0;border-radius:8px;background:#3a3d4a;color:#eee;font:inherit;cursor:pointer}' +
      '#__csp button.p{background:#4f8cff;color:#fff;font-weight:700}' +
      '#__cst{position:fixed;left:50%;top:14px;transform:translateX(-50%);z-index:2147483647;background:rgba(20,22,30,.92);color:#fff;padding:8px 14px;border-radius:20px;font:14px system-ui,sans-serif;pointer-events:none;transition:opacity .4s}';
    (document.head || document.documentElement).appendChild(st);
  }
  function toast(m) {
    if (!document.body) return;
    var t = document.getElementById('__cst');
    if (!t) { t = document.createElement('div'); t.id = '__cst'; document.body.appendChild(t); }
    t.textContent = m; t.style.opacity = '1';
    clearTimeout(t._h); t._h = setTimeout(function () { t.style.opacity = '0'; }, 2600);
  }
  function setStat(x) {
    statNow = x || '';
    if (ui.b) ui.b.className = on() ? statNow : '';
  }
  function close() { var p = document.getElementById('__csp'); if (p) p.remove(); }
  function panel(html) {
    close();
    var p = document.createElement('div'); p.id = '__csp';
    p.innerHTML = '<div class="bx">' + html + '</div>';
    p.addEventListener('pointerdown', function (e) { e.stopPropagation(); }, true);
    p.addEventListener('keydown', function (e) { e.stopPropagation(); }, true);
    p.addEventListener('keyup', function (e) { e.stopPropagation(); }, true);
    p.addEventListener('click', function (e) { if (e.target === p) close(); });
    document.body.appendChild(p);
    return p;
  }
  function ask(msg, opts) {
    return new Promise(function (res) {
      var p = panel('<h3>☁ 저장 선택</h3><p></p>' + opts.map(function (o, i) { return '<button data-i="' + i + '"' + (i === 0 ? ' class="p"' : '') + '></button>'; }).join(''));
      p.querySelector('p').textContent = msg;
      Array.prototype.forEach.call(p.querySelectorAll('button'), function (b) {
        b.textContent = opts[+b.dataset.i];
        b.onclick = function () { close(); res(+b.dataset.i); };
      });
      p.onclick = null;
    });
  }
  function open() {
    if (on()) {
      var p = panel('<h3>☁ 클라우드 저장</h3><p></p><button class="p" data-a="s">지금 동기화</button><button data-a="f">☁ 클라우드 저장 다시 받기</button><button data-a="o">로그아웃</button><button data-a="c">닫기</button>');
      var nd = Object.keys(dirty).length;
      p.querySelector('p').textContent = '로그인: ' + acct().id +
        '\n이 브라우저 저장: ' + keys().length + '개' + (nd ? ' (안 올라간 것 ' + nd + '개)' : '') +
        '\n마지막 동기화: ' + (lastOk ? new Date(lastOk).toLocaleTimeString() : '아직 없음') +
        (lastErr ? '\n⚠ 오류: ' + lastErr : '') +
        '\n\n저장은 자동으로 올라가고, 다른 브라우저에서 같은 아이디로 로그인하면 이어서 할 수 있어.';
      p.querySelector('[data-a=f]').onclick = function () { close(); toast('☁ 클라우드에서 받는 중…'); forceDown().then(function () { if (!blocked) toast(lastErr ? '☁ 실패: ' + lastErr : '☁ 이미 클라우드랑 같아'); }); };
      p.querySelector('[data-a=s]').onclick = function () { close(); toast('☁ 동기화 중…'); syncNow().then(function () { if (!blocked) toast(statNow === 'err' ? '☁ 동기화 실패 (인터넷 확인)' : '☁ 동기화 완료'); }); };
      p.querySelector('[data-a=o]').onclick = function () { logout(); close(); toast('☁ 로그아웃했어 (이 기기 저장은 그대로)'); };
      p.querySelector('[data-a=c]').onclick = close;
      return;
    }
    var q = panel('<h3>☁ 클라우드 저장 로그인</h3><p>처음 쓰는 아이디면 자동으로 새로 만들어져.\n모든 게임 저장이 같이 연동돼.</p>' +
      '<input id="__csi" placeholder="아이디 (2~20자)" autocomplete="username" maxlength="20">' +
      '<input id="__csw" type="password" placeholder="비밀번호 (4자 이상)" autocomplete="current-password">' +
      '<p id="__cse" style="color:#ff7a7a"></p><button class="p" data-a="l">로그인 / 가입</button><button data-a="c">닫기</button>');
    var go = q.querySelector('[data-a=l]'), er = q.querySelector('#__cse');
    q.querySelector('[data-a=c]').onclick = close;
    q.querySelector('#__csw').addEventListener('keydown', function (e) { if (e.key === 'Enter') go.click(); });
    go.onclick = function () {
      er.textContent = ''; go.disabled = true; go.textContent = '연결 중…';
      login(q.querySelector('#__csi').value, q.querySelector('#__csw').value).then(function (how) {
        close(); setStat('ok');
        if (how !== 'down') toast(how === 'up' ? '☁ 이 기기 저장을 클라우드에 올렸어!' : '☁ 로그인 완료');
      }, function (e) {
        go.disabled = false; go.textContent = '로그인 / 가입';
        er.textContent = /fetch|network|load/i.test(e.message) ? '서버 연결 실패 (인터넷 확인)' : e.message;
      });
    };
  }
  function button() {
    var b = document.createElement('div'); b.id = '__csb'; b.innerHTML = '☁<i></i>'; b.title = '클라우드 저장';
    var pos; try { pos = JSON.parse(g(P + 'pos') || 'null'); } catch (e) {}
    function place(x, y) {
      x = Math.max(0, Math.min(innerWidth - 30, x)); y = Math.max(0, Math.min(innerHeight - 30, y));
      b.style.left = x + 'px'; b.style.top = y + 'px'; return [x, y];
    }
    place(pos ? pos[0] * innerWidth : innerWidth - 36, pos ? pos[1] * innerHeight : innerHeight * 0.5);
    var d = null;
    b.addEventListener('pointerdown', function (e) {
      e.stopPropagation(); e.preventDefault();
      d = { x: e.clientX, y: e.clientY, l: b.offsetLeft, t: b.offsetTop, m: false };
      try { b.setPointerCapture(e.pointerId); } catch (er) {}
    });
    b.addEventListener('pointermove', function (e) {
      if (!d) return; e.stopPropagation();
      var dx = e.clientX - d.x, dy = e.clientY - d.y;
      if (Math.abs(dx) + Math.abs(dy) > 6) d.m = true;
      if (d.m) place(d.l + dx, d.t + dy);
    });
    b.addEventListener('pointerup', function (e) {
      if (!d) return; e.stopPropagation();
      if (d.m) s(P + 'pos', JSON.stringify([b.offsetLeft / innerWidth, b.offsetTop / innerHeight]));
      else open();
      d = null;
    });
    ['touchstart', 'touchend', 'mousedown', 'mouseup', 'click'].forEach(function (ev) {
      b.addEventListener(ev, function (e) { e.stopPropagation(); }, { passive: true });
    });
    addEventListener('resize', function () { place(b.offsetLeft, b.offsetTop); });
    document.body.appendChild(b); ui.b = b; setStat(statNow);
  }

  // 예전 버전에서 로그인했던 브라우저 → 저장 덮어쓰기 방지 위해 다시 로그인해서 고르게
  var needRelogin = !!g(P + 'id') && g(P + 'meta') === null;
  if (needRelogin) { r(P + 'id'); r(P + 'auth'); r(P + 'since'); dirty = {}; saveDirty(); }

  function start() {
    css(); button();
    if (needRelogin) toast('☁ 클라우드 저장 업데이트됨 — ☁ 버튼 눌러서 다시 로그인해줘');
    if (on()) syncNow(true);
    // 게임 쪽 저장 처리 뒤에 실행되도록 나중에 등록
    document.addEventListener('visibilitychange', function () {
      if (!on()) return;
      if (document.visibilityState === 'hidden') { clearTimeout(timer); timer = null; if (!blocked) push(true); }
      else syncNow();
    });
    addEventListener('pagehide', function () { if (on() && !blocked) push(true); });
    setInterval(function () { if (on() && !blocked && document.visibilityState === 'visible') syncNow(); }, 60000);
  }
  if (document.readyState === 'complete') start();
  else addEventListener('load', start);

  window.__CS = { open: open, login: login, logout: logout, sync: syncNow, status: function () { return { on: on(), id: acct().id, dirty: Object.keys(dirty), stat: statNow, err: lastErr }; }, forceDown: forceDown };
})();
