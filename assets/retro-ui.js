/* ============================================================
 * RetroSesler — Retro UI bildirim sistemi
 * ============================================================
 * Tarayıcı pop-up'ları (alert/confirm/prompt) yerine site
 * temasına uygun (Win2000 mavi gradient) toast + modal.
 *
 * Kullanım:
 *   retroToast('Mesajın!', 'ok' | 'error' | 'warn' | 'info')
 *   await retroConfirm('Emin misin?', { title, okText, cancelText, danger })
 *   await retroPrompt('Şifreyi gir:', { title, placeholder, defaultValue, type: 'text|password|number' })
 *
 * IIFE — global isim alanı: window.retroToast / retroConfirm / retroPrompt
 * ============================================================ */
(function () {
    if (window.retroToast && window.retroConfirm && window.retroPrompt) return; // tek kez yükle

    // ============ CSS — bir kez head'e enjekte ============
    if (!document.getElementById('retro-ui-styles')) {
        const css = `
            #retro-toast-stack {
                position: fixed; bottom: 20px; right: 20px;
                z-index: 99999; display: flex; flex-direction: column-reverse; gap: 8px;
                font-family: Tahoma, Verdana, sans-serif; pointer-events: none;
                max-width: 360px;
            }
            @media (max-width: 600px) {
                #retro-toast-stack {
                    left: 12px; right: 12px; bottom: 12px;
                    max-width: none; align-items: stretch;
                }
            }
            .retro-toast {
                pointer-events: auto;
                background: linear-gradient(180deg, #FAFAF5 0%, #ECE9D8 100%);
                border: 2px solid #A09880;
                border-radius: 6px;
                box-shadow: 3px 4px 12px rgba(0,0,0,0.35), inset 0 1px 0 #fff;
                overflow: hidden;
                opacity: 0; transform: translateY(20px);
                transition: opacity 0.2s, transform 0.2s;
                min-width: 240px;
            }
            .retro-toast.show { opacity: 1; transform: translateY(0); }
            .retro-toast-tb {
                background: linear-gradient(180deg, #4A90D9 0%, #2E6BBF 40%, #1E5AA8 100%);
                color: #fff; font-size: 12px; font-weight: bold;
                padding: 5px 10px;
                display: flex; align-items: center; gap: 8px;
                text-shadow: 1px 1px 1px rgba(0,0,0,0.4);
            }
            .retro-toast-tb .x {
                margin-left: auto; cursor: pointer;
                width: 18px; height: 14px;
                background: linear-gradient(180deg, #E8E4D9, #C8C3B5);
                border: 1px outset #fff; color: #333;
                font-size: 10px; font-weight: bold; line-height: 1;
                display: flex; align-items: center; justify-content: center;
            }
            .retro-toast-tb .x:active { border-style: inset; }
            .retro-toast-body {
                padding: 10px 12px; font-size: 12px; color: #222; line-height: 1.4;
            }
            /* Tip renkleri — titlebar'da accent */
            .retro-toast.ok .retro-toast-tb   { background: linear-gradient(180deg, #5cb85c 0%, #449d44 100%); }
            .retro-toast.warn .retro-toast-tb { background: linear-gradient(180deg, #f0ad4e 0%, #ec971f 100%); }
            .retro-toast.error .retro-toast-tb { background: linear-gradient(180deg, #d9534f 0%, #c9302c 100%); }
            .retro-toast.info .retro-toast-tb  { background: linear-gradient(180deg, #4A90D9 0%, #2E6BBF 100%); }

            /* ============ MODAL (confirm/prompt için) ============ */
            #retro-modal-overlay {
                position: fixed; inset: 0;
                background: rgba(0,0,0,0.45);
                z-index: 100000;
                display: none; align-items: center; justify-content: center;
                font-family: Tahoma, Verdana, sans-serif;
            }
            #retro-modal-overlay.show { display: flex; }
            .retro-modal {
                background: linear-gradient(180deg, #FAFAF5 0%, #ECE9D8 100%);
                border: 2px solid #A09880;
                border-radius: 6px;
                box-shadow: 4px 6px 20px rgba(0,0,0,0.4), inset 0 1px 0 #fff;
                overflow: hidden;
                min-width: min(340px, calc(100vw - 24px));
                max-width: 92vw;
                max-height: 85vh;
                display: flex;
                flex-direction: column;
                animation: retroModalIn 0.15s ease-out;
            }
            @media (max-width: 480px) {
                .retro-modal { min-width: calc(100vw - 16px); max-width: calc(100vw - 16px); max-height: 90vh; }
            }
            @keyframes retroModalIn {
                from { opacity: 0; transform: translateY(-12px) scale(0.96); }
                to   { opacity: 1; transform: translateY(0) scale(1); }
            }
            .retro-modal-tb {
                background: linear-gradient(180deg, #4A90D9 0%, #2E6BBF 40%, #1E5AA8 100%);
                color: #fff; font-size: 12px; font-weight: bold;
                padding: 6px 12px;
                display: flex; align-items: center; gap: 8px;
                text-shadow: 1px 1px 1px rgba(0,0,0,0.4);
                flex: 0 0 auto;
            }
            .retro-modal-tb.danger { background: linear-gradient(180deg, #d9534f 0%, #c9302c 100%); }
            .retro-modal-tb .x {
                margin-left: auto; cursor: pointer;
                width: 18px; height: 14px;
                background: linear-gradient(180deg, #E8E4D9, #C8C3B5);
                border: 1px outset #fff; color: #333;
                font-size: 10px; font-weight: bold; line-height: 1;
                display: flex; align-items: center; justify-content: center;
            }
            .retro-modal-body {
                padding: 18px 18px 14px;
                font-size: 13px; color: #222; line-height: 1.4;
                flex: 1 1 auto;
                overflow-y: auto;
                -webkit-overflow-scrolling: touch;
                min-height: 0;
            }
            .retro-modal-body .retro-msg {
                margin-bottom: 10px;
                white-space: pre-wrap;
                word-break: break-word;
            }
            .retro-modal-body input.retro-input {
                width: 100%;
                padding: 6px 9px;
                font-family: Tahoma; font-size: 13px;
                border: 2px inset #b0b0b0; background: #fff;
                box-sizing: border-box;
                margin-top: 4px;
            }
            .retro-modal-body input.retro-input:focus {
                outline: 1px solid #4A90D9; outline-offset: -1px;
            }
            .retro-modal-actions {
                background: #ECE9D8;
                border-top: 1px solid #A09880;
                padding: 10px 14px;
                display: flex; gap: 8px; justify-content: flex-end;
                flex: 0 0 auto;
                flex-wrap: wrap;
            }
            .retro-modal-btn {
                min-width: 76px;
                padding: 5px 14px;
                font-family: Tahoma, sans-serif; font-size: 12px;
                background: linear-gradient(180deg, #E8E4D9, #C8C3B5);
                border: 2px outset #d4d0c8;
                color: #1a1a1a;
                cursor: pointer;
            }
            .retro-modal-btn:hover { background: linear-gradient(180deg, #F5F2E8, #D8D3C5); }
            .retro-modal-btn:active { border-style: inset; transform: translateY(1px); }
            .retro-modal-btn.primary {
                background: linear-gradient(180deg, #4A90D9, #2E6BBF);
                color: #fff;
                border: 1px solid #1E5AA8;
                font-weight: bold;
            }
            .retro-modal-btn.primary:hover { filter: brightness(1.08); }
            .retro-modal-btn.danger {
                background: linear-gradient(180deg, #d9534f, #c9302c);
                color: #fff;
                border: 1px solid #ac2925;
                font-weight: bold;
            }
            .retro-modal-btn.danger:hover { filter: brightness(1.08); }
        `;
        const style = document.createElement('style');
        style.id = 'retro-ui-styles';
        style.textContent = css;
        document.head.appendChild(style);
    }

    // Toast stack container
    function getToastStack() {
        let s = document.getElementById('retro-toast-stack');
        if (!s) {
            s = document.createElement('div');
            s.id = 'retro-toast-stack';
            document.body.appendChild(s);
        }
        return s;
    }

    function escapeHtml(s) {
        const d = document.createElement('div'); d.textContent = s == null ? '' : String(s); return d.innerHTML;
    }

    const ICONS = { ok: '✅', warn: '⚠️', error: '❌', info: 'ℹ️' };
    const TITLES = { ok: 'Tamam', warn: 'Dikkat', error: 'Hata', info: 'Bilgi' };

    // ============ TOAST ============
    window.retroToast = function (message, type, opts) {
        type = type || 'info';
        opts = opts || {};
        const stack = getToastStack();
        const el = document.createElement('div');
        el.className = 'retro-toast ' + type;
        const title = opts.title || TITLES[type] || 'Bildirim';
        const icon = opts.icon || ICONS[type] || '';
        el.innerHTML = `
            <div class="retro-toast-tb">
                <span>${escapeHtml(icon)} ${escapeHtml(title)}</span>
                <div class="x">×</div>
            </div>
            <div class="retro-toast-body">${escapeHtml(message)}</div>
        `;
        stack.appendChild(el);
        // Trigger animation
        requestAnimationFrame(() => el.classList.add('show'));
        const remove = () => {
            el.classList.remove('show');
            setTimeout(() => el.remove(), 250);
        };
        el.querySelector('.x').addEventListener('click', remove);
        const timeout = opts.sticky ? 0 : (opts.timeout || (type === 'error' ? 5000 : type === 'warn' ? 4000 : 3000));
        if (timeout > 0) setTimeout(remove, timeout);
        return { close: remove, element: el };
    };

    // ============ MODAL CORE (confirm + prompt için) ============
    // window.openModal olarak da expose edilir (room.html host moderasyon menüleri kullanıyor)
    let activeModalResolve = null;
    window.openModal = openModal;
    function openModal({ title, icon, bodyHtml, okText, cancelText, danger, onMount }) {
        // Önceki modal'ı kapat
        if (activeModalResolve) { activeModalResolve(null); activeModalResolve = null; }

        let overlay = document.getElementById('retro-modal-overlay');
        if (!overlay) {
            overlay = document.createElement('div');
            overlay.id = 'retro-modal-overlay';
            document.body.appendChild(overlay);
        }

        return new Promise(resolve => {
            activeModalResolve = resolve;
            const close = (val) => {
                if (activeModalResolve !== resolve) return;
                activeModalResolve = null;
                overlay.classList.remove('show');
                setTimeout(() => { overlay.innerHTML = ''; }, 200);
                resolve(val);
            };
            const safeTitle = escapeHtml(title || 'Onay');
            const safeIcon = escapeHtml(icon || (danger ? '⚠️' : '❓'));
            const safeOk = escapeHtml(okText || 'Tamam');
            const safeCancel = escapeHtml(cancelText || 'Vazgeç');
            overlay.innerHTML = `
                <div class="retro-modal" role="dialog" aria-modal="true">
                    <div class="retro-modal-tb ${danger ? 'danger' : ''}">
                        <span>${safeIcon} ${safeTitle}</span>
                        <div class="x" data-act="cancel">×</div>
                    </div>
                    <div class="retro-modal-body">${bodyHtml}</div>
                    <div class="retro-modal-actions">
                        <button class="retro-modal-btn" data-act="cancel">${safeCancel}</button>
                        <button class="retro-modal-btn ${danger ? 'danger' : 'primary'}" data-act="ok">${safeOk}</button>
                    </div>
                </div>
            `;
            overlay.classList.add('show');
            // Event handlers
            overlay.querySelectorAll('[data-act]').forEach(btn => {
                btn.addEventListener('click', (e) => {
                    e.stopPropagation();
                    if (btn.dataset.act === 'ok') close('__ok__');
                    else close(null);
                });
            });
            overlay.addEventListener('click', (e) => {
                if (e.target === overlay) close(null);
            }, { once: true });
            // ESC kapat, Enter onayla
            const onKey = (e) => {
                if (e.key === 'Escape') { e.preventDefault(); close(null); document.removeEventListener('keydown', onKey); }
                else if (e.key === 'Enter' && !e.shiftKey) {
                    const t = e.target;
                    if (t && t.tagName === 'TEXTAREA') return;
                    e.preventDefault(); close('__ok__'); document.removeEventListener('keydown', onKey);
                }
            };
            document.addEventListener('keydown', onKey);
            // onMount callback (input focus vs için)
            if (typeof onMount === 'function') {
                setTimeout(() => onMount(overlay), 30);
            }
        });
    }

    // ============ CONFIRM ============
    window.retroConfirm = async function (message, opts) {
        opts = opts || {};
        const bodyHtml = `<div class="retro-msg">${escapeHtml(message)}</div>`;
        const res = await openModal({
            title: opts.title || (opts.danger ? 'Dikkat!' : 'Onay'),
            icon: opts.icon,
            bodyHtml,
            okText: opts.okText || (opts.danger ? 'Evet, devam' : 'Tamam'),
            cancelText: opts.cancelText || 'Vazgeç',
            danger: !!opts.danger,
        });
        return res === '__ok__';
    };

    // ============ PROMPT ============
    window.retroPrompt = async function (message, opts) {
        opts = opts || {};
        const inputType = opts.type === 'password' ? 'password' : (opts.type === 'number' ? 'number' : 'text');
        const placeholder = escapeHtml(opts.placeholder || '');
        const defaultVal = escapeHtml(opts.defaultValue || '');
        const bodyHtml = `
            <div class="retro-msg">${escapeHtml(message)}</div>
            <input class="retro-input" type="${inputType}" id="__retro_prompt_input"
                placeholder="${placeholder}" value="${defaultVal}"
                autocomplete="off" spellcheck="false">
        `;
        const res = await openModal({
            title: opts.title || 'Bilgi Gir',
            icon: opts.icon || '✏️',
            bodyHtml,
            okText: opts.okText || 'Tamam',
            cancelText: opts.cancelText || 'Vazgeç',
            onMount: (overlay) => {
                const inp = overlay.querySelector('#__retro_prompt_input');
                if (inp) { inp.focus(); inp.select(); }
            },
        });
        if (res !== '__ok__') return null;
        const inp = document.getElementById('__retro_prompt_input');
        return inp ? inp.value : '';
    };

    // Geriye dönük uyum için kullanıcı izni varsa native alert/confirm/prompt'u override etme
    // (bilinçli override istemeyenler için pasif sun)
})();
