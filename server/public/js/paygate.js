/* paygate.js — merchant popup integration (PRD §4 "Checkout and popup mode").
   Usage:
     <script src="http://localhost:3000/js/paygate.js"></script>
     PayGate.open({ payment_id | pay_url })  → overlay iframe of the hosted pay page
     PayGate.on('paid'|'needs_review'|'expired'|'closed', cb)
   A popup event is never proof of payment — confirm via webhook or GET /v1/payments/:id. */
(function () {
  const PayGate = {
    _handlers: {},
    on(ev, cb) { (this._handlers[ev] = this._handlers[ev] || []).push(cb); return this; },
    _emit(ev, data) { (this._handlers[ev] || []).forEach(cb => cb(data)); },
    open(opts = {}) {
      let url = opts.pay_url;
      if (!url && opts.payment_id) url = `${location.origin}/pay/${opts.payment_id}`;
      if (!url) throw new Error('PayGate.open needs pay_url or payment_id');
      this.close();
      const back = document.createElement('div');
      back.id = '__paygate_overlay';
      back.style.cssText = 'position:fixed;inset:0;background:rgba(10,10,14,.5);z-index:2147483000;display:flex;align-items:center;justify-content:center;padding:16px';
      const box = document.createElement('div');
      box.style.cssText = 'background:#fff;border-radius:16px;width:min(440px,100%);height:min(720px,92vh);overflow:hidden;position:relative;box-shadow:0 24px 64px rgba(0,0,0,.3)';
      const iframe = document.createElement('iframe');
      iframe.src = url; iframe.allow = 'clipboard-write';
      iframe.style.cssText = 'width:100%;height:100%;border:0';
      const x = document.createElement('button');
      x.textContent = '✕';
      x.setAttribute('aria-label', 'Close PayGate');
      x.style.cssText = 'position:absolute;top:8px;right:8px;z-index:2;width:36px;height:36px;border-radius:50%;border:1px solid #E7E7E3;background:#FAFAF9;cursor:pointer;font-size:16px';
      x.onclick = () => PayGate.close('closed');
      box.appendChild(x); box.appendChild(iframe); back.appendChild(box);
      back.addEventListener('click', e => { if (e.target === back) PayGate.close('closed'); });
      document.body.appendChild(back);

      window.addEventListener('message', this._relay = (e) => {
        const d = e.data || {};
        if (!d || d.paygate !== true) return;
        if (['paid', 'needs_review', 'expired', 'cancelled'].includes(d.event)) {
          PayGate._emit(d.event, d);
          setTimeout(() => PayGate.close(d.event), 1200);
        } else if (d.event === 'closed') PayGate.close('closed');
      });
      return this;
    },
    close(reason = 'closed') {
      const el = document.getElementById('__paygate_overlay');
      if (el) { el.remove(); if (this._relay) window.removeEventListener('message', this._relay); this._emit(reason, { reason }); }
      return this;
    },
  };
  window.PayGate = PayGate;
})();
