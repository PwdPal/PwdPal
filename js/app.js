/**
 * PwdPal — App Logic (v6 — Streamlined three-screen flow)
 * 
 * Screen 1: Seed input → auto-advance
 * Screen 2: Pattern drawing → auto-advance on completion
 * Screen 3: Domain input + saved domain cards → Generate
 */

const App = (() => {
    let els = {};
    let screens = [];
    let activeIndex = 0;
    let currentPattern = [];
    let userSeed = '';
    let passwordLength = 20;       // default length; a per-site length can override (8–64)
    const LENGTH_MIN = 12, LENGTH_MAX = 64;  // floor 12 per Quinn's gate (ADR-007): below 12 the guarantee-fixup collision can drop a required class until the algorithm-version field lands
    // Clamp a user-entered length to [8,64]; fall back to the default when blank/invalid.
    const clampLength = (v) => {
        const n = parseInt(v, 10);
        return Number.isFinite(n) ? Math.min(LENGTH_MAX, Math.max(LENGTH_MIN, n)) : passwordLength;
    };
    let patternInitialized = false;
    let savedDomains = [];
    let editingDomain = null;  // domain being edited, or null for new
    const APP_VERSION = '1.5.17';

    let domainIdleTimer = null;
    let patternIdleTimer = null;
    let patternHintRevealTimer = null;
    // Last "#..." suffix seen on the editing input — restored when the user
    // re-enables the Rotate toggle, so removing & re-adding doesn't lose a
    // user-typed rotation number.
    let rememberedRotateSuffix = '';

    // When a timed hint (pattern/security) is on screen, this points to its
    // dismiss function. Lets the logo back-button short-circuit the timer:
    // clicking it triggers the same fade-out + navigate path that the timer
    // would have run on completion. Null when no hint is showing.
    let activeHintDismiss = null;

    // Extension popup: true while the post-pattern thumbs-up confirmation
    // overlay is on screen. Used to block back-navigation (logo click and
    // browser-back) so users can't peek behind the overlay at the pattern
    // grid or cards container they came from. Never reset — the popup
    // closes on focus loss and the JS context dies with it.
    let extConfirmationActive = false;

    // PWA install — stash Chrome's deferred install event so we can trigger it
    // from our own footer entry rather than letting Chrome show its auto-banner.
    let deferredInstallPrompt = null;
    window.addEventListener('beforeinstallprompt', (e) => {
        e.preventDefault();
        deferredInstallPrompt = e;
        syncInstallLink();
    });
    window.addEventListener('appinstalled', () => {
        deferredInstallPrompt = null;
        syncInstallLink();
    });

    function isIOSDevice() {
        return /iPad|iPhone|iPod/.test(navigator.userAgent)
            || (navigator.maxTouchPoints > 1 && /Mac/.test(navigator.userAgent));
    }

    function isStandaloneInstalled() {
        return window.matchMedia('(display-mode: standalone)').matches
            || window.navigator.standalone === true;
    }

    function syncInstallLink() {
        const link = document.getElementById('install-link');
        const sep = document.getElementById('install-sep');
        if (!link || !sep) return;
        const visible = !isStandaloneInstalled()
                     && (deferredInstallPrompt !== null || isIOSDevice());
        link.style.display = visible ? '' : 'none';
        sep.style.display = visible ? '' : 'none';
    }

    // "Get the extension" footer CTA → the Chrome Web Store listing. Gated on a
    // URL that is empty until the extension is approved (no live link to a
    // pending listing). Flip EXTENSION_URL to the store URL at approval to
    // reveal it; until then the link and its separator stay hidden. The element
    // is web-only (absent from the extension popup), so this is inert there.
    const EXTENSION_URL = 'https://chromewebstore.google.com/detail/pwdpal/kocdmooghpgeghnfacajppmkjkdefcab';   // live: revealed at Chrome approval (2026-06)
    function syncExtensionLink() {
        const link = document.getElementById('extension-link');
        const sep = document.getElementById('extension-sep');
        if (!link || !sep) return;
        if (EXTENSION_URL) {
            link.href = EXTENSION_URL;
            link.style.display = '';
            sep.style.display = '';
        } else {
            link.style.display = 'none';
            sep.style.display = 'none';
        }
    }

    function showIOSInstallInstructions() {
        const modal = document.createElement('div');
        modal.className = 'install-modal';
        modal.innerHTML = `
            <div class="install-modal-content">
                <h3>Install PwdPal</h3>
                <ol>
                    <li>Tap the <strong>Share</strong> button in Safari's toolbar</li>
                    <li>Scroll and select <strong>Add to Home Screen</strong></li>
                    <li>Tap <strong>Add</strong></li>
                </ol>
                <button class="btn-pill install-modal-close">Got it</button>
            </div>
        `;
        document.body.appendChild(modal);
        const close = () => modal.remove();
        modal.querySelector('.install-modal-close').addEventListener('click', close);
        modal.addEventListener('click', (e) => { if (e.target === modal) close(); });
    }

    const STORAGE_KEYS = {
        seed: 'pwdpal_seed',
        domains: 'pwdpal_domains',
        theme: 'pwdpal_theme',
        genCount: 'pwdpal_gen_count',
        cardCopyCount: 'pwdpal_card_copy_count',
        tipDismissed: 'pwdpal_tip_dismissed',
        hintShown: 'pwdpal_hint_shown',
        securityHintShown: 'pwdpal_security_hint_shown'
    };

    const TIP_THRESHOLD = 30;
    // Master flag for "Support the project" UI — gates the footer link,
    // the tip-banner popup, and the ?tip dev override. Enabled once the
    // Ko-fi account (https://ko-fi.com/pwdpal) was sorted out.
    const SUPPORT_ENABLED = true;
    const IDLE_HINT_DELAY = 3500;
    const EDIT_HINT_REVEAL_DELAY = 2000;
    const MIN_PATTERN_NODES = 3;
    const SECURITY_HINT_THRESHOLD = 4;
    const PATTERN_HINT_SECONDS = 7;
    const SECURITY_HINT_SECONDS = 13;
    // Thumbs-up confirmation overlay ("copied!" / "saved!") timing
    const THUMBS_UP_HOLD_MS = 2000;
    const THUMBS_UP_FADE_OUT_MS = 400;

    const THEMES = ['auto', 'light', 'dark'];
    const THEME_ICONS = {
        auto: '<svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor"><path d="M12 2a10 10 0 1 0 0 20 10 10 0 0 0 0-20zm0 18V4a8 8 0 1 1 0 16z"/></svg>',
        light: '<svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor"><circle cx="12" cy="12" r="5"/><path d="M12 1v2m0 18v2m11-11h-2M3 12H1m16.07-7.07-1.41 1.41M7.34 16.66l-1.41 1.41m12.14 0-1.41-1.41M7.34 7.34 5.93 5.93" stroke="currentColor" stroke-width="2" stroke-linecap="round"/></svg>',
        dark: '<svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor"><path d="M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79z"/></svg>'
    };

    const TEXT = {
        domainSubtitleNew: 'Enter a domain',
        domainSubtitleExisting: 'Select or add a domain',
        domainSubtitleEditing: domain => `Editing ${domain}`,
        seedTip: 'Remember: use a phrase that is unique to you and that you won\'t forget!',
        seedChangeWarning: 'Keep in mind that changing the seed will affect password generation for any saved sites!',
        btnSave: 'Save',
        btnSaved: 'Saved!',
        btnGenerating: '···',
        patternHint: `Connect at least ${MIN_PATTERN_NODES} dots`,
    };

    function init() {
        // Handle /#clear route
        if (window.location.hash === '#clear') {
            localStorage.removeItem(STORAGE_KEYS.seed);
            localStorage.removeItem(STORAGE_KEYS.domains);
            localStorage.removeItem(STORAGE_KEYS.theme);
            window.location.hash = '#seed';
            window.location.reload();
            return;
        }

        // Tidy the address bar for visitors who arrived via a shared link
        // (drops the ?ref tag once it's already been measured server-side).
        stripShareRefFromUrl();

        // Init theme before DOM queries
        initTheme();

        els = {
            slides: document.getElementById('slides'),

            screenSeed: document.getElementById('screen-seed'),
            screenPattern: document.getElementById('screen-pattern'),
            screenDomain: document.getElementById('screen-domain'),

            seedInput: document.getElementById('seed-input'),
            seedContinue: document.getElementById('seed-continue'),

            patternContainer: document.getElementById('pattern-grid'),
            patternHint: document.getElementById('pattern-hint'),

            domainInputArea: document.getElementById('domain-input-area'),
            domainSubtitle: document.getElementById('domain-subtitle'),
            domainInput: document.getElementById('domain-input'),
            counterInput: document.getElementById('counter-input'),
            domainCards: document.getElementById('domain-cards'),
            generateBtn: document.getElementById('generate-btn'),

            ruleUppercase: document.getElementById('rule-uppercase'),
            ruleDigits: document.getElementById('rule-digits'),
            ruleSymbols: document.getElementById('rule-symbols'),
            ruleLength: document.getElementById('rule-length'),

            changeSeedLink: document.getElementById('config-change-seed'),
            themeToggle: document.getElementById('theme-toggle'),
            themeIcon: document.querySelector('#theme-toggle .theme-icon'),
            themeLabel: document.querySelector('#theme-toggle .theme-label')
        };

        screens = [els.screenSeed, els.screenPattern, els.screenDomain];

        // Load saved domains
        loadDomains();

        // Position the lock icon next to the text
        const logoSvg = document.querySelector('.logo-img');
        const logoText = logoSvg?.querySelector('text');
        const logoLock = logoSvg?.querySelector('.logo-lock');
        if (logoSvg && logoText && logoLock) {
            requestAnimationFrame(() => {
                const textBox = logoText.getBBox();
                const lockScale = 0.5;
                const lockW = 40 * lockScale;
                const lockX = textBox.x + textBox.width + 2;
                const lockY = textBox.y + textBox.height - (48 * lockScale);
                logoLock.setAttribute('transform', `translate(${lockX}, ${lockY}) scale(${lockScale})`);
                const totalW = lockX + lockW + 2;
                const totalH = Math.max(textBox.height + 4, 50);
                logoSvg.setAttribute('viewBox', `${textBox.x} ${textBox.y - 2} ${totalW - textBox.x} ${totalH}`);
            });
        }

        // Make logo clickable to go back to pattern from domain screen,
        // or from the seed screen when the user is changing an existing seed
        // (first-time setup has no pattern screen to return to yet).
        const logoDiv = document.querySelector('.logo');
        if (logoDiv) {
            logoDiv.addEventListener('click', () => {
                // Block back-navigation while the extension thumbs-up
                // overlay is on screen — otherwise the pattern grid /
                // cards container the user came from peek through
                // behind the overlay.
                if (extConfirmationActive) return;
                // If a timed hint is up, treat the back button as "expedite":
                // run its dismiss (fade out + navigate + restoreUI) immediately.
                if (activeHintDismiss) {
                    activeHintDismiss();
                    return;
                }
                if (activeIndex === 2) {
                    goToScreen(1, true);
                } else if (activeIndex === 0 && userSeed !== '') {
                    goToScreen(1, true);
                }
            });
        }

        // Determine starting screen (use replaceState, not pushState)
        // Suppress transitions on initial load
        els.slides.classList.add('no-transition');
        const storedSeed = localStorage.getItem(STORAGE_KEYS.seed);
        if (storedSeed) {
            userSeed = storedSeed;
            // Returning user — hide the tagline
            const tagline = document.getElementById('logo-tagline');
            if (tagline) tagline.classList.add('hidden');
            initPattern();
            goToScreen(1, false, false);
        } else {
            // First visit — hide "Change seed" option
            els.changeSeedLink.style.display = 'none';
            goToScreen(0, false, false);
            setTimeout(() => els.seedInput.focus(), 100);
            initSeedTipReveal();
        }
        requestAnimationFrame(() => {
            requestAnimationFrame(() => {
                els.slides.classList.remove('no-transition');
            });
        });

        // Recalculate slide height after fonts are fully loaded
        document.fonts.ready.then(() => refreshSlideHeight());

        // Re-check compact card mode on viewport resize
        let resizeTimer;
        window.addEventListener('resize', () => {
            clearTimeout(resizeTimer);
            resizeTimer = setTimeout(() => {
                checkCompactCards();
                refreshSlideHeight();
            }, 100);
        });

        // Browser back/forward
        window.addEventListener('popstate', onPopState);

        // ── Seed screen events ──
        els.seedInput.addEventListener('input', () => {
            els.seedContinue.disabled = els.seedInput.value.trim().length === 0;
        });
        els.seedContinue.addEventListener('click', onSeedSubmit);
        els.seedInput.addEventListener('keydown', (e) => {
            if (e.key === 'Enter' && !els.seedContinue.disabled) onSeedSubmit();
        });

        // Disable Tab key globally to prevent focus-related UI issues
        document.addEventListener('keydown', (e) => {
            if (e.key === 'Tab') e.preventDefault();
        });

        // ── Domain screen events ──
        els.domainInput.addEventListener('input', () => {
            updateGenerateState();
            syncRotateButton();
        });
        els.generateBtn.addEventListener('click', generatePassword);

        // ── Per-site length control: collapse to "len" at the default value,
        // reveal the number on focus or whenever a non-default length is set. ──
        if (els.ruleLength) {
            els.ruleLength.addEventListener('input', updateLengthDisplay);
            updateLengthDisplay();
        }

        // ── Install app (footer) ──
        const installLink = document.getElementById('install-link');
        if (installLink) {
            installLink.addEventListener('click', async () => {
                if (deferredInstallPrompt) {
                    deferredInstallPrompt.prompt();
                    try { await deferredInstallPrompt.userChoice; } catch (_) {}
                    deferredInstallPrompt = null;
                    syncInstallLink();
                } else if (isIOSDevice()) {
                    showIOSInstallInstructions();
                }
            });
        }
        syncInstallLink();

        // ── Get the extension (footer, gated until Web Store approval) ──
        syncExtensionLink();

        // ── Support the project (footer) ──
        if (!SUPPORT_ENABLED) {
            const supportLink = document.getElementById('support-link');
            const supportSep = document.getElementById('support-sep');
            if (supportLink) supportLink.style.display = 'none';
            if (supportSep) supportSep.style.display = 'none';
        }

        // ── Share PwdPal (footer) ──
        const shareLink = document.getElementById('share-link');
        if (shareLink) {
            shareLink.addEventListener('click', () => sharePwdPal(shareLink));
        }

        // ── Rotate toggle (in editing form) ──
        // Off → adds suffix (restoring the last remembered one, or "#1" by default).
        // On  → removes the current suffix, but remembers it so a re-toggle restores it.
        const rotateBtn = document.getElementById('rotate-btn');
        if (rotateBtn) {
            rotateBtn.addEventListener('click', () => {
                const value = els.domainInput.value || '';
                const hashIdx = value.indexOf('#');
                if (hashIdx === -1) {
                    const suffix = rememberedRotateSuffix || '#1';
                    els.domainInput.value = value + suffix;
                } else {
                    rememberedRotateSuffix = value.slice(hashIdx);
                    els.domainInput.value = value.slice(0, hashIdx);
                }
                updateGenerateState();
                syncRotateButton();
                els.domainInput.focus();
            });
        }
        els.domainInput.addEventListener('keydown', (e) => {
            if (e.key === 'Enter' && !els.generateBtn.disabled) generatePassword();
            if (e.key === 'Escape') {
                e.preventDefault();
                editingDomain = null;
                els.domainInput.value = '';
                updateGenerateState();
                els.domainInputArea.classList.add('collapsed');
                els.domainSubtitle.textContent = savedDomains.length > 0
                    ? TEXT.domainSubtitleExisting
                    : TEXT.domainSubtitleNew;
                // Remove any placeholder classes left on cards
                els.domainCards.querySelectorAll('.domain-card-placeholder').forEach(c => {
                    c.classList.remove('domain-card-placeholder');
                    c.style.cssText = '';
                });
                refreshSlideHeight();
            }
        });

        // ── Settings dropdown ──
        const settingsEl = document.getElementById('settings');
        const settingsBtn = document.getElementById('settings-btn');
        settingsBtn.addEventListener('click', (e) => {
            e.stopPropagation();
            settingsEl.classList.toggle('open');
        });
        document.addEventListener('click', (e) => {
            if (!settingsEl.contains(e.target)) {
                settingsEl.classList.remove('open');
            }
        });

        // ── Change seed (in settings) ──
        els.changeSeedLink.addEventListener('click', () => {
            settingsEl.classList.remove('open');
            els.seedInput.value = userSeed;
            els.seedContinue.disabled = false;
            els.seedContinue.textContent = 'Save';
            const tipEl = document.querySelector('.seed-tip');
            const tipText = document.getElementById('seed-tip-text');
            if (tipText) {
                tipText.innerHTML = `${TEXT.seedChangeWarning} <a href="how-it-works.html" target="_blank" rel="noopener">How it works ↗</a>`;
            }
            if (tipEl) tipEl.classList.add('visible');
            goToScreen(0, true);
            setTimeout(() => els.seedInput.focus(), 400);
        });

        // ── Theme toggle (in settings) ──
        els.themeToggle.addEventListener('click', () => {
            cycleTheme();
            // Keep menu open so user can see the change
        });
        // Sync button text with saved theme
        const savedTheme = localStorage.getItem(STORAGE_KEYS.theme) || 'auto';
        els.themeIcon.innerHTML = THEME_ICONS[savedTheme];
        els.themeLabel.textContent = savedTheme;

        updateGenerateState();
        initTipBanner();

        // Dev: ?tip forces the tip banner (respects SUPPORT_ENABLED)
        if (SUPPORT_ENABLED && new URLSearchParams(window.location.search).has('tip')) {
            document.getElementById('tip-banner')?.classList.add('visible');
        }

    }

    // ═══════════════════════════════
    // Screen navigation
    // ═══════════════════════════════

    const SCREEN_NAMES = ['seed', 'pattern', 'domain'];

    function goToScreen(index, animate, pushHistory = true) {
        activeIndex = index;

        if (animate) {
            animateHeight(screens[index]);
        }

        screens.forEach((screen, i) => {
            screen.classList.remove('active', 'left', 'right');
            if (i === index) {
                screen.classList.add('active');
            } else if (i < index) {
                screen.classList.add('left');
            } else {
                screen.classList.add('right');
            }
        });

        // Show back chevron on domain screen, or on the seed screen when
        // the user has an existing seed (i.e. the change-seed flow)
        document.getElementById('logo')?.classList.toggle('show-back', index === 2 || (index === 0 && userSeed !== ''));

        if (!animate) {
            requestAnimationFrame(() => {
                els.slides.style.height = (screens[index].scrollHeight + 2) + 'px';
            });
        }

        // Update browser history
        const hash = '#' + SCREEN_NAMES[index];
        if (pushHistory) {
            history.pushState({ screen: index }, '', hash);
        } else {
            history.replaceState({ screen: index }, '', hash);
        }

        // Close settings menu on screen change
        document.getElementById('settings')?.classList.remove('open');

        // Clear pattern whenever returning to pattern screen
        if (index === 1 && patternInitialized) {
            currentPattern = [];
            PatternLock.reset();
            if (els.patternHint) els.patternHint.classList.remove('hidden');
        }

        // Pattern subtitle + hint: hide for experienced users, fade in after idle.
        // Bottom hint is always revealed EDIT_HINT_REVEAL_DELAY after the top.
        if (patternIdleTimer) { clearTimeout(patternIdleTimer); patternIdleTimer = null; }
        if (patternHintRevealTimer) { clearTimeout(patternHintRevealTimer); patternHintRevealTimer = null; }
        const patternSubtitle = document.getElementById('pattern-subtitle');
        if (index === 1 && patternSubtitle) {
            const genCount = parseInt(localStorage.getItem(STORAGE_KEYS.genCount) || '0', 10);
            const scheduleHintReveal = () => {
                patternHintRevealTimer = setTimeout(() => {
                    patternHintRevealTimer = null;
                    if (els.patternHint) els.patternHint.classList.remove('subtitle-hidden');
                }, EDIT_HINT_REVEAL_DELAY);
            };
            if (els.patternHint) els.patternHint.classList.add('subtitle-hidden');
            if (genCount >= 3) {
                patternSubtitle.classList.add('subtitle-hidden');
                patternIdleTimer = setTimeout(() => {
                    patternSubtitle.classList.remove('subtitle-hidden');
                    scheduleHintReveal();
                }, IDLE_HINT_DELAY);
            } else {
                patternSubtitle.classList.remove('subtitle-hidden');
                scheduleHintReveal();
            }
        }

        // Domain subtitle: hide for experienced users, fade in after 5s idle
        if (domainIdleTimer) { clearTimeout(domainIdleTimer); domainIdleTimer = null; }
        if (index === 2) {
            const genCount = parseInt(localStorage.getItem(STORAGE_KEYS.genCount) || '0', 10);
            // Update text based on saved domains. In extension filtered-cards
            // mode, the subtitle becomes a disambiguation prompt instead.
            if (window.pwdpalFilteredHost) {
                els.domainSubtitle.textContent = `Pick an identity for ${window.pwdpalFilteredHost}`;
                els.domainSubtitle.classList.remove('subtitle-hidden');
            } else {
                els.domainSubtitle.textContent = savedDomains.length > 0
                    ? TEXT.domainSubtitleExisting
                    : TEXT.domainSubtitleNew;
            }
            if (!window.pwdpalFilteredHost && genCount >= 3) {
                els.domainSubtitle.classList.add('subtitle-hidden');
                domainIdleTimer = setTimeout(() => {
                    els.domainSubtitle.classList.remove('subtitle-hidden');
                    syncEditHint();
                }, IDLE_HINT_DELAY);
            } else {
                els.domainSubtitle.classList.remove('subtitle-hidden');
            }
            syncEditHint();
        }
    }

    // "Hold to edit" hint below the cards — visible only when the domain
    // subtitle is visible AND there are saved cards to edit. Reveal is delayed
    // by EDIT_HINT_REVEAL_DELAY so the bottom hint appears as a follow-up beat
    // after the top hint, rather than simultaneously.
    let editHintRevealTimer = null;
    function syncEditHint() {
        const editHint = document.getElementById('domain-edit-hint');
        if (!editHint) return;
        const subtitleHidden = els.domainSubtitle.classList.contains('subtitle-hidden');
        // In extension filtered-cards mode, editing isn't available — hide
        // the "Hold to edit" hint regardless of other state.
        const shouldHide = subtitleHidden || savedDomains.length === 0 || !!window.pwdpalFilteredHost;

        if (editHintRevealTimer) {
            clearTimeout(editHintRevealTimer);
            editHintRevealTimer = null;
        }

        if (shouldHide) {
            editHint.classList.add('subtitle-hidden');
            return;
        }

        // Only schedule the delayed reveal if it's currently hidden. Repeated
        // syncs while already-visible should be a no-op rather than re-fading.
        if (editHint.classList.contains('subtitle-hidden')) {
            editHintRevealTimer = setTimeout(() => {
                editHintRevealTimer = null;
                // Re-check in case state changed during the delay
                const stillEligible = !els.domainSubtitle.classList.contains('subtitle-hidden')
                                   && savedDomains.length > 0;
                if (stillEligible) editHint.classList.remove('subtitle-hidden');
            }, EDIT_HINT_REVEAL_DELAY);
        }
    }

    function onPopState(e) {
        // While the extension confirmation overlay is up, swallow browser
        // back. Re-push the current screen so the address bar stays in
        // sync with what's on screen.
        if (extConfirmationActive) {
            history.pushState({ screen: activeIndex }, '', '#' + SCREEN_NAMES[activeIndex]);
            return;
        }
        if (e.state && typeof e.state.screen === 'number') {
            const target = e.state.screen;
            // Block history navigation to domain — it's not a navigable screen
            if (target === 2) {
                history.replaceState({ screen: 1 }, '', '#pattern');
                if (activeIndex !== 1) goToScreen(1, false, false);
                return;
            }
            goToScreen(target, true, false);
        } else {
            // No state — user hit back past our first entry.
            // Push them back to the current screen to stay in the app.
            const hash = window.location.hash.replace('#', '');
            const idx = SCREEN_NAMES.indexOf(hash);
            goToScreen(idx >= 0 ? idx : activeIndex, false, false);
            history.pushState({ screen: activeIndex }, '', '#' + SCREEN_NAMES[activeIndex]);
        }
    }

    function animateHeight(targetSlide) {
        const orig = {
            position: targetSlide.style.position,
            visibility: targetSlide.style.visibility,
            opacity: targetSlide.style.opacity
        };
        targetSlide.style.position = 'relative';
        targetSlide.style.visibility = 'hidden';
        targetSlide.style.opacity = '0';
        const targetHeight = targetSlide.scrollHeight;
        targetSlide.style.position = orig.position;
        targetSlide.style.visibility = orig.visibility;
        targetSlide.style.opacity = orig.opacity;

        els.slides.style.height = els.slides.scrollHeight + 'px';
        els.slides.offsetHeight; // force reflow
        els.slides.style.height = targetHeight + 'px';
    }

    // ═══════════════════════════════
    // Seed
    // ═══════════════════════════════

    function onSeedSubmit() {
        const seed = els.seedInput.value.trim();
        if (!seed) return;
        const isChange = userSeed !== '';
        userSeed = seed;
        localStorage.setItem(STORAGE_KEYS.seed, seed);
        els.changeSeedLink.style.display = '';
        initPattern();
        if (isChange) {
            els.seedInput.blur();
            showSeedSavedConfirmation();
        } else {
            goToScreen(1, true);
        }
    }

    function showSeedSavedConfirmation() {
        const screen = document.getElementById('screen-seed');
        const searchBar = screen.querySelector('.search-bar');
        const tip = screen.querySelector('.seed-tip');

        const fadeTargets = [searchBar, tip].filter(Boolean);
        fadeTargets.forEach(el => {
            el.style.transition = 'opacity 0.25s ease-out';
            el.style.opacity = '0';
        });

        const settingsEl = document.getElementById('settings');
        settingsEl?.classList.add('confirmation-hidden');

        const screenRect = screen.getBoundingClientRect();
        const confirmation = document.createElement('div');
        Object.assign(confirmation.style, {
            position: 'fixed',
            left: screenRect.left + 'px',
            top: (screenRect.top + 20) + 'px',
            width: screenRect.width + 'px',
            display: 'flex',
            flexDirection: 'column',
            alignItems: 'center',
            justifyContent: 'flex-start',
            zIndex: '10',
            pointerEvents: 'none',
            opacity: '0',
            transform: 'scale(0.8)',
            transition: 'opacity 0.25s ease-out, transform 0.25s ease-out'
        });
        confirmation.innerHTML = `
            <svg width="160" height="160" viewBox="0 0 24 24" fill="#b0b0b0" style="flex-shrink: 0; min-width: 160px; min-height: 160px;" xmlns="http://www.w3.org/2000/svg">
                <path d="M2 20h2c.55 0 1-.45 1-1v-9c0-.55-.45-1-1-1H2v11zm19.83-7.12c.11-.25.17-.52.17-.8V11c0-1.1-.9-2-2-2h-5.5l.92-4.65c.05-.22.02-.46-.08-.66-.23-.45-.52-.86-.88-1.22L14 2 7.59 8.41C7.21 8.79 7 9.3 7 9.83v7.84C7 18.95 8.05 20 9.34 20h8.11c.7 0 1.36-.37 1.72-.97l2.66-6.15z"/>
            </svg>
            <div style="font-size: 20px; font-weight: 700; color: #b0b0b0; margin-top: 10px; font-family: var(--font); letter-spacing: 0.5px;">saved!</div>
        `;
        document.body.appendChild(confirmation);
        void confirmation.offsetHeight;

        setTimeout(() => {
            confirmation.style.opacity = '1';
            confirmation.style.transform = 'scale(1)';
        }, 100);

        setTimeout(() => {
            confirmation.style.transition = `opacity ${THUMBS_UP_FADE_OUT_MS}ms ease-out`;
            confirmation.style.opacity = '0';
            setTimeout(() => {
                confirmation.remove();
                settingsEl?.classList.remove('confirmation-hidden');
                goToScreen(1, true);
                setTimeout(() => {
                    fadeTargets.forEach(el => {
                        el.style.transition = '';
                        el.style.opacity = '';
                    });
                }, 450);
            }, THUMBS_UP_FADE_OUT_MS);
        }, THUMBS_UP_HOLD_MS);
    }

    // ═══════════════════════════════
    // Pattern
    // ═══════════════════════════════

    function initPattern() {
        if (!patternInitialized) {
            PatternLock.init(els.patternContainer, onPatternComplete);
            PatternLock.setMinNodes(MIN_PATTERN_NODES);
            if (els.patternHint) els.patternHint.textContent = TEXT.patternHint;
            PatternLock.onDrawStart(() => {
                if (patternIdleTimer) { clearTimeout(patternIdleTimer); patternIdleTimer = null; }
                if (patternHintRevealTimer) { clearTimeout(patternHintRevealTimer); patternHintRevealTimer = null; }
            });
            PatternLock.onReject(() => {
                if (patternHintRevealTimer) { clearTimeout(patternHintRevealTimer); patternHintRevealTimer = null; }
                const patternSubtitle = document.getElementById('pattern-subtitle');
                if (patternSubtitle) patternSubtitle.classList.remove('subtitle-hidden');
                if (els.patternHint) els.patternHint.classList.remove('subtitle-hidden');
            });
            patternInitialized = true;
        }
    }

    function onPatternComplete(pattern) {
        currentPattern = pattern;
        updateGenerateState();

        // Auto-advance to domain screen after brief pause
        setTimeout(() => {
            // Extension fast-path: if we know the active tab's hostname and
            // there are zero or one saved cards for it, generate the password
            // immediately rather than showing the cards UI. Multi-card cases
            // (and the web app) fall through to the normal domain screen.
            if (window.pwdpalIsExtension && window.pwdpalActiveHost) {
                const matches = savedDomains.filter(d => baseHostname(d.domain) === window.pwdpalActiveHost);
                if (matches.length === 0) {
                    extensionAutoGenerate(window.pwdpalActiveHost, {
                        length: passwordLength,
                        uppercase: true,
                        digits: true,
                        symbols: true
                    });
                    return;
                }
                if (matches.length === 1) {
                    const m = matches[0];
                    extensionAutoGenerate(m.domain, {
                        length: m.length || passwordLength,
                        uppercase: m.uppercase,
                        digits: m.digits,
                        symbols: m.symbols
                    });
                    return;
                }
                // 2+ matches: show a filtered cards page restricted to the
                // active hostname. Re-render to apply the filter, then
                // navigate. renderDomainCards reads window.pwdpalFilteredHost
                // and strips the Add button / drag / long-press wiring.
                window.pwdpalFilteredHost = window.pwdpalActiveHost;
                renderDomainCards();
            }
            activeIndex = 2;
            onDomainScreenEnter();
            goToScreen(2, true);
        }, 300);
    }

    // Extension popup: generate password for the given domain, copy it,
    // show the thumbs-up overlay anchored over `explodeEl` (whose contents
    // will burst into smoke and clear the space for the overlay).
    // explodeEl defaults to the pattern grid (auto-generate from pattern
    // screen); for the filtered-cards path, it's the cards container.
    // opts.rotate=true bumps the domain to the next available rotation
    // and persists it as a new card — used by the "Rotate →" link in
    // the overlay so the user can ask for a fresh password after the
    // fact instead of pre-committing before drawing the pattern.
    // Core extension-mode generation work: apply rotation, derive password,
    // copy to clipboard, fill the focused field, bump the counter. Returns
    // the resolved domain. Split out from extensionAutoGenerate so the
    // in-overlay rotation animation can sequence it against a deliberate
    // pause without showConfirmation firing prematurely.
    async function performExtensionGeneration(domain, rules, opts) {
        opts = opts || {};
        let finalDomain = domain;
        if (opts.rotate) {
            finalDomain = nextAvailableRotation(domain);
            savedDomains.unshift({
                domain: finalDomain,
                uppercase: rules.uppercase,
                digits: rules.digits,
                symbols: rules.symbols,
                length: rules.length || passwordLength
            });
            saveDomains();
        }
        const password = await PwdCrypto.generate({
            pattern: currentPattern,
            seed: userSeed,
            domain: finalDomain,
            counter: 1,
            rules
        });
        await navigator.clipboard.writeText(password);
        // Best-effort: also write the password directly into the active
        // page's focused password field (skipped silently if no such
        // field is focused, or if the popup-glue helper isn't loaded).
        // Clipboard is always written so the user can paste manually
        // when the page has no focused password input.
        if (typeof window.pwdpalFillActiveField === 'function') {
            window.pwdpalFillActiveField(password);
        }
        trackGeneration();
        return finalDomain;
    }

    async function extensionAutoGenerate(domain, rules, explodeEl, opts) {
        opts = opts || {};
        try {
            const finalDomain = await performExtensionGeneration(domain, rules, opts);
            showExtensionAutoGenerateConfirmation(finalDomain, false, explodeEl, rules, !!opts.rotate);
            // No explicit auto-close — Chrome already closes the popup on
            // focus loss, which fires the moment the user clicks into the
            // page to paste. Letting that natural dismissal handle things
            // avoids racing with Chrome and keeps the popup until the user
            // is ready to move on.
        } catch (err) {
            console.error('Extension auto-generate failed:', err);
            showExtensionAutoGenerateConfirmation(domain, /* failed */ true, explodeEl, rules, !!opts.rotate);
        }
    }

    // Append a progress ring SVG enveloping the entire content stack
    // (thumbs-up + headline + domain) inside the confirmation overlay.
    // Sized from the union bounding rect of the three child elements
    // plus a small padding, so the ring grows or shrinks with the text.
    // The ring fills clockwise over `durationMs` ms. Returns the ring
    // element so the caller can remove it after the animation completes.
    //
    // Options (all optional):
    //   bare:        skip the static track circle, so only the animated
    //                arc is rendered (no background "groove" to follow)
    //   stroke:      stroke color for the animated arc (CSS value)
    //   strokeWidth: stroke width in pixels
    //   startAt:     'top' (12 o'clock, default) or 'bottom' (6 o'clock)
    function injectRotatingRing(overlayEl, durationMs, opts) {
        opts = opts || {};
        const bare = !!opts.bare;
        const stroke = opts.stroke || 'var(--brand)';
        const strokeWidth = opts.strokeWidth || 3;
        const startAt = opts.startAt || 'top';

        const children = ['.ext-thumbs', '.ext-headline', '.ext-domain']
            .map(sel => overlayEl.querySelector(sel))
            .filter(Boolean);
        if (children.length === 0) return null;

        const rects = children.map(el => el.getBoundingClientRect());
        const left = Math.min(...rects.map(r => r.left));
        const right = Math.max(...rects.map(r => r.right));
        const top = Math.min(...rects.map(r => r.top));
        const bottom = Math.max(...rects.map(r => r.bottom));
        const contentW = right - left;
        const contentH = bottom - top;
        const cx = (left + right) / 2;
        const cy = (top + bottom) / 2;

        // The ring must enclose the content's bounding rect; diameter
        // equal to the rect's diagonal is the smallest circle that
        // covers all four corners. The padding adds breathing room
        // between the corners and the ring stroke.
        const padding = 22;
        const ringSize = Math.ceil(Math.hypot(contentW, contentH)) + padding * 2;
        const radius = (ringSize - strokeWidth) / 2;
        const circumference = 2 * Math.PI * radius;

        // SVG <circle> paths start at 3 o'clock. The base rotation of
        // -90deg moves the start to 12 o'clock (standard progress
        // rings); +90deg moves it to 6 o'clock for the "starts at the
        // bottom" variant.
        const svgRotation = startAt === 'bottom' ? 90 : -90;

        const ring = document.createElement('div');
        ring.id = 'ext-rotation-ring';
        Object.assign(ring.style, {
            position: 'fixed',
            left: (cx - ringSize / 2) + 'px',
            // Nudge down 10px — the union bounding rect is taller than
            // it is wide (text stack below the thumbs-up), so a circle
            // centered on the rect's geometric center sits a touch
            // higher than feels right against the thumbs-up.
            top: (cy - ringSize / 2 + 10) + 'px',
            width: ringSize + 'px',
            height: ringSize + 'px',
            zIndex: '11',
            pointerEvents: 'none'
        });
        const trackCircle = bare
            ? ''
            : `<circle cx="${ringSize / 2}" cy="${ringSize / 2}" r="${radius}" fill="none" stroke="var(--border)" stroke-width="${strokeWidth}"/>`;
        ring.innerHTML = `
            <svg width="${ringSize}" height="${ringSize}" viewBox="0 0 ${ringSize} ${ringSize}" style="transform: rotate(${svgRotation}deg);">
                ${trackCircle}
                <circle class="ext-rotate-ring" cx="${ringSize / 2}" cy="${ringSize / 2}" r="${radius}" fill="none" stroke="${stroke}" stroke-width="${strokeWidth}" stroke-linecap="round" style="stroke-dasharray: ${circumference}; stroke-dashoffset: ${circumference}; transition: stroke-dashoffset ${durationMs}ms linear;"/>
            </svg>
        `;
        document.body.appendChild(ring);

        // Kick the dashoffset animation on the next frame so the
        // transition actually animates (starting value must be applied
        // first).
        requestAnimationFrame(() => {
            const animRing = ring.querySelector('.ext-rotate-ring');
            if (animRing) animRing.style.strokeDashoffset = '0';
        });
        return ring;
    }

    function showExtensionAutoGenerateConfirmation(domain, failed, explodeEl, rules, wasRotated) {
        // Reuse an existing overlay when the user re-rotates from inside
        // it — that way we just refresh the domain text without tearing
        // the success state down and re-fading it in.
        let confirmation = document.getElementById('ext-auto-gen-overlay');
        const firstTime = !confirmation;

        if (firstTime) {
            // Hide pattern subtitle + hint so the overlay stands alone
            const patternSubtitle = document.getElementById('pattern-subtitle');
            if (patternSubtitle) patternSubtitle.classList.add('subtitle-hidden');
            const patternHint = document.getElementById('pattern-hint');
            if (patternHint) patternHint.classList.add('hidden');
            // Hide cards-page chrome too (in case we came from filtered-cards)
            if (els && els.domainSubtitle) els.domainSubtitle.classList.add('subtitle-hidden');
            const editHint = document.getElementById('domain-edit-hint');
            if (editHint) editHint.classList.add('subtitle-hidden');
            // Hide the back chevron — it's still on because the filtered-cards
            // flow leaves us on screen index 2. With the overlay covering
            // everything else, a lone chevron at the top reads as broken
            // navigation. The popup auto-closes on focus loss so we don't
            // bother restoring it.
            document.getElementById('logo')?.classList.remove('show-back');
            // Hide the settings gear — the overlay claims the screen and
            // a lone gear in the corner reads as a stray interactive
            // element. The popup auto-closes so no restore is needed.
            document.getElementById('settings')?.classList.add('confirmation-hidden');
            // Block back-navigation while the overlay is up — the logo
            // click handler and popstate guard both read this flag.
            extConfirmationActive = true;

            const anchorEl = explodeEl || document.getElementById('pattern-grid');
            // Capture the pre-transform rect BEFORE kicking off dustExplode —
            // once the transform is applied, getBoundingClientRect would
            // report the scaled-down geometry instead of where the element
            // used to be.
            const rect = anchorEl
                ? anchorEl.getBoundingClientRect()
                : { left: 0, top: 0, width: window.innerWidth, height: 240 };

            // Anchor the overlay a fixed distance below the logo rather
            // than to the source element. This keeps the thumbs-up at a
            // stable Y position even when the rotate button explodes and
            // removes a row of content — flex-start (below) means the
            // stack grows downward instead of re-centering.
            const logoRect = document.getElementById('logo')?.getBoundingClientRect();
            const overlayTop = logoRect ? logoRect.bottom + 60 : rect.top;

            // Burst the source element into smoke + shrink/fade it.
            if (anchorEl) {
                dustExplode(anchorEl, null);
            }

            confirmation = document.createElement('div');
            confirmation.id = 'ext-auto-gen-overlay';
            Object.assign(confirmation.style, {
                position: 'fixed',
                left: rect.left + 'px',
                top: overlayTop + 'px',
                width: rect.width + 'px',
                display: 'flex',
                flexDirection: 'column',
                alignItems: 'center',
                justifyContent: 'flex-start',
                zIndex: '10',
                pointerEvents: 'none',
                opacity: '0',
                transform: 'scale(0.85)',
                transition: 'opacity 0.25s ease-out, transform 0.25s ease-out'
            });
            document.body.appendChild(confirmation);
        }

        // Build the domain text node with the rotation suffix as a superscript,
        // reusing the same visual language as the card labels.
        const hashIdx = domain.indexOf('#');
        const base = hashIdx === -1 ? domain : domain.slice(0, hashIdx);
        const rotation = hashIdx === -1 ? '' : domain.slice(hashIdx + 1);
        const rotationHtml = rotation
            ? `<sup class="domain-rotation-token">${rotation}</sup>`
            : '';

        const headline = failed ? 'failed.' : 'copied!';
        // Rotate button only on the first (non-rotated) confirmation —
        // after a rotation, the rotated card has been persisted and the
        // user has the password; further bumps would be on a brand-new
        // popup session, not this one.
        const showRotate = !failed && !wasRotated;
        confirmation.innerHTML = `
            <svg class="ext-thumbs" width="120" height="120" viewBox="0 0 24 24" fill="#909090" style="flex-shrink: 0;" xmlns="http://www.w3.org/2000/svg">
                <path d="M2 20h2c.55 0 1-.45 1-1v-9c0-.55-.45-1-1-1H2v11zm19.83-7.12c.11-.25.17-.52.17-.8V11c0-1.1-.9-2-2-2h-5.5l.92-4.65c.05-.22.02-.46-.08-.66-.23-.45-.52-.86-.88-1.22L14 2 7.59 8.41C7.21 8.79 7 9.3 7 9.83v7.84C7 18.95 8.05 20 9.34 20h8.11c.7 0 1.36-.37 1.72-.97l2.66-6.15z"/>
            </svg>
            <div class="ext-headline" style="font-size: 20px; font-weight: 700; color: #909090; margin-top: 14px; font-family: var(--font); letter-spacing: 0.5px;">${headline}</div>
            <div class="ext-domain" style="font-size: 13px; font-weight: 700; color: #909090; margin-top: 12px; font-family: var(--font); letter-spacing: 0.5px; text-align: center;">${base}${rotationHtml}</div>
            ${showRotate ? '<button type="button" class="btn-pill ext-rotate-btn">Rotate</button>' : ''}
        `;

        const rotateBtn = confirmation.querySelector('.ext-rotate-btn');
        if (rotateBtn) {
            // Fade the button in slightly after the rest so it reads as a
            // secondary option rather than competing with the success state.
            setTimeout(() => rotateBtn.classList.add('visible'), 50);
            rotateBtn.addEventListener('click', async () => {
                rotateBtn.disabled = true;

                // Fade the button out (rather than exploding it) — the
                // thumbs-up stays put so the progress ring can wrap around
                // it as the rotation animation runs.
                rotateBtn.style.transition = 'opacity 0.25s ease-out';
                rotateBtn.style.opacity = '0';

                const headlineEl = confirmation.querySelector('.ext-headline');
                const domainEl = confirmation.querySelector('.ext-domain');

                // After the fade-out finishes, drop the button out of
                // layout, swap the headline to "rotating…" with the
                // shimmer animation, and inject the ring around the
                // content stack.
                const BUTTON_FADE_OUT_MS = 250;
                const ROTATING_MS = 1850;
                setTimeout(() => {
                    rotateBtn.remove();
                    if (headlineEl) {
                        headlineEl.textContent = 'rotating…';
                        headlineEl.classList.add('shimmer');
                    }
                    injectRotatingRing(confirmation, ROTATING_MS, {
                        bare: true,
                        // Same neutral gray as the #909090 thumbs-up but
                        // a shade lighter so the ring reads as part of
                        // the same UI family while still being visually
                        // distinct.
                        stroke: '#c0c0c0',
                        strokeWidth: 5,
                        startAt: 'bottom'
                    });
                }, BUTTON_FADE_OUT_MS);

                // Run generation + the minimum pause in parallel so the
                // ring always completes a full revolution regardless of
                // how fast PBKDF2 runs on this device. The wait equals
                // the button-fade delay (when the ring is actually
                // injected) plus the ring's animation duration, so the
                // ring completes its sweep before we tear it down.
                const TOTAL_WAIT_MS = BUTTON_FADE_OUT_MS + ROTATING_MS;
                let finalDomain = null;
                let failed = false;
                try {
                    const [resolved] = await Promise.all([
                        performExtensionGeneration(domain, rules, { rotate: true }),
                        new Promise(r => setTimeout(r, TOTAL_WAIT_MS))
                    ]);
                    finalDomain = resolved;
                } catch (err) {
                    console.error('Rotation failed:', err);
                    failed = true;
                    await new Promise(r => setTimeout(r, TOTAL_WAIT_MS));
                }

                // Tear down the ring, restore the headline, then explode
                // only the old rotation token (the superscript) — the
                // base hostname doesn't change between rotations, so
                // leaving it in place keeps the user's eye anchored and
                // makes the swap feel like a precise edit rather than a
                // wholesale re-paint. The old <sup> is cloned to a
                // fixed-positioned ghost (which is what dust-explodes),
                // and the live <sup> is updated to the new value so the
                // new token reveals underneath the dispersing dust.
                document.getElementById('ext-rotation-ring')?.remove();
                if (headlineEl) {
                    headlineEl.classList.remove('shimmer');
                    headlineEl.textContent = failed ? 'failed.' : 'copied!';
                }
                if (domainEl && !failed) {
                    const newDomain = finalDomain || domain;
                    const hIdx = newDomain.indexOf('#');
                    const newRotation = hIdx === -1 ? '' : newDomain.slice(hIdx + 1);

                    const oldSup = domainEl.querySelector('.domain-rotation-token');

                    if (oldSup) {
                        const r = oldSup.getBoundingClientRect();
                        const cs = getComputedStyle(oldSup);
                        const ghost = oldSup.cloneNode(true);
                        Object.assign(ghost.style, {
                            position: 'fixed',
                            left: r.left + 'px',
                            top: r.top + 'px',
                            margin: '0',
                            pointerEvents: 'none',
                            zIndex: '11',
                            // Fixed-positioned sup loses its em-relative
                            // sizing (no inline parent to compute against),
                            // so pin the computed values to keep the ghost
                            // visually identical to the original sup.
                            fontSize: cs.fontSize,
                            fontWeight: cs.fontWeight,
                            fontFamily: cs.fontFamily,
                            color: cs.color,
                            lineHeight: cs.lineHeight
                        });
                        document.body.appendChild(ghost);

                        if (newRotation) {
                            oldSup.textContent = newRotation;
                        } else {
                            oldSup.remove();
                        }

                        // Fewer puffs than a full-domain explosion since
                        // the superscript covers a much smaller area.
                        dustExplode(ghost, null, 8);
                        setTimeout(() => ghost.remove(), 400);
                    } else if (newRotation) {
                        // First-time rotation from a bare hostname — no
                        // old sup to explode, so just fade the new one in.
                        const sup = document.createElement('sup');
                        sup.className = 'domain-rotation-token';
                        sup.textContent = newRotation;
                        sup.style.opacity = '0';
                        sup.style.transition = 'opacity 0.3s ease-out';
                        domainEl.appendChild(sup);
                        requestAnimationFrame(() => { sup.style.opacity = '1'; });
                    }
                }
            });
        }

        if (firstTime) {
            void confirmation.offsetHeight;
            setTimeout(() => {
                confirmation.style.opacity = '1';
                confirmation.style.transform = 'scale(1)';
            }, 50);
        }
    }

    // ═══════════════════════════════
    // Domain cards
    // ═══════════════════════════════

    function loadDomains() {
        try {
            const raw = JSON.parse(localStorage.getItem(STORAGE_KEYS.domains) || '[]');
            // Migrate old string[] format to object[]
            savedDomains = raw.map(d => {
                if (typeof d === 'string') {
                    return { domain: d, uppercase: true, digits: true, symbols: true, length: passwordLength };
                }
                return d;
            });
        } catch {
            savedDomains = [];
        }
        renderDomainCards();
    }

    function saveDomains() {
        localStorage.setItem(STORAGE_KEYS.domains, JSON.stringify(savedDomains));
    }

    function addDomain(domain) {
        domain = domain.toLowerCase().trim()
            .replace(/^https?:\/\//, '').replace(/^www\./, '').replace(/\/$/, '');
        if (!domain) return;

        const opts = {
            domain,
            uppercase: els.ruleUppercase.checked,
            digits: els.ruleDigits.checked,
            symbols: els.ruleSymbols.checked,
            length: clampLength(els.ruleLength?.value)
        };

        // Update in-place if exists, otherwise prepend (new cards at head)
        const idx = savedDomains.findIndex(d => d.domain === domain);
        if (idx >= 0) {
            savedDomains[idx] = opts;
        } else {
            savedDomains.unshift(opts);
        }
        saveDomains();
    }

    function dustExplode(cardEl, callback, puffCount) {
        const rect = cardEl.getBoundingClientRect();

        // Shrink + fade the card
        cardEl.style.transition = 'transform 0.25s ease-out, opacity 0.25s ease-out';
        cardEl.style.transform = 'scale(0.8)';
        cardEl.style.opacity = '0';

        // Create smoke puffs
        const PUFF_COUNT = puffCount || 20;
        const particles = [];
        const container = document.createElement('div');
        container.style.cssText = 'position:fixed;top:0;left:0;width:100%;height:100%;pointer-events:none;z-index:200;overflow:visible';
        document.body.appendChild(container);

        for (let i = 0; i < PUFF_COUNT; i++) {
            const p = document.createElement('div');
            const size = 14 + Math.random() * 16;
            const angle = Math.random() * Math.PI * 2;
            const speed = 15 + Math.random() * 35;
            const x = rect.left + rect.width * 0.2 + Math.random() * rect.width * 0.6;
            const y = rect.top + rect.height * 0.2 + Math.random() * rect.height * 0.6;
            const gray = 160 + Math.floor(Math.random() * 60);

            p.style.cssText = `
                position: fixed;
                left: ${x - size / 2}px;
                top: ${y - size / 2}px;
                width: ${size}px;
                height: ${size}px;
                background: rgba(${gray}, ${gray}, ${gray}, 0.7);
                border-radius: 50%;
                pointer-events: none;
                filter: blur(3px);
                will-change: transform, opacity;
            `;
            container.appendChild(p);

            particles.push({
                el: p,
                vx: Math.cos(angle) * speed,
                vy: Math.sin(angle) * speed,
            });
        }

        const DURATION = 500;
        const start = performance.now();

        function animate(now) {
            const elapsed = now - start;
            const t = Math.min(elapsed / DURATION, 1);
            const ease = 1 - (1 - t) * (1 - t);

            particles.forEach(p => {
                const dx = p.vx * ease * 2;
                const dy = p.vy * ease * 2;
                const grow = 1 + ease * 1.5;
                const opacity = (1 - ease) * 0.6;

                p.el.style.transform = `translate(${dx}px, ${dy}px) scale(${grow})`;
                p.el.style.opacity = opacity;
            });

            if (t < 1) {
                requestAnimationFrame(animate);
            } else {
                container.remove();
                if (callback) callback();
            }
        }

        requestAnimationFrame(animate);
    }

    function removeDomain(domain) {
        // Snapshot positions of surviving cards before re-render
        const beforeRects = new Map();
        els.domainCards.querySelectorAll('.domain-card').forEach(c => {
            const d = c.getAttribute('data-domain');
            if (d && d !== domain) beforeRects.set(d, c.getBoundingClientRect());
        });
        const addBtn = els.domainCards.querySelector('#add-card-btn');
        if (addBtn) beforeRects.set('__add__', addBtn.getBoundingClientRect());

        savedDomains = savedDomains.filter(d => d.domain !== domain);
        saveDomains();
        renderDomainCards();
        refreshSlideHeight();

        // FLIP: animate surviving cards from old to new positions
        const flipTargets = [];
        els.domainCards.querySelectorAll('.domain-card').forEach(c => {
            const d = c.getAttribute('data-domain');
            const old = beforeRects.get(d);
            if (!old) return;
            const cur = c.getBoundingClientRect();
            const dx = old.left - cur.left;
            const dy = old.top - cur.top;
            if (dx !== 0 || dy !== 0) flipTargets.push({ el: c, dx, dy });
        });
        const newAddBtn = els.domainCards.querySelector('#add-card-btn');
        if (newAddBtn && beforeRects.has('__add__')) {
            const old = beforeRects.get('__add__');
            const cur = newAddBtn.getBoundingClientRect();
            const dx = old.left - cur.left;
            const dy = old.top - cur.top;
            if (dx !== 0 || dy !== 0) flipTargets.push({ el: newAddBtn, dx, dy });
        }

        flipTargets.forEach(({ el, dx, dy }) => {
            el.style.transition = 'none';
            el.style.transform = `translate(${dx}px, ${dy}px)`;
        });
        void document.body.offsetHeight;
        flipTargets.forEach(({ el }) => {
            el.style.transition = 'transform 0.25s cubic-bezier(0.2, 0, 0, 1)';
            el.style.transform = '';
        });
        setTimeout(() => {
            flipTargets.forEach(({ el }) => {
                el.style.transition = '';
                el.style.transform = '';
            });
            // If no cards remain, smoothly reveal the input area
            if (savedDomains.length === 0) {
                els.domainSubtitle.textContent = TEXT.domainSubtitleNew;
                els.domainInput.disabled = false;
                els.domainInput.value = '';

                // Expand instantly but invisible
                const inputArea = els.domainInputArea;
                inputArea.style.transition = 'none';
                inputArea.style.opacity = '0';
                inputArea.classList.remove('collapsed');
                void inputArea.offsetHeight;

                // Fade in smoothly
                inputArea.style.transition = 'opacity 0.3s ease-out';
                inputArea.style.opacity = '1';
                refreshSlideHeight();

                setTimeout(() => {
                    inputArea.style.transition = '';
                    inputArea.style.opacity = '';
                    els.domainInput.focus();
                }, 350);
            }
        }, 260);
    }

    // Favicon URL helper: strips the trailing "#..." rotation suffix so e.g.
    // "gmail.com#1" still resolves to the gmail favicon. The unmodified domain
    // (with the suffix) is still used for password derivation — only the icon
    // lookup is sanitised.
    // ─── Rotation helpers ────────────────────────────────────────────
    // The bare hostname is whatever sits before the first '#'.
    function baseHostname(domain) {
        const idx = (domain || '').indexOf('#');
        return idx === -1 ? domain : domain.slice(0, idx);
    }

    // Rotate the rotation token at the end of a domain string. Numeric tokens
    // (and numeric trailing portions of any token) get incremented; otherwise
    // a '1' is appended. Always-up-by-one — uniqueness is handled by
    // nextAvailableRotation, which keeps bumping until the result is free.
    function rotate(domain) {
        const hashIdx = (domain || '').indexOf('#');
        if (hashIdx === -1) return domain + '#1';
        const base = domain.slice(0, hashIdx);
        const token = domain.slice(hashIdx + 1);
        const m = token.match(/^(.*?)(\d+)$/);
        if (m) {
            const next = parseInt(m[2], 10) + 1;
            return base + '#' + m[1] + next;
        }
        return base + '#' + token + '1';
    }

    function nextAvailableRotation(domain) {
        const taken = new Set(savedDomains.map(d => d.domain));
        let candidate = rotate(domain);
        while (taken.has(candidate)) candidate = rotate(candidate);
        return candidate;
    }

    function faviconUrl(domain) {
        return `https://icons.duckduckgo.com/ip3/${domain.replace(/#.*$/, '')}.ico`;
    }

    // Attach a fallback cascade to a favicon <img>: DDG (already set as
    // src by faviconUrl) → icon.horse → Google s2 → local globe.svg.
    // Centralised so all card-render sites get the same chain — keeps
    // them from drifting and matches the # suffix-stripping that
    // faviconUrl does for the primary URL.
    function attachFaviconFallback(imgEl, domain) {
        const bare = domain.replace(/#.*$/, '');
        imgEl.onerror = () => {
            imgEl.onerror = () => {
                imgEl.onerror = () => {
                    imgEl.onerror = null;
                    imgEl.src = 'img/globe.svg';
                };
                imgEl.src = `https://www.google.com/s2/favicons?sz=32&domain=${bare}`;
            };
            imgEl.src = `https://icon.horse/icon/${bare}`;
        };
    }

    // Rotate-toggle sync — visible while editing an existing card; aria-pressed
    // reflects whether the current input value carries a "#..." rotation suffix.
    function syncRotateButton() {
        const btn = document.getElementById('rotate-btn');
        if (!btn) return;
        const value = els.domainInput.value || '';
        btn.style.display = editingDomain !== null ? '' : 'none';
        btn.setAttribute('aria-pressed', value.includes('#') ? 'true' : 'false');
    }

    // Renders the domain string into a label element, wrapping the trailing
    // "#..." rotation suffix in a styled span so it stands out as a rotation
    // marker.
    function renderDomainLabel(labelEl, domain) {
        labelEl.textContent = '';
        const hashIdx = domain.indexOf('#');
        if (hashIdx === -1) {
            labelEl.textContent = domain;
            return;
        }
        if (hashIdx > 0) {
            labelEl.appendChild(document.createTextNode(domain.slice(0, hashIdx)));
        }
        const tok = document.createElement('sup');
        tok.className = 'domain-rotation-token';
        tok.textContent = domain.slice(hashIdx + 1);  // drop the '#'
        labelEl.appendChild(tok);
    }

    function renderDomainCards() {
        els.domainCards.innerHTML = '';

        // Extension's filtered-cards picker mode: show only the cards for
        // the active hostname, no Add button, no edit/drag/remove wiring,
        // tap-to-pick routes through the extension auto-generate flow.
        const filteredHost = window.pwdpalFilteredHost;
        const cardsToShow = filteredHost
            ? savedDomains.filter(d => baseHostname(d.domain) === filteredHost)
            : savedDomains;

        // "+" add card (only if cards exist — otherwise input is already visible).
        // Hidden entirely in extension filtered mode (no card management there).
        if (!filteredHost && savedDomains.length > 0) {
            const addCard = document.createElement('div');
            addCard.className = 'domain-card-add';
            addCard.id = 'add-card-btn';
            addCard.innerHTML = '<span class="domain-card-add-icon">+</span> Add';
            addCard.addEventListener('click', () => {
                editingDomain = null;
                showInputArea(addCard);
            });
            els.domainCards.appendChild(addCard);
        }

        cardsToShow.forEach(entry => {
            const card = document.createElement('div');
            card.className = 'domain-card';
            card.setAttribute('data-domain', entry.domain);

            const favicon = document.createElement('img');
            favicon.className = 'domain-card-favicon';
            favicon.src = faviconUrl(entry.domain);
            // Request the larger source variant so CSS can downscale to
            // 20px crisply on HiDPI screens. Multi-resolution .ico files
            // (DDG) and PNGs from icon.horse expose this; Google s2 caps
            // at 32×32 regardless.
            favicon.width = 32;
            favicon.height = 32;
            favicon.alt = '';
            attachFaviconFallback(favicon, entry.domain);

            const label = document.createElement('span');
            label.className = 'domain-card-label';
            renderDomainLabel(label, entry.domain);

            card.appendChild(favicon);
            card.appendChild(label);

            // Remove (✕) button — kept on the filtered cards page too so
            // the user can delete an outdated identity, even though
            // editing/dragging is suppressed in that mode.
            const removeBtn = document.createElement('button');
            removeBtn.className = 'domain-card-remove';
            removeBtn.textContent = '✕';
            removeBtn.setAttribute('aria-label', `Remove ${entry.domain}`);
            removeBtn.addEventListener('click', (e) => {
                e.stopPropagation();
                dustExplode(card, () => removeDomain(entry.domain));
            });
            card.appendChild(removeBtn);

            if (filteredHost) {
                // Extension filtered mode: tap (anywhere except the ✕) =
                // select identity, generate + copy via auto-generate flow.
                // No drag, no long-press edit. Anchor the thumbs-up overlay
                // over the cards container.
                card.addEventListener('click', (e) => {
                    if (e.target.closest('.domain-card-remove')) return;
                    extensionAutoGenerate(entry.domain, {
                        length: entry.length || passwordLength,
                        uppercase: entry.uppercase,
                        digits: entry.digits,
                        symbols: entry.symbols
                    }, els.domainCards);
                });
            } else {
                // Web app / unfiltered cards page: drag-to-reorder + long-press
                // to edit (handled inside onCardDragStart).
                card.addEventListener('mousedown', (e) => onCardDragStart(e, card, entry));
                card.addEventListener('touchstart', (e) => onCardDragStart(e, card, entry), { passive: false });
            }

            els.domainCards.appendChild(card);
        });

        // Check compact mode synchronously after layout settles
        if (!skipCompactCheck) {
            void els.domainCards.offsetHeight;
            checkCompactCards();
        }

        syncEditHint();
    }

    function checkCompactCards() {
        if (activeIndex !== 2) return;

        // Suppress all transitions during the check
        els.slides.classList.add('no-transition');

        // Use search bar width as the reference for compact container width
        const searchBar = els.domainInputArea.querySelector('.search-bar');
        const compactContainerWidth = searchBar ? searchBar.offsetWidth : 336;

        // Start in compact mode with search-bar-matching width
        els.domainCards.classList.add('compact-cards');
        els.domainCards.style.maxWidth = compactContainerWidth + 'px';

        // Suppress card transitions individually
        const allItems = [...els.domainCards.children];
        allItems.forEach(c => c.style.transition = 'none');
        void els.domainCards.offsetHeight;

        const cards = [...els.domainCards.querySelectorAll('.domain-card, .domain-card-add')];
        if (cards.length === 0) {
            allItems.forEach(c => c.style.transition = '');
            els.slides.classList.remove('no-transition');
            return;
        }

        // Record compact row assignments
        const rows = [];
        let currentRow = [];
        let rowTop = cards[0].getBoundingClientRect().top;
        cards.forEach((c, i) => {
            const top = c.getBoundingClientRect().top;
            if (Math.abs(top - rowTop) > 2 && currentRow.length > 0) {
                rows.push([...currentRow]);
                currentRow = [i];
                rowTop = top;
            } else {
                currentRow.push(i);
            }
        });
        if (currentRow.length > 0) rows.push(currentRow);

        // Switch to large mode (unconstrained) and measure card widths
        els.domainCards.classList.remove('compact-cards');
        els.domainCards.style.maxWidth = 'none';
        void els.domainCards.offsetHeight;
        const largeWidths = cards.map(c => c.getBoundingClientRect().width);
        const largeGap = 10;

        // Compute the max row width for large mode
        let maxRowWidth = 0;
        rows.forEach(row => {
            let rowWidth = 0;
            row.forEach((cardIdx, j) => {
                rowWidth += largeWidths[cardIdx];
                if (j < row.length - 1) rowWidth += largeGap;
            });
            maxRowWidth = Math.max(maxRowWidth, rowWidth);
        });
        const largeMaxWidth = Math.ceil(maxRowWidth);

        // Check if large mode fits both vertically and horizontally
        els.domainCards.style.maxWidth = largeMaxWidth + 'px';
        void els.domainCards.offsetHeight;

        const largeScrollH = screens[2].scrollHeight;
        els.slides.style.height = (largeScrollH + 2) + 'px';
        void els.slides.offsetHeight;

        const bottom = els.slides.getBoundingClientRect().bottom;
        const slideWidth = screens[2].getBoundingClientRect().width;
        const footer = document.querySelector('.footer');
        const footerH = footer ? footer.offsetHeight : 0;
        const needsCompact = bottom > (window.innerHeight - footerH) || slideWidth < largeMaxWidth;

        if (needsCompact) {
            els.domainCards.classList.add('compact-cards');
            els.domainCards.style.maxWidth = compactContainerWidth + 'px';
            void els.domainCards.offsetHeight;
            const compactHeight = screens[2].scrollHeight + 2;
            els.slides.style.height = compactHeight + 'px';
            void els.slides.offsetHeight;

            // If compact cards still overflow, allow page scrolling
            const compactBottom = els.slides.getBoundingClientRect().bottom;
            if (compactBottom > (window.innerHeight - footerH)) {
                els.slides.style.overflow = 'visible';
            } else {
                els.slides.style.overflow = '';
            }
        } else {
            els.slides.style.overflow = '';
        }

        // Re-enable transitions
        allItems.forEach(c => c.style.transition = '');
        els.slides.classList.remove('no-transition');
    }

    // ═══════════════════════════════
    // Card drag-to-reorder
    // ═══════════════════════════════

    let skipCompactCheck = false;
    let dragState = null;

    function showCopyError() {
        const subtitleRect = els.domainSubtitle.getBoundingClientRect();
        const cardsRect = els.domainCards.getBoundingClientRect();

        const overlay = document.createElement('div');
        const padX = 100;
        const padY = 70;
        Object.assign(overlay.style, {
            position: 'fixed',
            left: (cardsRect.left - padX) + 'px',
            top: (subtitleRect.top + 20 - padY) + 'px',
            width: (cardsRect.width + padX * 2) + 'px',
            padding: padY + 'px 0',
            display: 'flex',
            flexDirection: 'column',
            alignItems: 'center',
            zIndex: '10',
            pointerEvents: 'none',
            opacity: '0',
            transform: 'scale(0.8)',
            transition: 'opacity 0.25s ease-out, transform 0.25s ease-out',
            background: 'radial-gradient(ellipse farthest-side at center, var(--bg) 0%, var(--bg) 65%, transparent 100%)'
        });
        overlay.innerHTML = `
            <svg width="120" height="120" viewBox="0 0 24 24" xmlns="http://www.w3.org/2000/svg">
                <circle cx="12" cy="12" r="10" fill="none" stroke="#d93025" stroke-width="2"/>
                <line x1="8.5" y1="8.5" x2="15.5" y2="15.5" stroke="#d93025" stroke-width="2.5" stroke-linecap="round"/>
                <line x1="15.5" y1="8.5" x2="8.5" y2="15.5" stroke="#d93025" stroke-width="2.5" stroke-linecap="round"/>
            </svg>
            <div style="font-size: 20px; font-weight: 700; color: #d93025; margin-top: 10px; font-family: var(--font); letter-spacing: 0.5px;">copy failed</div>
            <div style="font-size: 14px; color: var(--text-3); margin-top: 8px; font-family: var(--font); text-align: center; max-width: 240px; line-height: 1.5;">Check your browser's clipboard permissions and try again.</div>
        `;
        document.body.appendChild(overlay);
        void overlay.offsetHeight;
        setTimeout(() => {
            overlay.style.opacity = '1';
            overlay.style.transform = 'scale(1)';
        }, 100);

        setTimeout(() => {
            overlay.style.transition = 'opacity 0.4s ease-out';
            overlay.style.opacity = '0';
            setTimeout(() => overlay.remove(), 400);
        }, 2800);
    }

    async function onCardClick(clickedCard, entry) {
        // 1. Generate password and copy to clipboard
        const domain = entry.domain.replace(/^https?:\/\//, '').replace(/^www\./, '');
        const counter = parseInt(els.counterInput.value) || 1;
        const rules = {
            length: entry.length || passwordLength,
            uppercase: entry.uppercase,
            digits: entry.digits,
            symbols: entry.symbols
        };

        const isFirstCardCopy = !localStorage.getItem(STORAGE_KEYS.hintShown);
        let shouldShowSecurityHint = false;

        try {
            const password = await PwdCrypto.generate({
                pattern: currentPattern,
                seed: userSeed,
                domain,
                counter,
                rules
            });
            await navigator.clipboard.writeText(password);
            trackGeneration();
            if (isFirstCardCopy) localStorage.setItem(STORAGE_KEYS.hintShown, '1');

            const cardCopyCount = parseInt(localStorage.getItem(STORAGE_KEYS.cardCopyCount) || '0', 10) + 1;
            localStorage.setItem(STORAGE_KEYS.cardCopyCount, cardCopyCount);
            shouldShowSecurityHint = !localStorage.getItem(STORAGE_KEYS.securityHintShown) && cardCopyCount >= SECURITY_HINT_THRESHOLD;
            if (shouldShowSecurityHint) {
                localStorage.setItem(STORAGE_KEYS.securityHintShown, '1');
                // Also mark pattern hint as shown so it doesn't appear later
                localStorage.setItem(STORAGE_KEYS.hintShown, '1');
            }
        } catch (err) {
            console.error('Failed to generate/copy password:', err);
            showCopyError();
            return;
        }

        // 2. Make clicked card unclickable
        clickedCard.style.pointerEvents = 'none';

        // Cancel idle hint timer so subtitle doesn't fade in during animation
        if (domainIdleTimer) { clearTimeout(domainIdleTimer); domainIdleTimer = null; }

        // Hide input area visually if open (preserve space for animations)
        if (!els.domainInputArea.classList.contains('collapsed')) {
            els.domainInputArea.style.visibility = 'hidden';
        }

        // Prevent clipping during expand animation
        els.slides.style.overflow = 'visible';
        els.slides.parentElement.style.overflow = 'visible';

        // Collapse any page scroll before showing the confirmation. With many
        // saved cards the popup/page grows past the viewport and can be
        // scrolled down when a low card is tapped — the "copied!" overlay is
        // position:fixed anchored to the subtitle (near the top of the
        // content), so a scrolled-down view would place it above the visible
        // area and show a blank screen. Reset to top and lock scrolling for
        // the duration of the confirmation so there's no scrollbar and the
        // overlay is always in view. Restored in restoreUI.
        const scrollRoot = document.scrollingElement || document.documentElement;
        const wasScrollable = scrollRoot.scrollHeight > scrollRoot.clientHeight + 1;
        scrollRoot.scrollTop = 0;
        // Only lock overflow when the page actually had a scrollbar — avoids a
        // cosmetic scrollbar-gutter shift in the common case where everything
        // already fit. `null` means "wasn't locked, nothing to restore".
        let prevHtmlOverflow = null;
        if (wasScrollable) {
            prevHtmlOverflow = document.documentElement.style.overflow;
            document.documentElement.style.overflow = 'hidden';
        }

        // 3. Show "copied!" confirmation at the subtitle position
        // Give cards a z-index so they render above the confirmation
        [...els.domainCards.querySelectorAll('.domain-card'), els.domainCards.querySelector('#add-card-btn')]
            .filter(Boolean)
            .forEach(c => { c.style.position = 'relative'; c.style.zIndex = '2'; });

        // Hide subtitle text immediately to avoid clashing
        els.domainSubtitle.style.opacity = '0';
        els.domainSubtitle.style.transition = 'none';

        // Hide the "Hold to edit" hint along with the subtitle, and cancel
        // any pending delayed-reveal so it doesn't flash in mid-animation.
        if (editHintRevealTimer) { clearTimeout(editHintRevealTimer); editHintRevealTimer = null; }
        const editHintEl = document.getElementById('domain-edit-hint');
        if (editHintEl) {
            editHintEl.style.opacity = '0';
            editHintEl.style.transition = 'none';
        }
        // Hide the back chevron while the overlay covers the screen — a
        // lone chevron at the top reads as broken navigation. By the time
        // restoreUI runs we've already navigated back to the pattern
        // screen (1), where the chevron should stay hidden — goToScreen
        // toggles it correctly there, so we don't need to put it back.
        const logoEl = document.getElementById('logo');
        logoEl?.classList.remove('show-back');
        // Same rationale for the settings gear — restored in restoreUI.
        const settingsEl = document.getElementById('settings');
        settingsEl?.classList.add('confirmation-hidden');

        // Position at the subtitle area
        const subtitleRect = els.domainSubtitle.getBoundingClientRect();
        const cardsRect = els.domainCards.getBoundingClientRect();

        const confirmation = document.createElement('div');
        Object.assign(confirmation.style, {
            position: 'fixed',
            left: cardsRect.left + 'px',
            top: (subtitleRect.top + 40) + 'px',
            width: cardsRect.width + 'px',
            display: 'flex',
            flexDirection: 'column',
            alignItems: 'center',
            justifyContent: 'flex-start',
            zIndex: '10',
            pointerEvents: 'none',
            opacity: '0',
            transform: 'scale(0.8)',
            transition: 'opacity 0.25s ease-out, transform 0.25s ease-out'
        });
        confirmation.innerHTML = `
            <svg width="160" height="160" viewBox="0 0 24 24" fill="#b0b0b0" style="flex-shrink: 0; min-width: 160px; min-height: 160px;" xmlns="http://www.w3.org/2000/svg">
                <path d="M2 20h2c.55 0 1-.45 1-1v-9c0-.55-.45-1-1-1H2v11zm19.83-7.12c.11-.25.17-.52.17-.8V11c0-1.1-.9-2-2-2h-5.5l.92-4.65c.05-.22.02-.46-.08-.66-.23-.45-.52-.86-.88-1.22L14 2 7.59 8.41C7.21 8.79 7 9.3 7 9.83v7.84C7 18.95 8.05 20 9.34 20h8.11c.7 0 1.36-.37 1.72-.97l2.66-6.15z"/>
            </svg>
            <div style="font-size: 20px; font-weight: 700; color: #b0b0b0; margin-top: 10px; font-family: var(--font); letter-spacing: 0.5px;">copied!</div>
        `;
        document.body.appendChild(confirmation);
        void confirmation.offsetHeight;
        setTimeout(() => {
            confirmation.style.opacity = '1';
            confirmation.style.transform = 'scale(1)';
            confirmation.style.transition = 'opacity 0.25s ease-out, transform 0.25s ease-out, filter 1.8s ease-in';
            confirmation.style.filter = 'brightness(0.9)';
        }, 100);

        const restoreUI = () => {
            els.domainSubtitle.style.opacity = '';
            els.domainSubtitle.style.transition = '';
            if (editHintEl) {
                editHintEl.style.opacity = '';
                editHintEl.style.transition = '';
            }
            els.domainInputArea.style.visibility = '';
            if (prevHtmlOverflow !== null) document.documentElement.style.overflow = prevHtmlOverflow;
            settingsEl?.classList.remove('confirmation-hidden');
            renderDomainCards();
            refreshSlideHeight();
        };

        // Fade out the confirmation, then show explanation on first copy
        setTimeout(() => {
            confirmation.style.transition = `opacity ${THUMBS_UP_FADE_OUT_MS}ms ease-out`;
            confirmation.style.opacity = '0';
            setTimeout(() => {
                confirmation.remove();
                const lightbulbIcon = `<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M9 18h6"/><path d="M10 22h4"/><path d="M12 2a7 7 0 0 0-4 12.7V17h8v-2.3A7 7 0 0 0 12 2z"/></svg>`;
                const lockIcon = `<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="11" width="18" height="11" rx="2"/><path d="M7 11V7a5 5 0 0 1 10 0v4"/></svg>`;

                const showHint = (messageHTML, maxWidth, totalSeconds, iconSVG) => {
                    // Outer container must be at least as wide as the requested
                    // maxWidth so the inner text div's max-width can actually take
                    // effect. Re-center it around the cards' midpoint, then clamp
                    // to the viewport so wide hints don't overflow on small screens.
                    const VIEWPORT_PADDING = 16;
                    const desiredOuterWidth = Math.max(cardsRect.width, maxWidth + 40);
                    const outerWidth = Math.min(desiredOuterWidth, window.innerWidth - VIEWPORT_PADDING * 2);
                    const cardsCenter = cardsRect.left + cardsRect.width / 2;
                    let outerLeft = cardsCenter - outerWidth / 2;
                    outerLeft = Math.max(VIEWPORT_PADDING, Math.min(outerLeft, window.innerWidth - outerWidth - VIEWPORT_PADDING));

                    const hint = document.createElement('div');
                    Object.assign(hint.style, {
                        position: 'fixed',
                        left: outerLeft + 'px',
                        top: (subtitleRect.top + 20) + 'px',
                        width: outerWidth + 'px',
                        display: 'flex',
                        alignItems: 'center',
                        justifyContent: 'center',
                        zIndex: '10',
                        pointerEvents: 'none',
                        opacity: '0',
                        transition: 'opacity 0.3s ease-out'
                    });

                    const ringSize = 44;
                    const strokeWidth = 3;
                    const radius = (ringSize - strokeWidth) / 2;
                    const circumference = 2 * Math.PI * radius;

                    hint.innerHTML = `
                        <div style="display: flex; flex-direction: column; align-items: center; gap: 18px;">
                            <div style="position: relative; width: ${ringSize}px; height: ${ringSize}px;">
                                <svg width="${ringSize}" height="${ringSize}" viewBox="0 0 ${ringSize} ${ringSize}" style="transform: rotate(-90deg);">
                                    <circle cx="${ringSize / 2}" cy="${ringSize / 2}" r="${radius}" fill="none" stroke="var(--border)" stroke-width="${strokeWidth}"/>
                                    <circle class="hint-progress-ring" cx="${ringSize / 2}" cy="${ringSize / 2}" r="${radius}" fill="none" stroke="var(--brand)" stroke-width="${strokeWidth}" stroke-linecap="round" style="stroke-dasharray: ${circumference}; stroke-dashoffset: ${circumference}; transition: stroke-dashoffset ${totalSeconds}s linear;"/>
                                </svg>
                                <div style="position: absolute; inset: 0; display: flex; align-items: center; justify-content: center; color: var(--text-3);">
                                    ${iconSVG}
                                </div>
                            </div>
                            <div style="font-size: 17px; color: var(--text-2); font-family: var(--font); text-align: center; max-width: ${maxWidth}px; line-height: 1.6;">${messageHTML}</div>
                        </div>
                    `;
                    document.body.appendChild(hint);
                    void hint.offsetHeight;
                    hint.style.opacity = '1';

                    // Trigger ring fill animation on next frame
                    const ring = hint.querySelector('.hint-progress-ring');
                    requestAnimationFrame(() => {
                        if (ring) ring.style.strokeDashoffset = '0';
                    });

                    const dismissHint = () => {
                        // Guard against double-call (autoTimer + back button race)
                        if (activeHintDismiss !== dismissHint) return;
                        activeHintDismiss = null;
                        clearTimeout(autoTimer);
                        hint.style.transition = 'opacity 0.4s ease-out';
                        hint.style.opacity = '0';
                        setTimeout(() => {
                            hint.remove();
                            goToScreen(1, true);
                            setTimeout(restoreUI, 400);
                        }, 400);
                    };

                    const autoTimer = setTimeout(dismissHint, totalSeconds * 1000);
                    activeHintDismiss = dismissHint;
                };

                if (shouldShowSecurityHint) {
                    showHint(
                        `Remember, only you 
                     <br>know your pattern and 
                     <br>seed — that's what 
                     <br>keeps you secure.
                     <br>
                     <br>The flip side: forget
                     <br>either, and your
                     <br>passwords are gone.
                     <br>
                     <span style="font-size: 12px;">
                     <br>You can view your seed 
                     <br>anytime under Settings.
                     </span>`,
                        600,
                        SECURITY_HINT_SECONDS,
                        lockIcon
                    );
                } else if (isFirstCardCopy) {
                    showHint(
                        `Note, your pattern is 
                     <br>never stored — you'll 
                     <br>draw it each time.`,
                        260,
                        PATTERN_HINT_SECONDS,
                        lightbulbIcon
                    );
                } else {
                    goToScreen(1, true);
                    setTimeout(restoreUI, 400);
                }
            }, THUMBS_UP_FADE_OUT_MS);
        }, THUMBS_UP_HOLD_MS);

        // 4. Smoke-puff all OTHER cards + Add button simultaneously
        const allCards = [...els.domainCards.querySelectorAll('.domain-card')];
        const addBtn = els.domainCards.querySelector('#add-card-btn');
        const otherCards = allCards.filter(c => c !== clickedCard);
        if (addBtn) otherCards.push(addBtn);

        // Distribute a fixed particle budget across all exploding cards
        const TOTAL_PARTICLES = 20;
        const perCard = Math.max(3, Math.round(TOTAL_PARTICLES / otherCards.length));

        // Fire smoke puffs on each other card (non-blocking)
        otherCards.forEach(c => {
            dustExplode(c, null, perCard);
        });

        // 4. Clicked card: expand outward + fade over 1 second
        clickedCard.style.transition = 'none';
        clickedCard.style.transformOrigin = 'center center';
        void clickedCard.offsetHeight;
        clickedCard.style.transition = 'transform 1s ease-out, opacity 1s ease-out';
        clickedCard.style.transform = 'scale(1.8)';
        clickedCard.style.opacity = '0';

        // 5. After animation finishes, restore overflow (cards stay gone)
        setTimeout(() => {
            els.slides.style.overflow = '';
            els.slides.parentElement.style.overflow = '';
        }, 1000);
    }

    function onCardDragStart(e, card, entry) {
        // Don't drag from remove button or right-click
        const target = e.target;
        if (target.closest('.domain-card-remove')) return;
        if (e.button === 2) return;

        e.preventDefault();

        const rect = card.getBoundingClientRect();
        const isTouch = e.type === 'touchstart';
        const startX = isTouch ? e.touches[0].clientX : e.clientX;
        const startY = isTouch ? e.touches[0].clientY : e.clientY;

        // Long-press timer for edit mode (1 second)
        let longPressTriggered = false;
        const longPressTimer = setTimeout(() => {
            longPressTriggered = true;
            // Haptic feedback if available
            if (navigator.vibrate) navigator.vibrate(50);
            // Enter edit mode
            editingDomain = entry.domain;
            els.domainInput.disabled = false;
            els.domainInput.value = entry.domain;
            els.ruleUppercase.checked = entry.uppercase;
            els.ruleDigits.checked = entry.digits;
            els.ruleSymbols.checked = entry.symbols;
            if (els.ruleLength) { els.ruleLength.value = entry.length || passwordLength; updateLengthDisplay(); }
            updateGenerateState();
            showInputArea(card);
            // Clean up listeners
            document.removeEventListener(isTouch ? 'touchmove' : 'mousemove', onMove);
            document.removeEventListener(isTouch ? 'touchend' : 'mouseup', onEnd);
        }, 350);

        // Wait for a small movement before starting drag (avoid accidental drags)
        const threshold = 5;
        let started = false;

        const onMove = (ev) => {
            const cx = isTouch ? ev.touches[0].clientX : ev.clientX;
            const cy = isTouch ? ev.touches[0].clientY : ev.clientY;

            if (!started) {
                if (Math.abs(cx - startX) + Math.abs(cy - startY) < threshold) return;
                started = true;
                clearTimeout(longPressTimer);
                beginDrag(card, entry, rect, startX, startY);
            }

            if (dragState) moveDrag(cx, cy);
        };

        const onEnd = (ev) => {
            clearTimeout(longPressTimer);
            document.removeEventListener(isTouch ? 'touchmove' : 'mousemove', onMove);
            document.removeEventListener(isTouch ? 'touchend' : 'mouseup', onEnd);
            if (dragState) {
                endDrag();
            } else if (!started && !longPressTriggered) {
                // No drag, no long press — treat as click
                if (!target.closest('.domain-card-remove')) {
                    onCardClick(card, entry);
                }
            }
        };

        document.addEventListener(isTouch ? 'touchmove' : 'mousemove', onMove, { passive: false });
        document.addEventListener(isTouch ? 'touchend' : 'mouseup', onEnd);
    }

    function beginDrag(card, entry, rect, startX, startY) {
        const cards = [...els.domainCards.querySelectorAll('.domain-card')];
        const fromIndex = cards.indexOf(card);

        // Create floating clone
        const ghost = card.cloneNode(true);
        ghost.className = 'domain-card domain-card-dragging';
        Object.assign(ghost.style, {
            position: 'fixed',
            left: rect.left + 'px',
            top: rect.top + 'px',
            width: rect.width + 'px',
            height: rect.height + 'px',
            zIndex: '200',
            margin: '0',
            pointerEvents: 'none',
            transition: 'box-shadow 0.15s ease, transform 0.15s ease',
            boxShadow: '0 4px 12px rgba(0,0,0,0.15)',
            transform: 'scale(1.05)'
        });
        document.body.appendChild(ghost);

        // If in compact mode, lock compact styles since ghost is outside .compact-cards
        if (els.domainCards.classList.contains('compact-cards')) {
            ghost.style.fontSize = '12px';
            ghost.style.padding = '6px 8px';
            const favicon = ghost.querySelector('.domain-card-favicon');
            if (favicon) { favicon.style.width = '16px'; favicon.style.height = '16px'; }
        }

        // Mark original as placeholder (stays in DOM flow for spacing)
        card.classList.add('domain-card-placeholder');

        dragState = {
            ghost,
            card,
            entry,
            fromIndex,
            offsetX: startX - rect.left,
            offsetY: startY - rect.top
        };
    }

    let dragAnimating = false;

    function moveDrag(cx, cy) {
        const s = dragState;
        // Move ghost with cursor
        s.ghost.style.left = (cx - s.offsetX) + 'px';
        s.ghost.style.top = (cy - s.offsetY) + 'px';

        // Skip if a FLIP animation is in progress
        if (dragAnimating) return;

        // Only move when cursor is actually inside another card's bounds
        const allCards = [...els.domainCards.querySelectorAll('.domain-card')];
        const placeholderIdx = allCards.indexOf(s.card);

        for (let i = 0; i < allCards.length; i++) {
            const c = allCards[i];
            if (c === s.card) continue;
            const r = c.getBoundingClientRect();
            if (cx >= r.left && cx <= r.right && cy >= r.top && cy <= r.bottom) {
                // FLIP: snapshot positions of all cards before the DOM move
                const beforeRects = new Map();
                allCards.forEach(card => {
                    if (card !== s.card) {
                        beforeRects.set(card, card.getBoundingClientRect());
                    }
                });

                // Move placeholder in the DOM
                if (i > placeholderIdx) {
                    c.after(s.card);
                } else {
                    c.before(s.card);
                }

                // Update container height immediately for the new layout
                els.slides.style.height = screens[2].scrollHeight + 'px';

                // FLIP: animate cards from old position to new position
                beforeRects.forEach((oldRect, card) => {
                    const newRect = card.getBoundingClientRect();
                    const dx = oldRect.left - newRect.left;
                    const dy = oldRect.top - newRect.top;
                    if (dx === 0 && dy === 0) return;
                    card.style.transition = 'none';
                    card.style.transform = `translate(${dx}px, ${dy}px)`;
                });

                // Trigger reflow then animate to final positions
                void document.body.offsetHeight;
                beforeRects.forEach((_, card) => {
                    card.style.transition = 'transform 0.15s cubic-bezier(0.2, 0, 0, 1)';
                    card.style.transform = '';
                });

                // Block moves until animation completes
                dragAnimating = true;
                setTimeout(() => { dragAnimating = false; }, 150);

                break;
            }
        }
    }

    function endDrag() {
        const s = dragState;
        dragState = null;

        // Determine final index
        const allCards = [...els.domainCards.querySelectorAll('.domain-card')];
        const finalIndex = allCards.indexOf(s.card);

        // Animate ghost to the placeholder's actual position
        const targetRect = s.card.getBoundingClientRect();
        Object.assign(s.ghost.style, {
            transition: 'all 0.2s cubic-bezier(0.2, 0, 0, 1)',
            left: targetRect.left + 'px',
            top: targetRect.top + 'px',
            width: targetRect.width + 'px',
            transform: 'scale(1)',
            boxShadow: 'none'
        });

        let done = false;
        const cleanup = () => {
            if (done) return;
            done = true;
            s.ghost.remove();
            s.card.classList.remove('domain-card-placeholder');

            // Reorder savedDomains if position changed
            if (s.fromIndex !== finalIndex) {
                const [moved] = savedDomains.splice(s.fromIndex, 1);
                savedDomains.splice(finalIndex, 0, moved);
                saveDomains();
                // Reorder existing DOM nodes instead of re-rendering (avoids favicon flash)
                const domainCards = [...els.domainCards.querySelectorAll('.domain-card')];
                const addBtn = els.domainCards.querySelector('#add-card-btn');
                // Re-append in new order: add button first, then cards by savedDomains order
                if (addBtn) els.domainCards.appendChild(addBtn);
                savedDomains.forEach(entry => {
                    const card = domainCards.find(c => c.getAttribute('data-domain') === entry.domain);
                    if (card) els.domainCards.appendChild(card);
                });
                refreshSlideHeight();
            }
        };

        s.ghost.addEventListener('transitionend', cleanup, { once: true });
        setTimeout(cleanup, 250); // fallback
    }

    function showInputArea(fromElement) {
        // Restore any card still hidden as a placeholder by a previous
        // showInputArea call that never resolved into a save/cancel — e.g.
        // the user clicked "+" (which hides the Add button) and then
        // long-pressed an existing card to edit instead. Without this, the
        // Add button stays invisible while editing, so the user can't click
        // "new" to switch back to creating a card. Skip fromElement, which
        // this call is about to turn into its own placeholder.
        els.domainCards.querySelectorAll('.domain-card-placeholder').forEach(c => {
            if (c !== fromElement) {
                c.classList.remove('domain-card-placeholder');
                c.style.cssText = '';
            }
        });

        els.domainSubtitle.textContent = editingDomain
            ? TEXT.domainSubtitleEditing(editingDomain)
            : TEXT.domainSubtitleNew;

        // Immediately sync button state (disables if input empty)
        if (!editingDomain) {
            els.generateBtn.disabled = true;
            els.generateBtn.textContent = TEXT.btnSave;
        }

        const fromRect = fromElement.getBoundingClientRect();

        const inputArea = els.domainInputArea;
        const searchBar = inputArea.querySelector('.search-bar');

        // ── Phase 1: FLIP the card section for a smooth slide-down ──
        const cardsBefore = els.domainCards.getBoundingClientRect();
        const collapsedSlideHeight = screens[2].scrollHeight;

        // Expand input area instantly (invisible)
        inputArea.style.transition = 'none';
        inputArea.style.opacity = '0';
        inputArea.style.pointerEvents = 'none';
        inputArea.classList.remove('collapsed');
        void inputArea.offsetHeight;
        const toRect = searchBar.getBoundingClientRect();
        const expandedSlideHeight = screens[2].scrollHeight;

        // FLIP: offset cards back to their pre-expansion position
        const cardsAfter = els.domainCards.getBoundingClientRect();
        const deltaY = cardsBefore.top - cardsAfter.top;
        els.domainCards.style.transition = 'none';
        els.domainCards.style.transform = `translateY(${deltaY}px)`;

        // Set slide height to expanded immediately (no animation on slide)
        els.slides.style.transition = 'none';
        els.slides.style.height = expandedSlideHeight + 'px';
        void els.slides.offsetHeight;
        els.slides.style.transition = '';

        // Animate cards from old position to new position
        requestAnimationFrame(() => {
            els.domainCards.style.transition = 'transform 0.3s cubic-bezier(0.4, 0, 0.2, 1)';
            els.domainCards.style.transform = 'translateY(0)';
        });

        inputArea.style.transition = '';

        const SHIFT_MS = 300;
        const PILL_MS = 300;

        // ── Phase 2: After cards settle, fly pill into cleared space ──
        setTimeout(() => {
            // Clean up card section FLIP transform
            els.domainCards.style.transition = '';
            els.domainCards.style.transform = '';

            fromElement.classList.add('domain-card-placeholder');
            // If it's the Add button, hide the dashed placeholder entirely
            if (fromElement.id === 'add-card-btn') {
                fromElement.style.cssText += '; opacity: 0 !important; border-color: transparent !important; background: transparent !important;';
            }
            const currentFrom = fromElement.getBoundingClientRect();
            const finalTo = searchBar.getBoundingClientRect();

            const pill = document.createElement('div');
            pill.className = 'flying-pill';
            Object.assign(pill.style, {
                position: 'fixed',
                left: currentFrom.left + 'px',
                top: currentFrom.top + 'px',
                width: currentFrom.width + 'px',
                height: currentFrom.height + 'px',
                background: 'var(--surface)',
                border: '1px solid var(--border)',
                borderRadius: '20px',
                zIndex: '100',
                transition: 'none',
                boxShadow: 'none',
                pointerEvents: 'none'
            });
            document.body.appendChild(pill);
            void pill.offsetHeight;

            requestAnimationFrame(() => {
                Object.assign(pill.style, {
                    transition: `all ${PILL_MS}ms cubic-bezier(0.4, 0, 0.2, 1)`,
                    left: finalTo.left + 'px',
                    top: finalTo.top + 'px',
                    width: finalTo.width + 'px',
                    height: finalTo.height + 'px',
                    borderRadius: 'var(--radius)',
                    boxShadow: 'var(--shadow-search)',
                    border: 'var(--search-border, none)'
                });

                let done = false;
                const finish = () => {
                    if (done) return;
                    done = true;
                    pill.remove();
                    inputArea.style.opacity = '';
                    inputArea.style.pointerEvents = '';
                    els.domainInput.disabled = false;
                    if (!editingDomain) {
                        els.domainInput.value = '';
                        rememberedRotateSuffix = '';
                    } else {
                        els.domainInput.value = editingDomain;
                        const hashIdx = editingDomain.indexOf('#');
                        rememberedRotateSuffix = hashIdx !== -1 ? editingDomain.slice(hashIdx) : '';
                    }
                    els.domainInput.focus();
                    updateGenerateState();
                    syncRotateButton();
                    refreshSlideHeight();
                };
                pill.addEventListener('transitionend', finish, { once: true });
                setTimeout(finish, PILL_MS + 50);
            });
        }, SHIFT_MS);
    }

    function hideInputArea(targetDomain) {
        const searchBar = els.domainInputArea.querySelector('.search-bar');
        const fromRect = searchBar.getBoundingClientRect();
        const wasEditing = editingDomain;

        editingDomain = null;
        els.domainInput.disabled = true;
        updateGenerateState();
        const inputArea = els.domainInputArea;



        const PILL_MS = 300;

        if (wasEditing) {
            // ── Editing flow ──
            inputArea.style.opacity = '0';
            inputArea.style.pointerEvents = 'none';
            els.domainSubtitle.textContent = savedDomains.length > 0
                ? TEXT.domainSubtitleExisting
                : TEXT.domainSubtitleNew;
            // Update existing card DOM in-place (avoids favicon flash from full re-render)
            if (targetDomain) {
                const oldCard = els.domainCards.querySelector(`[data-domain="${wasEditing}"]`);
                if (oldCard) {
                    oldCard.setAttribute('data-domain', targetDomain);
                    const label = oldCard.querySelector('.domain-card-label');
                    if (label) renderDomainLabel(label, targetDomain);
                    if (wasEditing !== targetDomain) {
                        const favicon = oldCard.querySelector('.domain-card-favicon');
                        if (favicon) {
                            favicon.src = faviconUrl(targetDomain);
                            attachFaviconFallback(favicon, targetDomain);
                        }
                    }
                } else {
                    renderDomainCards();
                }
            } else {
                renderDomainCards();
            }
            refreshSlideHeight();

            const targetCard = targetDomain
                ? els.domainCards.querySelector(`[data-domain="${targetDomain}"]`)
                : null;

            if (!targetCard) {
                inputArea.style.opacity = '';
                inputArea.style.pointerEvents = '';
                inputArea.classList.add('collapsed');
                refreshSlideHeight();
                return;
            }

            // ── Fly pill back to existing card ──
            targetCard.classList.add('domain-card-placeholder');
            const toRect = targetCard.getBoundingClientRect();

            const pill = document.createElement('div');
            Object.assign(pill.style, {
                position: 'fixed',
                left: fromRect.left + 'px',
                top: fromRect.top + 'px',
                width: fromRect.width + 'px',
                height: fromRect.height + 'px',
                background: 'var(--surface)',
                border: 'var(--search-border, none)',
                borderRadius: 'var(--radius)',
                zIndex: '100',
                transition: 'none',
                boxShadow: 'var(--shadow-search)',
                pointerEvents: 'none'
            });
            document.body.appendChild(pill);
            void pill.offsetHeight;

            requestAnimationFrame(() => {
                Object.assign(pill.style, {
                    transition: `all ${PILL_MS}ms cubic-bezier(0.4, 0, 0.2, 1)`,
                    left: toRect.left + 'px',
                    top: toRect.top + 'px',
                    width: toRect.width + 'px',
                    height: toRect.height + 'px',
                    borderRadius: '20px',
                    boxShadow: 'none',
                    border: '1px solid var(--border)'
                });

                let done = false;
                const finish = () => {
                    if (done) return;
                    done = true;
                    pill.remove();
                    targetCard.classList.remove('domain-card-placeholder');

                    inputArea.style.pointerEvents = '';
                    inputArea.classList.add('collapsed');
                    setTimeout(() => {
                        inputArea.style.opacity = '';
                        refreshSlideHeight();
                    }, 300);
                };
                pill.addEventListener('transitionend', finish, { once: true });
                setTimeout(finish, PILL_MS + 50);
            });
        } else {
            // ── Adding flow: reuse the Add placeholder at the head ──
            // The Add button is still a placeholder from showInputArea.
            // We'll expand it to the new card's width, fly the pill to it,
            // then swap it for the actual domain card.

            const addPlaceholder = els.domainCards.querySelector('#add-card-btn');
            if (!addPlaceholder) {
                // Fallback: no Add button (shouldn't happen)
                inputArea.style.opacity = '';
                inputArea.style.pointerEvents = '';
                inputArea.classList.add('collapsed');
                els.domainSubtitle.textContent = savedDomains.length > 0
                    ? TEXT.domainSubtitleExisting : TEXT.domainSubtitleNew;
                renderDomainCards();
                refreshSlideHeight();
                return;
            }

            // Create the actual domain card element offscreen to measure width
            const entry = savedDomains.find(d => d.domain === targetDomain);
            const newCard = document.createElement('div');
            newCard.className = 'domain-card';
            newCard.setAttribute('data-domain', targetDomain);
            newCard.style.position = 'absolute';
            newCard.style.visibility = 'hidden';

            const favicon = document.createElement('img');
            favicon.className = 'domain-card-favicon';
            favicon.src = faviconUrl(targetDomain);
            favicon.width = 32;
            favicon.height = 32;
            favicon.alt = '';
            attachFaviconFallback(favicon, targetDomain);

            const label = document.createElement('span');
            label.className = 'domain-card-label';
            renderDomainLabel(label, targetDomain);

            const removeBtn = document.createElement('button');
            removeBtn.className = 'domain-card-remove';
            removeBtn.textContent = '\u2715';

            newCard.appendChild(favicon);
            newCard.appendChild(label);
            newCard.appendChild(removeBtn);
            els.domainCards.appendChild(newCard);
            void newCard.offsetHeight;
            const targetWidth = newCard.getBoundingClientRect().width;
            const targetHeight = newCard.getBoundingClientRect().height;
            newCard.remove();

            // Disable height animation and clipping during the entire add sequence
            els.slides.classList.add('no-transition');
            els.slides.style.overflow = 'visible';
            els.slides.style.height = 'auto';
            els.slides.parentElement.style.overflow = 'visible';

            // Step 1: Expand Add placeholder to match new card width
            // Snapshot all positions before the change
            const otherCards = [...els.domainCards.querySelectorAll('.domain-card')];
            const beforeRects = new Map();
            otherCards.forEach(c => beforeRects.set(c, c.getBoundingClientRect()));
            const placeholderBefore = addPlaceholder.getBoundingClientRect();

            // Jump to final size instantly (no CSS transition)
            addPlaceholder.style.transition = 'none';
            addPlaceholder.style.width = targetWidth + 'px';
            addPlaceholder.style.height = targetHeight + 'px';
            addPlaceholder.style.overflow = 'hidden';
            void addPlaceholder.offsetHeight;

            // FLIP the placeholder: scale from old size to new size
            const scaleX = placeholderBefore.width / targetWidth;
            const scaleY = placeholderBefore.height / targetHeight;
            addPlaceholder.style.transformOrigin = 'left center';
            addPlaceholder.style.transform = `scaleX(${scaleX}) scaleY(${scaleY})`;

            // FLIP cards: translate from old positions to new
            otherCards.forEach(c => {
                const oldRect = beforeRects.get(c);
                const newRect = c.getBoundingClientRect();
                const dx = oldRect.left - newRect.left;
                const dy = oldRect.top - newRect.top;
                if (dx === 0 && dy === 0) return;
                c.style.transition = 'none';
                c.style.transform = `translate(${dx}px, ${dy}px)`;
            });
            void document.body.offsetHeight;

            // Animate everything
            addPlaceholder.style.transition = 'transform 0.25s cubic-bezier(0.4, 0, 0.2, 1)';
            addPlaceholder.style.transform = '';
            otherCards.forEach(c => {
                c.style.transition = 'transform 0.25s cubic-bezier(0.2, 0, 0, 1)';
                c.style.transform = '';
            });

            const EXPAND_MS = 250;

            setTimeout(() => {
                // Clean up inline sizing and card transforms
                addPlaceholder.style.transition = '';
                addPlaceholder.style.overflow = '';
                addPlaceholder.style.transformOrigin = '';
                addPlaceholder.style.transform = '';
                otherCards.forEach(c => { c.style.transition = ''; c.style.transform = ''; });
                // Hide input area now, then fly the pill
                inputArea.style.opacity = '0';
                inputArea.style.pointerEvents = 'none';
                const fromRectNow = searchBar.getBoundingClientRect();
                const toRect = addPlaceholder.getBoundingClientRect();

                // Hide placeholder when pill starts flying (like editing flow)
                addPlaceholder.style.cssText += '; opacity: 0 !important; border-color: transparent !important; background: transparent !important;';

                // Step 2: Fly pill from search-bar to the expanded placeholder
                const pill = document.createElement('div');
                Object.assign(pill.style, {
                    position: 'fixed',
                    left: fromRectNow.left + 'px',
                    top: fromRectNow.top + 'px',
                    width: fromRectNow.width + 'px',
                    height: fromRectNow.height + 'px',
                    background: 'var(--surface)',
                    border: 'var(--search-border, none)',
                    borderRadius: 'var(--radius)',
                    zIndex: '100',
                    transition: 'none',
                    boxShadow: 'var(--shadow-search)',
                    pointerEvents: 'none'
                });
                document.body.appendChild(pill);
                void pill.offsetHeight;

                requestAnimationFrame(() => {
                    Object.assign(pill.style, {
                        transition: `all ${PILL_MS}ms cubic-bezier(0.4, 0, 0.2, 1)`,
                        left: toRect.left + 'px',
                        top: toRect.top + 'px',
                        width: toRect.width + 'px',
                        height: toRect.height + 'px',
                        borderRadius: '20px',
                        boxShadow: 'none',
                        border: '1px solid var(--border)'
                    });

                    let done = false;
                    const finish = () => {
                        if (done) return;
                        done = true;
                        pill.remove();

                        // Immediately show domain card content in the placeholder
                        // Clone to strip stale event listeners (e.g. showInputArea click)
                        const freshCard = addPlaceholder.cloneNode(false);
                        addPlaceholder.replaceWith(freshCard);
                        freshCard.className = 'domain-card';
                        freshCard.removeAttribute('id');
                        freshCard.setAttribute('data-domain', targetDomain);
                        freshCard.style.cssText = 'cursor: grab;';
                        freshCard.innerHTML = '';
                        const fav = document.createElement('img');
                        fav.className = 'domain-card-favicon';
                        fav.src = faviconUrl(targetDomain);
                        fav.width = 32; fav.height = 32; fav.alt = '';
                        attachFaviconFallback(fav, targetDomain);
                        const lbl = document.createElement('span');
                        lbl.className = 'domain-card-label';
                        renderDomainLabel(lbl, targetDomain);
                        const rmBtn = document.createElement('button');
                        rmBtn.className = 'domain-card-remove';
                        rmBtn.textContent = '✕';
                        rmBtn.setAttribute('aria-label', `Remove ${targetDomain}`);
                        rmBtn.addEventListener('click', (e) => {
                            e.stopPropagation();
                            dustExplode(freshCard, () => removeDomain(targetDomain));
                        });
                        freshCard.appendChild(fav);
                        freshCard.appendChild(lbl);
                        freshCard.appendChild(rmBtn);
                        // Add drag handlers
                        const cardEntry = savedDomains.find(d => d.domain === targetDomain);
                        if (cardEntry) {
                            freshCard.addEventListener('mousedown', (e) => onCardDragStart(e, freshCard, cardEntry));
                            freshCard.addEventListener('touchstart', (e) => onCardDragStart(e, freshCard, cardEntry), { passive: false });
                        }

                        // Step 3: Collapse input area, then re-render
                        // and animate the new Add button
                        els.domainSubtitle.textContent = TEXT.domainSubtitleExisting;
                        inputArea.style.pointerEvents = '';
                        inputArea.classList.add('collapsed');
                        setTimeout(() => {
                            inputArea.style.opacity = '';

                            // Create a fresh Add button at the head
                            const existingAdd = els.domainCards.querySelector('#add-card-btn');
                            if (existingAdd) existingAdd.remove();
                            const addCard = document.createElement('div');
                            addCard.className = 'domain-card-add';
                            addCard.id = 'add-card-btn';
                            addCard.innerHTML = '<span class="domain-card-add-icon">+</span> Add';
                            addCard.addEventListener('click', () => {
                                editingDomain = null;
                                showInputArea(addCard);
                            });
                            els.domainCards.insertBefore(addCard, els.domainCards.firstChild);

                            refreshSlideHeight();

                            // Animate new Add button expanding at the head
                            const newAddBtn = els.domainCards.querySelector('#add-card-btn');
                            if (newAddBtn) {
                                const btnWidth = newAddBtn.getBoundingClientRect().width;
                                newAddBtn.style.transition = 'none';
                                newAddBtn.style.width = '0';
                                newAddBtn.style.padding = '6px 0';
                                newAddBtn.style.overflow = 'hidden';
                                newAddBtn.style.opacity = '0';
                                void newAddBtn.offsetHeight;

                                // Pre-set container height for final layout with Add button
                                els.slides.style.height = screens[2].scrollHeight + 'px';

                                newAddBtn.style.transition = 'width 0.25s cubic-bezier(0.4, 0, 0.2, 1), padding 0.25s cubic-bezier(0.4, 0, 0.2, 1), opacity 0.25s ease';
                                newAddBtn.style.width = btnWidth + 'px';
                                newAddBtn.style.padding = '';
                                newAddBtn.style.opacity = '1';
                                setTimeout(() => {
                                    newAddBtn.style.transition = '';
                                    newAddBtn.style.width = '';
                                    newAddBtn.style.overflow = '';
                                    newAddBtn.style.opacity = '';
                                    els.slides.style.height = screens[2].scrollHeight + 'px';
                                    void els.slides.offsetHeight;
                                    els.slides.classList.remove('no-transition');
                                    els.slides.style.overflow = '';
                                    els.slides.parentElement.style.overflow = '';
                                }, 260);
                            } else {
                                els.slides.style.height = screens[2].scrollHeight + 'px';
                                void els.slides.offsetHeight;
                                els.slides.classList.remove('no-transition');
                                els.slides.style.overflow = '';
                                els.slides.parentElement.style.overflow = '';
                            }
                        }, 300);
                    };
                    pill.addEventListener('transitionend', finish, { once: true });
                    setTimeout(finish, PILL_MS + 50);
                });
            }, EXPAND_MS);
        }
    }

    function onDomainScreenEnter() {
        editingDomain = null;
        renderDomainCards();

        if (savedDomains.length > 0) {
            // Has cards → collapse input, show cards
            els.domainInputArea.style.transition = 'none';
            els.domainInputArea.classList.add('collapsed');
            void els.domainInputArea.offsetHeight;
            els.domainInputArea.style.transition = '';
            els.domainSubtitle.textContent = TEXT.domainSubtitleExisting;
            els.domainInput.disabled = false;
            els.domainInput.value = '';
        } else {
            // No cards → show input instantly (no transition)
            els.domainInputArea.style.transition = 'none';
            els.domainInputArea.classList.remove('collapsed');
            void els.domainInputArea.offsetHeight;
            els.domainInputArea.style.transition = '';
            els.domainSubtitle.textContent = TEXT.domainSubtitleNew;
            els.domainInput.disabled = false;
            els.domainInput.value = '';
            refreshSlideHeight();
            setTimeout(() => els.domainInput.focus(), 400);
        }
    }

    function refreshSlideHeight() {
        requestAnimationFrame(() => {
            els.slides.style.height = (screens[activeIndex].scrollHeight + 2) + 'px';

            // Allow page scrolling if content exceeds viewport (accounting for footer)
            const footer = document.querySelector('.footer');
            const footerH = footer ? footer.offsetHeight : 0;
            const bottom = els.slides.getBoundingClientRect().bottom;
            els.slides.style.overflow = bottom > (window.innerHeight - footerH) ? 'visible' : '';
        });
    }

    // ═══════════════════════════════
    // Generate
    // ═══════════════════════════════

    function updateGenerateState() {
        const ok = currentPattern.length >= 3
            && els.domainInput.value.trim().length > 0
            && userSeed.length > 0;
        els.generateBtn.disabled = !ok;
    }

    // Collapse the length control to just "len" at the default; reveal the number
    // when focused (CSS :focus-within) or whenever a non-default length is set
    // (this class). Cosmetic only — the saved value is clamped on save.
    function updateLengthDisplay() {
        if (!els.ruleLength) return;
        const container = els.ruleLength.closest('.pwd-option-length');
        if (container) {
            container.classList.toggle('length-custom', clampLength(els.ruleLength.value) !== passwordLength);
        }
    }

    async function generatePassword() {
        const rawDomain = els.domainInput.value.trim();
        const domain = rawDomain
            .replace(/^https?:\/\//, '').replace(/^www\./, '');
        const counter = parseInt(els.counterInput.value) || 1;

        const rules = {
            length: clampLength(els.ruleLength?.value),
            uppercase: els.ruleUppercase.checked,
            digits: els.ruleDigits.checked,
            symbols: els.ruleSymbols.checked
        };

        els.generateBtn.disabled = true;
        els.generateBtn.textContent = TEXT.btnGenerating;

        try {
            const password = await PwdCrypto.generate({
                pattern: currentPattern,
                seed: userSeed,
                domain,
                counter,
                rules
            });

            // If editing, update the existing entry; otherwise add new
            if (editingDomain) {
                const idx = savedDomains.findIndex(d => d.domain === editingDomain);
                if (idx >= 0) {
                    savedDomains[idx].domain = domain;
                    savedDomains[idx].uppercase = els.ruleUppercase.checked;
                    savedDomains[idx].digits = els.ruleDigits.checked;
                    savedDomains[idx].symbols = els.ruleSymbols.checked;
                    savedDomains[idx].length = clampLength(els.ruleLength?.value);
                    saveDomains();
                }
            } else {
                addDomain(domain);
            }

            // Clipboard copy is reserved for card clicks; saving only persists
            // the domain + rules so the user can explicitly copy by tapping the
            // card afterwards.
            trackGeneration();

            els.generateBtn.textContent = TEXT.btnSaved;
            els.generateBtn.classList.add('copied');

            // Brief pause to show "Copied!" state, then start fly animation
            setTimeout(() => hideInputArea(domain), 100);

            // Reset button state after delay
            setTimeout(() => {
                els.generateBtn.textContent = TEXT.btnSave;
                els.generateBtn.classList.remove('copied');
                els.generateBtn.disabled = false;
            }, 1300);
        } catch (err) {
            console.error(err);
            showCopyError();
            els.generateBtn.disabled = false;
            els.generateBtn.textContent = TEXT.btnSave;
            els.generateBtn.classList.remove('copied');
        }
    }

    // ═══════════════════════════════
    // Tip jar
    // ═══════════════════════════════

    function initSeedTipReveal() {
        const tipEl = document.querySelector('.seed-tip');
        if (!tipEl) return;

        let focusTimer = null;
        let revealed = false;

        const reveal = () => {
            if (revealed) return;
            revealed = true;
            tipEl.classList.add('visible');
            // Clean up listeners
            els.seedInput.removeEventListener('input', onInput);
            els.seedInput.removeEventListener('focus', onFocus);
            els.seedInput.removeEventListener('blur', onBlur);
            if (focusTimer) clearTimeout(focusTimer);
        };

        const onInput = () => reveal();

        const onFocus = () => {
            if (els.seedInput.value === '') {
                focusTimer = setTimeout(reveal, IDLE_HINT_DELAY);
            }
        };

        const onBlur = () => {
            if (focusTimer) { clearTimeout(focusTimer); focusTimer = null; }
        };

        els.seedInput.addEventListener('input', onInput);
        els.seedInput.addEventListener('focus', onFocus);
        els.seedInput.addEventListener('blur', onBlur);

        // If already focused (from the auto-focus), start the timer
        if (document.activeElement === els.seedInput) {
            onFocus();
        }
    }

    // ── Share PwdPal ──
    // Word-of-mouth growth lever. The shared/copied URL carries a ?ref tag that
    // a separate analytics workstream counts server-side from inbound visits:
    // ?ref=web from the web app's Share button, ?ref=ext from the extension's.
    // Same key, distinct values, so each surface is bucketed separately in the
    // rollup — and launch-channel tags (?ref=hn, ?ref=ph, …) slot into the same
    // key for free. We deliberately fire NO in-app analytics event here — this
    // is a privacy tool, so the click itself is never tracked. Do not add any
    // in-browser analytics call here.
    const SHARE_TITLE = 'PwdPal';
    const SHARE_TEXT = 'A password for every site, rebuilt from a pattern only you know — nothing stored.';

    async function sharePwdPal(btn) {
        // Canonical www host on purpose: the apex→www 301 strips the query, so
        // the ?ref tag must ride the www URL to survive the redirect. Computed
        // here (not at module scope) so window.pwdpalIsExtension is already set.
        const SHARE_URL = window.pwdpalIsExtension
            ? 'https://www.pwdpal.com/?ref=ext'
            : 'https://www.pwdpal.com/?ref=web';
        // Native share sheet where available (mobile / most modern browsers).
        if (navigator.share) {
            try {
                await navigator.share({ title: SHARE_TITLE, text: SHARE_TEXT, url: SHARE_URL });
                return;
            } catch (err) {
                // User cancelled the share sheet — do nothing. Any other
                // failure falls through to the clipboard copy below.
                if (err && err.name === 'AbortError') return;
            }
        }
        // Desktop / no-navigator.share fallback: copy the link and confirm
        // inline on the button (matches the app's clipboard-based feedback).
        try {
            await navigator.clipboard.writeText(SHARE_URL);
            showShareCopied(btn);
        } catch (err) {
            console.error('Failed to copy share link:', err);
        }
    }

    // Brief inline "Link copied" confirmation on the footer button, then
    // restore the original label. Guarded so rapid clicks don't stack.
    function showShareCopied(btn) {
        if (!btn || btn.dataset.confirming === '1') return;
        const original = btn.textContent;
        btn.dataset.confirming = '1';
        btn.textContent = 'Link copied';
        setTimeout(() => {
            btn.textContent = original;
            delete btn.dataset.confirming;
        }, 1800);
    }

    // Landing-side counterpart to sharePwdPal. A visitor who arrives via a
    // shared link hits the URL with its ?ref tag, which CloudFront records in
    // the edge access log BEFORE any JS runs — so word-of-mouth is already
    // measured server-side by the time we reach here. We then drop ?ref from
    // the address bar so the recipient sees a clean www.pwdpal.com, won't
    // bookmark or re-share the tagged URL, and gets no tracking-looking cruft.
    // Surgical: strips ONLY ?ref — any other query param (e.g. ?tip) and the
    // #screen hash are preserved — and is a no-op when no ?ref is present
    // (so it never fires in the extension popup, which has no ?ref).
    function stripShareRefFromUrl() {
        if (!window.history || !history.replaceState) return;
        const params = new URLSearchParams(window.location.search);
        if (!params.has('ref')) return;
        params.delete('ref');
        const qs = params.toString();
        const cleaned = window.location.pathname + (qs ? '?' + qs : '') + window.location.hash;
        try {
            history.replaceState(history.state, '', cleaned);
        } catch (_) {
            // replaceState can throw in unusual embedding contexts; prettifying
            // the URL is purely cosmetic, so swallow and carry on.
        }
    }

    function trackGeneration() {
        const count = parseInt(localStorage.getItem(STORAGE_KEYS.genCount) || '0', 10) + 1;
        localStorage.setItem(STORAGE_KEYS.genCount, count);
        if (count >= TIP_THRESHOLD) {
            maybeShowTipBanner();
        }
    }

    function maybeShowTipBanner() {
        if (!SUPPORT_ENABLED) return;
        const hideUntil = localStorage.getItem(STORAGE_KEYS.tipDismissed);
        if (hideUntil && Date.now() < parseInt(hideUntil, 10)) return;
        const banner = document.getElementById('tip-banner');
        if (banner && !banner.classList.contains('visible')) {
            setTimeout(() => banner.classList.add('visible'), 600);
        }
    }

    function initTipBanner() {
        if (!SUPPORT_ENABLED) return;
        const banner = document.getElementById('tip-banner');
        const closeBtn = document.getElementById('tip-banner-close');
        const dismissBanner = (cooldownDays) => {
            if (banner) banner.classList.remove('visible');
            const until = Date.now() + cooldownDays * 24 * 60 * 60 * 1000;
            localStorage.setItem(STORAGE_KEYS.tipDismissed, until.toString());
        };
        if (closeBtn) closeBtn.addEventListener('click', () => dismissBanner(7));
        banner?.querySelectorAll('.tip-link, .tip-inline-link').forEach(link => {
            link.addEventListener('click', () => dismissBanner(90));
        });
    }

    // ═══════════════════════════════
    // Theme
    // ═══════════════════════════════

    function initTheme() {
        const saved = localStorage.getItem(STORAGE_KEYS.theme) || 'auto';
        document.documentElement.setAttribute('data-theme', saved);
    }

    function setTheme(theme) {
        document.documentElement.setAttribute('data-theme', theme);
        localStorage.setItem(STORAGE_KEYS.theme, theme);
        els.themeIcon.innerHTML = THEME_ICONS[theme];
        els.themeLabel.textContent = theme;
        // Redraw pattern canvas with new colors
        if (patternInitialized) {
            PatternLock.updateTheme();
        }
    }

    function cycleTheme() {
        const current = localStorage.getItem(STORAGE_KEYS.theme) || 'auto';
        const next = THEMES[(THEMES.indexOf(current) + 1) % THEMES.length];
        setTheme(next);
    }

    return { init };
})();

document.addEventListener('DOMContentLoaded', async () => {
    // Extension popup may set window.pwdpalHydration to a Promise that
    // resolves once localStorage has been hydrated from the pwdpal.com
    // snapshot. On the web app this is undefined and we init immediately.
    if (window.pwdpalHydration) {
        try { await window.pwdpalHydration; } catch (_) {}
    }
    App.init();
});
