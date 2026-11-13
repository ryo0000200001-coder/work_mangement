'use strict';
(function () {
  const pad = (n) => String(n).padStart(2, '0');
  const WEEK = ['日', '月', '火', '水', '木', '金', '土'];

  // ---- 時計（日本時間で表示） ----
  function nowJst() {
    const d = new Date();
    return new Date(d.getTime() + (d.getTimezoneOffset() + 540) * 60000);
  }
  function tick() {
    const timeEl = document.querySelector('[data-clock-time]');
    if (!timeEl) return;
    const d = nowJst();
    timeEl.textContent = `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
    const dateEl = document.querySelector('[data-clock-date]');
    if (dateEl) dateEl.textContent = `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}（${WEEK[d.getDay()]}）`;
  }

  document.addEventListener('DOMContentLoaded', () => {
    if (document.querySelector('[data-clock-time]')) { tick(); setInterval(tick, 1000); }

    // 確認ダイアログ
    document.addEventListener('click', (e) => {
      const el = e.target.closest('[data-confirm]');
      if (el && !window.confirm(el.getAttribute('data-confirm'))) { e.preventDefault(); e.stopImmediatePropagation(); }
    }, true);

    // 二重送信防止。送信データ確定後にボタンを無効化する（押したボタンの値は送信される）
    document.querySelectorAll('form[data-once]').forEach((form) => {
      form.addEventListener('submit', (e) => {
        if (form.dataset.submitted) { e.preventDefault(); return; }
        form.dataset.submitted = '1';
        setTimeout(() => form.querySelectorAll('button').forEach((b) => { b.disabled = true; }), 0);
      });
    });
    // 戻るボタンでキャッシュから復帰した場合は再度押せるようにする
    window.addEventListener('pageshow', (e) => {
      if (e.persisted) window.location.reload();
    });

    // 値を変えたら自動送信
    document.querySelectorAll('form[data-autosubmit]').forEach((form) => {
      form.querySelectorAll('select, input').forEach((el) => {
        el.addEventListener('change', () => { if (!el.value) return; form.submit(); });
      });
    });

    // 休憩行の追加・削除
    const list = document.querySelector('[data-break-list]');
    const addBtn = document.querySelector('[data-break-add]');
    if (list && addBtn) {
      addBtn.addEventListener('click', () => {
        const rows = list.querySelectorAll('[data-break-row]');
        const clone = rows[rows.length - 1].cloneNode(true);
        clone.querySelectorAll('input').forEach((i) => { i.value = ''; });
        list.appendChild(clone);
        clone.querySelector('input').focus();
      });
      list.addEventListener('click', (e) => {
        const btn = e.target.closest('[data-break-remove]');
        if (!btn) return;
        const rows = list.querySelectorAll('[data-break-row]');
        const row = btn.closest('[data-break-row]');
        if (rows.length > 1) row.remove();
        else row.querySelectorAll('input').forEach((i) => { i.value = ''; });
      });
    }

    // モバイルメニュー
    const toggle = document.querySelector('[data-nav-toggle]');
    const nav = document.querySelector('[data-nav]');
    if (toggle && nav) {
      toggle.addEventListener('click', () => {
        const open = nav.classList.toggle('open');
        toggle.setAttribute('aria-expanded', String(open));
      });
    }
    // ドロップダウンの外側クリックで閉じる
    document.addEventListener('click', (e) => {
      document.querySelectorAll('details.nav-more[open]').forEach((d) => { if (!d.contains(e.target)) d.removeAttribute('open'); });
    });

    document.querySelectorAll('[data-print]').forEach((b) => b.addEventListener('click', () => window.print()));

    // シフト表: セルをクリックして編集ダイアログを開く
    const dialog = document.querySelector('[data-shift-dialog]');
    if (dialog) {
      const f = (name) => dialog.querySelector(`[data-f="${name}"]`);
      document.querySelectorAll('[data-shift-edit]').forEach((btn) => {
        btn.addEventListener('click', () => {
          const d = btn.dataset;
          f('user').value = d.user;
          f('date').value = d.date;
          f('title').textContent = `${d.name} — ${d.date}`;
          f('request').textContent = d.request;
          f('start').value = d.start;
          f('end').value = d.end;
          f('break').value = d.break;
          f('note').value = d.note;
          f('delete').hidden = !d.exists;
          if (typeof dialog.showModal === 'function') dialog.showModal(); else dialog.setAttribute('open', '');
          f('start').focus();
        });
      });
      dialog.querySelectorAll('[data-dialog-close]').forEach((b) => b.addEventListener('click', () => dialog.close()));
      dialog.addEventListener('click', (e) => { if (e.target === dialog) dialog.close(); });
    }

    // 希望シフト: 「休み希望」「未入力」の行は時間帯を入力不可にする
    // ※ disabled にすると送信されず配列の位置がずれるため readOnly を使う
    document.querySelectorAll('select[data-kind]').forEach((sel) => {
      if (sel.disabled) return;
      const sync = () => {
        const on = sel.value === 'available';
        sel.closest('tr').querySelectorAll('input[type="time"]').forEach((i) => {
          i.readOnly = !on;
          i.classList.toggle('is-off', !on);
          if (!on) i.value = '';
        });
      };
      sel.addEventListener('change', sync);
      sync();
    });
  });
})();
