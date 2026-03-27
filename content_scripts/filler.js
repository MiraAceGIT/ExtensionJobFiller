// Script injecté dans la page ISEP pour remplir le formulaire automatiquement


// ============================================================
// S'active uniquement sur la page de creation de candidature ISEP
// Lis les données en attente depuis chrome.storage (stockées par le service worker)
// Ignore les données trop vieilles (+ de 10 min) pour eviter les doubles remplissages
// Attends que le formulaire soit bien chargé (compat React/Vue/Angular)
// Rempli chaque champ reconnu avec les infos scrapés (titre, entreprise, contract etc)
// Affiche un toast pour dire a l'user combien de champs ont été rempli
// ============================================================


'use strict';

/**
 * ISEP Form Filler — content script
 * Automatically injected on every https://www.izia-isep.com/* page.
 * When pending job data is found in session storage it waits for the
 * "create company application" form to appear, then fills all recognised
 * fields using React/Vue/Angular-compatible event dispatching.
 */
(async function isepFiller() {

  console.log('[ISEP Filler] content script actif sur :', window.location.href);

  // Only act on the creation form
  if (!window.location.href.includes('/applications/company/create') &&
      !window.location.href.includes('/company/create')) {
    console.log('[ISEP Filler] URL ne correspond pas au formulaire, arrêt.');
    return;
  }

  // ── Read pending data ────────────────────────────────────
  const stored = await chrome.storage.local.get(['pendingJobData', 'pendingJobTimestamp']);
  console.log('[ISEP Filler] données en storage :', stored);

  if (!stored.pendingJobData) {
    console.warn('[ISEP Filler] Aucune donnée trouvée dans le storage.'); // qqun a rien collé ou ça a planté
    return;
  }

  // Ignore stale data (> 10 minutes old)
  const age = Date.now() - (stored.pendingJobTimestamp || 0);
  if (age > 10 * 60 * 1000) {
    console.warn('[ISEP Filler] Données trop anciennes, ignorées.'); // t'aurais du aller plus vite
    chrome.storage.local.remove(['pendingJobData', 'pendingJobTimestamp']);
    return;
  }

  let jobData;
  try {
    jobData = JSON.parse(stored.pendingJobData);
    console.log('[ISEP Filler] données du poste :', jobData);
  } catch {
    console.error('[ISEP Filler] Impossible de parser les données JSON.');
    return;
  }

  // Consume immediately so reloads don't re-trigger
  chrome.storage.local.remove(['pendingJobData', 'pendingJobTimestamp']);

  // ── Wait for the form ────────────────────────────────────
  try {
    await waitForForm();
    await sleep(1200); // React prend son temps comme d'hab

    const filled = await fillForm(jobData);
    console.log(`[ISEP Filler] ${filled} champ(s) rempli(s)`);
    if (filled > 0) {
      showToast(`✓ ${filled} champ(s) rempli(s) automatiquement`, '#2f855a');
    } else {
      showToast('⚠ Données extraites mais champs non trouvés.\nVérifiez la console pour les détails.', '#d97706');
    }
  } catch (err) {
    console.error('[ISEP Filler] Erreur:', err);
    showToast('⚠ ISEP Filler : ' + err.message, '#c53030');
  }

  // ============================================================
  // DOM helpers
  // ============================================================

  function sleep(ms) {
    return new Promise((r) => setTimeout(r, ms));
  }

  /** Resolve when the form renders, or reject after 15 s. */
  function waitForForm() {
    return new Promise((resolve, reject) => {
      if (getForm()) { resolve(); return; }

      const timer = setTimeout(() => {
        obs.disconnect();
        reject(new Error('Formulaire introuvable après 15 s.'));
      }, 15_000);

      const obs = new MutationObserver(() => {
        if (getForm()) {
          clearTimeout(timer);
          obs.disconnect();
          resolve();
        }
      });
      obs.observe(document.body, { childList: true, subtree: true }); //
    });
  }

  function getForm() {
    return (
      document.querySelector('form') ||
      document.querySelector('[class*="form"]') ||
      document.querySelector('[class*="create"]') ||
      document.querySelector('[class*="application"]')
    );
  }

  // ============================================================
  // Field discovery
  // ============================================================

  /**
   * Find an <input>, <select>, or <textarea> by scanning <label> text.
   * Handles the three common patterns:
   *   1. <label for="id"> … </label> <input id="id">
   *   2. <label><input></label>
   *   3. <label> … </label><input> (adjacent sibling)
   */
  function findByLabel(...keywords) {
    for (const label of document.querySelectorAll('label')) {
      const txt = label.textContent.toLowerCase();
      if (!keywords.some((k) => txt.includes(k.toLowerCase()))) continue;

      // Strategy 1 — for/htmlFor attribute
      const forId = label.getAttribute('for') || label.getAttribute('htmlFor');
      if (forId) {
        const el = document.getElementById(forId);
        if (el) return el;
      }
      // Strategy 2 — label wraps input
      const inner = label.querySelector('input, select, textarea');
      if (inner) return inner;

      // Strategy 3 — next sibling or sibling inside a wrapper
      let node = label.nextElementSibling;
      while (node) {
        if (/INPUT|SELECT|TEXTAREA/.test(node.tagName)) return node;
        const found = node.querySelector('input, select, textarea');
        if (found) return found;
        node = node.nextElementSibling;
      }
    }
    return null;
  }

  /**
   * Find a field by exact id (primary strategy for izia-isep MUI forms).
   */
  function findById(id) {
    return document.getElementById(id) || null;
  }

  /**
   * Find a field by data-testid attribute.
   */
  function findByTestId(testId) {
    return document.querySelector(`[data-testid="${testId}"]`) || null;
  }

  /**
   * Find a field by name / id / placeholder attribute substrings (fallback).
   */
  function findByAttr(...terms) {
    for (const term of terms) {
      const el =
        document.querySelector(`input[name*="${term}" i], input[id*="${term}" i]`) ||
        document.querySelector(`select[name*="${term}" i], select[id*="${term}" i]`) ||
        document.querySelector(`textarea[name*="${term}" i], textarea[id*="${term}" i]`) ||
        document.querySelector(`input[placeholder*="${term}" i]`) ||
        document.querySelector(`textarea[placeholder*="${term}" i]`);
      if (el) return el;
    }
    return null;
  }

  // ============================================================
  // Value setters — MUI / React compatible
  // ============================================================

  /** Fill a standard MUI text input (triggers React's synthetic events). */
  function setInputValue(el, value) {
    if (!el || value === null || value === undefined || value === '') return false;
    el.focus();
    const nativeInputValueSetter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set
      || Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')?.set;
    if (nativeInputValueSetter) {
      nativeInputValueSetter.call(el, value);
    } else {
      el.value = value;
    }
    el.dispatchEvent(new Event('input',  { bubbles: true, cancelable: true }));
    el.dispatchEvent(new Event('change', { bubbles: true, cancelable: true }));
    el.dispatchEvent(new KeyboardEvent('keyup', { bubbles: true, key: 'End' }));
    el.blur();
    console.log(`[ISEP Filler] ✓ Champ rempli : #${el.id || el.name} = "${value}"`);
    return true;
  }

  /**
   * Fill a MUI Select component (custom dropdown, not a native <select>).
   * Strategy: click the trigger → wait for listbox → click matching option.
   */
  async function setMuiSelectValue(fieldId, value) {
    if (!value) return false;
    const lv = value.toLowerCase().trim();

    // The clickable trigger is either the input itself or a sibling div[role="button"]
    const input = document.getElementById(fieldId);
    const trigger =
      (input?.closest('.MuiFormControl-root, .MuiInputBase-root') || input?.parentElement)
        ?.querySelector('[role="button"], .MuiSelect-select, .MuiNativeSelect-select') ||
      input;

    if (!trigger) {
      console.warn(`[ISEP Filler] Trigger MUI Select introuvable pour #${fieldId}`);
      return false;
    }

    trigger.click();
    await sleep(400);

    // The dropdown list is appended to <body>
    const listbox =
      document.querySelector('[role="listbox"]') ||
      document.querySelector('.MuiMenu-list, .MuiList-root');

    if (!listbox) {
      console.warn(`[ISEP Filler] Dropdown MUI non trouvée pour #${fieldId}`);
      // close any open menu
      document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
      return false;
    }

    const options = listbox.querySelectorAll('[role="option"], li');
    let best = null;
    let bestScore = 0;

    for (const opt of options) {
      const ot = opt.textContent.toLowerCase().trim();
      if (ot === lv) { best = opt; break; }
      if (ot.includes(lv) || lv.includes(ot)) {
        const score = Math.min(ot.length, lv.length) / Math.max(ot.length, lv.length, 1);
        if (score > bestScore) { best = opt; bestScore = score; }
      }
    }

    if (!best) {
      console.warn(`[ISEP Filler] Option "${value}" non trouvée dans la dropdown #${fieldId}`);
      document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
      return false;
    }

    best.click();
    await sleep(200);
    console.log(`[ISEP Filler] ✓ Select rempli : #${fieldId} = "${best.textContent.trim()}"`);
    return true;
  }

  /**
   * Fill a MUI Autocomplete (combobox) field.
   * Strategy: type text into input → wait for listbox suggestions → click best match.
   */
  async function setMuiAutocompleteValue(fieldId, value) {
    if (!value) return false;
    const lv = value.toLowerCase().trim();

    const input = document.getElementById(fieldId);
    if (!input) {
      console.warn(`[ISEP Filler] Autocomplete introuvable : #${fieldId}`);
      return false;
    }

    // Clear then type — triggers MUI's internal search
    input.focus();
    await sleep(100);
    const nativeSetter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set;
    if (nativeSetter) nativeSetter.call(input, value);
    else input.value = value;
    input.dispatchEvent(new Event('input',  { bubbles: true }));
    input.dispatchEvent(new Event('change', { bubbles: true }));
    input.dispatchEvent(new KeyboardEvent('keydown', { bubbles: true, key: 'ArrowDown' }));

    // Wait for suggestions listbox (up to 3 s)
    let listbox = null;
    for (let i = 0; i < 30; i++) {
      await sleep(100);
      listbox = document.querySelector('[role="listbox"]');
      if (listbox) break;
    }

    if (!listbox) {
      // No dropdown appeared — value might already be accepted (e.g. country default)
      input.blur();
      console.warn(`[ISEP Filler] Aucune suggestion pour #${fieldId} avec "${value}"`);
      return false;
    }

    const options = listbox.querySelectorAll('[role="option"]');
    let best = null;
    let bestScore = 0;

    for (const opt of options) {
      const ot = opt.textContent.toLowerCase().trim();
      if (ot === lv) { best = opt; break; }
      if (ot.includes(lv) || lv.includes(ot)) {
        const score = Math.min(ot.length, lv.length) / Math.max(ot.length, lv.length, 1);
        if (score > bestScore) { best = opt; bestScore = score; }
      }
    }

    // Fallback: take first option if nothing matched
    if (!best && options.length > 0) best = options[0];

    if (!best) {
      document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
      return false;
    }

    best.click();
    await sleep(200);
    console.log(`[ISEP Filler] ✓ Autocomplete rempli : #${fieldId} = "${best.textContent.trim()}"`);
    return true;
  }

  // ============================================================
  // Fill the form — uses real izia-isep field IDs (companyApplication.*)
  // ============================================================

  async function fillForm(d) {
    let count = 0;

    // ── 1. Text / textarea inputs ──────────────────────────────────────────
    const textFields = [
      { id: 'companyApplication.company',       value: d.company,            fallbackAttrs: ['company', 'entreprise'] },
      { id: 'companyApplication.positionLabel', value: d.title,              fallbackAttrs: ['positionLabel', 'position', 'poste', 'title', 'jobTitle'] },
      { id: 'companyApplication.link',             value: d.sourceUrl || d.url, fallbackAttrs: ['link', 'jobUrl', 'url', 'lien'] },
      { id: 'companyApplication.salary',             value: d.salary,            fallbackAttrs: ['salary', 'salaire'] },
      { id: 'companyApplication.startDate',     value: d.startDate,          fallbackAttrs: ['startDate', 'dateDebut'] },
      { id: 'companyApplication.duration',      value: d.duration,           fallbackAttrs: ['duration', 'duree'] },
      { id: 'companyApplication.description',   value: d.description,        fallbackAttrs: ['description', 'notes'] },
    ];

    for (const f of textFields) {
      if (!f.value) continue;
      const el =
        findById(f.id) ||
        findByTestId(`inputText-${f.id}`) ||
        findByLabel(...(f.fallbackAttrs)) ||
        findByAttr(...(f.fallbackAttrs));
      if (!el) {
        console.warn(`[ISEP Filler] Champ introuvable : ${f.id}`);
        continue;
      }
      if (setInputValue(el, f.value)) count++;
      await sleep(100);
    }

    // ── 2. Radio buttons — Type de contrat (Stage / Alternance) ──────────────
    if (d.contractType) {
      const ct = d.contractType.toLowerCase();
      const isAlternance = /alternance|alternant|apprentissage|apprenti|contrat pro|professionnalisation/.test(ct);
      const isStage      = /stage|stagiaire|internship/.test(ct);

      if (isAlternance || isStage) {
        // Strategy 1 — data-testid: radio-option-true = Alternance, radio-option-false = Stage
        // (confirmed: value="false" is the default/Stage option)
        const targetTestId = isAlternance ? 'radio-option-true' : 'radio-option-false';
        let radio = document.querySelector(`[data-testid="${targetTestId}"]`);

        // Strategy 2 — scan all radio inputs and match label text
        if (!radio) {
          const allRadios = document.querySelectorAll('input[type="radio"]');
          for (const r of allRadios) {
            const label = r.closest('label') || document.querySelector(`label[for="${r.id}"]`);
            const labelText = (label?.textContent || r.closest('[class*="FormControl"], [class*="Radio"]')?.textContent || '').toLowerCase();
            if (isAlternance && /alternance|alternant/.test(labelText)) { radio = r; break; }
            if (isStage      && /stage|stagiaire/.test(labelText))       { radio = r; break; }
          }
        }

        if (radio) {
          // Click the label (more reliable for MUI) or the input itself
          const clickTarget = radio.closest('label') || radio.parentElement || radio;
          clickTarget.click();
          await sleep(150);
          // Force checked state via React's property setter
          const nativeSetter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'checked')?.set;
          if (nativeSetter) nativeSetter.call(radio, true);
          radio.dispatchEvent(new Event('change', { bubbles: true }));
          radio.dispatchEvent(new Event('click',  { bubbles: true }));
          console.log(`[ISEP Filler] ✓ Contrat radio : "${isAlternance ? 'Alternance' : 'Stage'}"`);
          count++;
        } else {
          console.warn(`[ISEP Filler] Radio bouton contrat introuvable pour "${d.contractType}"`);
        }
      } else {
        console.warn(`[ISEP Filler] Type de contrat "${d.contractType}" non reconnu comme Stage ou Alternance.`);
      }
    }

    // ── 3. Ouvrir l'accordéon "Adresse" si fermé ─────────────────────────────
    const hasAddressData = d.country || d.city || d.street;
    if (hasAddressData) {
      // Find the accordion containing "Adresse" h3/h2/button
      const adresseAccordion = [...document.querySelectorAll('h3, h2, button, [class*="AccordionSummary"], [class*="accordion"]')]
        .find(el => el.textContent.trim().toLowerCase() === 'adresse');

      if (adresseAccordion) {
        // Click the summary/trigger (MUI accordion button is usually the closest button or the summary itself)
        const trigger = adresseAccordion.closest('button')
          || adresseAccordion.closest('[class*="AccordionSummary"]')
          || adresseAccordion.closest('[class*="Accordion"]')
          || adresseAccordion;
        const isExpanded = trigger.getAttribute('aria-expanded') === 'true';
        if (!isExpanded) {
          trigger.click();
          console.log('[ISEP Filler] Accordéon "Adresse" ouvert');
          await sleep(500);
        }
      }
    }

    // ── 4. MUI Autocomplete — Pays ────────────────────────────────────────────
    if (d.country) {
      if (await setMuiAutocompleteValue('companyApplication.companyAdressCountryId', d.country)) count++;
      await sleep(300);
    }

    // ── 5. MUI Autocomplete — Adresse (numéro et rue) ────────────────────────
    if (d.street) {
      if (await setMuiAutocompleteValue('companyApplication.companyAdressStreet', d.street)) count++;
      await sleep(300);
    }

    // ── 6. MUI Autocomplete — Ville ──────────────────────────────────────────
    if (d.city) {
      if (await setMuiAutocompleteValue('city', d.city)) count++;
      await sleep(300);
    }

    return count;
  }

  // ============================================================
  // Toast notification
  // ============================================================

  function showToast(message, bg) {
    const existing = document.getElementById('isep-filler-toast');
    if (existing) existing.remove();

    const toast = document.createElement('div');
    toast.id = 'isep-filler-toast';
    toast.textContent = message;
    toast.style.cssText = `
      position: fixed;
      top: 18px;
      right: 18px;
      z-index: 2147483647;
      background: ${bg};
      color: #fff;
      padding: 12px 18px;
      border-radius: 8px;
      font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif;
      font-size: 13.5px;
      font-weight: 500;
      line-height: 1.4;
      box-shadow: 0 4px 18px rgba(0,0,0,.22);
      white-space: pre-line;
      max-width: 360px;
      animation: isepSlideIn 0.3s ease;
    `;

    const style = document.createElement('style');
    style.textContent = `
      @keyframes isepSlideIn {
        from { transform: translateX(110%); opacity: 0; }
        to   { transform: translateX(0);    opacity: 1; }
      }
    `;
    document.head.appendChild(style);
    document.body.appendChild(toast);

    setTimeout(() => {
      toast.style.transition = 'opacity 0.4s';
      toast.style.opacity = '0';
      setTimeout(() => toast.remove(), 400);
    }, 5000);
  }

})();
