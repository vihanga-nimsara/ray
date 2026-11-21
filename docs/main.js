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
        try {
          document.execCommand('copy');
        } catch {
          // no-op
        }
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
})();
