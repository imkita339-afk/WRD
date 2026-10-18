'use strict';

/*
 * WHO RUINED? — визуальные эффекты: искры на фоне, появление результата,
 * счётчики, подсветка под курсором. Только оформление: данных и скоринга не касается.
 * При prefers-reduced-motion всё анимированное отключается, контент сразу виден.
 */
(function () {
  const WR = window.WR || (window.WR = {});
  const mq = window.matchMedia ? window.matchMedia('(prefers-reduced-motion: reduce)') : { matches: false };
  const reduced = () => mq.matches;
  const lowEnd = (navigator.hardwareConcurrency || 8) <= 4 || (navigator.deviceMemory || 8) <= 4;
  const finePointer = window.matchMedia && window.matchMedia('(hover: hover) and (pointer: fine)').matches;
  const saveData = !!(navigator.connection && navigator.connection.saveData);
  const root = document.documentElement;

  // Облегчённый режим: без искр и бесконечных анимаций фона
  function goLite() { root.classList.add('fx-lite'); embers.stop(); }

  // ======================================================================
  // Искры на фоне: несколько десятков точек, 30 кадров/с, пауза вне экрана.
  // Если сам браузер стабильно не успевает 25 кадров/с — переходим в облегчённый режим.
  // ======================================================================
  const embers = (function () {
    let canvas, ctx, sprites, parts = [], raf = 0, last = 0, prev = 0, visible = true, w = 0, h = 0, dpr = 1;
    let samples = [], probed = false;
    const COLORS = [[255, 120, 60], [255, 70, 50], [232, 163, 61], [121, 176, 255]];

    function sprite(rgb) {
      const s = 32, c = document.createElement('canvas');
      c.width = c.height = s;
      const g = c.getContext('2d'), gr = g.createRadialGradient(s / 2, s / 2, 0, s / 2, s / 2, s / 2);
      gr.addColorStop(0, `rgba(255,240,220,1)`);
      gr.addColorStop(0.18, `rgba(${rgb},0.9)`);
      gr.addColorStop(0.5, `rgba(${rgb},0.22)`);
      gr.addColorStop(1, `rgba(${rgb},0)`);
      g.fillStyle = gr;
      g.fillRect(0, 0, s, s);
      return c;
    }

    function spawn(p, initial) {
      p.x = Math.random() * w;
      p.y = initial ? Math.random() * h : h + 10;
      p.r = 3 + Math.random() * 7;
      p.vy = 10 + Math.random() * 26;
      p.sway = 6 + Math.random() * 16;
      p.ph = Math.random() * Math.PI * 2;
      p.sp = 0.4 + Math.random() * 0.9;
      p.a = 0.25 + Math.random() * 0.6;
      // в основном тёплые искры, изредка холодные — под цвета команд
      p.c = Math.random() < 0.12 ? 3 : Math.floor(Math.random() * 3);
      return p;
    }

    function resize() {
      dpr = Math.min(window.devicePixelRatio || 1, lowEnd ? 1 : 1.5);
      w = canvas.clientWidth;
      h = canvas.clientHeight;
      canvas.width = Math.round(w * dpr);
      canvas.height = Math.round(h * dpr);
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      const n = Math.min(lowEnd ? 22 : 48, Math.round((w * h) / (lowEnd ? 42000 : 24000)));
      while (parts.length < n) parts.push(spawn({}, true));
      parts.length = n;
    }

    // медиана интервалов между кадрами, первые кадры после запуска пропускаем
    function probe(now) {
      if (prev) samples.push(now - prev);
      prev = now;
      if (samples.length < 140) return;
      probed = true;
      const s = samples.slice(20).sort((a, b) => a - b);
      if (s[s.length >> 1] > 40) goLite();
    }

    function frame(now) {
      raf = requestAnimationFrame(frame);
      if (!probed) probe(now);
      if (now - last < 33) return;
      const dt = Math.min(0.1, (now - last) / 1000);
      last = now;
      ctx.clearRect(0, 0, w, h);
      ctx.globalCompositeOperation = 'lighter';
      for (const p of parts) {
        p.y -= p.vy * dt;
        p.ph += p.sp * dt;
        if (p.y < -20) spawn(p, false);
        const fade = Math.min(1, p.y / (h * 0.35)); // гаснут к верху
        const flick = 0.75 + 0.25 * Math.sin(p.ph * 3.1);
        ctx.globalAlpha = Math.max(0, p.a * fade * flick);
        const d = p.r * 2;
        ctx.drawImage(sprites[p.c], p.x + Math.sin(p.ph) * p.sway - p.r, p.y - p.r, d, d);
      }
      ctx.globalAlpha = 1;
    }

    function run() {
      if (raf || !visible || document.hidden || reduced()) return;
      if (root.classList.contains('fx-lite')) return;
      last = performance.now();
      prev = 0;
      samples = [];
      raf = requestAnimationFrame(frame);
    }
    function stop() { cancelAnimationFrame(raf); raf = 0; }

    function init() {
      const host = document.querySelector('.bg');
      if (!host || reduced() || !window.requestAnimationFrame) return;
      canvas = document.createElement('canvas');
      canvas.className = 'embers';
      canvas.setAttribute('aria-hidden', 'true');
      host.appendChild(canvas);
      ctx = canvas.getContext('2d');
      if (!ctx) { canvas.remove(); return; }
      sprites = COLORS.map((c) => sprite(c.join(',')));
      resize();
      let rt = 0;
      window.addEventListener('resize', () => { clearTimeout(rt); rt = setTimeout(resize, 150); });
      document.addEventListener('visibilitychange', () => (document.hidden ? stop() : run()));
      if ('IntersectionObserver' in window) {
        new IntersectionObserver((es) => {
          visible = es[0].isIntersecting;
          root.classList.toggle('fx-bg-off', !visible); // фон за экраном — его CSS-анимации на паузу
          visible ? run() : stop();
        }).observe(canvas);
      }
      if (mq.addEventListener) mq.addEventListener('change', () => (reduced() ? (stop(), ctx.clearRect(0, 0, w, h)) : run()));
      run();
    }
    return { init, stop };
  })();

  // ======================================================================
  // Счётчики: data-count на элементе, текст — итоговое число
  // ======================================================================
  function countUp(el, delay) {
    const to = Number(el.dataset.count);
    if (!isFinite(to)) return;
    const dur = 900;
    let t0 = 0;
    el.textContent = '0';
    const step = (now) => {
      if (!el.isConnected) return;
      if (!t0) t0 = now + (delay || 0);
      const k = Math.max(0, Math.min(1, (now - t0) / dur));
      const e = 1 - Math.pow(1 - k, 3);
      el.textContent = String(Math.round(to * e));
      if (k < 1) requestAnimationFrame(step);
    };
    requestAnimationFrame(step);
  }

  // ======================================================================
  // Появление блоков при прокрутке
  // ======================================================================
  let io = null;
  function onSeen(entries) {
    entries.forEach((en) => {
      if (!en.isIntersecting) return;
      const el = en.target;
      io.unobserve(el);
      el.classList.add('fx-seen');
      el.querySelectorAll('[data-count]').forEach((c) => countUp(c, 250));
      setTimeout(() => el.classList.remove('fx-pending', 'fx-seen'), 1600);
    });
  }

  function reveal() {
    const root = document.getElementById('result');
    if (!root || reduced() || !('IntersectionObserver' in window)) return;
    if (io) io.disconnect();
    io = new IntersectionObserver(onSeen, { rootMargin: '0px 0px -8% 0px', threshold: 0 });
    const blocks = [...root.children].flatMap((s) => (s.id === 'awards' ? [...s.children] : [s]))
      .filter((s) => s.innerHTML.trim());
    blocks.forEach((el, i) => {
      el.classList.remove('fx-seen');
      el.classList.add('fx-pending');
      el.style.setProperty('--fx-i', String(i % 4));
      io.observe(el);
    });
  }

  // ======================================================================
  // Состояние загрузки
  // ======================================================================
  function loading(on) {
    document.body.classList.toggle('is-loading', !!on);
  }

  // ======================================================================
  // Подсветка под курсором на карточках (только мышь)
  // ======================================================================
  function spotlight() {
    if (!finePointer) return;
    let tgt = null, ev = null, queued = false;
    document.addEventListener('pointermove', (e) => {
      ev = e;
      if (queued) return;
      queued = true;
      requestAnimationFrame(() => {
        queued = false;
        const el = ev.target.closest && ev.target.closest('.verdict, .pcard, .award, .ep, .story-card, .phase, .stat');
        if (tgt && tgt !== el) tgt.classList.remove('fx-lit');
        tgt = el;
        if (!el) return;
        const r = el.getBoundingClientRect();
        el.style.setProperty('--mx', `${ev.clientX - r.left}px`);
        el.style.setProperty('--my', `${ev.clientY - r.top}px`);
        el.classList.add('fx-lit');
      });
    }, { passive: true });
  }

  function init() {
    if (saveData) root.classList.add('fx-lite');
    embers.init();
    spotlight();
  }

  WR.fx = { reveal, loading, countUp };
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
  else init();
})();
