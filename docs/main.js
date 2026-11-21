(() => {
  'use strict';

  // IntersectionObserver reveal.
  const reveals = document.querySelectorAll('.reveal');
  if ('IntersectionObserver' in window) {
    const observer = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) {
          if (entry.isIntersecting) {
            entry.target.classList.add('is-visible');
            observer.unobserve(entry.target);
          }
        }
      },
      { threshold: 0.12, rootMargin: '0px 0px -40px 0px' },
    );
    reveals.forEach((el) => observer.observe(el));
  } else {
    reveals.forEach((el) => el.classList.add('is-visible'));
  }

  // Copy shortcut.
  const copyBtn = document.querySelector('.copy-key');
  if (copyBtn) {
    copyBtn.addEventListener('click', async () => {
      const text = copyBtn.dataset.copy || 'Ctrl + Space';
      try {
        await navigator.clipboard.writeText(text);
      } catch {
        const ta = document.createElement('textarea');
        ta.value = text;
        ta.style.position = 'fixed';
        ta.style.opacity = '0';
        document.body.appendChild(ta);
        ta.select();
        try { document.execCommand('copy'); } catch { /* no-op */ }
        document.body.removeChild(ta);
      }
      copyBtn.textContent = 'Copied';
      copyBtn.classList.add('is-copied');
      window.setTimeout(() => {
        copyBtn.textContent = 'Copy';
        copyBtn.classList.remove('is-copied');
      }, 1500);
    });
  }

  // Live demo in the hero bar.
  const demoInput = document.getElementById('demoInput');
  const demoList = document.getElementById('demoList');
  const demoBar = document.getElementById('demoBar');
  if (demoInput && demoList && demoBar) {
    const apps = [
      { name: 'Steam', icon: 'assets/apps/steam.png', tile: false },
      { name: 'Spotify', icon: 'assets/apps/spotify.png', tile: false },
      { name: 'Settings', icon: 'assets/apps/settings.png', tile: false },
      { name: 'Discord', icon: 'assets/apps/discord.png', tile: false },
      { name: 'WhatsApp', icon: 'assets/apps/whatsapp.png', tile: false },
      { name: 'Google Chrome', icon: 'assets/apps/google-chrome.png', tile: false },
      { name: 'Figma', icon: 'assets/apps/figma.png', tile: false },
      { name: 'Terminal', icon: 'assets/apps/terminal.png', tile: false },
      { name: 'Visual Studio Code', icon: 'assets/apps/visual-studio-code.png', tile: false },
      { name: 'Blender', icon: 'assets/apps/blender-5-3-0-0.png', tile: false },
      { name: 'Slack', icon: null, tile: true, letter: 'S' },
      { name: 'Snipping tool', icon: null, tile: true, letter: 'S' },
    ];

    const queries = ['steam', 'fig', 'term', 'set', 'spo', 'dis'];
    const reduce = window.matchMedia('(prefers-reduced-motion: reduce)').matches;

    function highlight(name, q) {
      const lower = name.toLowerCase();
      const idx = lower.indexOf(q);
      if (idx < 0) return name;
      return (
        name.slice(0, idx) +
        '<span class="match">' + name.slice(idx, idx + q.length) + '</span>' +
        name.slice(idx + q.length)
      );
    }

    function renderResults(q) {
      demoList.innerHTML = '';
      const term = q.trim().toLowerCase();
      const results = term
        ? apps.filter((a) => a.name.toLowerCase().includes(term)).slice(0, 5)
        : apps.slice(0, 5);
      results.forEach((app, i) => {
        const li = document.createElement('li');
        li.className = 'spot-row' + (i === 0 && term ? ' is-active' : '');
        if (app.tile) {
          const tile = document.createElement('span');
          tile.className = 'spot-icon spot-icon-tile';
          tile.setAttribute('aria-hidden', 'true');
          tile.textContent = app.letter;
          li.appendChild(tile);
        } else {
          const img = document.createElement('img');
          img.className = 'spot-icon';
          img.src = app.icon;
          img.alt = '';
          img.width = 20;
          img.height = 20;
          li.appendChild(img);
        }
        const name = document.createElement('span');
        name.className = 'spot-name';
        name.innerHTML = term ? highlight(app.name, term) : app.name;
        li.appendChild(name);
        demoList.appendChild(li);
      });
    }

    function typeQuery(q, cb) {
      let i = 0;
      demoInput.textContent = '';
      renderResults('');
      const step = () => {
        if (i < q.length) {
          demoInput.textContent += q[i++];
          renderResults(demoInput.textContent);
          setTimeout(step, 90);
        } else {
          cb();
        }
      };
      step();
    }

    function clearQuery(cb) {
      demoInput.textContent = '';
      renderResults('');
      cb();
    }

    if (reduce) {
      demoInput.textContent = 'steam';
      renderResults('steam');
      return;
    }

    renderResults('');
    let qi = 0;
    function cycle() {
      const q = queries[qi % queries.length];
      qi++;
      typeQuery(q, () => {
        const active = demoList.querySelector('.spot-row.is-active');
        if (active) active.classList.add('is-launching');
        window.setTimeout(() => {
          if (active) active.classList.remove('is-launching');
          clearQuery(() => {
            window.setTimeout(cycle, 700);
          });
        }, 1500);
      });
    }

    window.setTimeout(cycle, 900);
  }
})();
