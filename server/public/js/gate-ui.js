/* Gate UI shared JS: toasts, clipboard, theme, i18n (en/bn), money formatting. */
window.GateUI = (() => {
  const I18N = {
    en: {
      pay_title: 'Complete your payment',
      amount_due: 'Amount to send',
      step1: 'Open your {p} app and send exactly the amount above to this number',
      step2: 'Put this reference in the payment note / reference field',
      step3: 'Come back, enter your TrxID and press Confirm payment',
      wallet_number: 'Wallet number',
      reference: 'Reference',
      copy: 'Copy', copied: 'Copied',
      trxid_label: 'Transaction ID (TrxID)',
      trxid_ph: 'e.g. DJC9SZQV0J',
      confirm: 'Confirm payment',
      loading: 'Checking your payment…',
      loading_sub: 'This usually takes a few seconds.',
      paid: 'Payment received',
      paid_sub: 'Thank you! You can go back to the shop.',
      still_checking: "We haven't seen your payment yet. It can take a minute.",
      still_checking_sub: 'Keep this page open — it completes automatically. Or re-check the TrxID you entered.',
      review: 'Your payment needs review',
      expired: 'This payment link has expired.',
      expired_sub: 'Start again from the shop.',
      cancel: 'This payment was cancelled.',
      back_shop: 'Back to shop',
      support: 'Contact support',
      expires_in: 'Expires in',
      lang_toggle: 'বাংলা',
      time_left: 'Time left',
      wrong_trxid: 'That does not look like a valid TrxID. Check what your wallet app shows.',
      already_used: 'This TrxID was already used.',
      locked: 'Too many failed attempts. Please try again in 15 minutes.',
      sent_to: 'Send to',
      holder: 'Holder',
    },
    bn: {
      pay_title: 'পেমেন্ট সম্পন্ন করুন',
      amount_due: 'প্রেরণ করতে হবে',
      step1: 'আপনার {p} অ্যাপ খুলে ঠিক এই টাকার পরিমাণ এই নম্বরে পাঠান',
      step2: 'পেমেন্টের নোট/রেফারেন্স ঘরে এই কোডটি লিখুন',
      step3: 'ফিরে এসে TrxID লিখে “Confirm payment” চাপুন',
      wallet_number: 'ওয়ালেট নম্বর',
      reference: 'রেফারেন্স',
      copy: 'কপি', copied: 'কপি হয়েছে',
      trxid_label: 'লেনদেন আইডি (TrxID)',
      trxid_ph: 'যেমন DJC9SZQV0J',
      confirm: 'পেমেন্ট নিশ্চিত করুন',
      loading: 'আপনার পেমেন্ট যাচাই করা হচ্ছে…',
      loading_sub: 'সাধারণত কয়েক সেকেন্ড লাগে।',
      paid: 'পেমেন্ট গ্রহণ করা হয়েছে',
      paid_sub: 'ধন্যবাদ! আপনি দোকানে ফিরে যেতে পারেন।',
      still_checking: 'আমরা এখনও আপনার পেমেন্ট দেখিনি। এক মিনিট সময় লাগতে পারে।',
      still_checking_sub: 'এই পেজ খোলা রাখুন — স্বয়ংক্রিয়ভাবে সম্পন্ন হবে। অথবা লেখা TrxID আবার যাচাই করুন।',
      review: 'আপনার পেমেন্ট পর্যালোচনা প্রয়োজন',
      expired: 'এই পেমেন্ট লিংকের সময় শেষ হয়েছে।',
      expired_sub: 'দোকান থেকে আবার শুরু করুন।',
      cancel: 'এই পেমেন্ট বাতিল হয়েছে।',
      back_shop: 'দোকানে ফিরুন',
      support: 'সহায়তা নিন',
      expires_in: 'সময় বাকি',
      lang_toggle: 'English',
      time_left: 'সময় বাকি',
      wrong_trxid: 'এটি সঠিক TrxID মনে হচ্ছে না। আপনার ওয়ালেট অ্যাপে যা দেখায় তা লিখুন।',
      already_used: 'এই TrxID আগেই ব্যবহৃত হয়েছে।',
      locked: 'অনেকবার ভুল হয়েছে। ১৫ মিনিট পর আবার চেষ্টা করুন।',
      sent_to: 'পাঠান',
      holder: 'নাম',
    },
  };

  let lang = localStorage.getItem('pg_lang') || 'en';
  function t(key, vars) {
    let s = (I18N[lang] && I18N[lang][key]) || I18N.en[key] || key;
    if (vars) for (const k of Object.keys(vars)) s = s.replaceAll('{' + k + '}', vars[k]);
    return s;
  }
  function setLang(l) { lang = l; localStorage.setItem('pg_lang', l); document.documentElement.lang = l === 'bn' ? 'bn' : 'en'; }

  function taka(paisa) {
    const n = (paisa / 100).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
    return '৳' + n;
  }

  function toast(msg) {
    let host = document.getElementById('toasts');
    if (!host) { host = document.createElement('div'); host.id = 'toasts'; document.body.appendChild(host); }
    const el = document.createElement('div'); el.className = 'toast'; el.textContent = msg;
    host.appendChild(el); setTimeout(() => el.remove(), 4000);
  }

  async function copy(text, label) {
    try { await navigator.clipboard.writeText(text); }
    catch {
      const ta = document.createElement('textarea'); ta.value = text; document.body.appendChild(ta);
      ta.select(); document.execCommand('copy'); ta.remove();
    }
    toast(label || t('copied'));
  }

  function esc(s) { return String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])); }

  function fmtDate(iso) { try { return new Date(iso).toLocaleString(); } catch { return iso; } }

  function relTime(iso) {
    if (!iso) return '—';
    const s = Math.floor((Date.now() - new Date(iso).getTime()) / 1000);
    if (s < 60) return s + 's ago'; if (s < 3600) return Math.floor(s / 60) + 'm ago';
    if (s < 86400) return Math.floor(s / 3600) + 'h ago'; return Math.floor(s / 86400) + 'd ago';
  }

  // Theme toggle with persistence
  function initTheme(btnId) {
    const apply = () => {
      const saved = localStorage.getItem('pg_theme');
      if (saved) document.documentElement.setAttribute('data-theme', saved);
    };
    apply();
    const btn = btnId && document.getElementById(btnId);
    if (btn) btn.addEventListener('click', () => {
      const cur = document.documentElement.getAttribute('data-theme') ||
        (matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light');
      const next = cur === 'dark' ? 'light' : 'dark';
      document.documentElement.setAttribute('data-theme', next);
      localStorage.setItem('pg_theme', next);
    });
  }

  return { t, setLang, get lang() { return lang; }, taka, toast, copy, esc, fmtDate, relTime, initTheme, I18N };
})();
